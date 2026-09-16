-- Additive migration: server-authored, append-only asset origin records.
-- This migration intentionally creates only asset_provenance and its indexes.
CREATE TABLE IF NOT EXISTS asset_provenance (
  id serial PRIMARY KEY,
  tenant_id integer NOT NULL,
  asset_kind text NOT NULL,
  source_kind text NOT NULL,
  character_id integer,
  outfit_id integer,
  role_id text,
  operation_identity text NOT NULL,
  provider text,
  model text,
  provider_request_id text,
  provider_operation_id integer,
  artifact_path text NOT NULL,
  artifact_sha256 text NOT NULL,
  parent_path text,
  parent_sha256 text,
  input_ancestry jsonb NOT NULL,
  succeeded_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS asset_provenance_tenant_idx
  ON asset_provenance (tenant_id);
CREATE INDEX IF NOT EXISTS asset_provenance_character_idx
  ON asset_provenance (tenant_id, character_id);
CREATE INDEX IF NOT EXISTS asset_provenance_artifact_idx
  ON asset_provenance (tenant_id, artifact_path);
CREATE UNIQUE INDEX IF NOT EXISTS asset_provenance_operation_kind_uniq
  ON asset_provenance (tenant_id, asset_kind, operation_identity);