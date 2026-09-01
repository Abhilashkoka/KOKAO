---
name: Dynamic voice catalogs
description: Caching rules for provider-backed voice selectors whose credentials and availability change independently of deployments.
---

Provider-backed voice catalogs must be served with `Cache-Control: no-store` and refetched whenever the selection workflow mounts. Built-in voices remain the fail-soft fallback, but a previously empty provider section must not persist in browser or query cache after recovery.

Character Dialogue and Guided Story must share the same normalized voice catalog: built-in voices, available ElevenLabs premade voices, and tenant-owned clones. A Brand Kit is optional; selecting one of its clones is only one voice choice, not a workflow prerequisite. Resolve the submitted catalog ID server-side before funding and freeze the normalized voice metadata into the job so retries never depend on a live catalog or changed Brand Kit.

**Why:** A temporary credential/provider outage returned only built-in voices; the browser retained that valid-but-incomplete response after ElevenLabs recovered, hiding all premade voices without showing an error. Character Dialogue also previously conflated voice selection with Brand Kit selection, incorrectly blocking users who wanted built-in or provider-premade voices.

**How to apply:** Treat voice catalogs as dynamic health/configuration data. Keep tenant-owned clone filtering and submitted-ID validation server-side, preserve a visible provider warning for live failures, and do not use a long stale time or conditional HTTP cache for the combined catalog. New jobs use frozen voice snapshots; only legacy jobs may resolve a Brand Kit voice at render time.