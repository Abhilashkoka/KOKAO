---
name: Hoisted @types/react clash
description: Why libraries without an @types/react peer break web typecheck when mobile pins an older @types/react, and the packageExtensions fix.
---

The workspace intentionally carries two `@types/react` versions: the catalog (`^19.2.x`) for web apps and the Expo mobile app's pinned `~19.1.x`. Libraries that ship bundled `.d.ts` files but do NOT declare `@types/react` as a peerDependency (react-day-picker, lucide-react) resolve React types from pnpm's hoisted fallback `node_modules/.pnpm/node_modules/@types/react` — which may be the mobile 19.1.x copy — producing "Two different types with this name exist, but they are unrelated" (`VoidOrUndefinedOnly`, `CSSProperties`) errors in web typechecks.

**Fix:** add a `packageExtensions` entry in `pnpm-workspace.yaml` giving the library an optional `@types/react: '*'` peer, so pnpm links each consumer's own `@types/react` into the library's virtual store tree. Then `pnpm install`.

**How to apply:** if a web artifact's typecheck fails with duplicate/unrelated React types pointing at `@types+react@19.1.x` in the error, identify the peerless library in the error path and extend the existing `packageExtensions` block — don't add global `overrides` (the mobile app needs its pinned version) and don't `@ts-ignore`.
