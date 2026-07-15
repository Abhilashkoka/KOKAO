---
name: Dead-connection e2e seeding (Accounts page)
description: How to deterministically seed dead Facebook/Instagram/LinkedIn connections so the Accounts page shows its reconnect prompts in a UI/e2e test.
---

# Seeding dead social connections for the Accounts page

The Accounts page auto re-verifies stored credentials on load, which will overwrite
naively-seeded state. To seed a *stable* dead connection for an e2e/UI check:

- **Facebook / Instagram (`verify_status='failed'`)**: set `verified_at = now()`.
  The reverify helpers (`reverifyFacebook`/`reverifyInstagram`) bail out early when
  the row is not stale (`REVERIFY_STALE_MS = 15 min`), so a fresh `verified_at`
  preserves the seeded `failed` state and never makes a live Graph API call.
  `encrypted_credentials` only needs to be non-null (decrypt failures are caught);
  it's never decrypted while the row is fresh.
- **Instagram's own failed prompt requires Facebook `verified`** — the IG card only
  renders its re-enter form when the FB GET returns `verify_status='verified'`.
  So FB-failed and IG-failed cannot be shown in the same page load; seed them in two
  phases (FB failed + LinkedIn expired first, then FB verified + IG failed).
- **LinkedIn expired**: set `access_token` non-null and `token_expires_at` in the
  **past**. `reverifyLinkedin` (now in `lib/socialReverify.ts`, shared with the
  background sweep) does NOT clear the token on timestamp-expiry, so
  `/linkedin/status` reports `expired=true` → "Reconnect needed" pill. NOTE: if the
  seeded row has `verify_status='verified'`, timestamp-expiry now flips it to
  `failed` + fires the breakage notification; seed `verify_status='failed'` if you
  don't want a notification row. (A future/no expiry with a fake token gets cleared
  by the live USERINFO call → "Not connected".)
- **Meta must be app-configured** for the FB/IG cards to render forms at all: insert
  an `app_credentials` row `provider='meta'` with `last_test_status='verified'`
  (`isMetaAppConfigured` only checks that column, doesn't decrypt). Dev usually has
  NO meta row — snapshot/delete it afterward to restore state.

**Why:** the reconnect UI depends on server auto-reverify, so seeding must respect the
staleness gate and per-platform expiry semantics or the prompts won't reproduce.

**How to apply:** target the browser-created tenant by `tenants.email` (the Clerk test
login email is stored on the tenant). Clean up the global meta row + throwaway tenant
after the run.
