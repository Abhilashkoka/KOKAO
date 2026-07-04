# SocialForge — Final Audit Memo
Date: 2026-07-03 · Consolidates the security review and the /lessismore restraint pass into one prioritized plan. Ordering is deliberate: **production-blocking risk first, then security, then maintainability, then simplification.** Every claim was verified first-hand against the code; assumptions are labeled.

---

## Verdict

SocialForge is a well-built, single-product multi-tenant AI social-content SaaS (Express 5 API + React 19 SPA + Postgres/Drizzle + Clerk). The core security model is sound — consistent tenant scoping, authenticated encryption at rest, a thorough SSRF guard, live-verified superadmin gating, no SQL injection or server-side XSS, no real secrets in source. It is **not yet safe to deploy** as-is: one cross-tenant data-exposure bug and a Replit-prototype CORS/config posture must be closed first. None of the blockers are large; most of the remaining work is deletion and consolidation.

---

## PART 1 — Must fix before deployment (production-blocking)

These four gate the launch. All are small.

**B1 — Private object reads have no ownership check (High, cross-tenant data exposure).**
`api-server/src/routes/storage.ts:92` streams any existing object to any authenticated tenant. The ACL engine that should stop it (`lib/objectAcl.ts`) is dead code — `canAccessObject` has no caller — and `imagePath` is stored as free-form `string().nullish()`, so object paths are attacker-influenceable, not merely secret. Result: a leaked/guessed path is a reliable cross-tenant read of private uploads (brand assets, generated images). *Fix (least-code): mint keys as `/objects/uploads/<tenantId>/<uuid>` and reject reads whose prefix ≠ `req.tenantId`; then delete `objectAcl.ts`.* Closes the hole and removes an abstraction in one move.

**B2 — Wildcard credentialed CORS (High, contingent).**
`api-server/src/app.ts:38` — `cors({ credentials: true, origin: true })`. Confirmed the app is **cookie-authed** (no `setAuthTokenGetter` call anywhere → same-origin Clerk `__session` cookie is the auth). This reflects any origin with credentials; the only remaining defense is the cookie's `SameSite`. *Fix: allowlist origins from `REPLIT_DOMAINS` + the prod domain.* **Validate the prod `__session` SameSite value** — it decides whether B2 is live today or merely latent. Fix regardless.

**B3 — Replit dev-defaults that silently weaken prod (Medium→High if misconfigured).**
The Clerk proxy is a no-op unless `NODE_ENV=production` **and** `CLERK_SECRET_KEY` is set (`clerkProxyMiddleware.ts:57,62`). If either env var is wrong in the deployment, auth proxying disables itself quietly. *Fix: fail loud (crash on boot) when running in a deployed context without the required Clerk env, rather than degrading silently.* Add a startup env-var assertion for the full required set (`DATABASE_URL`, `SESSION_SECRET`, `CLERK_*`, `PUBLIC_OBJECT_SEARCH_PATHS`, `PRIVATE_OBJECT_DIR`).

**B4 — No rate limiting, no security headers (Medium).**
No `express-rate-limit`, no `helmet` in the chain. `/ai/summarize-url` (server-side URL fetch), image generation, and credential-verify endpoints (each calls out to Meta/X) are per-request unthrottled — cost-abuse and third-party-reputation risk. *Fix: `helmet()` + a global limiter with tight buckets on `/ai/*`, `/social-credentials/*`, and OAuth routes.* Small, standard, and cheap insurance for a public launch.

---

## PART 2 — Security hardening (soon after launch)

**S1 — Encryption key coupled to `SESSION_SECRET`.** `secretCrypto.ts:13` derives the AES-256-GCM key as `SHA256(SESSION_SECRET)` — the same secret that signs OAuth state — and the ciphertext format is unversioned. Rotating the session secret silently bricks every stored social credential. *Fix: dedicated `CREDENTIALS_ENCRYPTION_KEY`; version-prefix payloads (`v1:…`) for staged rotation.* Crypto primitives themselves are correct (authenticated, random IV, fail-closed).

**S2 — Hardcoded superadmin email.** `superadmins.ts:12` compiles in `abhilash.koka1@gmail.com` as a standing admin in every deployment. The gate around it is strong (live verified-email recheck, owner-only grants, fail-closed), but a repo/export leak names the privileged account and ownership transfer needs a redeploy. *Fix: move entirely to `SUPERADMIN_EMAILS` env.*

**S3 — `trust proxy` unset while trusting `x-forwarded-*`.** The code reads forwarded headers manually (`clerkProxyMiddleware.ts`, `credentials.ts:146`, `twitter.ts:37`); safe only while the Replit/Cloud Run edge is always in front and strips inbound forwarded headers. **Validate** the edge behavior; set `trust proxy` appropriately.

**S4 — Pre-auth public object streamer.** `storage.ts:29` serves anything under `PUBLIC_OBJECT_SEARCH_PATHS` unauthenticated — safe only while that env names a genuinely public prefix. *Fix: document the invariant; assert resolved paths stay within an intended sub-prefix.*

