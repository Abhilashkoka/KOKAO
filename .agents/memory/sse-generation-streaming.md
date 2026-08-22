---
name: SSE generation streaming & async image jobs
description: Metering/settlement rules for streamed AI output and background generation jobs.
---

# SSE streaming & async generation jobs

- **Disconnect metering rule:** with SSE, output reaches the client *before* final settlement. If the client disconnects mid-stream after any delta was delivered, SETTLE (charge) the reserved funding; refund only when zero usable output was sent.
  - **Why:** always refunding on disconnect lets clients read the streamed result and drop the connection to dodge the charge (flagged as a billing bypass in review).
  - **How to apply:** exactly-once settlement via one `fundingResolved` flag with settleOnce/releaseOnce helpers; the `close` handler picks settle vs release based on bytes delivered.
- **Governance trace parity:** when governed streamed output is delivered before disconnect, record the compiled-prompt trace as successful even though aborting the upstream stream enters the error path.
  - **Why:** delivered output is consumed and settled; suppressing its prompt trace creates an audit gap for admin-published templates.
  - **How to apply:** distinguish abort-after-usable-output from model failure before the abort guard, and regression-test a real client socket close after the first parsed delta.
- **Job runner claim:** background runners must claim atomically (conditional `UPDATE ... WHERE status='queued' RETURNING`) — select-then-update lets a double enqueue process and charge twice.
- **Gate parity:** an async twin of a sync route must replicate ALL of the sync route's feature-flag gates, and clients should fall back to the sync route on both 404 and 403 feature_disabled so server/client flag drift degrades gracefully.
- **jsdom testing:** mock the streaming/async entry points to reject with `{status: 404}` so component tests exercise the real JSON-fallback path against existing hook mocks.
