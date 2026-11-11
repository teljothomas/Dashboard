/* eslint-disable @typescript-eslint/require-await -- stub job handlers are async by contract */
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, resetDatabase, testDbUrls, truncateAll } from '../../test/db.js';
import { createDatabase, type Database } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { AppError } from '../errors.js';
import { core } from '../modules/core/index.js';
import { JobRegistry, type JobRecord } from './registry.js';
import { JobWorker } from './worker.js';

const urls = testDbUrls();
let db: Database;
let owner: pg.Pool;

beforeAll(async () => {
  await resetDatabase(urls);
  await runMigrations(urls.owner, MIGRATIONS_DIR);
  db = createDatabase(urls.app);
  owner = new pg.Pool({ connectionString: urls.owner, max: 2 });
});

beforeEach(async () => {
  await truncateAll(urls);
});

afterAll(async () => {
  await db.destroy();
  await owner.end();
});

interface JobRow {
  id: string;
  status: string;
  attempts: number;
  last_error: string | null;
  locked_by: string | null;
  run_at: Date;
}

async function jobRow(id: string): Promise<JobRow> {
  const { rows } = await owner.query<JobRow>(
    'SELECT id, status, attempts, last_error, locked_by, run_at FROM job WHERE id = $1',
    [id],
  );
  const row = rows[0];
  if (!row) throw new Error(`job ${id} not found`);
  return row;
}

async function enqueue(
  kind: string,
  payload: Record<string, unknown> = {},
  runAt?: Date,
  maxAttempts?: number,
): Promise<string> {
  return db.transaction().execute((tx) => core.jobs.enqueue(tx, kind, payload, runAt, maxAttempts));
}

function worker(registry: JobRegistry, workerId = 'test-worker'): JobWorker {
  return new JobWorker({ db, registry, workerId, pollIntervalMs: 20, backoffBaseMs: 60_000 });
}

/** Wait until `check` passes, polling. */
async function eventually(check: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('condition not met in time');
}

describe('core.jobs.enqueue', () => {
  it('queues a job with defaults', async () => {
    const id = await enqueue('demo', { a: 1 });
    const { rows } = await owner.query('SELECT * FROM job WHERE id = $1', [id]);
    expect(rows[0]).toMatchObject({
      kind: 'demo',
      status: 'QUEUED',
      attempts: 0,
      max_attempts: 5,
      payload: { a: 1 },
    });
  });

  it('stores array payload fields as jsonb', async () => {
    const id = await enqueue('demo', { ids: [1, 2] });
    const { rows } = await owner.query<{ payload: unknown }>(
      'SELECT payload FROM job WHERE id = $1',
      [id],
    );
    expect(rows[0]?.payload).toEqual({ ids: [1, 2] });
  });

  it('does not exist if the surrounding transaction rolls back', async () => {
    await db
      .transaction()
      .execute(async (tx) => {
        await core.jobs.enqueue(tx, 'demo', {});
        throw new Error('abort');
      })
      .catch(() => undefined);
    const { rows } = await owner.query<{ n: number }>('SELECT count(*)::int AS n FROM job');
    expect(rows[0]?.n).toBe(0);
  });

  it('rejects an empty kind and a bad maxAttempts', async () => {
    const empty = await enqueue('').catch((e: unknown) => e);
    expect(empty).toBeInstanceOf(AppError);
    const bad = await enqueue('demo', {}, undefined, 0).catch((e: unknown) => e);
    expect(bad).toBeInstanceOf(AppError);
  });
});

