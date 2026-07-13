---
name: Stale Clerk session symptom
description: Browser looks signed in but every API call 401s; superadmin nav quietly disappears.
---

The Clerk client can hold a stale/expired dev session: the UI renders the signed-in shell while the server rejects every request with 401. Symptom reported by users as "feature X disappeared" (e.g. superadmin nav links gated on `/me` data).

**Why:** client-side Clerk state and server-side token verification can disagree; React Query then has no `/me` data, so role-gated UI silently vanishes instead of erroring.

**How to apply:** when a user reports a gated feature "disappearing", first check workflow logs for `/api/me` 401s before hunting code regressions. A session guard in `AppLayout` now auto-signs-out on a persistent `/me` 401 (one-shot ref latch), landing the user on the sign-in page. Verify server auth health with the e2e testing subagent (`runTest({testClerkAuth:true, testPlan})` — parameter is `testPlan`, not `plan`).
