import { sql } from 'kysely';
import {
  LEASE_TTL_SECONDS,
  type HeartbeatRequest,
  type HeartbeatResponse,
  type LeaseAcquireResponse,
  type PostingMode,
} from '@tradex/contracts';
import type { Database } from '../../db/index.js';
import { AppError } from '../../errors.js';
import type { Tx } from '../core/context.js';

/** An agent whose signature was verified for this request. */
export interface AuthenticatedAgent {
  id: string;
  companyId: string;
  machineName: string;
}

/**
 * The lease check every mutating connector call runs in the same transaction as its writes
 * (SYNC_DESIGN section 4): the caller must hold the company lease at exactly `epoch` and it must be
 * live (database clock). The lease row is locked until the transaction ends, so a takeover cannot slip
 * in between the check and the write. `update` is for callers that renew the lease themselves
 * (heartbeat), `share` for everyone else. Otherwise: 409 LEASE_STALE, and the agent must stop,
 * re-acquire and re-verify anything in flight.
 */
export async function assertLease(
  tx: Tx,
  agent: AuthenticatedAgent,
  epoch: number,
  mode: 'share' | 'update' = 'share',
): Promise<void> {
  const base = tx
    .selectFrom('connector_lease')
    .select(['agent_id', 'epoch', sql<boolean>`expires_at > now()`.as('live')])
    .where('company_id', '=', agent.companyId);
  const lease = await (mode === 'update' ? base.forUpdate() : base.forShare()).executeTakeFirst();
  if (!lease || lease.agent_id !== agent.id || Number(lease.epoch) !== epoch || !lease.live) {
    throw new AppError('LEASE_STALE', 'Lease is not held at this epoch. Re-acquire the lease.');
  }
}

/**
 * `POST /lease/acquire`. Granted when there is no lease, the lease has expired, or the caller already
 * holds it. The epoch grows whenever the holder changes or the previous lease had expired (a gap in
 * holding means in-flight work is uncertain, TS-T10); a live lease the caller already holds keeps its
 * epoch. The caller proves it verified the company by sending the company fingerprint.
 */
export async function acquireLease(
  db: Database,
  agent: AuthenticatedAgent,
  companyFingerprint: string,
): Promise<LeaseAcquireResponse> {
  return db.transaction().execute(async (tx) => {
    const company = await tx
      .selectFrom('tally_company')
      .select('fingerprint')
      .where('id', '=', agent.companyId)
      .executeTakeFirstOrThrow();
    if (company.fingerprint !== companyFingerprint) {
      throw new AppError('FORBIDDEN', 'Company identity does not match.', {
        reason: 'COMPANY_MISMATCH',
      });
    }

    const ttl = sql<Date>`now() + make_interval(secs => ${LEASE_TTL_SECONDS})`;
    const inserted = await tx
      .insertInto('connector_lease')
      .values({ company_id: agent.companyId, agent_id: agent.id, epoch: 1, expires_at: ttl })
      .onConflict((oc) => oc.column('company_id').doNothing())
      .returning(['epoch', 'expires_at'])
      .executeTakeFirst();
    if (inserted) {
      return { epoch: Number(inserted.epoch), expiresAt: inserted.expires_at.toISOString() };
    }

    // One atomic statement: the row lock serialises racing acquirers; the loser matches no row.
    const granted = await sql<{ epoch: string; expires_at: Date }>`
      UPDATE connector_lease SET
        epoch = CASE WHEN agent_id = ${agent.id} AND expires_at > now() THEN epoch ELSE epoch + 1 END,
        acquired_at = CASE WHEN agent_id = ${agent.id} AND expires_at > now() THEN acquired_at ELSE now() END,
        agent_id = ${agent.id},
        renewed_at = now(),
        expires_at = ${ttl}
      WHERE company_id = ${agent.companyId} AND (agent_id = ${agent.id} OR expires_at <= now())
      RETURNING epoch, expires_at`.execute(tx);
    const row = granted.rows[0];
    if (row) return { epoch: Number(row.epoch), expiresAt: row.expires_at.toISOString() };

    const holder = await tx
      .selectFrom('connector_lease')
      .select(['agent_id', 'expires_at'])
      .where('company_id', '=', agent.companyId)
      .executeTakeFirstOrThrow();
    throw new AppError('LEASE_HELD', 'Another agent holds the lease.', {
      holderAgentId: holder.agent_id,
      expiresAt: holder.expires_at.toISOString(),
    });
  });
}

/**
 * `POST /lease/release`: expires the lease (the row and epoch stay, so a later holder always gets a
 * larger epoch). Releasing a lease the caller does not hold at this epoch is LEASE_STALE.
 */
export async function releaseLease(
  db: Database,
  agent: AuthenticatedAgent,
  epoch: number,
): Promise<void> {
  await db.transaction().execute(async (tx) => {
    await assertLease(tx, agent, epoch, 'update');
    await tx
      .updateTable('connector_lease')
      .set({ expires_at: sql`now()` })
      .where('company_id', '=', agent.companyId)
      .execute();
  });
}

const HEARTBEAT_RETENTION_DAYS = 30;
const HEARTBEAT_PURGE_EVERY_MS = 60 * 60 * 1000;
let lastHeartbeatPurge = 0;

/**
 * `POST /heartbeat`: renews the lease for another TTL, records the heartbeat and the agent's last
 * status. `commands` is empty until a later work package queues commands for agents (the agent already
 * reconciles on start, SYNC_DESIGN section 5 step 4).
 */
export async function heartbeat(
  db: Database,
  agent: AuthenticatedAgent,
  input: HeartbeatRequest,
): Promise<HeartbeatResponse> {
  const response = await db.transaction().execute(async (tx) => {
    await assertLease(tx, agent, input.epoch, 'update');
    const lease = await tx
      .updateTable('connector_lease')
      .set({
        renewed_at: sql`now()`,
        expires_at: sql`now() + make_interval(secs => ${LEASE_TTL_SECONDS})`,
      })
      .where('company_id', '=', agent.companyId)
      .returning('expires_at')
      .executeTakeFirstOrThrow();
    await tx
      .insertInto('connector_heartbeat')
      .values({
        agent_id: agent.id,
        tally_reachable: input.tallyReachable,
        company_match: input.companyMatch,
        tally_version: input.tallyVersion,
        local_queue: input.journalPending,
        error: input.lastError,
      })
      .execute();
    await tx
      .updateTable('connector_agent')
      .set({
        last_seen_at: sql`now()`,
        last_status: JSON.stringify({
          tallyReachable: input.tallyReachable,
          tallyVersion: input.tallyVersion,
          companyMatch: input.companyMatch,
          journalPending: input.journalPending,
          lastError: input.lastError,
        }),
      })
      .where('id', '=', agent.id)
      .execute();
    const company = await tx
      .selectFrom('tally_company')
      .select('posting_mode')
      .where('id', '=', agent.companyId)
      .executeTakeFirstOrThrow();
    return {
      expiresAt: lease.expires_at.toISOString(),
      postingMode: company.posting_mode as PostingMode,
      commands: [],
    } satisfies HeartbeatResponse;
  });

  const nowMs = Date.now();
  if (nowMs - lastHeartbeatPurge > HEARTBEAT_PURGE_EVERY_MS) {
    lastHeartbeatPurge = nowMs;
    await db
      .deleteFrom('connector_heartbeat')
      .where('at', '<', sql<Date>`now() - make_interval(days => ${HEARTBEAT_RETENTION_DAYS})`)
      .execute()
      .catch(() => undefined);
  }
  return response;
}
