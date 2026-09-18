-- Additive migration: universal, provider-independent likeness attestation.
--
-- Step 1 of 2. This file only ADDS columns and tables. It does not drop the
-- legacy providers/image_processor_scope columns, so a deploy that rolls back
-- keeps working. Run scripts/src/backfill-likeness-recipients.mjs after this,
-- then 2026-09-18_universal_likeness_attestation_cleanup.sql.

-- The subject class describes who is depicted. Existing rows are all uploaded
-- personal sources, split by the subject they already recorded.
ALTER TABLE character_likeness_consent_grants
  ADD COLUMN IF NOT EXISTS subject_class text;

UPDATE character_likeness_consent_grants
   SET subject_class = CASE
         WHEN subject = 'authorized_person' THEN 'uploaded_authorized_person'
         ELSE 'uploaded_self'
       END
 WHERE subject_class IS NULL;

ALTER TABLE character_likeness_consent_grants
  ALTER COLUMN subject_class SET NOT NULL;

-- Video depiction becomes a use scope of its own, separate from wardrobe edits
-- and from scripted speech. Existing grants that permitted scripted speech had
-- already authorized being depicted in video, so they inherit it; grants that
-- did not are left at false and re-ask on next use.
ALTER TABLE character_likeness_consent_grants
  ADD COLUMN IF NOT EXISTS allow_video_depiction boolean NOT NULL DEFAULT false;

UPDATE character_likeness_consent_grants
   SET allow_video_depiction = true
 WHERE allow_scripted_speech = true;

CREATE TABLE IF NOT EXISTS character_likeness_recipient_disclosures (
  id serial PRIMARY KEY,
  tenant_id integer NOT NULL,
  character_id integer NOT NULL,
  consent_id integer NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  operation text NOT NULL,
  scope_label text NOT NULL,
  acting_clerk_user_id text NOT NULL,
  acknowledged_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS character_likeness_recipient_disclosure_uniq
  ON character_likeness_recipient_disclosures
     (tenant_id, consent_id, provider, model, operation);
CREATE INDEX IF NOT EXISTS character_likeness_recipient_disclosure_character_idx
  ON character_likeness_recipient_disclosures
     (tenant_id, character_id, acknowledged_at);

CREATE TABLE IF NOT EXISTS character_likeness_recipient_revocations (
  id serial PRIMARY KEY,
  tenant_id integer NOT NULL,
  character_id integer NOT NULL,
  disclosure_id integer NOT NULL,
  acting_clerk_user_id text NOT NULL,
  revoked_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS character_likeness_recipient_revocation_uniq
  ON character_likeness_recipient_revocations (disclosure_id);
CREATE INDEX IF NOT EXISTS character_likeness_recipient_revocation_character_idx
  ON character_likeness_recipient_revocations (tenant_id, character_id, revoked_at);

CREATE TABLE IF NOT EXISTS tenant_likeness_standing_declarations (
  id serial PRIMARY KEY,
  tenant_id integer NOT NULL,
  policy_version text NOT NULL,
  statement text NOT NULL,
  fictional_only_confirmed boolean NOT NULL,
  adult_confirmed boolean NOT NULL,
  no_real_person_confirmed boolean NOT NULL,
  acting_clerk_user_id text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tenant_likeness_standing_declaration_idx
  ON tenant_likeness_standing_declarations (tenant_id, granted_at);

-- The legacy policy_version welded the attestation to whichever image provider
-- the admin had selected, by hashing the processor scope into the version
-- string. Strip that suffix so an unrelated routing change stops marking every
-- grant stale. The date prefix is preserved verbatim.
UPDATE character_likeness_consent_grants
   SET policy_version = split_part(policy_version, ':image-processors:', 1)
 WHERE policy_version LIKE '%:image-processors:%';
