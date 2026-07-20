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
- Tests mirror ads.test.ts: vi.mock `../lib/linkedinAdsApi` with importOriginal spread, real dev DB, mocks for list/read/create/update/state fns. Every adapter fn touched by routes/engine must be in the mock list or the spread hits the real network.
- **Creatives are create-only** through the engine (org URN → optional image upload → dark post → creative); the creative verify step is status-only because LinkedIn's creative read-back doesn't echo text/image — a read-back failure marks "unverified", not failed.
- Creative image inputs must be tenant-scoped storage paths (`/objects/<tenantId>/...`, 400 otherwise) and landing URLs must be https — validated at draft-create time, not apply time.
- **Location targeting** rides the normal campaign update draft: `targetingLocations` [{urn,name}] validated against `^urn:li:geo:\d+$`, diffed as "Target locations", applied as sorted URNs; geo typeahead endpoint is LinkedIn-only and marks the connection failed on auth errors.
- **Sweep reverify:** "linkedin" is in `AD_SWEEP_PLATFORMS`; its check is refresh-first, then stored-expiry short-circuit, then a cheap ad-account read whose 401s go through the refresh gate (never demote on 401 alone). The refresh module's markFailed/renew paths fire/resolve the deduped `ads_connection_failed` notification themselves.
- **Token refresh:** the ads OAuth callback stores LinkedIn's programmatic refresh token + both expiries in the encrypted credentials; a silent refresher renews access tokens within a 7-day pre-expiry window — proactively from the connection sweep AND on-demand when a connection row is loaded. Only a definitive 400/401 refresh rejection (or an expired/absent refresh token) marks the row failed; transient failures leave the row untouched. Downstream LinkedIn API 401/403s must NOT mark the row failed directly — they go through the auth-failure gate, which forces one refresh attempt first and only demotes on definitive refresh-token death. A successful refresh revives a previously failed row to verified.

**Why:** unit mismatches and silent non-auth 401 handling were the two easiest ways to corrupt drift checks or miss reconnect prompts.
**How to apply:** any new LinkedIn ads surface (creatives, targeting, groups) must convert budgets at the adapter and set authFailed explicitly on token errors.
