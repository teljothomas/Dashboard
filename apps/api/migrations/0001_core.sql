-- 0001_core: extensions, shared trigger functions, core tables (DATA_MODEL section 1).
-- Forward-only. Runs inside one transaction (runner), as the tradex_owner role.
-- Tables created here receive DML grants for tradex_app through the default privileges set in
-- deploy/db-init/01-roles.sql; tables that must be restricted REVOKE explicitly below.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Shared trigger functions
-- ---------------------------------------------------------------------------

-- Pull cursor for devices (SYNC_DESIGN section 1). One global, monotonic (not gap-free) sequence.
CREATE SEQUENCE sync_seq_global AS bigint START WITH 1 INCREMENT BY 1 NO CYCLE;

CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- Optimistic concurrency counter (ADR-012). Services compare version in their WHERE clause.
CREATE FUNCTION bump_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$;

-- Stamps NEW.sync_seq on insert and update. Attach to tables that carry a sync_seq bigint column.
CREATE FUNCTION assign_sync_seq() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.sync_seq := nextval('sync_seq_global');
  RETURN NEW;
END;
$$;

-- [IMM] tables. TG_ARGV[0] names the lock column (boolean: true = locked; any other type: non-null =
-- locked). Blocks UPDATE and DELETE of a locked row. Attach as:
--   CREATE TRIGGER ... BEFORE UPDATE OR DELETE ON t FOR EACH ROW
--   EXECUTE FUNCTION forbid_update_when_locked('locked_at');
-- SQLSTATE TX423 maps to the RECORD_LOCKED error code in the API.
CREATE FUNCTION forbid_update_when_locked() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  lock_column text := TG_ARGV[0];
  lock_value jsonb;
BEGIN
  IF lock_column IS NULL THEN
    RAISE EXCEPTION 'forbid_update_when_locked requires the lock column name as argument';
  END IF;
  lock_value := to_jsonb(OLD) -> lock_column;
  IF lock_value IS NULL THEN
    RAISE EXCEPTION 'forbid_update_when_locked: column % not found on %', lock_column, TG_TABLE_NAME;
  END IF;
  IF lock_value <> 'null'::jsonb AND lock_value <> 'false'::jsonb THEN
    RAISE EXCEPTION 'RECORD_LOCKED: % row is locked', TG_TABLE_NAME USING ERRCODE = 'TX423';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

-- Append-only tables: blocks UPDATE and DELETE for every role, including the owner.
CREATE FUNCTION forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% not allowed)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'TX403';
END;
$$;

-- ---------------------------------------------------------------------------
-- division (seeded, not user-editable)
-- ---------------------------------------------------------------------------

CREATE TABLE division (
  id          uuid        PRIMARY KEY,
  code        text        NOT NULL UNIQUE CHECK (code IN ('MEAT', 'LOGISTICS')),
  name        text        NOT NULL CHECK (length(btrim(name)) > 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid,
  version     integer     NOT NULL DEFAULT 1
);

CREATE TRIGGER division_set_updated_at BEFORE UPDATE ON division
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER division_bump_version BEFORE UPDATE ON division
  FOR EACH ROW EXECUTE FUNCTION bump_version();

-- Fixed UUID v7 values so every environment and every device agrees on the division ids.
INSERT INTO division (id, code, name) VALUES
  ('01930000-0000-7000-8000-000000000001', 'MEAT', 'Meat'),
  ('01930000-0000-7000-8000-000000000002', 'LOGISTICS', 'Logistics');

-- ---------------------------------------------------------------------------
-- app_setting
-- ---------------------------------------------------------------------------

CREATE TABLE app_setting (
  key         text        PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  value       jsonb       NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid,
  version     integer     NOT NULL DEFAULT 1
);

CREATE TRIGGER app_setting_set_updated_at BEFORE UPDATE ON app_setting
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER app_setting_bump_version BEFORE UPDATE ON app_setting
  FOR EACH ROW EXECUTE FUNCTION bump_version();

INSERT INTO app_setting (key, value) VALUES
  ('tally_stale_hours', '24'::jsonb),
  ('fy_start_month', '4'::jsonb);

-- ---------------------------------------------------------------------------
-- number_sequence: assigned with UPDATE ... RETURNING inside the caller's transaction
-- (gap-free per committed transaction). Hot row, so no version counter.
-- ---------------------------------------------------------------------------

CREATE TABLE number_sequence (
  name         text        NOT NULL CHECK (name ~ '^[A-Z][A-Z0-9_]*$'),
  fiscal_year  integer     NOT NULL CHECK (fiscal_year BETWEEN 2000 AND 2999),
  next_value   bigint      NOT NULL DEFAULT 1 CHECK (next_value >= 1),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (name, fiscal_year)
);

CREATE TRIGGER number_sequence_set_updated_at BEFORE UPDATE ON number_sequence
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- audit_log: append-only (ADR-013). entity_id is text because some entities
-- (app_setting) are keyed by text, not uuid.
-- ---------------------------------------------------------------------------

CREATE TABLE audit_log (
  id              bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at              timestamptz NOT NULL DEFAULT now(),
  actor_user_id   uuid,
  actor_agent_id  uuid,
  device_id       uuid,
  request_id      text,
  action          text        NOT NULL CHECK (length(action) > 0),
  entity_type     text        NOT NULL CHECK (length(entity_type) > 0),
  entity_id       text        NOT NULL CHECK (length(entity_id) > 0),
  before          jsonb,
  after           jsonb,
  ip              inet
);

CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_id, at);
CREATE INDEX audit_log_at_idx ON audit_log (at);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_user_id, at) WHERE actor_user_id IS NOT NULL;

