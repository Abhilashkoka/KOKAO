# Character visual QA response contract

## Compatibility evidence

Reviewed on 2026-09-17:

- The local Replit OpenAI integration guidance lists `gpt-5.6-luna`, Chat Completions, and `max_completion_tokens` for GPT-5-family models. Its examples use JSON-object output.
- [Replit AI Integrations documentation](https://docs.replit.com/features/integrations/replit-ai-integrations) does not explicitly guarantee strict JSON Schema output for this managed alias. Keep `response_format: { type: "json_object" }`; do not infer backend support from SDK types.
- The QA budget is 4096 completion tokens, including reasoning. This is an application bound, not a claim about the model's maximum. The existing 30-second deadline and disabled SDK retries remain.

Available deployment logs contain durable QA error summaries but no completion finish reason or content length. No sanitized production response for the reported draft was available for this work. No production draft, ledger, or exact provider response was verified or edited. Fixture tests establish how failures are handled, not the cause of that production incident.

## Acceptance

Require exactly one choice, `finish_reason: "stop"`, no refusal or tool call, and a single complete JSON object. Do not strip prose/fences, join multiple content parts, or extract a passing fragment. The exact required keys must be present once, with canonical enum/boolean/integer types; aliases, duplicate keys, missing fields, and extras fail closed.

Sheets require an `accept` decision, five panels, one subject in every panel, the same identity, and design consistency. Portrait/outfit acceptance still requires exactly one full-body subject and design consistency. Uncertain, rejected, incomplete, or invalid assessments never reach persistence.

## Operator diagnostics

Find `event: "character_visual_qa_failed"`:

| `kind` | Meaning |
| --- | --- |
| `truncated` | Provider reported `finish_reason: "length"`, even if text is parseable |
| `refused` | Explicit refusal or content-filter finish |
| `empty` | Completed envelope with missing/blank content |
| `malformed` | Invalid structure, finish reason, JSON, decision, or required fields |
| `uncertain` | Typed verdict could not confirm the visual checks |
| `invalid` | Typed verdict rejected the image or a required visual check failed |
| `timeout` | QA deadline expired |
| `unavailable` | QA request failed |

Logs include tenant, mode, fixed model, bounded choice count/content length, and an allowlisted finish reason. Opaque operation, provider-request, and completion IDs are SHA-256 hashed as `operationKeyHash`, `requestIdHash`, and `completionIdHash`. To correlate, hash the exact already-known identifier using UTF-8 SHA-256; do not hash a JSON-quoted version. Missing IDs remain absent. Never log raw responses, errors, prompts, images, or refusal text.

Received responses attempt cost capture before verdict parsing, including empty or refused responses. QA telemetry is customer-unmetered and best effort; telemetry failures cannot alter the verdict. Transport failures do not invent token usage.

## Recovery

A confirmed sheet QA failure is terminal for that generated image: there is no automatic paid image regeneration or fallback. The existing funding-release path remains responsible for the failed sheet. An explicit per-role retry creates one new sheet in the same Guided draft, preserving the approved script, canonical portrait, outfit, and successful other roles. It is not a free recheck of retained rejected bytes. Unknown image-provider outcomes remain blocked from retry. A replacement sheet still requires explicit human approval.

Automatic cast workers and manual cast requests acquire the same durable role-execution claim before funding or provider dispatch. A competing request receives an in-progress conflict instead of generating a second sheet. Checkpoint writes and release paths verify ownership; active or unknown provider outcomes cannot be reclaimed. A retry may briefly report that failure finalization is still in progress until the prior owner completes its refund and releases the claim.

Failed sheets retain their original funding until a durable release is confirmed. Credit refund and release evidence commit atomically; wallet release requires a matching refund receipt. After an interruption or refund error, the first retry only recovers that release and reports that no new sheet was started. Once released, the user explicitly retries again to generate a replacement. Legacy credit failures without verifiable release evidence require support reconciliation rather than a guessed duplicate refund.