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
- TikTok Ads: same engine via a per-platform ops dispatch keyed on the connection's platform; the OAuth token response itself lists the granted advertiser ids (store them; validate any later selection against that list). Campaign schedules (start/stop) live on AD GROUPS, not campaigns — campaign drafts must reject schedule fields. Auth-failed = HTTP 401 or business codes 40101/40102/40104/40105/40001. Budgets in minor units like Meta.
- **How to apply:** any new ads platform or target type must reuse this engine — add an adapter, not a new pipeline. Tests: mock only the adapter network fns; keep engine + DB real (see `routes/ads.test.ts`).

## TikTok ad group schedules
- TikTok schedules live on ad groups only (campaigns have none; ads have neither schedule nor budget).
- Adapter normalizes TikTok's "YYYY-MM-DD HH:MM:SS" UTC times to ISO Z (tiktokTimeToIso/isoToTiktokTime); epoch/empty placeholders map to null; SCHEDULE_FROM_NOW means no end time.
- adgroup/update/ requires a COMPLETE schedule: when a draft proposes only one side, the adapter reads the current ad group and fills the other side before writing.
- readAdGroupState now returns the real schedule, so unmanaged schedule drift DOES expire drafts — that guard was lifted deliberately when schedule editing shipped.
