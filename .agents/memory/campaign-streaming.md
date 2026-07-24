---
name: Campaign SSE streaming
description: Lessons from streaming multi-platform campaign captions over SSE — partial-JSON attribution, disconnect funding races, kill-switch testing.
---

# Campaign caption streaming (SSE)

- **Partial-JSON attribution**: to stream per-platform captions from a single JSON completion, the prompt's output format MUST demand `"platform"` before `"caption"` in each post object; the incremental parser attributes text to the last seen platform. The final `result` event re-parses the full JSON and self-corrects any drift.
  - **Why:** the model writes one JSON blob; without a guaranteed key order the parser can't know which platform an in-flight caption belongs to.
- **Disconnect funding race**: when a client disconnects mid-stream, the `close` handler must claim the funding-resolution flag SYNCHRONOUSLY before doing any async settle work. Otherwise the aborted upstream fetch rejects, and the error path's refund can win the race — refunding credits for work already delivered.
  - **How to apply:** split `settleOnce` into an unguarded `settleRows` plus inline flag guards; set the flag first, then await.
- **Settle policy:** deltas delivered → settle (charge stands); nothing delivered → refund. Mirrors the caption stream.
- **Kill-switch route tests**: mocking `../lib/featureFlags` does NOT work — `requireFeature` calls the internal `isFeatureEnabled` so the mock is bypassed. Instead insert a real `featureFlagsTable` row `{feature, enabled:false}` and call `invalidateFeatureFlagCache()`, cleaning up in beforeEach/afterEach.
- **Frontend test strategy**: jsdom lacks streaming fetch; mock the stream client module (`@/lib/campaignStream`) to reject with `{status: 404}` so studio takes its JSON-fallback path, which existing mutation-mock assertions cover.
