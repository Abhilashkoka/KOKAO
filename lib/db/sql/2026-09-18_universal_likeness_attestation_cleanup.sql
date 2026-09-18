-- Step 2 of 2. Run ONLY after 2026-09-18_universal_likeness_attestation.sql
-- and after scripts/src/backfill-likeness-recipients.mjs has reported every
-- legacy grant migrated into character_likeness_recipient_disclosures.
--
-- Recipients are no longer grant columns. They live in the append-only
-- disclosure ledger so that adding a provider never invalidates a statement
-- about the person depicted.

ALTER TABLE character_likeness_consent_grants
  DROP COLUMN IF EXISTS providers;
ALTER TABLE character_likeness_consent_grants
  DROP COLUMN IF EXISTS image_processor_scope;
