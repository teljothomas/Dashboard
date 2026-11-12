-- 0006_tally_mirror: Tally connector and read-only mirror (DATA_MODEL section 4, SYNC_DESIGN 4-5),
-- plus a minimal `party` table (DATA_MODEL section 6) that Phase 06 will extend.
-- Forward-only. Runs inside one transaction (runner), as the tradex_owner role.
-- tradex_app receives DML through the default privileges set in deploy/db-init/01-roles.sql.
--
-- The WP text calls this migration 0005; 0005 is attachment_per_uploader, so it is 0006.
-- Local additions to DATA_MODEL (see docs/TASK_LOG.md): tally_voucher.content_hash (ALTERID is NOT
-- VERIFIED, TALLY_INTEGRATION section 8, so unchanged vouchers are detected by hash), *_name columns on
-- ledger and stock lines (Tally exports carry names, not guids), import_batch.stream RECON for
-- recon-snapshot idempotency, nullable alter ids.

-- ---------------------------------------------------------------------------
-- tally_company: the expected identity of one Tally company (BR-020)
-- ---------------------------------------------------------------------------

CREATE TABLE tally_company (
  id                     uuid        PRIMARY KEY,
  display_name           text        NOT NULL CHECK (length(btrim(display_name)) > 0),
  tally_name             text        NOT NULL CHECK (length(btrim(tally_name)) > 0),
  company_number         text        NOT NULL DEFAULT '',
  books_from             date        NOT NULL,
  tally_guid             text,
  fy_start_month         smallint    NOT NULL DEFAULT 4 CHECK (fy_start_month BETWEEN 1 AND 12),
  -- sha256(normalised name|number|books_from|guid-if-available), hex
  fingerprint            char(64)    NOT NULL UNIQUE CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  is_test                boolean     NOT NULL DEFAULT false,
  posting_mode           text        NOT NULL DEFAULT 'DISABLED'
                         CHECK (posting_mode IN ('DISABLED', 'TEST_ONLY', 'PRODUCTION')),
  production_approval_id uuid        REFERENCES owner_approval (id) ON DELETE RESTRICT,
  created_at             timestamptz NOT NULL DEFAULT now(),
  created_by             uuid        REFERENCES app_user (id) ON DELETE RESTRICT,
  updated_at             timestamptz NOT NULL DEFAULT now(),
  updated_by             uuid        REFERENCES app_user (id) ON DELETE RESTRICT,
  version                integer     NOT NULL DEFAULT 1,
  CONSTRAINT tally_company_production_needs_approval CHECK (
    posting_mode <> 'PRODUCTION' OR production_approval_id IS NOT NULL
  )
);

CREATE TRIGGER tally_company_set_updated_at BEFORE UPDATE ON tally_company
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER tally_company_bump_version BEFORE UPDATE ON tally_company
  FOR EACH ROW EXECUTE FUNCTION bump_version();

-- ---------------------------------------------------------------------------
-- Connector: registration code, agent, lease, heartbeat, nonce (SECURITY section 1 agent row)
-- ---------------------------------------------------------------------------

-- Created before the code table so used_by_agent_id can reference it.
CREATE TABLE connector_agent (
  id                  uuid        PRIMARY KEY,
  company_id          uuid        NOT NULL REFERENCES tally_company (id) ON DELETE RESTRICT,
  machine_name        text        NOT NULL CHECK (length(btrim(machine_name)) BETWEEN 1 AND 200),
  machine_fingerprint text        NOT NULL CHECK (length(machine_fingerprint) BETWEEN 8 AND 256),
  public_key          text        NOT NULL CHECK (length(public_key) BETWEEN 80 AND 2000),
  agent_version       text        NOT NULL CHECK (length(agent_version) BETWEEN 1 AND 64),
  status              text        NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVOKED')),
  registered_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz,
  last_status         jsonb,
  revoked_at          timestamptz,
  revoked_by          uuid        REFERENCES app_user (id) ON DELETE RESTRICT,
  CONSTRAINT connector_agent_revoked_complete CHECK (
    (status = 'ACTIVE' AND revoked_at IS NULL) OR (status = 'REVOKED' AND revoked_at IS NOT NULL)
  )
);

