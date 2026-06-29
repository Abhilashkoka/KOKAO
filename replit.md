# SocialForge

SocialForge is a multi-tenant SaaS web app for AI-powered social media content: it generates on-brand captions and images, organizes a content library, manages brand kits, schedules posts, and connects social accounts (Instagram/Facebook/LinkedIn/YouTube). Built to scale to 5K-20K users with per-tenant subscription quotas (free/pro/business).

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server
- `pnpm --filter @workspace/socialforge run dev` — run the web frontend
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL`, Clerk keys (`CLERK_*`, `VITE_CLERK_PUBLISHABLE_KEY`), object storage vars, OpenAI access via integration proxy

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Auth: Replit-managed Clerk (cookie-based sessions on web)
- Frontend: React 19 + Vite + wouter + TanStack Query + shadcn/ui
- AI: OpenAI via Replit AI integration proxy (captions + images)
- Build: esbuild (CJS bundle)

## Where things live

- API contract (source of truth): `lib/api-spec/openapi.yaml` — change here, then run codegen
- Generated API hooks/schemas: `lib/api-client-react/src/generated/` (import via `@workspace/api-client-react`)
- DB schema (source of truth): `lib/db/src/schema/` (tenants, brandKits, contentItems, scheduledPosts, connectedAccounts, usageEvents)
- API routes: `artifacts/api-server/src/routes/` — auth gating lives in `routes/index.ts`
- Tenant provisioning: `artifacts/api-server/src/middlewares/requireTenant.ts`
- Plan limits / quota helpers: `artifacts/api-server/src/lib/plans.ts`, `lib/usage.ts`
- Superadmin: allowlist `artifacts/api-server/src/lib/superadmins.ts`, grantable DB flag `tenants.isSuperadmin`, gate `middlewares/requireSuperadmin.ts`, routes `routes/admin.ts` (owner-only `PATCH /admin/tenants/:id/superadmin`), live verified-email helper `lib/clerkUser.ts`, page `artifacts/socialforge/src/pages/admin.tsx`
- Frontend: `artifacts/socialforge/src/`

## Architecture decisions

- Multi-tenancy without Clerk orgs: each `clerkUserId` is its own tenant, auto-provisioned on the first authenticated request by `requireTenant`. No manual signup/tenant-creation step.
- Auth is gated ONCE in `routes/index.ts`: public routers (health, storage, plans) are mounted first, then `router.use(requireTenant)`, then the protected routers. Do NOT add `requireTenant` per-router.
- Quotas: AI caption/image endpoints enforce per-tenant monthly limits and return HTTP 402 when exceeded; usage is metered via `usageEvents`.
- AI is owner/tenant-configurable via `tenant.aiModel`. Images go to object storage; endpoints return both a stored `imagePath` and `b64Json` for instant preview.
- Web auth uses Clerk session cookies (same-origin via proxy) — the frontend does NOT use `setAuthTokenGetter` or a custom API base URL.
- Cross-tenant superadmin is BOTH a permanent email allowlist (built-in `abhilash.koka1@gmail.com`, extendable via `SUPERADMIN_EMAILS` env) AND a grantable per-tenant DB flag (`tenants.isSuperadmin`). Effective superadmin = DB flag OR allowlisted email. The `/admin/*` gate (`requireSuperadmin`) trusts the DB flag as a fast-path (read fresh each request, so revoke is immediate), otherwise falls back to checking the user's LIVE verified Clerk email — only verified emails count, and it fails closed (403) on any Clerk error. The cached `tenants.email` column is only a UI hint (drives `/me` `isSuperadmin`/`isOwner` and the nav link); it is never the security boundary. Do not gate authorization on the cached column.
- Role management (grant/revoke superadmin) is OWNER-ONLY: `PATCH /admin/tenants/:id/superadmin` independently re-checks that the ACTOR is allowlisted via their LIVE verified email (a merely granted superadmin cannot mint/remove superadmins) and rejects writes whose TARGET is allowlisted (owners are permanent, shown as "Owner" with a locked toggle). `/me` exposes `isOwner` so the UI disables role controls for non-owner superadmins.
- Frontend admin page denies access when ANY admin endpoint returns 403 (authoritative), not just on the cached `me.isSuperadmin` — React Query serves that stale after a live revoke, so a revoked user would otherwise keep seeing the dashboard.
- AI assists in `routes/ai.ts`: `/ai/suggest-topics` and `/ai/summarize-url` are UNMETERED (helpers, no quota). `/ai/generate-campaign` is metered as 1 caption per requested platform — it pre-checks quota (402 if `usage.captions + platforms.length` would exceed the plan) and records one caption usage per platform on success. Campaign returns caption+hashtags+imagePrompt per platform but does NOT generate images server-side; the UI calls the existing `/ai/generate-image` per platform on demand.
- SSRF guard: `/ai/summarize-url` fetches arbitrary user URLs server-side, so it is hardened in `routes/ai.ts` — `assertPublicHost` blocks IP-literal and DNS-resolved private/loopback/link-local/CGNAT/multicast/reserved ranges (IPv4 + full IPv6 incl. all IPv4-mapped/compatible forms via `ipv6ToBytes`), blocks `localhost`/`.local`/`.internal`, strips IPv6 brackets, and fails closed. `safeFetch` uses `redirect:"manual"` and re-validates the host on every hop. Response body is streamed and capped (`MAX_FETCH_BYTES`), content-type is allowlisted, and the timeout is cleared in `finally`. Residual risk: DNS-rebinding TOCTOU (validation resolves the host, then `fetch` resolves again) is accepted given the request timeout and small response cap; tighten with IP-pinned connect/egress proxy if needed.

## Product

- AI content studio: generate captions and images from a prompt, optionally tied to a brand kit. Also: topic ideation (niche -> 5 ideas), article-URL -> brief (fetch + summarize to {title, summary}), and multi-platform campaign generation (one brief -> per-platform caption + hashtags + image prompt).
- Content library: save, edit, delete content items (draft/scheduled/published).
- Brand kits: colors, voice, hashtags, logo upload.
- Scheduling: schedule posts to a calendar (records only for now).
- Connected accounts: Instagram/Facebook/LinkedIn/YouTube records (no live OAuth yet).
- Settings: workspace name, AI model, plan; view available plans.
- Admin dashboard (superadmin only, `/admin`): platform stats, all-tenants table with counts/usage, per-tenant plan changes, and (owners only) grant/revoke of the superadmin role per tenant.

## User preferences

- No emojis in the UI.

## Gotchas

- Image display: render stored images via `/api/storage${imagePath}` (imagePath has the form `/objects/...`).
- After editing `openapi.yaml`, always re-run codegen before using updated types.
- Do not change the OpenAPI `info.title` — it controls generated filenames.
- Tenant-scoped data: seeding global rows won't appear in the UI because everything is scoped to the signed-in user's auto-provisioned tenant.

## Deferred

- Live social OAuth + real publishing, Stripe billing, mobile app.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
