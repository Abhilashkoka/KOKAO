# KOKAO — Tech Stack Reference

A plain-language reference for what KOKAO is built with and where each piece lives.
(Last updated: July 22, 2026)

## The big picture

KOKAO is one project made up of several apps that share code:

| App | What it is | Where it lives |
|---|---|---|
| Web app | The main KOKAO website users log into | `artifacts/socialforge` |
| API server | The backend that all apps talk to | `artifacts/api-server` |
| Mobile app | The KOKAO phone app (iOS/Android) | `artifacts/mobile` |
| Promo video | The animated KOKAO promo | `artifacts/kokao-promo` |
| Shared libraries | Code reused by all apps (API contract, database schema, etc.) | `lib/` |

## Languages & foundation

- **TypeScript 5.9** — the programming language used everywhere (JavaScript with type safety).
- **Node.js 24** — the runtime that executes the server code.
- **pnpm workspaces** — keeps all the apps and shared libraries organized in one repository.

## Backend (API server)

- **Express 5** — the web server framework handling all API requests.
- **PostgreSQL** — the database where all data lives (tenants, posts, brand kits, billing, etc.).
- **Drizzle ORM** — the tool the code uses to read and write the database safely.
- **Zod** — validates that all data coming in and going out has the right shape.
- **esbuild** — bundles the server code for running.

## Frontend (web app)

- **React 19** — the framework that builds the user interface.
- **Vite** — the build tool that serves and bundles the web app.
- **wouter** — handles page navigation (routing).
- **TanStack Query** — fetches data from the API and keeps screens up to date.
- **shadcn/ui + Tailwind CSS** — the component library and styling system.

## Mobile app

- **Expo (React Native)** — lets the same React skills build native iOS/Android apps.

## How the apps talk to each other

- **OpenAPI contract** (`lib/api-spec/openapi.yaml`) — the single source of truth describing every API endpoint.
- **Orval code generation** — automatically generates typed hooks and validators from that contract, so frontend and backend can never drift apart silently.

## Accounts, payments, and AI

- **Clerk** — handles sign-up, login, and sessions (managed through Replit).
- **Razorpay** — billing: subscriptions, credit packs, promo codes (prices stored in paise).
- **OpenAI via Replit AI proxy** — default AI for captions and images; admins can switch to other providers (OpenRouter for text; Gemini, Stability, Replicate, BFL and others for images; Groq/Deepgram/AssemblyAI for voice transcription).
- **SendGrid** — sends email notifications.
- **Expo push** — sends mobile push notifications.

## Social platform connections

Direct integrations with **Facebook, Instagram, LinkedIn, X (Twitter), Threads**, plus ad platforms (**Meta Ads, Google Ads, LinkedIn Ads, TikTok Ads**). Credentials are encrypted in the database (AES-256-GCM).

## Storage & security highlights

- **Replit object storage** — uploaded and generated images, scoped per workspace.
- Multi-tenant: every user gets their own isolated workspace; all data is scoped to it.
- Rate limiting, CORS allowlists, encrypted credentials, and server-side permission checks in production.
- Every tenant-facing feature has a platform-wide kill switch controllable from the admin dashboard.

## Testing & quality

- **Vitest** — automated tests for server, web, and mobile.
- **Playwright-based browser tests** — end-to-end checks of real user flows.
- Type checking (`pnpm run typecheck`), API spec linting, and code-generation drift checks run on every change.

## Handy commands

- `pnpm run typecheck` — check the whole project for type errors
- `pnpm run test` — run all tests
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API code after editing the contract
- `pnpm --filter @workspace/db run push` — apply database schema changes (development only)
