---
name: Platform feature kill switches
description: Superadmin per-feature disable across all tenants — enforcement pattern and pitfalls
---

# Platform feature kill switches

Superadmin toggles that disable a feature module for ALL tenants. No DB row = enabled; middleware fails OPEN on DB errors (a broken flags table must never take the app down).

**Rule:** enforcement must cover every path a feature can execute through, not just its main route prefix.
**Why:** first review pass failed because (a) scheduled/background publishing bypassed the connectedAccounts switch (only checked scheduling), and (b) plan changes flow through the general settings endpoint, not just /billing routes.
**How to apply:** when adding a switch, grep for background jobs, retry/resend paths, and cross-cutting endpoints (settings mutations) that touch the feature, and gate each. Frontend hiding (nav, routes, tabs) is UX only — the server 403 `{code:"feature_disabled"}` is the boundary. Admin routes stay ungated so superadmins can always re-enable.
