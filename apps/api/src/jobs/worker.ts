import { sql } from 'kysely';
import { uuidv7 } from '@tradex/domain';
import type { Database } from '../db/index.js';
import { runWithContext } from '../modules/core/context.js';
import type { JobRecord, JobRegistry } from './registry.js';

export interface WorkerOptions {
  db: Database;
  registry: JobRegistry;
  /** Identifies this worker in `job.locked_by`. Defaults to a fresh id. */
  workerId?: string;
  /** Idle poll interval. Default 2000 ms. */
  pollIntervalMs?: number;
  /** How long a claim holds before another worker may take the job over. Default 5 min. */
  lockMs?: number;
  /** First retry delay; doubles each attempt. Default 5000 ms. */
  backoffBaseMs?: number;
  /** Upper bound for the retry delay. Default 1 hour. */
  backoffMaxMs?: number;
  /** Log sink; defaults to silent. */
  onError?: (message: string, error: unknown) => void;
}

const LAST_ERROR_MAX = 2000;

/** Delay before retry number `attempt` (1-based: the attempt that just failed). */
export function backoffMs(attempt: number, baseMs: number, maxMs: number): number {
  return Math.min(baseMs * 2 ** Math.max(attempt - 1, 0), maxMs);
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, LAST_ERROR_MAX);
}

/**
 * PostgreSQL-backed job worker (ADR-006). One job at a time per worker; run several workers (or
 * processes) for parallelism. A job is claimed with `FOR UPDATE SKIP LOCKED` in a short
 * transaction that flips it to RUNNING, so two workers never run the same job. The handler runs
 * outside that transaction. A RUNNING job whose lock expired (worker crashed) is reclaimable.
 *
 * Lifecycle: QUEUED -> RUNNING -> DONE; on error RUNNING -> FAILED (retry at run_at, exponential
 * backoff) until attempts reach max_attempts, then DEAD.
 */
export class JobWorker {
  readonly workerId: string;
  private readonly db: Database;
  private readonly registry: JobRegistry;
  private readonly pollIntervalMs: number;
  private readonly lockMs: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly onError: (message: string, error: unknown) => void;

  private running = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(options: WorkerOptions) {
    this.db = options.db;
    this.registry = options.registry;
    this.workerId = options.workerId ?? `worker-${uuidv7()}`;
    this.pollIntervalMs = options.pollIntervalMs ?? 2000;
    this.lockMs = options.lockMs ?? 5 * 60_000;
    this.backoffBaseMs = options.backoffBaseMs ?? 5000;
    this.backoffMaxMs = options.backoffMaxMs ?? 60 * 60_000;
    this.onError = options.onError ?? (() => undefined);
  }

  /** Start polling. Idempotent. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.runLoop();
  }

  /** Stop polling, let an in-flight job finish, then resolve. Idempotent. */
  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
    this.loop = undefined;
  }

  /** Process jobs until none is ready. Returns how many ran. For tests and one-shot runs. */
  async drain(): Promise<number> {
    let count = 0;
    while (await this.runOnce()) count += 1;
    return count;
  }

  /** Claim and run at most one job. Returns false when nothing was ready. */
  async runOnce(): Promise<boolean> {
    const job = await this.claim();
    if (!job) return false;
    await this.execute(job);
    return true;
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      let ran = false;
      try {
        ran = await this.runOnce();
      } catch (error) {
        this.onError('job worker iteration failed', error);
      }
      if (!ran && this.running) await this.idle();
    }
  }

  private idle(): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.wake = undefined;
        resolve();
      };
      const timer = setTimeout(done, this.pollIntervalMs);
      this.wake = done;
    });
  }

  private async claim(): Promise<JobRecord | undefined> {
    const kinds = this.registry.kinds();
    if (kinds.length === 0) return undefined;
    const lockSeconds = this.lockMs / 1000;

    return this.db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom('job')
        .select(['id', 'kind', 'payload', 'status', 'attempts', 'max_attempts'])
        .where('kind', 'in', kinds)
        .where((eb) =>
          eb.or([
            eb.and([
              eb('status', 'in', ['QUEUED', 'FAILED']),
              eb('run_at', '<=', sql<Date>`now()`),
            ]),
            eb.and([eb('status', '=', 'RUNNING'), eb('locked_until', '<', sql<Date>`now()`)]),
          ]),
        )
        .orderBy('run_at')
        .orderBy('id')
        .limit(1)
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (!row) return undefined;

      // A crashed worker already used the last attempt: do not run it again.
      if (row.status === 'RUNNING' && row.attempts >= row.max_attempts) {
        await trx
          .updateTable('job')
          .set({
            status: 'DEAD',
            last_error: 'lock expired after the final attempt (worker presumed crashed)',
            locked_by: null,
            locked_until: null,
          })
          .where('id', '=', row.id)
          .execute();
        return undefined;
      }

      await trx
        .updateTable('job')
        .set({
          status: 'RUNNING',
          attempts: row.attempts + 1,
          locked_by: this.workerId,
          locked_until: sql<Date>`now() + make_interval(secs => ${lockSeconds})`,
        })
        .where('id', '=', row.id)
        .execute();

      return {
        id: row.id,
        kind: row.kind,
        payload: row.payload,
        attempt: row.attempts + 1,
        maxAttempts: row.max_attempts,
      };
    });
  }

  private async execute(job: JobRecord): Promise<void> {
    const handler = this.registry.get(job.kind);
    try {
      if (!handler) throw new Error(`no handler registered for kind ${job.kind}`);
      await runWithContext({}, () => handler(job, this.db));
      await this.db
        .updateTable('job')
        .set({ status: 'DONE', last_error: null, locked_by: null, locked_until: null })
        .where('id', '=', job.id)
        .where('locked_by', '=', this.workerId)
        .execute();
    } catch (error) {
      await this.fail(job, error);
    }
  }

  private async fail(job: JobRecord, error: unknown): Promise<void> {
    const dead = job.attempt >= job.maxAttempts;
    const delaySeconds = backoffMs(job.attempt, this.backoffBaseMs, this.backoffMaxMs) / 1000;
    try {
      await this.db
        .updateTable('job')
        .set({
          status: dead ? 'DEAD' : 'FAILED',
          last_error: errorText(error),
          locked_by: null,
          locked_until: null,
          ...(dead ? {} : { run_at: sql<Date>`now() + make_interval(secs => ${delaySeconds})` }),
        })
        .where('id', '=', job.id)
        .where('locked_by', '=', this.workerId)
        .execute();
    } catch (updateError) {
      // The lock expiry will make the job reclaimable; nothing more to do here.
      this.onError(`could not record failure of job ${job.id}`, updateError);
    }
  }
}
