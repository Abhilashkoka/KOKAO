---
name: Codegen drift validation
description: Why the codegen-drift validation generates into a temp dir instead of the working tree
---
Rule: validation steps that re-run codegen must NOT write into the working tree.
**Why:** validations run in parallel; orval's clean:true wipes lib/*/src/generated mid-run, making the concurrent typecheck validation fail with 180 "Cannot find module" errors.
**How to apply:** use lib/api-spec/orval.drift.config.ts (output root from DRIFT_OUT_ROOT) to generate into a mktemp mirror (copy custom-fetch.ts so relative mutator imports match), then diff -r against committed dirs. Keep the drift config in sync with orval.config.ts.

**Also:** an upstream task merge can wipe `lib/api-zod/src/generated/types/*` while leaving the barrel index intact (hundreds of TS2307s project-wide). Don't debug — regenerate with `pnpm --filter @workspace/api-spec run codegen` and commit the restored files.
