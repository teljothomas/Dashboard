import type pg from 'pg';

/** Syntactically valid placeholder (satisfies the CHECK; verifies against nothing). */
const PLACEHOLDER_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$cGxhY2Vob2xkZXJwbGFjZWhvbGRlcg';

/**
 * Insert app_user and device rows (as the owner role) so tests that write client_mutation rows
 * satisfy the device foreign key. Each user is ACTIVE with no roles. `devices` are owned by the
 * first user.
 */
export async function insertTestIdentity(
  owner: pg.Pool,
  userIds: readonly string[],
  deviceIds: readonly string[],
): Promise<void> {
  for (const [index, id] of userIds.entries()) {
    await owner.query(
      `INSERT INTO app_user (id, username, display_name, password_hash, must_change_password)
       VALUES ($1, $2, $2, $3, false) ON CONFLICT DO NOTHING`,
      [id, `test-user-${String(index + 1)}`, PLACEHOLDER_HASH],
    );
  }
  const first = userIds[0];
  if (first === undefined) return;
  for (const id of deviceIds) {
    await owner.query(`INSERT INTO device (id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [
      id,
      first,
    ]);
  }
}
