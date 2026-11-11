import { sql } from 'kysely';
import { uuidv7 } from '@tradex/domain';
import type { Database } from '../../db/index.js';
import { AppError } from '../../errors.js';
import * as audit from '../core/audit.js';
import { checkPasswordPolicy, hashPassword, PASSWORD_PROBLEM_MESSAGE } from './password.js';
import { seedIdentity } from './seed.js';

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const OWNER_ROLE_CODE = 'OWNER';
/** Serialises owner bootstrap across processes (pg_advisory_xact_lock key, arbitrary constant). */
const OWNER_BOOTSTRAP_LOCK = 4_004_001;

export interface CreateOwnerInput {
  username: string;
  displayName: string;
  password: string;
  /** Allow creating another OWNER when one already exists. */
  additional?: boolean;
}

export interface CreatedUser {
  id: string;
  username: string;
}

/** Lowercase and trim; the database also enforces the lowercase pattern. */
export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Create a user holding the OWNER role (no division limiter), with must_change_password = false.
 * Seeds the identity catalogue first when the OWNER role does not exist yet (fresh install).
 * Refuses when an OWNER already exists unless `additional` is set. Audited (no password data).
 * Hashing happens before the transaction so the advisory lock is held only briefly.
 */
export async function createOwner(db: Database, input: CreateOwnerInput): Promise<CreatedUser> {
  const username = normalizeUsername(input.username);
  const displayName = input.displayName.trim();
  if (!USERNAME_PATTERN.test(username)) {
    throw new AppError(
      'VALIDATION_FAILED',
      'Username must be 3 to 64 characters: lowercase letters, digits, dot, underscore or hyphen.',
    );
  }
  if (displayName.length === 0) {
    throw new AppError('VALIDATION_FAILED', 'Display name is required.');
  }
  const problem = checkPasswordPolicy(input.password);
  if (problem !== null) {
    throw new AppError('VALIDATION_FAILED', PASSWORD_PROBLEM_MESSAGE[problem], { reason: problem });
  }
  const passwordHash = await hashPassword(input.password);

  return db.transaction().execute(async (tx) => {
    await sql`SELECT pg_advisory_xact_lock(${OWNER_BOOTSTRAP_LOCK})`.execute(tx);

    let role = await tx
      .selectFrom('role')
      .select('id')
      .where('code', '=', OWNER_ROLE_CODE)
      .executeTakeFirst();
    if (!role) {
      await seedIdentity(tx);
      role = await tx
        .selectFrom('role')
        .select('id')
        .where('code', '=', OWNER_ROLE_CODE)
        .executeTakeFirstOrThrow();
    }

    if (input.additional !== true) {
      const existing = await tx
        .selectFrom('user_role')
        .select('id')
        .where('role_id', '=', role.id)
        .limit(1)
        .executeTakeFirst();
      if (existing) {
        throw new AppError(
          'INVALID_TRANSITION',
          'An OWNER already exists. Use --additional to create another one.',
          { reason: 'OWNER_EXISTS' },
        );
      }
    }

    const taken = await tx
      .selectFrom('app_user')
      .select('id')
      .where('username', '=', username)
      .executeTakeFirst();
    if (taken) {
      throw new AppError('VALIDATION_FAILED', 'That username is already in use.', {
        reason: 'USERNAME_TAKEN',
      });
    }

    const id = uuidv7();
    await tx
      .insertInto('app_user')
      .values({
        id,
        username,
        display_name: displayName,
        password_hash: passwordHash,
        status: 'ACTIVE',
        must_change_password: false,
      })
      .execute();
    await tx
      .insertInto('user_role')
      .values({ id: uuidv7(), user_id: id, role_id: role.id, division_id: null })
      .execute();

    await audit.record(tx, {
      action: 'user.create',
      entityType: 'app_user',
      entityId: id,
      before: null,
      after: { username, display_name: displayName, roles: [OWNER_ROLE_CODE], bootstrap: true },
      ctx: {},
    });
    return { id, username };
  });
}
