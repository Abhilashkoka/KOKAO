---
name: React types identity
description: Why @types/react must resolve to one version workspace-wide and how it's enforced
---
Rule: `@types/react` / `@types/react-dom` must resolve to a single version across the whole workspace. They are pinned via `overrides` in `pnpm-workspace.yaml` (^19.2.0), overriding the Expo mobile app's older `~19.1.x` pin.

**Why:** two coexisting `@types/react` versions (Expo dependency graph vs web catalog) give react-day-picker/radix a different React type identity than the web app, producing baffling "Two different types with this name exist" errors in `calendar.tsx` and breaking the web typecheck gate.

**How to apply:** if the web typecheck suddenly fails with unrelated-identical-type errors in UI components, check `ls node_modules/.pnpm | grep '@types+react@'` for duplicates before touching component code. Keep the override in place when bumping Expo; Expo tolerates newer React types.
