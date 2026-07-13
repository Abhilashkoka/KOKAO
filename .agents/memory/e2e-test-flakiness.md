---
name: E2E false failures from mid-test workflow restarts
description: How to recognize and handle Playwright e2e failures caused by environment restarts, not bugs
---

**Rule:** When a runTest e2e failure reports missing toasts/dialogs but data was clearly persisted, check whether the workflows restarted mid-test (log file boot timestamps, "[vite] server connection lost" in browser console) before assuming a code bug.

**Why:** A brand-draft e2e run failed claiming no AI-draft toast and a letter-fallback logo, yet the DB row contained the full drafted payload (logo + colors). All three workflows had restarted during the test, reloading the page and wiping transient UI state. A clean re-run passed fully.

**How to apply:** On a suspicious e2e failure, verify server-side truth first (query the dev DB for the created rows), then correlate workflow log boot times with the test window. If restarts overlapped the test, re-run once before changing code.
