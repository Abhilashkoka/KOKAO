---
name: LinkedIn Ads module
description: How LinkedIn paid-media support hangs off the shared ads engine; budget-unit and token quirks.
---

- LinkedIn Ads reuses the shared draft-and-approve ads engine; the adapter is dispatched by `connection.platform` inside the engine — routes never call the adapter directly.
- **Budget units:** LinkedIn REST budgets are MAJOR currency units (strings); KOKAO stores minor units everywhere. The adapter converts ×/÷100 at the boundary — never leak major units into diffs/snapshots.
- LinkedIn campaign creates REQUIRE a campaignGroupId (no default group); Meta's `objective` is Meta-only. The draft-create route validates per platform.
- Campaign groups are draftable too, but create-only and LinkedIn-only (`targetType: campaign_group`, name/status/lifetimeBudget only; no daily budget or schedule). Group creates POST `adAccounts/{id}/adCampaignGroups` with `runSchedule.start=now`; id comes from the `x-restli-id` header. Engine-wide draft types use `AdsDraftTargetType` (= AdsTargetType | campaign_group).
- OAuth reuses the same LinkedIn app creds as organic publishing (`r_ads rw_ads r_ads_reporting`, space-separated scopes); callback lands the connection in `pending_selection` until the tenant picks an ad account.
- `LinkedinAdsApiError` only counts as an auth failure when constructed with `authFailed=true` (third arg) — status 401 alone is not enough for `isAdsAuthError`.
- Tests mirror ads.test.ts: vi.mock `../lib/linkedinAdsApi` with importOriginal spread, real dev DB, mocks for list/read/create/update/state fns.

**Why:** unit mismatches and silent non-auth 401 handling were the two easiest ways to corrupt drift checks or miss reconnect prompts.
**How to apply:** any new LinkedIn ads surface (creatives, targeting, groups) must convert budgets at the adapter and set authFailed explicitly on token errors.