CREATE TRIGGER audit_log_forbid_mutation BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------
-- job (ADR-006): PostgreSQL queue, claimed with FOR UPDATE SKIP LOCKED
-- ---------------------------------------------------------------------------

CREATE TABLE job (
  id            uuid        PRIMARY KEY,
  kind          text        NOT NULL CHECK (length(kind) > 0),
  payload       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  status        text        NOT NULL DEFAULT 'QUEUED'
                CHECK (status IN ('QUEUED', 'RUNNING', 'DONE', 'FAILED', 'DEAD')),
  run_at        timestamptz NOT NULL DEFAULT now(),
  attempts      integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts  integer     NOT NULL DEFAULT 5 CHECK (max_attempts >= 1),
  last_error    text,
  locked_by     text,
  locked_until  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    uuid,
  version       integer     NOT NULL DEFAULT 1
);

CREATE INDEX job_status_run_at_idx ON job (status, run_at);

CREATE TRIGGER job_set_updated_at BEFORE UPDATE ON job
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER job_bump_version BEFORE UPDATE ON job
  FOR EACH ROW EXECUTE FUNCTION bump_version();

-- ---------------------------------------------------------------------------
-- owner_approval: append-only record of protected-operation approvals.
-- kind is a pattern check (not a closed list) so new kinds do not need a column change.
-- ---------------------------------------------------------------------------

CREATE TABLE owner_approval (
  id           uuid        PRIMARY KEY,
  kind         text        NOT NULL CHECK (kind ~ '^[A-Z][A-Z0-9_]*$'),
  subject      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  approved_by  uuid        NOT NULL,
  approved_at  timestamptz NOT NULL DEFAULT now(),
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX owner_approval_kind_idx ON owner_approval (kind, approved_at);

CREATE TRIGGER owner_approval_forbid_mutation BEFORE UPDATE OR DELETE ON owner_approval
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------
-- notification: targeted at one user or at a role. title/body carry the display text.
-- ---------------------------------------------------------------------------

CREATE TABLE notification (
  id           uuid        PRIMARY KEY,
  user_id      uuid,
  target_role  text,
  kind         text        NOT NULL CHECK (kind ~ '^[A-Z][A-Z0-9_]*$'),
  entity_type  text,
  entity_id    text,
  title        text        NOT NULL CHECK (length(btrim(title)) > 0),
  body         text,
  due_at       timestamptz,
  read_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   uuid,
  version      integer     NOT NULL DEFAULT 1,
  CHECK (user_id IS NOT NULL OR target_role IS NOT NULL)
);

CREATE INDEX notification_user_idx ON notification (user_id, read_at, created_at);
CREATE INDEX notification_role_idx ON notification (target_role, read_at, created_at)
  WHERE target_role IS NOT NULL;

CREATE TRIGGER notification_set_updated_at BEFORE UPDATE ON notification
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER notification_bump_version BEFORE UPDATE ON notification
  FOR EACH ROW EXECUTE FUNCTION bump_version();

-- ---------------------------------------------------------------------------
-- Runtime role restrictions (skipped when the role does not exist, e.g. ad-hoc local databases).
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tradex_app') THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM tradex_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON owner_approval FROM tradex_app;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON division FROM tradex_app;
  END IF;
END
$$;