CREATE INDEX connector_agent_company_idx ON connector_agent (company_id, status);

-- One-time, 15 minute code. Only the sha256 is stored; the code is shown to the admin once.
CREATE TABLE connector_registration_code (
  id                uuid        PRIMARY KEY,
  company_id        uuid        NOT NULL REFERENCES tally_company (id) ON DELETE RESTRICT,
  code_hash         char(64)    NOT NULL UNIQUE CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  expires_at        timestamptz NOT NULL,
  used_at           timestamptz,
  used_by_agent_id  uuid        REFERENCES connector_agent (id) ON DELETE RESTRICT,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid        NOT NULL REFERENCES app_user (id) ON DELETE RESTRICT,
  CONSTRAINT connector_code_used_complete CHECK (
    (used_at IS NULL AND used_by_agent_id IS NULL) OR (used_at IS NOT NULL AND used_by_agent_id IS NOT NULL)
  )
);

CREATE INDEX connector_registration_code_company_idx ON connector_registration_code (company_id, created_at);

-- One row per company, never deleted: the epoch only ever grows, so a stale agent can never match a
-- fresh lease. Release and revoke expire the row instead (SYNC_DESIGN section 4).
CREATE TABLE connector_lease (
  company_id   uuid        PRIMARY KEY REFERENCES tally_company (id) ON DELETE RESTRICT,
  agent_id     uuid        NOT NULL REFERENCES connector_agent (id) ON DELETE RESTRICT,
  epoch        bigint      NOT NULL CHECK (epoch >= 1),
  acquired_at  timestamptz NOT NULL DEFAULT now(),
  renewed_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL
);

-- Retention 30 days (purged opportunistically by the heartbeat path).
CREATE TABLE connector_heartbeat (
  id               bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agent_id         uuid        NOT NULL REFERENCES connector_agent (id) ON DELETE RESTRICT,
  at               timestamptz NOT NULL DEFAULT now(),
  tally_reachable  boolean     NOT NULL,
  company_match    boolean     NOT NULL,
  tally_version    text        CHECK (tally_version IS NULL OR length(tally_version) <= 64),
  local_queue      integer     NOT NULL DEFAULT 0 CHECK (local_queue >= 0),
  error            text        CHECK (error IS NULL OR length(error) <= 2000)
);

CREATE INDEX connector_heartbeat_agent_idx ON connector_heartbeat (agent_id, at DESC);
CREATE INDEX connector_heartbeat_at_idx ON connector_heartbeat (at);

-- Replay guard: unique per agent, purged after 10 minutes (the timestamp window is 5).
CREATE TABLE connector_nonce (
  agent_id  uuid        NOT NULL REFERENCES connector_agent (id) ON DELETE CASCADE,
  nonce     uuid        NOT NULL,
  at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, nonce)
);

CREATE INDEX connector_nonce_at_idx ON connector_nonce (at);

-- ---------------------------------------------------------------------------
-- Import bookkeeping: watermarks and batches (SYNC_DESIGN section 5)
-- ---------------------------------------------------------------------------

CREATE TABLE sync_watermark (
  company_id           uuid        NOT NULL REFERENCES tally_company (id) ON DELETE RESTRICT,
  stream               text        NOT NULL CHECK (stream IN ('MASTERS', 'VOUCHERS', 'BALANCES')),
  last_alter_id        bigint      NOT NULL DEFAULT 0 CHECK (last_alter_id >= 0),
  last_success_at      timestamptz,
  last_full_recon_at   timestamptz,
  PRIMARY KEY (company_id, stream)
);

