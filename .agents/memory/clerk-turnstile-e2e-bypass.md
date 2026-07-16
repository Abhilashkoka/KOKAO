---
name: Clerk Turnstile CAPTCHA bypass for automated sign-up tests
description: How to get an automated browser through Clerk's Cloudflare Turnstile bot protection on sign-up.
---

Clerk dev instances show an interactive Cloudflare Turnstile CAPTCHA on sign-up that silently stalls all automated runs (headless Playwright AND the runTest subagent — this is why "testing-infrastructure timeouts" occur: clerk-js never sends the sign_ups POST until the widget solves).

**Working bypass (Playwright):**
1. Mint a testing token: `POST https://api.clerk.com/v1/testing_tokens` with `CLERK_SECRET_KEY` bearer.
2. `page.route` all Clerk FAPI (`*.clerk.accounts.dev`) `/v1/*` requests and append `__clerk_testing_token=<token>` (what @clerk/testing does).
3. That alone is NOT enough — the environment response still advertises the real Turnstile sitekey, so clerk-js still renders the widget. Additionally intercept `/v1/environment`, rewrite `display_config.captcha_public_key` and `captcha_public_key_invisible` to Cloudflare's always-pass test key `1x00000000000000000000AA` and set `captcha_widget_type: "invisible"`. The dummy captcha token is accepted server-side because the testing token is active.
4. Sign up with `<x>+clerk_test@example.com`, verification code 424242.

**Other pitfalls hit:**
- Playwright's downloaded chromium fails on NixOS (missing libglib); install Nix `chromium` via system deps and pass `executablePath`.
- Expo web keeps prior screens mounted, so `getByPlaceholder(...)` matches twice — use `.last()`; list-item clicks may need `{ force: true }` (scroll container intercepts pointer events).
- A working script lives at `.local/mobile-e2e.mjs` (full sign-up → Studio caption → save → Library edit → Accounts flow).
- Delete test Clerk users + their tenants/content rows after runs.

**Sign-IN bot protection (needs_client_trust):** a password sign-in from a brand-new automated browser client returns `status: needs_client_trust` even with a valid testing token (`captcha_bypass` stays false), the env-sitekey rewrite, and an API-version downgrade — the password verifies but the sign-in never completes, and the app's custom flow surfaces "Additional verification is required." Bypass: establish client trust the way real returning users do — sign UP in the same browser session first (with the sign-up bypass above), then sign out; subsequent sign-ins on that client complete normally. Also: creating a user via the backend API leaves the email unverified — PATCH `/v1/email_addresses/{id}` `{verified:true}` if you need it. Working sign-in harness: `.local/mobile-signin-e2e.mjs`.
