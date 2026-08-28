# NVIDIA controlled live validation — 2026-08-28

## Decision

Do not activate NVIDIA deployments for production traffic.

The controlled live pass found that both hosted models currently covered by KOKAO's verified contracts were retired upstream. No controlled self-hosted NIM endpoints were available for the remaining capabilities.

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