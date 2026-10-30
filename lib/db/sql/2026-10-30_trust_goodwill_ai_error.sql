-- Schema catch-up for Honest pricing (T1), Goodwill fixes (T2) and
-- AI Error Guarantee (T3). Additive only; safe to run more than once.
--
-- Without the two credit_meter_settings columns every query that reads the
-- meter mode fails ("column confirm_above_credits does not exist"), which
-- empties Admin -> Workspaces and breaks script writing and generation.

ALTER TABLE credit_meter_settings ADD COLUMN IF NOT EXISTS confirm_above_credits integer;
ALTER TABLE credit_meter_settings ADD COLUMN IF NOT EXISTS confirm_above_percent integer;

CREATE TABLE IF NOT EXISTS goodwill_settings (
  id integer PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT true,
  free_image_redos_per_video integer NOT NULL DEFAULT 1,
  free_smart_edit_seconds integer NOT NULL DEFAULT 3,
  monthly_budget_credits integer NOT NULL DEFAULT 50,
  daily_alarm_credits integer NOT NULL DEFAULT 500,
  last_alarm_date text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_error_claims (
  id serial PRIMARY KEY,
  tenant_id integer NOT NULL,
  job_id integer NOT NULL,
  version_id text NOT NULL DEFAULT 'v0',
  category text NOT NULL,
  start_sec real NOT NULL,
  end_sec real NOT NULL,
  video_duration_sec real NOT NULL,
  note text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending',
  auto_approved boolean NOT NULL DEFAULT false,
  suggested_credits real NOT NULL DEFAULT 0,
  credits_refunded real NOT NULL DEFAULT 0,
  decided_by_tenant_id integer,
  decision_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS ai_error_claims_tenant_job ON ai_error_claims (tenant_id, job_id);
CREATE INDEX IF NOT EXISTS ai_error_claims_status_created ON ai_error_claims (status, created_at);
CREATE INDEX IF NOT EXISTS ai_error_claims_tenant_created ON ai_error_claims (tenant_id, created_at);

CREATE TABLE IF NOT EXISTS ai_error_guarantee_settings (
  id integer PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false,
  claim_window_days integer NOT NULL DEFAULT 7,
  auto_approve_per_month integer NOT NULL DEFAULT 2,
  auto_approve_max_percent integer NOT NULL DEFAULT 50,
  updated_at timestamptz NOT NULL DEFAULT now()
);
