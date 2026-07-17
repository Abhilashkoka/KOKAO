---
name: Production deploy env shadowing & CORS case bug
description: Why the published app can misbehave — user-set secrets shadow platform vars in production; CORS allowlist must be lowercase.
---

- User-set secrets named `REPLIT_DOMAINS` / `REPLIT_DEV_DOMAIN` / `REPL_ID` exist in this project and hold DEV values (pike.replit.dev). Secrets are global, so in a deployment they shadow the platform-provided production values — breaking CORS allowlists, email/reconnect links, anything built from REPLIT_DOMAINS.
- **Agents cannot delete secrets**: `deleteEnvVars` silently "succeeds" against the env-var store but leaves same-named secrets untouched. Only the user can remove them via the Secrets tab. Always re-check with `viewEnvVars({type:"secret"})` after a delete.
- The Helium DB vars (`DATABASE_URL`, `PG*`) appearing as secrets are platform-managed and swapped for production automatically — leave them alone.
- Browsers always send a lowercase `Origin` header; the published domain contains capitals (SMP-builder-…replit.app). Any origin allowlist built from env must lowercase hostnames (fixed in the CORS origin builder) or production's own origin is silently rejected.
- The api-server prod bundle boots and serves /api/healthz even when the DB is unreachable (startup recovery swallows errors), so a bad DATABASE_URL does NOT fail the deploy health probe.
