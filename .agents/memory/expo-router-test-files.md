---
name: Expo router bundles test files in app/
description: Mobile publish builds fail when test files land inside the expo-router app/ directory.
---

# Expo Router bundles anything in app/

Any file under the mobile artifact's `app/` directory — including `*.test.tsx` and `__tests__/` — is treated as a route by expo-router and bundled into the production Metro bundle. Test files import vitest → vite, and Metro fails on vite's server-only code, surfacing in the deploy build only as "Bundling failed → Download failed: HTTP 500" with the real error swallowed.

**Why:** merged task tests placed in `app/` broke the publish build even though dev preview, typecheck, and vitest were all green.
**How to apply:** keep all mobile tests outside `app/` (use the artifact's `test/`/`tests/` dirs). To surface the real Metro error, run `expo export --platform ios` directly — the deploy build script hides it.
