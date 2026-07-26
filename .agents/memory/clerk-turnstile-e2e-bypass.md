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
- Expo web registers a service worker that issues the Clerk FAPI requests — `context.route` never fires unless the context is created with `serviceWorkers: "block"`.
- The `/v1/environment` request is a POST with `_method=PATCH` (not GET); the sitekey-rewrite interception must match ANY method or the real Turnstile key slips through and sign-up stalls silently.
- Playwright's downloaded chromium fails on NixOS (missing libglib); install Nix `chromium` via system deps and pass `executablePath`.
- Expo web keeps prior screens mounted, so `getByPlaceholder(...)` matches twice — use `.last()`; list-item clicks may need `{ force: true }` (scroll container intercepts pointer events).
- Harness scripts under `.local/` do NOT persist across task environments — rewrite from this recipe each time (latest pattern: sign-up bypass, seed via pg from lib/db, client-side nav only; auth screen link text is "Create an account", not "Sign up").
- Delete test Clerk users + their tenants/content rows after runs.

**Sign-in UX for needs_client_trust:** the mobile sign-in screen now falls back to the email-code first factor (`signIn.emailCode.sendCode()`/`verifyCode`) when password sign-in ends at `needs_client_trust` or `needs_first_factor` — email code IS accepted even while status is needs_client_trust and completes the sign-in. Note @clerk/expo 3.7.5 types omit `needs_client_trust` from `SignInStatus` in the resolved shared version the app sees; compare via `signIn.status as string`. E2E: `.local/mobile-signin-e2e.mjs` (create user via backend API + PATCH email verified:true, sign in from a fresh context, code 424242).

**Web needs_client_trust is already handled:** Clerk's prebuilt `<SignIn>` (used by the web auth page) natively routes `needs_client_trust` to a `/sign-in/client-trust` email-code step and completes the session — verified empirically on a fresh browser client; no custom fallback needed on web (only custom flows like mobile's need one). Web harness: `.local/web-signin-e2e.mjs` (backend-created verified user, testing token + env sitekey rewrite, use `button.cl-formButtonPrimary` not text "Continue" — that matches Continue-with-Google; type OTP via focusing `input[data-input-otp]`).

**Sign-IN bot protection (needs_client_trust):** a password sign-in from a brand-new automated browser client returns `status: needs_client_trust` even with a valid testing token (`captcha_bypass` stays false), the env-sitekey rewrite, and an API-version downgrade — the password verifies but the sign-in never completes, and the app's custom flow surfaces "Additional verification is required." Bypass: establish client trust the way real returning users do — sign UP in the same browser session first (with the sign-up bypass above), then sign out; subsequent sign-ins on that client complete normally. Also: creating a user via the backend API leaves the email unverified — PATCH `/v1/email_addresses/{id}` `{verified:true}` if you need it. Working sign-in harness: `.local/mobile-signin-e2e.mjs`.

## Expo/mobile CORS origins
- Dev: REPLIT_DOMAINS excludes the Expo dev domain; the API CORS allowlist must include REPLIT_EXPO_DEV_DOMAIN.
- Production: the mobile build's public domain comes from REPLIT_INTERNAL_APP_DOMAIN (may include a scheme, not guaranteed to be in REPLIT_DOMAINS); buildAllowedOrigins includes it defensively, scheme-normalized. Live production CORS is still unverified until the first publish.

**When the testing subagent is unavailable** (`Unknown config kind: testing` despite the validator listing it — happens under heavy parallel task load), the DIY Playwright harness works end-to-end: Nix chromium executablePath, sign-UP a fresh `+clerk_test` user (OTP 424242) with the testing-token + sitekey-rewrite routes, then grant powers via direct DB flags (e.g. `tenants.is_superadmin=true`). Authed API calls can be made from the page via `page.evaluate(fetch(...， credentials:'include'))`. Import pg via the pnpm store path; root `node_modules/playwright` imports fine.
