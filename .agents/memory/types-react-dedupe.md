---
name: '@types/react dedupe'
description: Why duplicated @types/react versions break the web typecheck and how they are kept deduped
---
Rule: keep exactly one `@types/react`/`@types/react-dom` version in the workspace, enforced by pnpm-workspace.yaml `overrides` (pinned to the catalog range).

**Why:** packages without their own `@types/react` dependency (e.g. react-day-picker) resolve React types from pnpm's hidden hoisted store `node_modules/.pnpm/node_modules/@types/react`. If another workspace package (mobile pinned `~19.1`) causes an older copy to win the hoist, tsc sees two unrelated `@types/react` instances and fails with "Two different types with this name exist" in components mixing that lib with radix/shadcn.

**How to apply:** if a typecheck fails with dual-@types/react errors, check `ls node_modules/.pnpm | grep '@types+react@'` and `readlink node_modules/.pnpm/node_modules/@types/react`; fix by keeping the workspace override in sync with the catalog rather than patching component types.