describe('JobWorker', () => {
  it('runs a queued job once and marks it DONE', async () => {
    const seen: JobRecord[] = [];
    const registry = new JobRegistry().register('demo', async (job) => {
      seen.push(job);
    });
    const id = await enqueue('demo', { n: 7 });
    expect(await worker(registry).drain()).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      id,
      kind: 'demo',
      payload: { n: 7 },
      attempt: 1,
      maxAttempts: 5,
    });
    expect(await jobRow(id)).toMatchObject({
      status: 'DONE',
      attempts: 1,
      locked_by: null,
      last_error: null,
    });
  });

  it('retries a failing job with exponential backoff, then marks it DEAD', async () => {
    let calls = 0;
    const registry = new JobRegistry().register('flaky', async () => {
      calls += 1;
      throw new Error(`boom ${calls}`);
    });
    const w = worker(registry);
    const id = await enqueue('flaky', {}, undefined, 3);

    // Attempt 1 fails: FAILED, retry scheduled ~60 s ahead (base 60 s), not runnable yet.
    expect(await w.runOnce()).toBe(true);
    let row = await jobRow(id);
    expect(row).toMatchObject({
      status: 'FAILED',
      attempts: 1,
      last_error: 'boom 1',
      locked_by: null,
    });
    const firstDelay = row.run_at.getTime() - Date.now();
    expect(firstDelay).toBeGreaterThan(50_000);
    expect(firstDelay).toBeLessThanOrEqual(65_000);
    expect(await w.runOnce()).toBe(false);
    expect(calls).toBe(1);

    // Attempt 2: backoff doubles to ~120 s.
    await owner.query('UPDATE job SET run_at = now() WHERE id = $1', [id]);
    expect(await w.runOnce()).toBe(true);
    row = await jobRow(id);
    expect(row).toMatchObject({ status: 'FAILED', attempts: 2, last_error: 'boom 2' });
    const secondDelay = row.run_at.getTime() - Date.now();
    expect(secondDelay).toBeGreaterThan(110_000);
    expect(secondDelay).toBeLessThanOrEqual(125_000);

    // Attempt 3 is the last: DEAD, never retried.
    await owner.query('UPDATE job SET run_at = now() WHERE id = $1', [id]);
    expect(await w.runOnce()).toBe(true);
    expect(await jobRow(id)).toMatchObject({ status: 'DEAD', attempts: 3, last_error: 'boom 3' });
    await owner.query('UPDATE job SET run_at = now() WHERE id = $1', [id]);
    expect(await w.runOnce()).toBe(false);
    expect(calls).toBe(3);
  });

  it('succeeds on a retry after an earlier failure', async () => {
    let calls = 0;
    const registry = new JobRegistry().register('flaky', async () => {
      calls += 1;
      if (calls === 1) throw new Error('first try fails');
    });
    const w = worker(registry);
    const id = await enqueue('flaky');
    await w.runOnce();
    await owner.query('UPDATE job SET run_at = now() WHERE id = $1', [id]);
    await w.runOnce();
    expect(await jobRow(id)).toMatchObject({ status: 'DONE', attempts: 2, last_error: null });
  });

  it('records non-Error throws and truncates long messages', async () => {
    const registry = new JobRegistry()
      .register('str', async () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- non-Error throw is the case under test
        throw 'plain string failure';
      })
      .register('long', async () => {
        throw new Error('x'.repeat(5000));
      });
    const w = worker(registry);
    const a = await enqueue('str');
    const b = await enqueue('long');
    await w.drain();
    expect((await jobRow(a)).last_error).toBe('plain string failure');
    expect((await jobRow(b)).last_error).toHaveLength(2000);
  });

  it('does not claim jobs of an unregistered kind or jobs scheduled in the future', async () => {
    const registry = new JobRegistry().register('known', async () => undefined);
    const unknown = await enqueue('unknown');
    const later = await enqueue('known', {}, new Date(Date.now() + 3_600_000));
    expect(await worker(registry).drain()).toBe(0);
    expect((await jobRow(unknown)).status).toBe('QUEUED');
    expect((await jobRow(later)).status).toBe('QUEUED');
  });

  it('with no handlers registered claims nothing', async () => {
    const id = await enqueue('demo');
    expect(await worker(new JobRegistry()).runOnce()).toBe(false);
    expect((await jobRow(id)).status).toBe('QUEUED');
  });

  // Offsets are tens of seconds: the DB clock (container) and the Node clock may differ slightly.
  it('runs jobs oldest run_at first', async () => {
    const order: string[] = [];
    const registry = new JobRegistry().register('demo', async (job) => {
      order.push((job.payload as { n: number }).n.toString());
    });
    await enqueue('demo', { n: 2 }, new Date(Date.now() - 30_000));
    await enqueue('demo', { n: 1 }, new Date(Date.now() - 60_000));
    await enqueue('demo', { n: 3 }, new Date(Date.now() - 10_000));
    await worker(registry).drain();
    expect(order).toEqual(['1', '2', '3']);
  });

  it('two workers never run the same job', async () => {
    const total = 40;
    const runs = new Map<string, string[]>();
    const makeRegistry = (workerName: string): JobRegistry =>
      new JobRegistry().register('demo', async (job) => {
        const list = runs.get(job.id) ?? [];
        list.push(workerName);
        runs.set(job.id, list);
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
    const ids = new Set<string>();
    for (let i = 0; i < total; i++) ids.add(await enqueue('demo', { i }));

    const [a, b] = await Promise.all([
      worker(makeRegistry('A'), 'worker-A').drain(),
      worker(makeRegistry('B'), 'worker-B').drain(),
    ]);

    expect(a + b).toBe(total);
    expect(runs.size).toBe(total);
    for (const id of ids) expect(runs.get(id), `job ${id}`).toHaveLength(1);
    const { rows } = await owner.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM job WHERE status = 'DONE'`,
    );
    expect(rows[0]?.n).toBe(total);
  });

  it('does not hand a job that is held in another transaction to a second worker', async () => {
    const registry = new JobRegistry().register('demo', async () => undefined);
    const id = await enqueue('demo');
    // Simulate worker A mid-claim: row locked FOR UPDATE inside an open transaction.
    const holder = await owner.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM job WHERE id = $1 FOR UPDATE', [id]);
      expect(await worker(registry, 'B').runOnce()).toBe(false);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    expect(await worker(registry, 'B').runOnce()).toBe(true);
  });

  it('reclaims a RUNNING job whose lock expired', async () => {
    const seen: number[] = [];
    const registry = new JobRegistry().register('demo', async (job) => {
      seen.push(job.attempt);
    });
    const id = await enqueue('demo');
    await owner.query(
      `UPDATE job SET status = 'RUNNING', attempts = 1, locked_by = 'dead-worker',
         locked_until = now() - interval '1 minute' WHERE id = $1`,
      [id],
    );
    expect(await worker(registry).drain()).toBe(1);
    expect(seen).toEqual([2]);
    expect(await jobRow(id)).toMatchObject({ status: 'DONE', attempts: 2 });
  });

  it('leaves a RUNNING job with a live lock alone', async () => {
    const registry = new JobRegistry().register('demo', async () => undefined);
    const id = await enqueue('demo');
    await owner.query(
      `UPDATE job SET status = 'RUNNING', attempts = 1, locked_by = 'other',
         locked_until = now() + interval '5 minutes' WHERE id = $1`,
      [id],
    );
    expect(await worker(registry).runOnce()).toBe(false);
    expect(await jobRow(id)).toMatchObject({ status: 'RUNNING', locked_by: 'other' });
  });

  it('marks an expired RUNNING job DEAD when its final attempt already used up', async () => {
    let calls = 0;
    const registry = new JobRegistry().register('demo', async () => {
      calls += 1;
    });
    const id = await enqueue('demo', {}, undefined, 2);
    await owner.query(
      `UPDATE job SET status = 'RUNNING', attempts = 2, locked_by = 'dead-worker',
         locked_until = now() - interval '1 minute' WHERE id = $1`,
      [id],
    );
    await worker(registry).drain();
    expect(calls).toBe(0);
    expect(await jobRow(id)).toMatchObject({ status: 'DEAD', attempts: 2 });
  });

  it('start() processes jobs in the background and stop() waits for the in-flight job', async () => {
    let finished = false;
    let started: () => void = () => undefined;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const registry = new JobRegistry().register('slow', async () => {
      started();
      await new Promise((resolve) => setTimeout(resolve, 150));
      finished = true;
    });
    const id = await enqueue('slow');
    const w = worker(registry);
    w.start();
    w.start(); // idempotent
    await startedPromise;
    await w.stop();
    expect(finished).toBe(true);
    expect((await jobRow(id)).status).toBe('DONE');
  });

  it('picks up jobs enqueued after start, and stops processing after stop()', async () => {
    const done: string[] = [];
    const registry = new JobRegistry().register('demo', async (job) => {
      done.push(job.id);
    });
    const w = worker(registry);
    w.start();
    const first = await enqueue('demo');
    await eventually(async () => (await jobRow(first)).status === 'DONE');
    await w.stop();
    await w.stop(); // idempotent
    const second = await enqueue('demo');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await jobRow(second)).status).toBe('QUEUED');
    expect(done).toEqual([first]);
  });

  it('stop() returns promptly while idle', async () => {
    const w = new JobWorker({
      db,
      registry: new JobRegistry().register('demo', async () => undefined),
      pollIntervalMs: 60_000,
    });
    w.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const began = Date.now();
    await w.stop();
    expect(Date.now() - began).toBeLessThan(2000);
  });

  it('keeps a missing-handler race from stranding a job in RUNNING', async () => {
    // The claim only selects registered kinds, so this stubs the lookup to exercise the
    // execute() guard: the job must end FAILED with a clear error, never stuck RUNNING.
    const registry = new JobRegistry().register('demo', async () => undefined);
    const w = worker(registry);
    const id = await enqueue('demo');
    const original = registry.get.bind(registry);
    registry.get = (kind: string) => (kind === 'demo' ? undefined : original(kind));
    await w.runOnce();
    expect(await jobRow(id)).toMatchObject({ status: 'FAILED', attempts: 1 });
    expect((await jobRow(id)).last_error).toMatch(/no handler registered/);
  });

  it('generates a worker id when none is given', () => {
    const w = new JobWorker({ db, registry: new JobRegistry() });
    expect(w.workerId).toMatch(/^worker-[0-9a-f-]{36}$/);
  });
});
