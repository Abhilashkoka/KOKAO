# KOKAO Load-Testing Plan

Scope: the 5 highest-priority endpoints from the verified API inventory.
Auth model: Clerk **session cookie** (no JWT). Every protected request must send the
`__session` cookie of a real signed-in staging user. The first request per user also
pays the `requireTenant` cost (Clerk session verification + tenant lookup).

## Rate limits you must plan around (production only)

| Limiter | Scope | Limit |
|---|---|---|
| Global | all /api routes, per IP | 300 req/min |
| AI | /api/ai/*, per IP | 30 req/min |
| Sensitive | /social-credentials, /twitter, /linkedin, /youtube, /threads | 20 req/min |

Consequences:
- From a single load-generator IP you can never legitimately exceed 300 req/min
  (5 req/s) in production. To test beyond that, either run against a staging
  deployment with `NODE_ENV != production` (limiters are disabled there), or use
  multiple load-generator IPs. **Recommended: dedicated staging deployment.**
- AI endpoints cap at 30/min/IP (0.5 req/s) in production — the k6 AI scenario
  below stays under that by design; raise it only on staging.
- 429 responses are rate-limiter rejections, not app failures. Count them
  separately from 5xx.

Also note AI quotas: caption/image endpoints return **402** when the tenant's
monthly plan quota is exhausted. Use a staging tenant on an unlimited plan
(set plan limits to -1 in the admin panel) or 402s will pollute results.

## Stage 0 — Baseline (before any load)
Single user, 1 request per endpoint, record cold and warm latency. This is your
reference for regression comparison.

## Endpoint plans

### 1. GET /api/me (light read)
- **Purpose:** app-shell gate; every page load calls it. Measures Clerk session
  verification + tenant lookup under concurrency.
- **Expected bottleneck:** Clerk session verification (network to Clerk in dev
  instances) and the tenants table lookup.
- **Safe start:** 5 VUs (virtual users), 1 req/s each.
- **Ramp:** 5 → 25 → 50 VUs over 3 stages of 2 min each; hold 50 for 5 min.
- **Thresholds:** p95 < 300 ms, error rate (non-2xx excluding 429) < 1%.

### 2. GET /api/content (light read)
- **Purpose:** main working-screen list; re-fetched after every mutation.
- **Expected bottleneck:** Postgres query on content_items as row count grows —
  seed the staging tenant with 500–1,000 items first, or the test is unrealistically fast.
- **Safe start:** 5 VUs.
- **Ramp:** 5 → 25 → 50 VUs, same shape as /me; hold 5 min.
- **Thresholds:** p95 < 400 ms, error rate < 1%.

### 3. GET /api/accounts (light read)
- **Purpose:** dashboard/accounts page; joins connection + verify status for 6 platforms.
- **Expected bottleneck:** connected_accounts query; small table, so this should be
  the fastest of the three — if it isn't, something is wrong with the query.
- **Safe start:** 5 VUs.
- **Ramp:** 5 → 25 → 50 VUs; hold 5 min.
- **Thresholds:** p95 < 300 ms, error rate < 1%.

### 4. POST /api/ai/generate-caption (heavy AI)
- **Purpose:** core product action. You are testing the app's behavior around a
  slow upstream (OpenAI): connection pool usage, quota metering writes, request
  queuing — NOT OpenAI's speed.
- **Expected bottleneck:** upstream AI latency (2–15 s) holding Node event-loop
  requests open; the aiLimiter (30/min/IP) in production; usage-metering DB writes.
- **Safe start:** 2 VUs, ≤ 0.4 req/s total (stays under 30/min).
- **Ramp:** 2 → 5 → 10 VUs on staging only (limiter off). Do not exceed 10 VUs
  without watching the AI provider bill — every request costs real money.
- **Thresholds:** p95 < 20 s, error rate < 2% (402/429 counted separately).

### 5. POST /api/ai/generate-image (heaviest)
- **Purpose:** stress the full pipeline: AI image generation + object-storage write
  + large (~1–2 MB base64) response bodies.
- **Expected bottleneck:** upstream image generation (10–60 s), response payload
  size (memory + bandwidth), object-storage write latency.
- **Safe start:** 1 VU.
- **Ramp:** 1 → 3 → 5 VUs, staging only. Image generation is the most expensive
  call in the app — keep total request count low (tens, not thousands).
- **Thresholds:** p95 < 60 s, error rate < 2%.

## Test separation
- **Scenario A — light reads:** /me, /content, /accounts together with realistic
  mix (2:2:1), since real page loads fire them together.
- **Scenario B — heavy AI:** caption + image, low concurrency, long timeouts,
  run separately so AI latency doesn't skew read metrics.
Never run A and B against production simultaneously from one IP — the global
300/min limiter will throttle A when B is running.

## Abort criteria (stop the test immediately)
- Error rate (5xx) > 5% sustained for 60 s
- p95 of light reads > 2 s sustained
- Server memory growth without plateau (watch deployment logs)

## What "pass" looks like
- 50 concurrent users on light reads with p95 under the thresholds and zero 5xx
  comfortably covers the 5K–20K registered-user target (typical concurrency is
  ~1–2% of registered users).
