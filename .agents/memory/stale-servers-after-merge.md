---
name: Stale servers after merges
description: Failed managed workflows can coexist with older compiled servers still serving the preview.
---

A failed workflow reporting EADDRINUSE does not mean the preview is offline or running the latest build.

**Why:** After merges, duplicate API and web startup attempts failed while older processes retained the configured ports. Requests could reach the older compiled code, and the managed workflow logs contained only the duplicate startup failure, not the request's actual error.

**How to apply:** Identify the listening process and verify its working directory before stopping it and restarting the exact managed workflow. Compare request timestamps with the running build, not merely the commit date. Do not infer a specific provider failure from missing request logs.