**Verified clean (both the security pass and this consolidation):** SQL injection (Drizzle parameterized), server-side XSS (React escaping; the one `dangerouslySetInnerHTML` is in a dead component), SSRF (thorough IPv4/IPv6 guard, manual redirect re-validation, body cap, fail-closed), OAuth CSRF & open redirect (HMAC-signed, tenant-bound, TTL'd, timing-safe state; fixed relative redirects), insecure deserialization, command injection, path traversal, hardcoded app secrets (matches are test fixtures), client bundle (only public `VITE_CLERK_*` exposed).

---

## PART 3 — Replit-export risk register (the theme you asked to emphasize)

| Risk | Where | Prototype-acceptable? | Prod action |
|---|---|---|---|
| Silent auth-proxy no-op on env mismatch | `clerkProxyMiddleware.ts:57,62` | Yes | **B3** — fail loud + boot-time env assertion |
| Env-var assumptions undocumented / unenforced | `objectStorage.ts:44,63` (throw-on-missing, but late) | Yes | Assert all required env at boot, not on first request |
| Wildcard CORS from a same-origin prototype | `app.ts:38` | Yes | **B2** — allowlist |
| Standing hardcoded admin email | `superadmins.ts:12` | Yes | **S2** — env-only |
| Committed pnpm store + `dist/` + `.tsbuildinfo` in export | `.local/share/pnpm/`, `lib/*/dist/` | Yes | Remove from repo/export; gitignore. Widens exposure (source, internal paths) |
| Client-side `/admin` route renders for any signed-in user | `App.tsx:132` | Yes (UI only) | Acceptable — every `/api/admin/*` is server-enforced 403; leave, or gate UI for polish |
| Scheduling implies a capability that doesn't exist | `scheduledPosts` (no executor) | Yes | Decide: build cron executor **or** relabel UI "planning only" before users trust it |
| Object-storage auth via Replit sidecar only | `objectStorage.ts:12` | Yes | Fine on Replit; a non-Replit target needs a real GCS credential strategy |

Client-side exposure check came back clean: only the public Clerk publishable key reaches the browser. The dangerous prototype residue is server-side config posture (B2/B3) and the shipped scaffolding, not leaked frontend secrets.

---

## PART 4 — Maintainability (post-launch, reduces cost of every future change)

The single highest-leverage refactor: **collapse the four copy-pasted platform stacks behind one adapter.** Meta/LinkedIn/Twitter credentials + OAuth + publish + reverify are ~2,900 route lines of the same shape repeated four times (`linkedin.ts` 678, `meta.ts` 595, `credentials.ts` 588, `twitter.ts` 484, `twitterApi.ts` ~600). Define `interface SocialPlatform { getAuthUrl?, verifyCredentials, publish, reverify }`, implement one file per platform, and make routes thin. Adding a platform becomes one file instead of a 600-line stack. Alongside it: extract `lib/oauthState.ts` (state sign/verify is duplicated verbatim in `twitter.ts:58` and `linkedin.ts:42`) and split `credentials.ts` by trust level (superadmin app-keys vs. tenant tokens — they should not share a file).

On the frontend, the five oversized pages (`admin.tsx` 1109, `accounts.tsx` 1033, `brand-kits.tsx` 749, `studio.tsx` 617, `library.tsx` 533) each mix data-fetching, dialogs, cards, and status logic. Reduce to route shells plus extracted components, and factor the 5 near-identical publish dialogs and 4 credential cards into shared `PublishDialog`/`CredentialCard`. Do these when you next touch each page, not as a big-bang rewrite.

---

## PART 5 — Simplification / deletion (do freely; mostly zero-risk)

Pure removals, no behavior change:
- `artifacts/mockup-sandbox/` — an entire unreferenced showcase app.
- ~40+ unused shadcn `ui/*` components (verified: app code imports ~21; the rest — carousel, menubar, chart, sidebar, command, input-otp, drawer, resizable, pagination, breadcrumb, … — are dead). Deletes the one live `dangerouslySetInnerHTML` (`ui/chart.tsx`) as a bonus.
- `scripts/src/hello.ts` scaffold.
- `.local/share/pnpm/`, all `lib/*/dist/`, all `*.tsbuildinfo` — build output/committed store; gitignore.
- `lib/objectAcl.ts` — once B1 is fixed the prefix way (it's the abstraction B1 replaces).

Rename for clarity when convenient (validate Replit tooling references first): `artifacts/` → `apps/`, `socialforge` → `web`, `api-server` → `api`.

Redefine the notification subsystem's scope: it carries a full catalog/policy/preference/resolution layer for **one** event type. Keep the dispatch choke point; don't grow the abstraction until a second event type actually exists.

---

## PART 6 — Docs

Promote `replit.md` into a real `README.md`. It's accurate but lives in a Replit-only filename and has one material gap: it lists Instagram/Facebook/LinkedIn/YouTube but omits the ~1,300 lines of shipped **X/Twitter** integration. The README should state, plainly: what the app is, the four supported platforms (including X), the full required-env list, and what's deferred — especially that **scheduling records but does not execute**, and that billing is manual.

---

## One-page action order

**Before deploy:** B1 (object authz + delete objectAcl) → B2 (CORS allowlist + validate SameSite) → B3 (fail-loud env assertions) → B4 (helmet + rate limit). Plus the zero-risk deletions in Part 5 (they shrink the export you're about to ship).

**Week 1–2 after:** S1 (dedicated encryption key) → S2 (admin email to env) → S3/S4 (proxy + public-path validation) → README.

**Ongoing:** platform adapter + `oauthState` extraction → split oversized pages/routes as touched → decide scheduling's product truth.

Assumptions to confirm before signing off: prod serves SPA+API same-origin; `__session` SameSite value; the Replit edge strips inbound `x-forwarded-*`; production value of `PUBLIC_OBJECT_SEARCH_PATHS`.
