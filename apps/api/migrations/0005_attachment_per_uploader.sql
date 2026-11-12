-- 0005_attachment_per_uploader: attachment dedupe per uploader (WP-04.3 follow-up, owner approved).
-- Forward-only. Runs inside one transaction (runner), as the tradex_owner role.
--
-- Before: sha256 was globally unique, so a second user uploading identical bytes was handed the
-- first user's attachment id (and with it that user's read and link rights). Now each uploader
-- has their own row; rows with the same content share one stored blob (same storage_key).
-- Existing rows are unaffected: each is the only row for its sha256, which satisfies the new key.
ALTER TABLE attachment DROP CONSTRAINT attachment_sha256_key;
ALTER TABLE attachment DROP CONSTRAINT attachment_storage_key_key;
ALTER TABLE attachment ADD CONSTRAINT attachment_sha256_uploader_key UNIQUE (sha256, uploaded_by);
CREATE INDEX attachment_storage_key_idx ON attachment (storage_key);
