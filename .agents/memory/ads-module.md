---
name: Paid media / Meta Ads module
description: Draft-and-approve safety engine for ad platform writes; owner-only approval; Meta Ads adapter patterns.
---

# Ads module (paid media)

- Every ad-platform write goes through the draft-and-approve pipeline in `adsEngine` — never call the Meta Ads adapter directly from routes. **Why:** ads spend real money; the safety model (diff preview, owner approval, drift expiry, verification, append-only log) is the product guarantee.
- Apply pipeline order: in-process lock → status-guarded draft→approved claim → re-read remote state and compare with the draft's `beforeSnapshot` (mismatch = EXPIRED, never applied) → platform write → read-back verification (`verified`/`mismatch`/`unverified`) → append-only change log (best-effort). Replaying an approved draft returns its final state without a second platform write.
- Approval is OWNER-only at the route (`req.memberRole === "owner"`); admins/members can create drafts but never apply. Module has a global superadmin switch (`adsSettingsTable`, no row = enabled; toggles audited as `ads_module_toggled`).
- Duplicate draft creation is blocked by a per-tenant idempotency key (409 returns the existing draft).
- Graph state reads are per-target-type: campaigns/ad sets/ads each have a distinct readable field list (ads have no budgets, ad sets no stop_time) — requesting a field an object lacks fails the whole read. Ad sets use `end_time`, not `stop_time`, so ad set schedule edits are deliberately unsupported. Ad drafts allow only name/status; ad set drafts name/status/budgets.
- Meta Ads: budgets are in minor units; OAuth scope `ads_management,ads_read,business_management`; short-lived tokens exchanged for long-lived at callback; auth failures (`MetaAdsApiError.authFailed`) flip the connection to failed for a reconnect prompt.
- **How to apply:** any new ads platform or target type must reuse this engine — add an adapter, not a new pipeline. Tests: mock only the adapter network fns; keep engine + DB real (see `routes/ads.test.ts`).
