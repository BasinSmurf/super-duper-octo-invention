-- WI-04: per-unit evidence pushes to VaultPRO (BlueLion) asynchronously.
--
-- ServicePRO keeps its own copy and remains the immediate read path; the push
-- is a background errand. That is a deliberate change from a Vault-first model:
-- a tech photographing a cracked regulator must not wait on, or be blocked by,
-- an integration two networks away.
--
-- The push cannot happen until the unit has a Vault identity to hang the
-- document on, which is what the `asset` queue rows resolve. Attachments for a
-- unit with no resolved assetId stay pending and are retried -- that is the
-- normal early state, not an error.
ALTER TYPE "BlueLionEntityType" ADD VALUE 'attachment';

ALTER TABLE "attachments" ADD COLUMN "bluelion_doc_id" TEXT;
ALTER TABLE "attachments" ADD COLUMN "bluelion_synced_at" TIMESTAMP(3);
