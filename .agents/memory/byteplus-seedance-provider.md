---
name: BytePlus Seedance provider
description: Durable contract and safety rules for direct first-party Seedance video generation through BytePlus ModelArk.
---

Use BytePlus ModelArk’s international API as the first-party ByteDance route for Seedance 2.5. Keep its provider identity and model ID separate from OpenRouter, Higgsfield, and other aggregators.

**Why:** Provider slugs are not interchangeable contracts. BytePlus publishes a dedicated asynchronous task API for Seedance 2.5, while the same marketing model name on an aggregator may use different inputs, capabilities, and billing.

**How to apply:** Use the exact documented ModelArk model and structured multimodal content contract. Treat native audio, first/last frames, durations, resolutions, and aspect ratios as provider-and-model capabilities rather than inferring them from a display name.

Never automatically retry the task-creation POST unless BytePlus publishes an idempotency mechanism that KOKAO uses with a stable key.

**Why:** A lost response after ModelArk accepts the request can otherwise create multiple paid renders, with only one tracked by KOKAO.

**How to apply:** Submit creation once. Polling is safe to retry. Keep one absolute deadline over request and body reads, abort stalled requests, cap response sizes, and revalidate every output redirect as HTTPS on a public host.