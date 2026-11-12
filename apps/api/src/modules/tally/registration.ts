import { randomInt } from 'node:crypto';
import { sql } from 'kysely';
import type {
  ConnectorAgentDto,
  RegisterRequest,
  RegisterResponse,
  RegistrationCodeDto,
} from '@tradex/contracts';
import { uuidv7 } from '@tradex/domain';
import type { Database } from '../../db/index.js';
import { AppError } from '../../errors.js';
import * as audit from '../core/audit.js';
import type { ActorContext } from '../core/context.js';
import { dateOnly } from './dates.js';
import { normalisePublicKeyPem, sha256Hex } from './signature.js';

/** Same alphabet as password reset codes: no I, L, O, 0 or 1 (typed by hand on the Tally PC). */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 16;
const CODE_PATTERN = /^[A-HJ-KM-NP-Z2-9]{16}$/;
export const REGISTRATION_CODE_TTL_MINUTES = 15;

/** Display form `XXXX-XXXX-XXXX-XXXX` (about 79 bits of entropy). */
export function generateRegistrationCode(): string {
  let raw = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    raw += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return raw.match(/.{4}/g)?.join('-') ?? raw;
}

/** Uppercase, strip separators. Returns null for anything that cannot be a code. */
export function normaliseRegistrationCode(input: string): string | null {
  const raw = input.replace(/[\s-]/g, '').toUpperCase();
  return CODE_PATTERN.test(raw) ? raw : null;
}

const hashCode = (normalised: string): string =>
  sha256Hex(`tradex-connector-registration:${normalised}`);

/**
 * Admin: issue a one-time code for a company. Older unused codes of the same company stop working, so
 * at most one code is live per company. Only the hash is stored; the clear code is returned once.
 */
export async function issueRegistrationCode(
  db: Database,
  companyId: string,
  actor: ActorContext & { userId: string },
): Promise<RegistrationCodeDto> {
  const code = generateRegistrationCode();
  const normalised = normaliseRegistrationCode(code) as string;
  return db.transaction().execute(async (tx) => {
    const company = await tx
      .selectFrom('tally_company')
      .select('id')
      .where('id', '=', companyId)
      .forShare()
      .executeTakeFirst();
    if (!company) throw new AppError('NOT_FOUND', 'Company not found');
    await tx
      .updateTable('connector_registration_code')
      .set({ expires_at: sql`now()` })
      .where('company_id', '=', companyId)
      .where('used_at', 'is', null)
      .where('expires_at', '>', sql<Date>`now()`)
      .execute();
    const row = await tx
      .insertInto('connector_registration_code')
      .values({
        id: uuidv7(),
        company_id: companyId,
        code_hash: hashCode(normalised),
        expires_at: sql`now() + make_interval(mins => ${REGISTRATION_CODE_TTL_MINUTES})`,
        created_by: actor.userId,
      })
      .returning(['id', 'expires_at'])
      .executeTakeFirstOrThrow();
    await audit.record(tx, {
      action: 'connector.registration_code.issue',
      entityType: 'connector_registration_code',
      entityId: row.id,
      after: { companyId, expiresAt: row.expires_at.toISOString() },
      ctx: actor,
    });
    return { companyId, code, expiresAt: row.expires_at.toISOString() };
  });
}

const INVALID_CODE = 'Registration code is invalid or expired.';

/**
 * `POST /connector/v1/register` (unsigned). The code is consumed in the same transaction that creates
 * the agent, under a row lock, so two registrations racing on one code cannot both win. Unknown,
 * expired and already used codes are indistinguishable to the caller.
 */
