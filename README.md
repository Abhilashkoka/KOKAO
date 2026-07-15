# KOKAO

KOKAO is a multi-tenant SaaS web app for AI-powered social media content. It
generates on-brand captions and images, organizes a content library, manages
versioned brand kits, plans posts on a calendar, and connects social accounts.
Every signed-in user is automatically provisioned as their own isolated tenant,
with per-tenant subscription quotas (free / pro / business).

> This file is the canonical project overview. `replit.md` mirrors it for the
> Replit workspace and additionally carries fine-grained implementation notes and
> agent-facing conventions.

## Supported platforms

Four platforms are integrated:

- **Facebook Page** — real encrypted credential framework. An admin sets the Meta
  App ID/Secret once; each tenant enters its own Page token/ID, auto-tested on
  save. Publish from the Content Library once verified.
- **Instagram Business** — same Meta credential framework (tenant supplies its IG
  account ID). Publish from the Content Library once verified.
- **X (Twitter)** — real OAuth 2.0 with PKCE; HMAC-signed, tenant-bound OAuth
  state.
- **LinkedIn** — real OAuth 2.0 (requires `LINKEDIN_CLIENT_ID` /
  `LINKEDIN_CLIENT_SECRET`).

## Features

- **AI content studio** — generate captions and images from a prompt, optionally
  tied to a brand kit. Also topic ideation (niche → 5 ideas), article-URL → brief
  (fetch + summarize), and multi-platform campaign generation (one brief →
  per-platform caption + hashtags + image prompt).
- **Content library** — save, edit, delete content items (draft / scheduled /
  published) and publish to connected accounts.
- **Brand kits** — multiple brands per tenant with a versioned-JSON payload
  (identity, logos, colors, typography, voice, visual style, layout tokens,
  channel rules) as the source of truth. Editing creates a new activated version;
  optional AI draft from a URL/notes; skippable first-login onboarding wizard.
- **Scheduling** — plan posts on a calendar.
- **Settings** — workspace name, AI model, plan; view available plans.
- **Admin dashboard** (superadmin only) — platform stats, all-tenants table with
  usage, per-tenant plan changes, and (owners only) grant/revoke of the superadmin
  role.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from an OpenAPI spec)
- Auth: Replit-managed Clerk (cookie-based sessions on web)
- Frontend: React 19 + Vite + wouter + TanStack Query + shadcn/ui
- AI: OpenAI via the Replit AI integration proxy (captions + images)

## Run & operate

- `pnpm --filter @workspace/api-server run dev` — run the API server
- `pnpm --filter @workspace/socialforge run dev` — run the web frontend
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod
  schemas from the OpenAPI spec (run after editing `lib/api-spec/openapi.yaml`)
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run test` — run the API test suite

## Environment

Required (asserted at boot in production by `lib/assertEnv.ts`):

- `DATABASE_URL`
- `SESSION_SECRET`
- Clerk: `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`,
  `VITE_CLERK_PUBLISHABLE_KEY`
- Object storage: `PUBLIC_OBJECT_SEARCH_PATHS`, `PRIVATE_OBJECT_DIR`,
  `DEFAULT_OBJECT_STORAGE_BUCKET_ID`
- OpenAI access via the Replit AI integration proxy

Optional:

- `SUPERADMIN_EMAILS` — comma-separated allowlist of cross-tenant superadmins.
  There are NO hardcoded admin emails in source; an unset var means no
  allowlisted admins.
- `CREDENTIALS_ENCRYPTION_KEY` — dedicated at-rest key for social credentials.
  Falls back to `SESSION_SECRET` when unset, so rotating the session secret does
  not brick previously stored credentials.
- `LINKEDIN_CLIENT_ID` / `LINKEDIN_CLIENT_SECRET` — required only for LinkedIn
  OAuth.
- SendGrid connector — enables best-effort breakage-notification emails; the app
  no-ops safely when it is not connected.

## Architecture notes

- **Multi-tenancy without Clerk orgs.** Each `clerkUserId` is its own tenant,
  auto-provisioned on the first authenticated request. No manual signup step.
- **Quotas.** AI caption/image endpoints enforce per-tenant monthly limits and
  return HTTP 402 when exceeded; usage is metered via `usageEvents`.
- **Tenant-scoped object storage.** Uploads are keyed under
  `/objects/<tenantId>/…` and every read/publish path asserts the prefix matches
  the caller's tenant (404 on mismatch). This key namespacing is the security
  boundary.
- **Production hardening** (only when `NODE_ENV=production`): boot-time env
  assertions, a `REPLIT_DOMAINS`-based CORS allowlist, `helmet`, `trust proxy`,
  and rate limiting.

## Deferred / not implemented

- **Scheduling does not execute.** The calendar RECORDS scheduled posts only —
  there is no cron/executor that publishes them at the scheduled time. All
  publishing is manual from the Content Library.
- **Billing is manual.** Plans are set per tenant by an admin; there is no
  automated (e.g. Stripe) billing integration.
- Mobile app.

## Repository layout

This is a pnpm monorepo:

- `artifacts/api-server` — Express API
- `artifacts/socialforge` — React + Vite web frontend
- `lib/*` — shared libraries (DB schema, OpenAPI spec, generated API client)

See `replit.md` for detailed, file-level pointers and conventions.
