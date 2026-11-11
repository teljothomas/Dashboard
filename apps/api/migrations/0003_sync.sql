-- 0003_sync: device sync server tables (DATA_MODEL section 3, SYNC_DESIGN section 2).
-- Forward-only. Runs inside one transaction (runner), as the tradex_owner role.
-- tradex_app receives DML through the default privileges set in deploy/db-init/01-roles.sql.
--
-- device_id and user_id are plain uuids here: the device and user tables arrive in Phase 04 and
-- WP-04.1 adds the foreign keys.

-- One row per processed device mutation. Replaying a known mutation_id returns result_body
-- (idempotent replay, SYNC_DESIGN 2.1). payload_hash (sha256 of the canonical mutation) detects a
-- reused mutation_id with different content. Only final results are stored; BLOCKED_BY_PREVIOUS and
-- DUPLICATE_SUSPECTED are transient and the client may resend, so they are not.
CREATE TABLE client_mutation (
  mutation_id       uuid        PRIMARY KEY,
  device_id         uuid        NOT NULL,
  user_id           uuid        NOT NULL,
  entity_type       text        NOT NULL CHECK (entity_type ~ '^[a-z][a-z0-9_]*$'),
  entity_id         uuid        NOT NULL,
  op                text        NOT NULL CHECK (op IN ('CREATE', 'UPDATE', 'SUBMIT', 'CANCEL')),
  base_version      integer     CHECK (base_version IS NULL OR base_version >= 0),
  payload_hash      char(64)    NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  client_created_at timestamptz NOT NULL,
  received_at       timestamptz NOT NULL DEFAULT now(),
  result            text        NOT NULL CHECK (result IN ('APPLIED', 'CONFLICT', 'REJECTED')),
  result_body       jsonb       NOT NULL
);

CREATE INDEX client_mutation_entity_idx ON client_mutation (entity_type, entity_id, received_at);
CREATE INDEX client_mutation_device_idx ON client_mutation (device_id, received_at);

-- A mutation the server could not apply without losing someone's data. Both sides are preserved
-- (client_payload and server_snapshot) until the record owner or an approver resolves it.
-- Ids are server-generated uuid v7 (time ordered, used as the list cursor).
CREATE TABLE sync_conflict (
  id               uuid        PRIMARY KEY,
  mutation_id      uuid        NOT NULL UNIQUE REFERENCES client_mutation (mutation_id) ON DELETE RESTRICT,
  entity_type      text        NOT NULL CHECK (entity_type ~ '^[a-z][a-z0-9_]*$'),
  entity_id        uuid        NOT NULL,
  op               text        NOT NULL CHECK (op IN ('CREATE', 'UPDATE', 'SUBMIT', 'CANCEL')),
  device_id        uuid        NOT NULL,
  user_id          uuid        NOT NULL,
  base_version     integer     CHECK (base_version IS NULL OR base_version >= 0),
  server_version   integer     CHECK (server_version IS NULL OR server_version >= 0),
  reason           text        NOT NULL CHECK (length(reason) BETWEEN 1 AND 64),
  client_payload   jsonb       NOT NULL,
  server_snapshot  jsonb,
  status           text        NOT NULL DEFAULT 'OPEN' CHECK (status IN
                     ('OPEN', 'RESOLVED_KEEP_SERVER', 'RESOLVED_APPLY_CLIENT', 'RESOLVED_MERGED')),
  resolved_by      uuid,
  resolved_at      timestamptz,
  resolved_values  jsonb,
  note             text        CHECK (note IS NULL OR length(note) <= 2000),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sync_conflict_resolution_complete CHECK (
    (status = 'OPEN' AND resolved_by IS NULL AND resolved_at IS NULL)
    OR (status <> 'OPEN' AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL)
  )
);

CREATE INDEX sync_conflict_user_status_idx ON sync_conflict (user_id, status, id);
CREATE INDEX sync_conflict_status_idx ON sync_conflict (status, id);
CREATE INDEX sync_conflict_entity_idx ON sync_conflict (entity_type, entity_id);
