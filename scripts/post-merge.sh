#!/bin/bash
set -e

# Post-merge setup: bring the environment in sync after a task merge.
# Idempotent and non-interactive.

pnpm install

# Apply any database schema changes (dev database only).
pnpm --filter @workspace/db run push-force

# Regenerate API hooks/schemas in case the OpenAPI spec changed.
pnpm --filter @workspace/api-spec run codegen

# Rebuild composite libs so leaf packages see fresh declarations.
pnpm run typecheck:libs
