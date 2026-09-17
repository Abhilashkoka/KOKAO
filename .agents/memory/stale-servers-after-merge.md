---
name: Stale servers after merges
description: Failed managed workflows can coexist with older compiled servers still serving the preview.
---

A failed workflow reporting EADDRINUSE does not mean the preview is offline or running the latest build.

**Why:** After merges, duplicate API and web startup attempts failed while older processes retained the configured ports. Requests could reach the older compiled code, and the managed workflow logs contained only the duplicate startup failure, not the request's actual error.

**How to apply:** Identify the listening process and verify its working directory before stopping it and restarting the exact managed workflow. Compare request timestamps with the running build, not merely the commit date. Do not infer a specific provider failure from missing request logs.

A successful setup/reconciliation callback is not proof that every service has acquired its intended port.

**Why:** Reconciliation can finish before duplicate servers fail, while Vite silently selects another port or Expo waits for an interactive port-change answer.

**How to apply:** Check service readiness logs after reconciliation. For stale-process conflicts, explicitly stop the affected managed workflows before restarting; that can clean up older process trees which a reconciliation restart left behind. Only terminate remaining processes after verifying ownership.