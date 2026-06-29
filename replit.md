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
- Frontend: `artifacts/socialforge/src/`

## Architecture decisions

- Multi-tenancy without Clerk orgs: each `clerkUserId` is its own tenant, auto-provisioned on the first authenticated request by `requireTenant`. No manual signup/tenant-creation step.
- Auth is gated ONCE in `routes/index.ts`: public routers (health, storage, plans) are mounted first, then `router.use(requireTenant)`, then the protected routers. Do NOT add `requireTenant` per-router.
- Quotas: AI caption/image endpoints enforce per-tenant monthly limits and return HTTP 402 when exceeded; usage is metered via `usageEvents`.
- AI is owner/tenant-configurable via `tenant.aiModel`. Images go to object storage; endpoints return both a stored `imagePath` and `b64Json` for instant preview.
- Web auth uses Clerk session cookies (same-origin via proxy) — the frontend does NOT use `setAuthTokenGetter` or a custom API base URL.

## Product

- AI content studio: generate captions and images from a prompt, optionally tied to a brand kit.
- Content library: save, edit, delete content items (draft/scheduled/published).
- Brand kits: colors, voice, hashtags, logo upload.
- Scheduling: schedule posts to a calendar (records only for now).
- Connected accounts: Instagram/Facebook/LinkedIn/YouTube records (no live OAuth yet).
- Settings: workspace name, AI model, plan; view available plans.

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
