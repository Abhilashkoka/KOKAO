---
name: Google Ads paid-media platform
description: Quirks and decisions from adding Google Ads alongside Meta in the draft-and-approve ads engine.
---

# Google Ads module

- The ads engine dispatches by `connection.platform` through a `PlatformOps` interface (readState/update/create/defaultObjective). Add new ad platforms by adding an ops object, never by branching in routes.
- **Google rejects lifetime budgets.** Google Ads campaigns use daily budgets only; the engine throws a 400 before any platform write, and the web draft dialog hides the field for google connections. Keep both sides in sync.
- **Unit mapping:** Google money is in micros; the app stores minor units. Convert with ×/÷10,000 (micros = minor × 10,000 for a 100-subunit currency). Metrics: ctr comes as a fraction (×100 for %), spend = costMicros/1e6 major units, results = conversions.
- **OAuth:** must request `access_type=offline&prompt=consent` or Google won't return a refresh token on re-consent; the callback redirects with `?google=error&reason=no_refresh_token` when that happens and the UI explains removing app access in Google account settings.
- **MCC:** customer listing expands manager accounts to their client accounts; client accounts carry a `loginCustomerId` (the manager) which must be persisted into the connection's encrypted creds and sent as the `login-customer-id` header on every API call. Manager accounts themselves cannot run campaigns and are filtered out of the picker.
- Access tokens are refreshed per call from the stored refresh token (`getGoogleAdsAuth`); `invalid_grant` is an auth error → connection `verifyStatus='failed'` → UI reconnect prompt.
- Dev/test overrides: `GOOGLE_ADS_API_BASE_OVERRIDE`, `GOOGLE_ADS_TOKEN_URL_OVERRIDE`, version via `GOOGLE_ADS_API_VERSION`.
- **Ad group/ad targets:** ad groups have no budget on Google — the money knob is the default max CPC bid, surfaced through the engine's shared `dailyBudget` slot (minor units ↔ micros) so drift/verify/caps all work; the UI labels it "Default CPC bid" for google ad sets. Google ads support status flips only (rename is rejected at draft creation and in the adapter); ad status mutates via `adGroupAds:mutate` with the `{adGroupId}~{adId}` resource name looked up by ad id first.
- Google Ads app credentials (clientId/clientSecret/developerToken) can't be cheaply verified at save time (no app-only endpoint); they're saved as "untested" and effectively verified on the first tenant connect.

**Why:** these mappings/flags are external-API contracts that are invisible in local tests (network is mocked) — breaking them only shows up against the real API.
**How to apply:** when touching `lib/googleAdsApi.ts`, `lib/adsEngine.ts`, or the ads UI's google paths.
