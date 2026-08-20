-- Prompt Kit: style variants within a flow.
--
-- Dev uses `pnpm --filter @workspace/db run push-force`, which applies this
-- automatically from the schema. This file is the reviewed version for a
-- database that holds real prompt data, where `push` is not a migration story.
--
-- Safe to run on a live database: the column is nullable with no default, so
-- every existing row reads as the flow's BASE case — exactly the behaviour
-- before variants existed. Nothing is rewritten and no table is locked for
-- longer than a catalog update.

BEGIN;

ALTER TABLE prompt_case_types
  ADD COLUMN IF NOT EXISTS variant_key text;

-- At most one ACTIVE case per (flow, variant), so resolution is deterministic.
--
-- Two indexes rather than one: Postgres treats each NULL as distinct in a
-- unique index, so a single (flow_key, variant_key) index would still permit
-- ten active base cases for the same flow. The IS NULL index closes that.
-- Archived cases are exempt so history is retained.
CREATE UNIQUE INDEX IF NOT EXISTS prompt_case_types_flow_base_uniq
  ON prompt_case_types (flow_key)
  WHERE status = 'active' AND variant_key IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS prompt_case_types_flow_variant_uniq
  ON prompt_case_types (flow_key, variant_key)
  WHERE status = 'active' AND variant_key IS NOT NULL;

COMMIT;

-- If the first index fails with a uniqueness violation, the database already
-- holds two active cases bound to the same flow. That was ambiguous before
-- this change too (resolution silently took the lowest id); pick the one you
-- want and archive the other, then re-run:
--
--   SELECT flow_key, count(*), array_agg(slug)
--     FROM prompt_case_types
--    WHERE status = 'active' AND flow_key IS NOT NULL
--    GROUP BY flow_key HAVING count(*) > 1;
--
-- Rollback:
--   DROP INDEX IF EXISTS prompt_case_types_flow_variant_uniq;
--   DROP INDEX IF EXISTS prompt_case_types_flow_base_uniq;
--   ALTER TABLE prompt_case_types DROP COLUMN IF EXISTS variant_key;
