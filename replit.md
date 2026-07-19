# KOKAO

KOKAO (internal codename SocialForge; code packages keep the `@workspace/socialforge` name — do not rename) is a multi-tenant SaaS web app for AI-powered social media content: on-brand captions and images, a content library, brand kits, post scheduling, and social account connections (Instagram/Facebook/LinkedIn/YouTube/X/Threads). Built to scale to 5K-20K users with per-tenant subscription quotas.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — API server
- `pnpm --filter @workspace/socialforge run dev` — web frontend
- `pnpm run typecheck` — full typecheck; `pnpm run build` — typecheck + build
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks/Zod from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env (asserted at boot in production by `lib/assertEnv.ts`): `DATABASE_URL`, `SESSION_SECRET`, Clerk keys (`CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `VITE_CLERK_PUBLISHABLE_KEY`), object storage vars, OpenAI via integration proxy. Optional: `SUPERADMIN_EMAILS`, `CREDENTIALS_ENCRYPTION_KEY` (falls back to `SESSION_SECRET`), `LINKEDIN_CLIENT_ID`/`LINKEDIN_CLIENT_SECRET`, SendGrid connector.

## Stack

pnpm workspaces, Node.js 24, TypeScript 5.9. API: Express 5. DB: PostgreSQL + Drizzle. Validation: Zod (`zod/v4`) + `drizzle-zod`. Codegen: Orval from OpenAPI. Auth: Replit-managed Clerk (cookie sessions on web). Frontend: React 19 + Vite + wouter + TanStack Query + shadcn/ui. AI: OpenAI via Replit AI proxy. Build: esbuild (CJS).

## Where things live

- API contract (source of truth): `lib/api-spec/openapi.yaml` — edit, then run codegen. Generated hooks/schemas: `lib/api-client-react/src/generated/` (import via `@workspace/api-client-react`).
- DB schema (source of truth): `lib/db/src/schema/`.
- API routes: `artifacts/api-server/src/routes/`; server libs: `artifacts/api-server/src/lib/`; frontend: `artifacts/socialforge/src/`; admin UI: `src/pages/admin/`.
- Tenant provisioning: `middlewares/requireTenant.ts` (also does team-invite auto-accept).
- Brand kits: payload type `lib/db/src/schema/brandKitPayload.ts` (versioned JSON, source of truth; edit = new activated version). Server helpers `lib/brandKit/`. Routes `routes/{brandKits,brandPreferences,onboarding}.ts` are SESSION-scoped — NO tenantId in URLs (IDOR avoidance); scope every query by `req.tenantId`.
- Plans/quotas: `lib/plans.ts` (async DB-backed catalog: `plan_settings` rows override `DEFAULT_PLANS`, 30s cache; `getPlanLimits` is async — await it), `lib/usage.ts`. Superadmin plan editor: `/admin/plans` routes in `routes/admin.ts` ("free" is the undeletable signup fallback; in-use plans can't be deleted; -1 = unlimited; prices in PAISE).
- Superadmin: allowlist `lib/superadmins.ts`, DB flag `tenants.isSuperadmin`, gate `middlewares/requireSuperadmin.ts`, routes `routes/admin.ts`, live verified-email helper `lib/clerkUser.ts`. Admin actions are audited via `recordAdminAction` (append-only `admin_audit_logs`, best-effort).
- Notifications: catalog `lib/notificationCatalog.ts`; effective-setting resolution `lib/notificationSettings.ts` (global superadmin policy `notification_policies` folds with tenant `notification_preferences`; team members get MEMBER-scoped rows in `member_notification_preferences`). Dispatch choke point `lib/notifications.ts` consults `getEffectiveSetting` before writing/emailing; email via SendGrid connector (`lib/email.ts`, best-effort, no-ops when unconnected). Policy authority is enforced SERVER-SIDE; never trust the client.
- OAuth state (shared): `lib/oauthState.ts` — HMAC-signed, tenant-bound, TTL'd state used by X/LinkedIn/Threads; do not re-implement per platform.
- Social credentials: encryption `lib/secretCrypto.ts` (AES-256-GCM; encrypt with `CREDENTIALS_ENCRYPTION_KEY` when set, decrypt dual-reads with `SESSION_SECRET` fallback; `v1:`-prefixed payloads). App-level creds in `app_credentials` (Meta/LinkedIn/Threads/Razorpay/provider keys); tenant creds on `connectedAccounts` (`encryptedCredentials`/`verifyStatus`). Credential CRUD `routes/credentials.ts`; publishing `routes/{meta,linkedin,twitter,threads}.ts`. Platform secrets go in headers/POST body, never URLs.
- App branding (white-label): singleton `lib/db/src/schema/appBrandSettings.ts` (nullable = KOKAO default). `GET /app-brand` is PUBLIC; writes superadmin-only (`routes/appBrand.ts`). Frontend `src/lib/brand.tsx`, editor `src/pages/app-branding.tsx`.
- Team add-on: schema `lib/db/src/schema/team.ts` + `tenants.seatLimit` + `planSettings.teamSeats`; server lib `lib/team.ts` (effective limit = tenant.seatLimit ?? plan.teamSeats, 0 = off; seats = owner + members + pending invites); routes `routes/team.ts` gated by `middlewares/requireWorkspaceAdmin.ts`. CAUTION: with members, `req.tenantId` can be another user's workspace — never write owner-identity tenant columns unless `req.memberRole === "owner"`.
- Design skill (2-step image prompt design pass): `lib/designSkill.ts` + `skills/canvasDesign.ts`; global switch `design_skill_settings`, per-tenant override `tenants.designSkillEnabled` (null = follow global); fails soft to the plain prompt.
- Image generation providers: `lib/imageGen/` (openaiBuiltin | gemini | bfl | stability | replicate | openaiCompatible); selection singleton `imageGenSettings`. Keys encrypted in `app_credentials` `imagegen_<id>` (DB key wins over env secret; clients only see `keySource`). Custom provider is SSRF-guarded.
- ASR (voice notes): `lib/asr/` (groq default | openaiWhisper | deepgram | assemblyai); selection `asrSettings`; keys in `app_credentials` `asr_<id>` (same DB-wins pattern). `POST /ai/transcribe` is unmetered.
- Taste memory (style learning): `lib/tasteMemory.ts` + `tasteProfiles` table (jsonb per tenant, SELECT FOR UPDATE writes); signals fired from publish/schedule/save hooks; soft AI guidance only — brand rules and the explicit prompt always win.
- Billing (Razorpay): schema `lib/db/src/schema/billing.ts` (subscriptions with `billingCycle` monthly|yearly, credit packs/balances/ledger, `razorpay_events` webhook idempotency) + `planSettings.priceInr`/`priceInrYearly` (+ Razorpay plan ids; yearly = 12-month total in PAISE, requires a monthly price, saving mints a yearly Razorpay Plan). Client `lib/razorpay.ts` (encrypted creds row, HMAC verification). Credits `lib/credits.ts` (transactional, idempotent per order id; ledger records the APPLIED delta so it reconciles with balance). Tenant routes `routes/billing.ts` — all writes OWNER-only; verify paths re-fetch the canonical Razorpay entity and require final paid/active status, never trusting the browser. Webhook `routes/razorpayWebhook.ts` is PUBLIC, signature-gated on rawBody, event-deduped; lapse downgrades to free only after the paid period end. Admin plan override (`tenants.planOverriddenAt`) blocks webhook plan sync until the tenant's own billing action clears it. UI: `components/billing-settings.tsx` (Monthly/Yearly pill toggle), admin `plans-tab.tsx`.
- Analytics (consent-gated): schema `lib/db/src/schema/analytics.ts`; server lib `lib/analytics.ts`; ingest `routes/analyticsIngest.ts` is PUBLIC but consent is enforced SERVER-SIDE from STORED consent (no consent = batch dropped; category opt-outs null gated columns; anonymous senders get lifecycle events only). Reports `routes/analytics.ts` (superadmin platform-wide, owner/admin own tenant, members 403). Trackers: web `src/lib/analytics.ts`, mobile `artifacts/mobile/lib/analytics.ts` (GPS only with precise opt-in; coarse location is server geo-IP).
- Paid media / Meta Ads: schema `lib/db/src/schema/ads.ts`; adapter `lib/metaAdsApi.ts`; draft-and-approve engine `lib/adsEngine.ts` (owner-only approve, idempotency key, drift expiry, read-back verify, append-only `ads_change_logs`); routes `routes/ads.ts` (OAuth callback public); global switch `ads_settings` (no row = enabled, superadmin-only, audited); tenant UI `src/pages/ads.tsx` (`/ads`). All platform writes go through the engine — never call the adapter from routes.
- Connection sweep: `lib/connectionSweep.ts` — periodic in-process reverify of tenants' social connections, with capped fail-streak tracking and superadmin alerts.

## Architecture decisions

- Multi-tenancy without Clerk orgs: each `clerkUserId` is its own tenant, auto-provisioned on first authenticated request by `requireTenant`.
- Auth is gated ONCE in `routes/index.ts`: public routers first, then `router.use(requireTenant)`, then protected routers. Do NOT add `requireTenant` per-router.
- Quotas: AI caption/image endpoints enforce per-tenant monthly limits (spend plan quota first, then credits; 402 only when both are gone); metered via `usageEvents`. `/ai/suggest-topics`, `/ai/summarize-url`, `/ai/transcribe` are unmetered; `/ai/generate-campaign` meters 1 caption per platform and pre-checks quota.
- Web auth uses Clerk session cookies (same-origin via proxy) — the frontend does NOT use `setAuthTokenGetter` or a custom API base URL.
- Effective superadmin = DB flag (`tenants.isSuperadmin`, read fresh each request) OR `SUPERADMIN_EMAILS` allowlist checked against the user's LIVE verified Clerk email (fails closed on Clerk errors). The cached `tenants.email` column is only a UI hint — never gate authorization on it. No hardcoded emails in source.
- Grant/revoke superadmin is OWNER-ONLY: the actor must be live-allowlisted (a merely granted superadmin cannot mint/remove superadmins); allowlisted targets are permanent. The admin page denies access when any admin endpoint 403s, not just on cached `me.isSuperadmin`.
- Object storage is tenant-scoped by KEY: uploads live under `/objects/<tenantId>/uploads/<uuid>` and every read/publish path in `lib/objectStorage.ts` asserts the prefix matches `req.tenantId` (404 on mismatch). This is the security boundary — never trust a client-supplied path. No ACL module.
- Production hardening (only when `NODE_ENV=production`): boot env assertion, CORS allowlist from `REPLIT_DOMAINS`, helmet, trust proxy, express-rate-limit (global 300/min, `/ai` 30/min, sensitive routes 20/min; all skip in test).
- SSRF guard for server-side fetches of user URLs (`/ai/summarize-url`, custom image providers): `assertPublicHost` blocks private/reserved ranges (IPv4+IPv6), manual redirects re-validate every hop, response size capped, content-type allowlisted, fails closed.

## Product

- AI content studio: captions + images from a prompt, optionally tied to a brand kit. Single results auto-save as a library draft (updated in place; Save accepts, Discard deletes). Header strip shows live quota remaining. Also topic ideation, article-URL -> brief, and multi-platform campaign generation (images generated client-initiated per platform).
- Content library: save, edit, delete items (draft/scheduled/published); publishing happens from here.
- Brand kits: multiple brands per tenant, versioned JSON payload, one default, AI draft from URL/notes, skippable onboarding wizard.
- Scheduling now auto-publishes: `lib/scheduledPublisher.ts` runs an in-process loop (connectionSweep pattern, started in `index.ts`) that claims due `scheduled_posts` (pending→processing atomically), holds the same per-item lock as manual publishes, and drives the shared `publish<Platform>Core` functions (`lib/publishOutcome.ts` documents the contract: cores own content-item status; callers hold the lock). Schedule statuses: pending/processing/published/failed/cancelled + `failureReason`; stuck 'processing' rows are failed after a timeout (never re-driven — the platform write may have landed). Outcomes notify tenants (`scheduled_post_published` in-app, `scheduled_publish_failed` in-app + best-effort email).
- Connected accounts: Facebook Page + Instagram Business (encrypted per-tenant creds, auto-tested on save), LinkedIn/Threads/X via real OAuth; long Threads captions publish as a reply-chained thread.
- Admin dashboard (`/admin`, superadmin-only): platform stats, tenants table, plan changes, role management, platform credentials, providers, notification policies, seat requests, credit packs/grants.
- Analytics page (`/analytics`), Settings tabs: workspace, Notifications, Team, Style memory, Billing.

## User preferences

- No emojis in the UI.

## Gotchas

- Render stored images via `/api/storage${imagePath}` (`imagePath` = `/objects/<tenantId>/uploads/<uuid>`); cross-tenant paths 404; legacy non-namespaced paths won't resolve.
- After editing `openapi.yaml`, always re-run codegen before using updated types. Do not change the OpenAPI `info.title` — it controls generated filenames.
- Tenant-scoped data: seeding global rows won't appear in the UI; everything is scoped to the signed-in user's tenant.
- Prices are stored in PAISE everywhere in billing.

## Deferred

- Mobile app is in progress (`artifacts/mobile`, Expo). Stripe not planned (billing is live via Razorpay).

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
- Detailed module histories and hard-won lessons live in `.agents/memory/`.
