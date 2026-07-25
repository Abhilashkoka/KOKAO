# Patch 9 — Provider scoring and generation telemetry

`provider-scoring-and-telemetry.patch` · apply after `footage-and-prompt-breadth.patch`

## Apply

```bash
git apply provider-scoring-and-telemetry.patch
pnpm --filter @workspace/db run push   # five new nullable usage_events columns
pnpm --filter @workspace/api-spec run codegen
```

`db:push` **is** required this time (patch 8 didn't need it). All five columns
are nullable additions to `usage_events` — no backfill, no data loss, existing
rows simply keep NULLs where nothing was measured. The generated client and zod
files are already in the patch, so codegen should report no changes; run it to
confirm your spec and generated code agree. No new dependency, no new secret,
no new feature flag.

## What it does

Two of the last open items from the study, and they turn out to be the same
item viewed from opposite ends: choosing a provider well requires knowing what
the last choice actually cost you.

**Image generation stops having a favourite.** Before this patch there was one
admin-pinned provider and a fallback list ordered only by whether a circuit
breaker was open. Now every configured provider is scored per request on four
axes — recent success rate (weight 0.40), observed latency (0.15), price
relative to the other candidates (0.20), and an editorial quality tier (0.25) —
and the request goes to the winner, with the rest of the ranking becoming the
fallback chain in order. The full ranked table is logged, and the winning
sentence ("gemini won on 4/4 ok · ~3.2s · ₹2.50 · quality 0.90 (0.71), ahead of
openai (0.62)") is stored on the usage row.

Reliability uses shrinkage rather than a raw ratio: `(successes + 3×0.8) /
(samples + 3)`. A provider nobody has called yet scores 0.8 instead of a
perfect 1.0, and one unlucky failure scores 0.6 instead of 0 — a single 503
shouldn't brand a vendor unusable for the rest of the process's life. Latency
is the exponential moving average of successful calls (α = 0.3), not the last
measurement, so one slow call doesn't reorder the world.

Admins get **Auto — best scoring provider** at the top of the picker in the AI
tab, and the live ranking with each provider's evidence and score. The ranking
renders whether or not Auto is selected, so the effect of switching to it is
visible before you commit. A provider whose breaker is currently open shows as
**Cooling off**.

**Streamed generations were being metered blind.** This one is a bug, not a
feature gap: a streamed OpenAI-compatible completion reports no usage block
unless the request asks for one with `stream_options: { include_usage: true }`,
and KOKAO never asked. Every streamed caption and every streamed campaign was
recorded with NULL input tokens, NULL output tokens and NULL cost — so the
superadmin cost report was quietly measuring only the non-streaming paths,
which is to say almost nothing a real tenant does. Streaming now asks, and the
numbers land.

On top of that, `usage_events` grows four columns that make a cost figure
explainable rather than merely present: `ttft_ms` (time to first token — the
number a tenant experiences as "did it hang?", which `duration_ms` cannot
show), `cached_input_tokens` and `reasoning_tokens` (subsets of the input and
output totals, not additions to them), and `fallback_step` + `routing_reason`
for the routed image path.

## Three decisions worth knowing about

**Health is a partition, not a weight.** The obvious design is to fold
"breaker open" in as a fifth scoring axis. I ran the arithmetic and it lands at
0.60 against 0.62 for a healthy unknown — technically correct today, and one
weight tweak away from silently sending traffic to a provider the breaker
already decided is down. So ranking sorts healthy candidates first and appends
the unhealthy ones, and the scores only order within each group. The circuit
breaker's promise survives any future weight tuning, and there's a test named
after exactly that ("never ranks an open breaker above a working provider")
holding a cheap, fast, flawless, top-rated but broken provider in last place.

**Cost is scored only against the other candidates, and only when at least two
of them are priced.** Prices live in the admin price table and are filled in
per model as you get round to it. If a lone priced provider were scored
absolutely it would win for the accident of having a price on file, which would
make the honest act of entering one actively harmful. With fewer than two
prices the cost axis drops out and everyone gets the neutral 0.5. Note that
this reads the price table regardless of the `aiCostTracking` flag — that flag
governs superadmin *reporting*, and switching reporting off must not blind the
router to price.

**The cached/reasoning split is recorded but does not change the cost formula.**
Discounting cached prompt tokens properly needs its own price column per model
plus admin UI to fill it, and inventing a discount would be worse than a known
overstatement. Recording the split is what turns that overstatement from
invisible into visible and quantifiable — you can now see that 400 of a
1,200-token prompt were served from the provider's cache and decide whether the
column is worth building. There is a test asserting the cost stays undiscounted
so this stays a decision rather than a bug.

## Files

| | |
|---|---|
| `artifacts/api-server/src/lib/providerScore.ts` | new — the scorer, the reason strings and `explainWinner` |
| `artifacts/api-server/src/lib/providerScore.test.ts` | new — 19 tests, weights asserted as literals on purpose |
| `artifacts/api-server/src/lib/imageGen/routing.test.ts` | new — 15 tests over auto routing and the ranking endpoint |
| `artifacts/api-server/src/lib/providerHealth.ts` | modified — a 20-outcome window and smoothed latency per provider |
| `artifacts/api-server/src/lib/providerHealth.test.ts` | modified — 7 tests for the observed stats |
| `artifacts/api-server/src/lib/imageGen/index.ts` | modified — the `auto` sentinel, ranked chain, lazy extension |
| `artifacts/api-server/src/lib/imageGen/types.ts` | modified — `fallbackStep` / `routingReason` on the result |
| `artifacts/api-server/src/lib/imageGeneration.ts` | modified — carries both onto the usage row |
| `artifacts/api-server/src/lib/aiCost.ts` | modified — `streamUsageParams`, the token split, `imageUnitCostsPaise` |
| `artifacts/api-server/src/lib/aiCost.test.ts` | modified — 9 tests for the split and per-candidate pricing |
| `artifacts/api-server/src/lib/asr/index.ts` | modified — fallbacks ranked instead of only partitioned |
| `artifacts/api-server/src/lib/usage.ts` | modified — five new best-effort meta fields |
| `artifacts/api-server/src/routes/ai.ts` | modified — ask for streamed usage, measure TTFT |
| `artifacts/api-server/src/routes/ai.captionStream.test.ts` | modified — 3 tests for the new columns |
| `artifacts/api-server/src/routes/admin.ts` | modified — serve the ranking, accept and audit `auto` |
| `artifacts/socialforge/src/pages/admin/ai-tab.tsx` | modified — the Auto option and the ranking list |
| `artifacts/socialforge/src/pages/admin/ai-tab.test.tsx` | new — 6 tests |
| `lib/db/src/schema/usageEvents.ts` | modified — five nullable columns |
| `lib/api-spec/openapi.yaml` | modified — `ImageGenRankedProvider`, `autoRanking`, `"auto"` documented |

## Verified

Full api-server suite: **1427 tests passing** across 114 files. Web suite:
**350 passing** across 39 files. Typecheck clean across all 14 workspace
projects. OpenAPI spec lint clean. Codegen clean. Patch verified to apply
cleanly against a fresh checkout of the previous commit.

## The one thing to eyeball on a live run

Continuity — "keep one campaign's images on the same provider" — is the study's
sixth axis and it is deliberately **not** implemented. Score stability delivers
it in practice: nothing about a provider changes between two images generated a
few seconds apart, so the same one wins both times, and buying the guarantee
outright would mean a `campaignId → last provider` lookup on the hot path of
every generation.

The hole is a mid-campaign *failure*. If a provider dies on image three of
five, the remaining images finish on the fallback — which is the right call for
completing the job, and can leave one campaign with images from two different
models. Generate a five-image campaign under Auto on Replit and look at the
`fallback_step` column on those five rows: all zeros means you never hit it.
If you do hit it and the visual mismatch bothers you more than a failed
generation would, the fix is a lookup, not a rethink — say the word.