-- id is the agent's batch uuid: the idempotency key. payload_sha256 detects a reused id with different
-- content. A batch is applied in the same transaction that inserts it, so RECEIVED and REJECTED exist
-- for future use (Phase 05.5 journal) and a batch row normally lands as APPLIED.
CREATE TABLE import_batch (
  id              uuid        PRIMARY KEY,
  company_id      uuid        NOT NULL REFERENCES tally_company (id) ON DELETE RESTRICT,
  agent_id        uuid        NOT NULL REFERENCES connector_agent (id) ON DELETE RESTRICT,
  epoch           bigint      NOT NULL CHECK (epoch >= 1),
  stream          text        NOT NULL CHECK (stream IN ('MASTERS', 'VOUCHERS', 'BALANCES', 'RECON')),
  from_alter_id   bigint      CHECK (from_alter_id IS NULL OR from_alter_id >= 0),
  to_alter_id     bigint      CHECK (to_alter_id IS NULL OR to_alter_id >= 0),
  record_count    integer     NOT NULL CHECK (record_count >= 0),
  payload_sha256  char(64)    NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  status          text        NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED', 'APPLIED', 'REJECTED')),
  error           text        CHECK (error IS NULL OR length(error) <= 2000),
  result_summary  jsonb,
  received_at     timestamptz NOT NULL DEFAULT now(),
  applied_at      timestamptz,
  CONSTRAINT import_batch_applied_complete CHECK (status <> 'APPLIED' OR applied_at IS NOT NULL)
);

CREATE INDEX import_batch_company_idx ON import_batch (company_id, received_at DESC);

-- ---------------------------------------------------------------------------
-- [TALLY] masters. Written only by the import pipeline; never deleted (archived_in_tally).
-- ---------------------------------------------------------------------------

CREATE TABLE tally_group (
  id                    uuid        PRIMARY KEY,
  company_id            uuid        NOT NULL REFERENCES tally_company (id) ON DELETE RESTRICT,
  guid                  text        NOT NULL CHECK (length(guid) BETWEEN 1 AND 128),
  name                  text        NOT NULL CHECK (length(btrim(name)) > 0),
  parent                text,
  alter_id              bigint      CHECK (alter_id IS NULL OR alter_id >= 0),
  archived_in_tally     boolean     NOT NULL DEFAULT false,
  last_import_batch_id  uuid        REFERENCES import_batch (id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, guid)
);

CREATE TABLE tally_ledger (
  id                    uuid        PRIMARY KEY,
  company_id            uuid        NOT NULL REFERENCES tally_company (id) ON DELETE RESTRICT,
  guid                  text        NOT NULL CHECK (length(guid) BETWEEN 1 AND 128),
  name                  text        NOT NULL CHECK (length(btrim(name)) > 0),
  parent_group          text,
  is_party              boolean     NOT NULL DEFAULT false,
  gstin                 text        CHECK (gstin IS NULL OR length(gstin) <= 32),
  alter_id              bigint      CHECK (alter_id IS NULL OR alter_id >= 0),
  opening_balance       numeric(18,2),
  archived_in_tally     boolean     NOT NULL DEFAULT false,
  last_import_batch_id  uuid        REFERENCES import_batch (id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, guid)
);

CREATE INDEX tally_ledger_name_idx ON tally_ledger (company_id, lower(name));

CREATE TABLE tally_stock_item (
  id                    uuid        PRIMARY KEY,
  company_id            uuid        NOT NULL REFERENCES tally_company (id) ON DELETE RESTRICT,
  guid                  text        NOT NULL CHECK (length(guid) BETWEEN 1 AND 128),
  name                  text        NOT NULL CHECK (length(btrim(name)) > 0),
  parent                text,
  unit_name             text,
  alter_id              bigint      CHECK (alter_id IS NULL OR alter_id >= 0),
  archived_in_tally     boolean     NOT NULL DEFAULT false,
  last_import_batch_id  uuid        REFERENCES import_batch (id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, guid)
);

CREATE INDEX tally_stock_item_name_idx ON tally_stock_item (company_id, lower(name));

CREATE TABLE tally_unit (
  id                    uuid        PRIMARY KEY,
  company_id            uuid        NOT NULL REFERENCES tally_company (id) ON DELETE RESTRICT,
  guid                  text        NOT NULL CHECK (length(guid) BETWEEN 1 AND 128),
  name                  text        NOT NULL CHECK (length(btrim(name)) > 0),
  alter_id              bigint      CHECK (alter_id IS NULL OR alter_id >= 0),
  archived_in_tally     boolean     NOT NULL DEFAULT false,
  last_import_batch_id  uuid        REFERENCES import_batch (id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, guid)
);

