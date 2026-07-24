---
name: SSE generation streaming & async image jobs
description: Metering/settlement rules for streamed AI output and background image jobs; frontend fallback pattern.
---

# SSE caption streaming + async image jobs

- **Disconnect metering rule:** with SSE, output is delivered *before* final settlement. If the client disconnects mid-stream after any delta was sent, the request must SETTLE (charge), not refund — otherwise clients can read the caption and drop the connection to dodge the charge. Refund only when zero usable output was delivered. Keep exactly-once settlement via a single `fundingResolved` flag with settleOnce/releaseOnce helpers.
- **Why:** architect review flagged a real billing bypass when disconnects always refunded.
- Stream protocol: `data: <JSON>` events with `type: delta | result | error`; delta carries only the incremental slice; the client accumulates.
- **Job runner claim:** background job runners must claim atomically (`UPDATE ... SET status='processing' WHERE id=? AND status='queued' RETURNING`) — never select-then-update, or double enqueue double-charges.
- **Gate parity:** an async twin of a sync route must replicate ALL of the sync route's feature-flag gates (e.g. `referenceImages`), not just its own kill switch.
- **Frontend fallback:** studio streams via a manual fetch helper (`src/lib/captionStream.ts`) and falls back to the generated JSON mutation on err.status 404/405; async image jobs fall back to the sync route on 404. jsdom tests mock the stream helper / `generateImageAsync` to reject with `{status: 404}` so tests exercise the real fallback path against the existing hook mocks.
