---
name: Validation runner SIGTERMs api-server tests
description: Full-suite completion validation can kill the slow api-server vitest run (exit 143) under parallel load even when it passes standalone.
---
The completion-validation `pnpm run test` step runs all suites in parallel; the api-server suite (~4 min standalone) can be SIGTERM'd (exit status 143) by the runner's wall-clock budget while every other step (typecheck, codegen drift, spec lint, code review) passes.

**Why:** Observed repeatedly (4 consecutive runs) on a frontend-only change; the same api-server suite exited 0 when run standalone. Not fixed by purging test tenants (none leaked).

**How to apply:** If validation fails only on api-server `Exit status 143` with no test failures in the log, verify the suite passes standalone (`pnpm --filter @workspace/api-server run test` with a generous timeout), then use `skip_validation_reason` documenting the verified local pass — don't refactor tests. Also: a concurrent task merge can scramble declaration order in shared files (TDZ errors) and leave the dev DB behind new schema tables (`pnpm --filter @workspace/db run push`).
