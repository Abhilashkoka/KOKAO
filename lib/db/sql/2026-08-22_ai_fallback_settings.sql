BEGIN;

CREATE TABLE IF NOT EXISTS ai_fallback_settings (
  id integer PRIMARY KEY DEFAULT 1,
  orders jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;