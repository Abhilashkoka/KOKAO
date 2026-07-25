# Patch 8 — Footage and prompt breadth

`footage-and-prompt-breadth.patch` · apply after `provider-resilience.patch`

## Apply

```bash
git apply footage-and-prompt-breadth.patch
pnpm --filter @workspace/api-spec run codegen
```

The generated client and zod files are already in the patch, so codegen should
report no changes — run it anyway to confirm your spec and your generated code
agree. No schema change, no `db:push`, no new dependency, no new secret, no new
feature flag.

## What it does

Two unrelated ceilings, both about breadth rather than reliability.

**Stock footage stops depending on one library.** Wikimedia Commons joins the
stock registry as a third source that needs no key at all — no account, no
dashboard, no free-tier ceiling. It is restricted to public domain and CC0
files: CC-BY is excluded because a published Instagram post has nowhere to put
an attribution line, and CC-BY-SA because share-alike could follow a tenant's
finished video out the door. Tenants see it in the picker as **Commons
(archival)** and can choose it outright.

It is failover, not a substitute. Commons only joins the `auto` list when a
keyed library is already configured, so a fresh deployment still gets the loud
400 asking for a Pexels or Pixabay key instead of quietly serving archive
clips forever. Ordering runs through the circuit breaker across both groups, so
a healthy Commons beats a broken Pexels, and a healthy Pexels still wins
outright.

**The runtime now actually walks the list.** This is the part that was
promised in patch 7 and not delivered: `gatherStockClips` resolved one source
and gave up. It now tries each source in turn and moves on when one comes back
empty — which covers both "the API is 503ing" and "this library has nothing
for monsoon street food". From the caller's seat those are the same problem
with the same answer. Preflight walks the same list, so it can neither refuse
a job the runtime would have served nor fund one the runtime will reject for a
missing key. An explicit source choice arrives as a one-element list, so it
still fails loudly rather than silently substituting a different library.

**The image studio can ask for a photograph.** Image models answer to camera
format, focal length, aperture and light far more reliably than to
"professional" or "high quality", and there is no reason a tenant running a
coffee shop should know that. The Studio brief grows a **Look** row: five genre
pills (Product, Food, Fashion, Lifestyle, Architecture), each carrying the
boring correct gear for that shoot — macro at f/8 on a seamless sweep for
packshots, 35mm wide open by a window for lifestyle — plus a collapsed *Camera
details* row where any single axis can be overridden.

It is a lookup and a join. No model call, no key, no cost, and the same recipe
always compiles to the same string. Picking nothing sends exactly the request
it sent before this patch.

## Three decisions worth knowing about

**The compile happens in the route, not the runner.** The compiled sentence is
what lands in the job's `prompt` column, so the gallery shows something a
tenant can paste back in and re-run, and there is no schema change and no
runner change. The brand kit, taste pass and reference guide are still layered
on afterwards by `performImageGeneration` — the compiler only writes the
photography.

**No vocabulary endpoint.** The pill ids live in the OpenAPI enums, so clients
are typed from the contract and a bad id is a 400 rather than a silently
dropped axis. The label maps in `studio.tsx` are keyed by those generated
unions, which means adding an id to the spec without labelling it is a build
error, not a pill that quietly never renders. That is one endpoint, one query
hook and one loading state we don't own — for data that never changes at
runtime. A drift test walks the generated zod enums both ways against the
server's phrase tables.

**archive.org and NASA were considered and skipped.** Neither reports clip
duration or dimensions in search results, so every candidate would need its own
follow-up fetch, and the existing 1280×720 rendition floor rejects most of
archive.org's standard-definition catalogue anyway. Commons reports width,
height, duration and licence in one query and offers pre-made 1080p transcodes.

## Files

| | |
|---|---|
| `artifacts/api-server/src/lib/imageGen/promptCompiler.ts` | new — the pill vocabularies and the compile |
| `artifacts/api-server/src/lib/imageGen/promptCompiler.test.ts` | new — 14 tests, including the schema-drift check |
| `artifacts/api-server/src/lib/videoGen/topicVideo/stockSources.test.ts` | new — 21 tests |
| `artifacts/api-server/src/lib/videoGen/topicVideo/stockSources.ts` | modified — Commons source, keyless keys, `collectStockCandidates` |
| `artifacts/api-server/src/lib/videoGen/topicVideo/index.ts` | modified — walks the candidate list instead of one source |
| `artifacts/api-server/src/lib/videoGen/preflight.ts` | modified — shares that same list |
| `artifacts/api-server/src/lib/videoGen/preflight.test.ts` | modified — the archive as failover, and not as an excuse |
| `artifacts/api-server/src/routes/ai.ts` | modified — one line: compile before generating |
| `artifacts/api-server/src/routes/imageJobs.ts` | modified — one line: store the compiled prompt |
| `artifacts/api-server/src/routes/imageJobs.cancel.test.ts` | modified — 2 tests for the compiled column and a bad id |
| `artifacts/socialforge/src/pages/studio.tsx` | modified — the Look row |
| `artifacts/socialforge/src/pages/studio.test.tsx` | modified — 4 tests |
| `artifacts/socialforge/src/pages/video-studio.tsx` | modified — Commons in the source picker |
| `artifacts/socialforge/src/pages/admin/ai-tab.tsx` | modified — "No key needed" instead of an input box |
| `artifacts/api-server/src/lib/videoGen/jobRunner.ts` | modified — one word in the source guard |
| `lib/db/src/schema/videoGenerations.ts` | modified — comment only |
| `lib/api-spec/openapi.yaml` | modified — `ImagePromptRecipe`, keyless stock fields |

## Verified

Full api-server suite: **1376 tests passing** across 112 files. Web suite:
**344 passing** across 38 files. Typecheck clean across all 14 workspace
projects. OpenAPI spec lint clean. Codegen clean.

## The one thing to eyeball on a live run

Commons' `derivatives` video property is the only piece of this I could not
exercise against the real API from here — Wikimedia's endpoint isn't reachable
from my sandbox, so the parser is written defensively and retries without
`derivatives` if the API rejects that property, falling back to the original
file URL. Generate one topic video with **Commons (archival)** selected on
Replit and check the log for `stock search failed for term`. If you see it,
the retry path is the thing to look at; clips will still come through at
original resolution either way.