export async function registerAgent(
  db: Database,
  input: RegisterRequest,
  actor: ActorContext,
): Promise<RegisterResponse> {
  const publicKey = normalisePublicKeyPem(input.publicKeyPem);
  if (publicKey === null) {
    throw new AppError('VALIDATION_FAILED', 'Public key must be an EC P-256 SPKI PEM', {
      fields: [{ path: 'publicKeyPem', message: 'expected an EC P-256 SPKI public key' }],
    });
  }
  const normalised = normaliseRegistrationCode(input.registrationCode);
  if (normalised === null) throw new AppError('UNAUTHENTICATED', INVALID_CODE);

  return db.transaction().execute(async (tx) => {
    const code = await tx
      .selectFrom('connector_registration_code as c')
      .innerJoin('tally_company as t', 't.id', 'c.company_id')
      .select([
        'c.id as codeId',
        'c.company_id',
        't.tally_name',
        't.company_number',
        't.books_from',
      ])
      .where('c.code_hash', '=', hashCode(normalised))
      .where('c.used_at', 'is', null)
      .where('c.expires_at', '>', sql<Date>`now()`)
      .forUpdate('c')
      .executeTakeFirst();
    if (!code) throw new AppError('UNAUTHENTICATED', INVALID_CODE);

    const agentId = uuidv7();
    await tx
      .insertInto('connector_agent')
      .values({
        id: agentId,
        company_id: code.company_id,
        machine_name: input.machineName,
        machine_fingerprint: input.machineFingerprint,
        public_key: publicKey,
        agent_version: input.agentVersion,
      })
      .execute();
    await tx
      .updateTable('connector_registration_code')
      .set({ used_at: sql`now()`, used_by_agent_id: agentId })
      .where('id', '=', code.codeId)
      .execute();
    await audit.record(tx, {
      action: 'connector.agent.register',
      entityType: 'connector_agent',
      entityId: agentId,
      after: {
        companyId: code.company_id,
        machineName: input.machineName,
        agentVersion: input.agentVersion,
      },
      ctx: { ...actor, agentId },
    });
    return {
      agentId,
      companyId: code.company_id,
      expectedCompany: {
        tallyName: code.tally_name,
        companyNumber: code.company_number,
        booksFrom: dateOnly(code.books_from),
      },
    };
  });
}

export async function listAgents(
  db: Database,
  filter: { companyId?: string | undefined } = {},
): Promise<ConnectorAgentDto[]> {
  let query = db
    .selectFrom('connector_agent as a')
    .leftJoin('connector_lease as l', (join) =>
      join
        .onRef('l.company_id', '=', 'a.company_id')
        .onRef('l.agent_id', '=', 'a.id')
        .on('l.expires_at', '>', sql<Date>`now()`),
    )
    .select([
      'a.id',
      'a.company_id',
      'a.machine_name',
      'a.agent_version',
      'a.status',
      'a.registered_at',
      'a.last_seen_at',
      'a.last_status',
      'l.agent_id as lease_agent_id',
    ])
    .orderBy('a.registered_at')
    .orderBy('a.id');
  if (filter.companyId) query = query.where('a.company_id', '=', filter.companyId);
  const rows = await query.execute();
  return rows.map((row) => ({
    id: row.id,
    companyId: row.company_id,
    machineName: row.machine_name,
    agentVersion: row.agent_version,
    status: row.status as ConnectorAgentDto['status'],
    registeredAt: row.registered_at.toISOString(),
    lastSeenAt: row.last_seen_at ? row.last_seen_at.toISOString() : null,
    lastStatus: (row.last_status as Record<string, unknown> | null) ?? null,
    isLeaseHolder: row.lease_agent_id !== null,
  }));
}

/**
 * Admin: revoke an agent. It can no longer sign in, and a lease it holds is expired at once (the row and
 * its epoch stay, so the epoch only ever grows). Revoking twice is a no-op.
 */
export async function revokeAgent(
  db: Database,
  agentId: string,
  actor: ActorContext & { userId: string },
): Promise<{ id: string; status: 'REVOKED' }> {
  return db.transaction().execute(async (tx) => {
    const agent = await tx
      .selectFrom('connector_agent')
      .select(['id', 'company_id', 'status'])
      .where('id', '=', agentId)
      .forUpdate()
      .executeTakeFirst();
    if (!agent) throw new AppError('NOT_FOUND', 'Agent not found');
    if (agent.status === 'REVOKED') return { id: agent.id, status: 'REVOKED' as const };
    await tx
      .updateTable('connector_agent')
      .set({ status: 'REVOKED', revoked_at: sql`now()`, revoked_by: actor.userId })
      .where('id', '=', agentId)
      .execute();
    await tx
      .updateTable('connector_lease')
      .set({ expires_at: sql`now()` })
      .where('agent_id', '=', agentId)
      .where('expires_at', '>', sql<Date>`now()`)
      .execute();
    await audit.record(tx, {
      action: 'connector.agent.revoke',
      entityType: 'connector_agent',
      entityId: agentId,
      before: { status: 'ACTIVE' },
      after: { status: 'REVOKED' },
      ctx: actor,
    });
    return { id: agent.id, status: 'REVOKED' as const };
  });
}
