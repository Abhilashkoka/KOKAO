---
name: Dynamic voice catalogs
description: Caching rules for provider-backed voice selectors whose credentials and availability change independently of deployments.
---

Provider-backed voice catalogs must be served with `Cache-Control: no-store` and refetched whenever the selection workflow mounts. Built-in voices remain the fail-soft fallback, but a previously empty provider section must not persist in browser or query cache after recovery.

**Why:** A temporary credential/provider outage returned only built-in voices; the browser retained that valid-but-incomplete response after ElevenLabs recovered, hiding all premade voices without showing an error.

**How to apply:** Treat voice catalogs as dynamic health/configuration data. Keep tenant-owned clone filtering server-side, preserve a visible provider warning for live failures, and do not use a long stale time or conditional HTTP cache for the combined catalog.