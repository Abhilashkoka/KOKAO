# NVIDIA controlled live validation — 2026-08-28

## Decision

Do not activate NVIDIA deployments for production traffic.

The initial controlled live pass found that both hosted models previously covered by KOKAO's verified contracts were retired upstream. A follow-up qualification selected and technically verified current hosted text and multimodal replacements, but NVIDIA documents these serverless endpoints as free preview APIs for prototyping and does not publish an exact production per-token tariff for them. They are recorded as prototype-only contracts and remain ineligible for KOKAO production traffic. No controlled self-hosted NIM endpoints were available for the remaining capabilities.

## Environment

- NVIDIA API Catalog credential: configured through Replit Secrets
- Hosted endpoint: `https://integrate.api.nvidia.com/v1`
- Self-hosted NIM endpoints: unavailable
- Production traffic: not enabled
- Secret values and authorization headers: not recorded

## Hosted catalog and generation results

The hosted `GET /v1/models` request succeeded with HTTP 200.

| Capability | Contract model | Minimal generation | Result |
| --- | --- | --- | --- |
| Text | `meta/llama-3.1-70b-instruct` | Chat completion, maximum 3 tokens | HTTP 410 Gone |
| Multimodal | `nvidia/llama-3.1-nemotron-nano-vl-8b-v1` | Chat completion, maximum 3 tokens | HTTP 410 Gone |

NVIDIA reported that both models reached end of life on 2026-08-26 at 09:00 UTC. Neither model was present in the successful catalog response.

Because no generation succeeded, there was no valid provider usage receipt to price and no successful work to settle against a tenant wallet. Connection health and activation must remain failed. Retry would repeat a terminal 410 response and must not be treated as a transient provider failure.

No newly discovered hosted model was substituted automatically. Discovery is informational and must not expand the verified model allowlist.

## Replacement hosted qualification

The follow-up used the same hosted endpoint and credential. Each successful request used `POST /v1/chat/completions`, `max_tokens: 3`, and no tools. Streaming requests also used `stream: true` and `stream_options.include_usage: true`.

| Capability | Selected candidate | Catalog | JSON response | Streaming response | Provider attribution |
| --- | --- | --- | --- | --- | --- |
| Text | `nvidia/nemotron-3-nano-30b-a3b` | Present | HTTP 200; `chat.completion`; usage 18 input / 3 output | HTTP 200 SSE; `chat.completion.chunk`; `[DONE]`; final usage 18 / 3 | Response and every stream chunk reported the exact requested model |
| Multimodal | `meta/llama-3.2-11b-vision-instruct` | Present | HTTP 200; `chat.completion`; usage 1618 input / 3 output | HTTP 200 SSE; `chat.completion.chunk`; `[DONE]`; final usage 1618 / 3 | Response and every stream chunk reported the exact requested model |

The multimodal request used an inline one-pixel PNG data URI in an OpenAI-compatible `image_url` content part. The response was text-only as expected.

Both streams returned `text/event-stream`, data-only SSE JSON chunks, a terminal finish reason, a final usage-bearing chunk, and `data: [DONE]`. The text model included `reasoning_content` alongside normal content; KOKAO may ignore it without affecting the portable content and usage contract.

Malformed `messages` and an invalid image URL each returned HTTP 400 JSON with an `error` object containing a numeric `code`, textual `type`, and textual `message`. These are terminal caller errors. The retired models' HTTP 410 is also terminal and is explicitly covered by retry-classification tests.

### Pricing and activation decision

NVIDIA's official "Run NIM Anywhere" documentation says Developer Program members have free access to hosted NIM API endpoints for prototyping. The Discover page labels them "Free serverless APIs for development." NVIDIA separately states that production use requires NVIDIA AI Enterprise licensing, beginning at $4,500 per GPU per year; it does not publish a model-specific production input/output token price for these hosted previews.

Therefore the exact hosted-preview provider rate is USD 0 for both input and output tokens, scoped only to prototyping. It is not a usable production tariff. KOKAO records that scope on the contracts and refuses production activation even if an admin adds a price row, enables the deployment, and passes catalog health.

The hosted qualification does not qualify either model for a self-hosted NIM. Changing the deployment kind is rejected until that exact self-hosted endpoint independently passes generation, streaming, usage, error, attribution, licensing, and pricing validation.

Wallet behavior remains fail-closed:

- No tenant generation can reach either hosted preview while it is production-ineligible, so no live tenant reservation was created for the qualification calls.
- Token usage and exact serving-model attribution match KOKAO's existing text cost receipt shape.
- A zero provider cost never makes tenant work silently free: the wallet settlement layer treats zero as unavailable and uses the configured product charge.
- Provider failure paths release the full reservation; permanent 400/410 errors are not retried or failed over, while 429/5xx/network errors retain the existing transient classification.

Official references:

- https://docs.api.nvidia.com/nim/docs/run-anywhere
- https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-nano-30b-a3b-infer
- https://docs.api.nvidia.com/nim/reference/meta-llama-3_2-11b-vision-instruct-infer
- https://build.nvidia.com/explore/discover

## Self-hosted capability results

| Capability | Verified contract model | Result |
| --- | --- | --- |
| Image | `stabilityai/stable-diffusion-xl` | Blocked: no controlled self-hosted NIM endpoint |
| Video | `wan-ai/wan2.2` | Blocked: no controlled self-hosted NIM endpoint |
| ASR | `nvidia/parakeet-ctc-1.1b-asr` | Blocked: no controlled self-hosted Speech NIM endpoint |
| TTS | `nvidia/magpie-tts` | Blocked: no controlled self-hosted Speech NIM endpoint |

These capabilities cannot be validated from the hosted API Catalog credential. They must remain disabled until their exact endpoint, request, response, media-validation, usage, retry, and accounting contracts pass a controlled live run.

## Discovery safety

The successful hosted catalog response included embedding and retrieval model IDs, including IDs containing `embed` and `retriever`. KOKAO's NVIDIA discovery policy classifies embedding, reranking, and retrieval IDs as unsupported and non-selectable. Other unknown IDs remain non-selectable unless an exact deployment-kind, capability, model, and protocol contract is added and independently verified.

## Required evidence before activation

For each replacement hosted model or controlled self-hosted deployment:

1. Verify the exact model ID is returned by that deployment's discovery endpoint.
2. Pass the capability-specific connection test.
3. Run one minimal generation and validate the full upstream response and media.
4. Capture exact provider attribution and a usable cost receipt.
5. Verify wallet reservation, settlement, retry classification, and refund behavior.
6. Keep embeddings, rerankers, retrieval models, and unknown IDs disabled.
7. Record any version-specific request or response differences before enabling traffic.