CREATE TABLE tally_voucher_type (
  id                    uuid        PRIMARY KEY,
  company_id            uuid        NOT NULL REFERENCES tally_company (id) ON DELETE RESTRICT,
  guid                  text        NOT NULL CHECK (length(guid) BETWEEN 1 AND 128),
  name                  text        NOT NULL CHECK (length(btrim(name)) > 0),
  parent                text,
  alter_id              bigint      CHECK (alter_id IS NULL OR alter_id >= 0),
  archived_in_tally     boolean     NOT NULL DEFAULT false,
  last_import_batch_id  uuid        REFERENCES import_batch (id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, guid)
);

CREATE TABLE tally_cost_centre (
  id                    uuid        PRIMARY KEY,
  company_id            uuid        NOT NULL REFERENCES tally_company (id) ON DELETE RESTRICT,
  guid                  text        NOT NULL CHECK (length(guid) BETWEEN 1 AND 128),
  name                  text        NOT NULL CHECK (length(btrim(name)) > 0),
  parent                text,
  alter_id              bigint      CHECK (alter_id IS NULL OR alter_id >= 0),
  archived_in_tally     boolean     NOT NULL DEFAULT false,
  last_import_batch_id  uuid        REFERENCES import_batch (id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, guid)
);

-- ---------------------------------------------------------------------------
-- [TALLY] vouchers and lines
-- ---------------------------------------------------------------------------

CREATE TABLE tally_voucher (
  id                    uuid        PRIMARY KEY,
  company_id            uuid        NOT NULL REFERENCES tally_company (id) ON DELETE RESTRICT,
  guid                  text        NOT NULL CHECK (length(guid) BETWEEN 1 AND 128),
  master_id             bigint,
  alter_id              bigint      CHECK (alter_id IS NULL OR alter_id >= 0),
  voucher_type_name     text        NOT NULL CHECK (length(btrim(voucher_type_name)) > 0),
  base_type             text        NOT NULL CHECK (base_type IN
                          ('SALES', 'PURCHASE', 'RECEIPT', 'PAYMENT', 'JOURNAL', 'CONTRA',
                           'CREDIT_NOTE', 'DEBIT_NOTE', 'OTHER')),
  voucher_number        text        NOT NULL DEFAULT '',
  voucher_date          date        NOT NULL,
  reference             text,
  party_ledger_name     text,
  party_ledger_guid     text,
  narration             text,
  amount                numeric(18,2) NOT NULL,
  is_cancelled          boolean     NOT NULL DEFAULT false,
  is_deleted_in_tally   boolean     NOT NULL DEFAULT false,
  -- uuid parsed from a `[ERP:<uuid>]` marker in the narration (ADR-031)
  erp_event_id          uuid,
  -- sha256 of the canonical imported content: an unchanged re-export is a no-op (no ALTERID needed)
  content_hash          char(64)    NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  last_import_batch_id  uuid        REFERENCES import_batch (id) ON DELETE RESTRICT,
  imported_at           timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, guid)
);

CREATE INDEX tally_voucher_date_idx ON tally_voucher (company_id, voucher_date, id);
CREATE INDEX tally_voucher_type_idx ON tally_voucher (company_id, base_type, voucher_date);
CREATE INDEX tally_voucher_erp_event_idx ON tally_voucher (erp_event_id) WHERE erp_event_id IS NOT NULL;

CREATE TABLE tally_voucher_ledger_line (
  id             uuid          PRIMARY KEY,
  voucher_id     uuid          NOT NULL REFERENCES tally_voucher (id) ON DELETE RESTRICT,
  line_no        integer       NOT NULL CHECK (line_no >= 1),
  ledger_name    text          NOT NULL CHECK (length(btrim(ledger_name)) > 0),
  ledger_guid    text,
  amount         numeric(18,2) NOT NULL,
  is_party       boolean       NOT NULL DEFAULT false,
  cost_centres   jsonb         NOT NULL DEFAULT '[]'::jsonb,
  UNIQUE (voucher_id, line_no)
);

