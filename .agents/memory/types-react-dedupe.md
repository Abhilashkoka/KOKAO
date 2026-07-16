---
name: '@types/react dedupe'
description: Why duplicated @types/react versions break the web typecheck and how they are kept deduped
---
Rule: keep exactly one `@types/react`/`@types/react-dom` version in the workspace, enforced by pnpm-workspace.yaml `overrides` AND catalog, and that version must be the ~19.1 range that Expo/react-native require.

**Why:** packages without their own `@types/react` dependency (e.g. react-day-picker) resolve React types from pnpm's hidden hoisted store. Two versions → tsc sees two unrelated `@types/react` instances and the WEB typecheck fails with "Two different types with this name exist". But deduping upward to 19.2 breaks the MOBILE typecheck instead: @types/react 19.2 makes react-native/expo class components (Image, BlurView, NativeTabs) invalid JSX element types. So the single workspace version must stay on ~19.1 until Expo/RN support 19.2.

**How to apply:** if a typecheck fails with dual-@types/react errors, check `ls node_modules/.pnpm | grep '@types+react@'`; fix in pnpm-workspace.yaml (catalog + overrides pinned to ~19.1.x) then `pnpm install`. Node_modules can be stale relative to the lockfile — a plain `pnpm install` may change resolution without any lockfile diff. Never patch component types per-site.
