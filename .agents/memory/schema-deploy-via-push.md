---
name: Schema deploys via push
description: How database schema changes reach dev and production in this project (no migration files).
---
This repo intentionally has NO migration files or migration runner.
**Why:** Replit-managed PostgreSQL applies schema changes automatically: `scripts/post-merge.sh` runs `pnpm --filter @workspace/db run push-force` for the dev DB, and Replit's Publish flow diffs the dev schema against production and applies it (the database skill explicitly forbids hand-written prod migration scripts).
**How to apply:** When adding columns, give them `NOT NULL DEFAULT ...` (or nullable) so the push is safe on populated tables. If a code review rejects a schema change for "missing migration," cite this mechanism and request a fresh review.