CREATE TABLE tally_voucher_inventory_line (
  id               uuid          PRIMARY KEY,
  voucher_id       uuid          NOT NULL REFERENCES tally_voucher (id) ON DELETE RESTRICT,
  line_no          integer       NOT NULL CHECK (line_no >= 1),
  stock_item_name  text          NOT NULL CHECK (length(btrim(stock_item_name)) > 0),
  stock_item_guid  text,
  qty              numeric(14,3) NOT NULL,
  uom              text,
  rate             numeric(18,4),
  amount           numeric(18,2) NOT NULL,
  batch_name       text,
  godown           text,
  UNIQUE (voucher_id, line_no)
);

-- Cash, bank and party closing balances. Sign convention is confirmed in WP-05.7 (section 8 item d).
CREATE TABLE tally_balance_snapshot (
  id                    uuid          PRIMARY KEY,
  company_id            uuid          NOT NULL REFERENCES tally_company (id) ON DELETE RESTRICT,
  ledger_name           text          NOT NULL CHECK (length(btrim(ledger_name)) > 0),
  ledger_guid           text,
  as_of                 date          NOT NULL,
  closing_balance       numeric(18,2) NOT NULL,
  last_import_batch_id  uuid          REFERENCES import_batch (id) ON DELETE RESTRICT,
  imported_at           timestamptz   NOT NULL DEFAULT now(),
  UNIQUE (company_id, ledger_name, as_of)
);

-- ---------------------------------------------------------------------------
-- party (DATA_MODEL section 6, minimal): created here because Phase 06 has not run. Tally party
-- ledgers upsert into it on import. Phase 06 adds sync_seq registration, phone, address and edits.
-- ---------------------------------------------------------------------------

CREATE TABLE party (
  id                uuid        PRIMARY KEY,
  name              text        NOT NULL CHECK (length(btrim(name)) > 0),
  kinds             text[]      NOT NULL DEFAULT '{}'
                    CHECK (kinds <@ ARRAY['CUSTOMER', 'SUPPLIER', 'TRANSPORT_CUSTOMER', 'LENDER', 'LESSOR', 'VENDOR']::text[]),
  phone             text,
  gstin             text        CHECK (gstin IS NULL OR length(gstin) <= 32),
  address           text,
  tally_ledger_guid text        UNIQUE,
  source            text        NOT NULL CHECK (source IN ('TALLY', 'ERP')),
  archived_at       timestamptz,
  sync_seq          bigint,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid        REFERENCES app_user (id) ON DELETE RESTRICT,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid        REFERENCES app_user (id) ON DELETE RESTRICT,
  version           integer     NOT NULL DEFAULT 1
);

CREATE INDEX party_name_idx ON party (lower(name));
CREATE INDEX party_sync_seq_idx ON party (sync_seq);

CREATE TRIGGER party_set_updated_at BEFORE UPDATE ON party
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER party_bump_version BEFORE UPDATE ON party
  FOR EACH ROW EXECUTE FUNCTION bump_version();
CREATE TRIGGER party_assign_sync_seq BEFORE INSERT OR UPDATE ON party
  FOR EACH ROW EXECUTE FUNCTION assign_sync_seq();

-- ---------------------------------------------------------------------------
-- Runtime role restrictions: imported records are never physically deleted by the application
-- (flags only). Voucher lines are replaced when a voucher changes, so they keep DELETE.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tradex_app') THEN
    REVOKE DELETE, TRUNCATE ON
      tally_company, connector_agent, connector_registration_code, connector_lease, import_batch,
      tally_group, tally_ledger, tally_stock_item, tally_unit, tally_voucher_type, tally_cost_centre,
      tally_voucher, tally_balance_snapshot
    FROM tradex_app;
    REVOKE TRUNCATE ON tally_voucher_ledger_line, tally_voucher_inventory_line FROM tradex_app;
  END IF;
END
$$;
