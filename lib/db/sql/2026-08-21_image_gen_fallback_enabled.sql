-- Image generation: make fallback behavior explicit and safe for existing
-- deployments. Existing selections retain the historical fallback-enabled
-- behavior; new rows also default to it.

BEGIN;

ALTER TABLE image_gen_settings
  ADD COLUMN IF NOT EXISTS fallback_enabled boolean NOT NULL DEFAULT true;

COMMIT;