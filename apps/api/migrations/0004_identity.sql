-- 0004_identity: users, roles, permissions, sessions, devices, login attempts (DATA_MODEL section 2).
-- Forward-only. Runs inside one transaction (runner), as the tradex_owner role.
-- tradex_app receives DML through the default privileges set in deploy/db-init/01-roles.sql.
-- The permission catalogue and the six system roles are seeded by seedIdentity() (idempotent,
-- modules/identity/seed.ts), not here, so TypeScript stays the single source for the matrix.

-- ---------------------------------------------------------------------------
-- app_user
-- ---------------------------------------------------------------------------

CREATE TABLE app_user (
  id                    uuid        PRIMARY KEY,
  username              text        NOT NULL UNIQUE
                        CHECK (username ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),
  display_name          text        NOT NULL CHECK (length(btrim(display_name)) > 0),
  phone                 text        CHECK (phone IS NULL OR length(phone) BETWEEN 5 AND 32),
  password_hash         text        NOT NULL CHECK (password_hash LIKE '$argon2id$%'),
  status                text        NOT NULL DEFAULT 'ACTIVE'
                        CHECK (status IN ('ACTIVE', 'DISABLED', 'LOCKED')),
  failed_logins         integer     NOT NULL DEFAULT 0 CHECK (failed_logins >= 0),
  locked_until          timestamptz,
  must_change_password  boolean     NOT NULL DEFAULT true,
  last_login_at         timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid        REFERENCES app_user (id) ON DELETE RESTRICT,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  updated_by            uuid        REFERENCES app_user (id) ON DELETE RESTRICT,
  version               integer     NOT NULL DEFAULT 1
);

CREATE TRIGGER app_user_set_updated_at BEFORE UPDATE ON app_user
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER app_user_bump_version BEFORE UPDATE ON app_user
  FOR EACH ROW EXECUTE FUNCTION bump_version();

-- ---------------------------------------------------------------------------
-- role, permission, role_permission, user_role
-- ---------------------------------------------------------------------------

CREATE TABLE role (
  id          uuid        PRIMARY KEY,
  code        text        NOT NULL UNIQUE CHECK (code ~ '^[A-Z][A-Z0-9_]*$'),
  name        text        NOT NULL CHECK (length(btrim(name)) > 0),
  is_system   boolean     NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid        REFERENCES app_user (id) ON DELETE RESTRICT,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid        REFERENCES app_user (id) ON DELETE RESTRICT,
  version     integer     NOT NULL DEFAULT 1
);

CREATE TRIGGER role_set_updated_at BEFORE UPDATE ON role
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER role_bump_version BEFORE UPDATE ON role
  FOR EACH ROW EXECUTE FUNCTION bump_version();

-- System roles keep their code and flag, and cannot be deleted. Renaming a display name is allowed.
CREATE FUNCTION protect_system_role() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.is_system THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'system role % cannot be deleted', OLD.code USING ERRCODE = 'TX403';
    END IF;
    IF NEW.code <> OLD.code OR NEW.is_system <> OLD.is_system THEN
      RAISE EXCEPTION 'system role % code and is_system cannot change', OLD.code USING ERRCODE = 'TX403';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER role_protect_system BEFORE UPDATE OR DELETE ON role
  FOR EACH ROW EXECUTE FUNCTION protect_system_role();

