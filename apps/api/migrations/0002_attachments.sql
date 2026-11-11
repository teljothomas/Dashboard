-- 0002_attachments: attachment and attachment_link (DATA_MODEL section 1, SECURITY section 5).
-- Forward-only. Runs inside one transaction (runner), as the tradex_owner role.
-- tradex_app receives DML through the default privileges set in deploy/db-init/01-roles.sql.

-- One row per distinct stored file. sha256 is the hash of the bytes as stored (after image
-- re-encode), so a re-upload of the same content returns the existing row (unique sha256).
-- scanned_ok is true once the upload passed magic-byte sniffing, image re-encode or the PDF
-- structure checks; there is no antivirus engine behind it. Files are never served unless true.
CREATE TABLE attachment (
  id            uuid        PRIMARY KEY,
  sha256        char(64)    NOT NULL UNIQUE CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  mime          text        NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  size_bytes    bigint      NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 10485760),
  storage_key   text        NOT NULL UNIQUE,
  original_name text        NOT NULL CHECK (length(original_name) BETWEEN 1 AND 255),
  uploaded_by   uuid        NOT NULL,
  device_id     uuid,
  scanned_ok    boolean     NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX attachment_uploaded_by_idx ON attachment (uploaded_by, created_at);

-- Links an attachment to a business record. Unique per (attachment, entity): linking again is a
-- no-op when the role matches. entity_id is text because some entities use non-uuid keys.
CREATE TABLE attachment_link (
  attachment_id uuid        NOT NULL REFERENCES attachment (id) ON DELETE RESTRICT,
  entity_type   text        NOT NULL CHECK (entity_type ~ '^[a-z][a-z0-9_]*$'),
  entity_id     text        NOT NULL CHECK (length(entity_id) BETWEEN 1 AND 128),
  role          text        NOT NULL CHECK (role IN ('BILL', 'PROOF', 'DOC', 'PHOTO')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid,
  PRIMARY KEY (attachment_id, entity_type, entity_id)
);

CREATE INDEX attachment_link_entity_idx ON attachment_link (entity_type, entity_id);
