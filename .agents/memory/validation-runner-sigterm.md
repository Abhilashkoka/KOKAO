---
name: Validation resource contention
description: Parallel checks can exhaust validation budgets or delay Preview startup even when the code passes independently.
---
The completion-validation `pnpm run test` step runs all suites in parallel; the api-server suite (~4 min standalone) can be SIGTERM'd (exit status 143) by the runner's wall-clock budget while every other step (typecheck, codegen drift, spec lint, code review) passes.

**Why:** Observed repeatedly (4 consecutive runs) on a frontend-only change; the same api-server suite exited 0 when run standalone. Not fixed by purging test tenants (none leaked).

**How to apply:** If validation fails only on api-server `Exit status 143` with no test failures in the log, verify the suite passes standalone (`pnpm --filter @workspace/api-server run test` with a generous timeout), then use `skip_validation_reason` documenting the verified local pass — don't refactor tests. Also: a concurrent task merge can scramble declaration order in shared files (TDZ errors) and leave the dev DB behind new schema tables (`pnpm --filter @workspace/db run push`).

Also seen: the full `pnpm run test` validation step can hit POLL_BUDGET_EXCEEDED (1800 polls) twice in a row while all other steps pass. Same remedy — run the touched suites locally, then markTaskComplete with skip_validation_reason citing the local runs.

Heavy shared-library regeneration/typechecking can also delay the frontend's build-before-preview startup enough to trigger a port timeout.

**Why:** The frontend timed out while compilers were busy, then built and served normally after those checks finished, without any source or port-configuration change.

**How to apply:** Distinguish an unfinished build from an actual port mismatch or code error. Finish resource-heavy checks before retrying the managed frontend workflow; avoid changing working startup commands just to bypass contention.

Startup failures can also appear as a Vitest fork-worker handshake timeout or an isolated test-database schema setup timeout, followed by misleading “No test files found” output.

**Why:** A full validation run hit both startup timeouts while mobile/web tests passed; the affected client package and repaired API tests passed separately.

**How to apply:** Inspect the first failure, distinguish setup timeouts from assertions, and verify affected packages separately. Never disable database isolation or reuse Preview data to make setup pass. Audit any completion-validation skip with the exact timeout and separate checks that passed.