-- Catalogue: INTERFACES section 3. Codes are two or three lowercase dotted words.
CREATE TABLE permission (
  code        text        PRIMARY KEY CHECK (code ~ '^[a-z]+(\.[a-z]+){1,2}$'),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE role_permission (
  role_id          uuid        NOT NULL REFERENCES role (id) ON DELETE RESTRICT,
  permission_code  text        NOT NULL REFERENCES permission (code) ON DELETE RESTRICT,
  scope            text        NOT NULL CHECK (scope IN ('OWN', 'DIVISION', 'ALL')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role_id, permission_code)
);

CREATE INDEX role_permission_permission_idx ON role_permission (permission_code);

-- division_id NULL means "no division limiter" (a scope of ALL); the unique index treats NULL as one value.
CREATE TABLE user_role (
  id           uuid        PRIMARY KEY,
  user_id      uuid        NOT NULL REFERENCES app_user (id) ON DELETE RESTRICT,
  role_id      uuid        NOT NULL REFERENCES role (id) ON DELETE RESTRICT,
  division_id  uuid        REFERENCES division (id) ON DELETE RESTRICT,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid        REFERENCES app_user (id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX user_role_unique_idx ON user_role
  (user_id, role_id, COALESCE(division_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX user_role_role_idx ON user_role (role_id);

-- ---------------------------------------------------------------------------
-- device: id is the client-generated uuid (OFFLINE_DESIGN). Registered on the first authenticated
-- request from that device (WP-04.2).
-- ---------------------------------------------------------------------------

CREATE TABLE device (
  id             uuid        PRIMARY KEY,
  user_id        uuid        NOT NULL REFERENCES app_user (id) ON DELETE RESTRICT,
  label          text        CHECK (label IS NULL OR length(label) <= 100),
  platform       text        CHECK (platform IS NULL OR length(platform) <= 100),
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_sync_at   timestamptz,
  revoked_at     timestamptz
);

CREATE INDEX device_user_idx ON device (user_id);

-- client_mutation.device_id and sync_conflict.device_id were plain uuids in 0003.
ALTER TABLE client_mutation
  ADD CONSTRAINT client_mutation_device_fk FOREIGN KEY (device_id) REFERENCES device (id) ON DELETE RESTRICT;
ALTER TABLE sync_conflict
  ADD CONSTRAINT sync_conflict_device_fk FOREIGN KEY (device_id) REFERENCES device (id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- session: only the SHA-256 of the 256-bit token is stored (ADR-050).
-- ---------------------------------------------------------------------------

CREATE TABLE session (
  id                   uuid        PRIMARY KEY,
  token_hash           char(64)    NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  user_id              uuid        NOT NULL REFERENCES app_user (id) ON DELETE RESTRICT,
  device_id            uuid        REFERENCES device (id) ON DELETE RESTRICT,
  created_at           timestamptz NOT NULL DEFAULT now(),
  last_seen_at         timestamptz NOT NULL DEFAULT now(),
  expires_at           timestamptz NOT NULL,
  absolute_expires_at  timestamptz NOT NULL,
  revoked_at           timestamptz,
  user_agent           text        CHECK (user_agent IS NULL OR length(user_agent) <= 512),
  ip                   inet,
  CHECK (expires_at <= absolute_expires_at)
);

CREATE INDEX session_user_idx ON session (user_id) WHERE revoked_at IS NULL;
CREATE INDEX session_expiry_idx ON session (absolute_expires_at);

-- ---------------------------------------------------------------------------
-- password_reset: admin-issued one-time code, hashed, 30 minutes, single use (SECURITY section 2).
-- ---------------------------------------------------------------------------

CREATE TABLE password_reset (
  id          uuid        PRIMARY KEY,
  user_id     uuid        NOT NULL REFERENCES app_user (id) ON DELETE RESTRICT,
  code_hash   char(64)    NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  issued_by   uuid        NOT NULL REFERENCES app_user (id) ON DELETE RESTRICT,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX password_reset_user_idx ON password_reset (user_id, created_at);
CREATE INDEX password_reset_code_idx ON password_reset (code_hash);

-- ---------------------------------------------------------------------------
-- login_attempt: rate limiting and forensics, 90-day retention. username is not a FK: failed attempts
-- for unknown usernames are recorded too.
-- ---------------------------------------------------------------------------

CREATE TABLE login_attempt (
  id        bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username  text        NOT NULL CHECK (length(username) <= 128),
  ip        inet,
  at        timestamptz NOT NULL DEFAULT now(),
  success   boolean     NOT NULL
);

CREATE INDEX login_attempt_username_idx ON login_attempt (username, at);
CREATE INDEX login_attempt_ip_idx ON login_attempt (ip, at);
CREATE INDEX login_attempt_at_idx ON login_attempt (at);
