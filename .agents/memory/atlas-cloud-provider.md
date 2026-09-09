---
name: Atlas Cloud provider
description: Safety and lifecycle rules for Atlas Cloud video generation and fictional-character assets.
---

Atlas Cloud is a distinct paid video provider; never reuse BytePlus model contracts, credentials, task IDs, prices, or asset IDs for it.

**Why:** Atlas is an aggregator with its own asynchronous prediction API and account-wide Asset Library. Marketing model names do not imply identical provider behavior.

**How to apply:** Fence every paid submit durably before POST, save accepted prediction IDs immediately, resume polling instead of resubmitting, and send unknown-cost events as NULL. Activation requires an authoritative price.

Atlas Seedance reference-to-video predictions can legitimately remain processing beyond ten minutes; use a provider-specific long poll budget rather than the shared short video-provider budget.

**Why:** A live four-scene Guided job had two completed predictions and two healthy predictions still processing when the generic ten-minute deadline marked the job failed. Both pending predictions later completed without another POST.

**How to apply:** Allow at least thirty minutes for Atlas prediction polling. If the wait still expires, keep the accepted task ID and tell the user recovery continues that exact task instead of implying the provider rejected it.

An Atlas HTTP 402 is a definite provider-account billing rejection, not an ambiguous paid submit and not a transient scene failure.

**Why:** Retrying a 402 left the pre-submit fence without a task ID, so the retry surfaced as “outcome uncertain” and hid the actual Atlas credit problem.

**How to apply:** On definite non-timeout 4xx responses, clear the operation’s empty submit marker before surfacing the error. Never retry 402; report that no Atlas task was accepted and the configured Atlas account needs provider credits or billing repair.

Atlas Asset Library records have three distinct identifiers: the numeric library record ID is for status/deletion GETs, `ark_asset_id` is the strict ASCII `asset-*` generation reference used as `asset://...`, and `atlas_asset_id` is informational. Successful responses may use a nested `data` envelope and a string application code.

**Why:** Live funded-account testing showed that string IDs fail status GETs, while Seedance ignores the numeric record ID for generation. Treating them as interchangeable makes active assets fail at dispatch.

**How to apply:** Persist the numeric and generation IDs separately, validate canonical and compatibility values with one strict grammar, reconcile known numeric records through GET, and never repeat Asset POSTs for ambiguous or already-fenced submissions.

Asset registration, outfit insertion, and character/outfit deletion must share parent-before-child locking and revalidate the exact asset snapshot before deletion.

**Why:** A provider-success/database-failure retry can duplicate an account-wide asset, while deletion racing a fenced registration or new outfit insert can orphan remote or stored assets.

**How to apply:** Persist a durable fence immediately before Asset POST; unresolved fences block retries and deletion. Serialize existing-character outfit insertion and deletion on the tenant-owned parent, then compare locked child state before deleting.

Only AI-generated fictional characters may enter the Atlas Asset Library. Uploaded, unknown-provenance, or BytePlus-verified identities must never reach Atlas through raw-image or asset paths.

**Why:** Atlas documents that real-human references require authorized assets, but its public API does not expose a KOKAO-compatible liveness/right-verification flow.

**How to apply:** Freeze provenance and provider-specific asset requirements in job snapshots, then re-check active tenant ownership at dispatch. Missing/deleted mappings fail closed. Routine local deletion requires an affirmative Atlas GET 404; compensation may attempt numeric-ID DELETE, but unsupported/ambiguous cleanup remains fenced.

Guided-created fictional cast uses immutable creation evidence, while each consuming draft independently proves current membership and approvals. Create a numbered attempt before registration, but register before funding; lock final evidence validation and funding in one transaction.

**Why:** Creation revision/role is provenance, not a lifetime binding. Equating it with a later draft breaks safe reuse, while separating validation from funding lets approval changes charge a job that cannot render.

**How to apply:** Hash approved sheet/outfit bytes, lock parent before outfit, freeze numeric and `asset-*` IDs separately, and revalidate immediately before every paid call. Initial and retry attempts serialize on the canonical recovery chain and use fresh creating leases.

Known-ID compensation and ambiguous submission are different states. A confirmed compensated record may become retryable only after GET 404; a submission with unknown provider identity never auto-replays.

**Why:** Database acknowledgement can fail after a mapping commit, and Atlas GET can fail temporarily after successful cleanup. Collapsing either case into a generic failure creates duplicates or permanent deadlocks.

**How to apply:** Preserve numeric cleanup receipts and compensation intent across transient GET failures, clear stale generation IDs after successful compensation, and keep original unknown-ID submissions permanently fenced.

Provider-returned output URLs require address-pinned HTTPS transport: validate and connect to the same public IP while preserving TLS hostname/SNI.

**Why:** DNS validation followed by ordinary fetch permits DNS rebinding between lookup and connection.

**How to apply:** Reject redirects and private/reserved addresses, cap output bytes, and enforce one deadline over headers and streamed body. Rotate across validated public CDN addresses; after a download failure, GET-refresh the same completed prediction before retrying its output URL. Never repeat the paid POST.

Node's HTTPS client can invoke a custom pinned `lookup` with `options.all=true`; in that mode the callback must receive an address array rather than scalar address/family arguments.

**Why:** Returning the scalar callback shape in all-address mode fails locally with `ERR_INVALID_IP_ADDRESS` before connecting, which looks like a CDN timeout even though the Atlas output is healthy.

**How to apply:** Every custom address-pinned HTTPS lookup must support both callback overloads, and tests must exercise the `all=true` branch.

An Atlas outfit Asset Library entry does not implicitly carry its separately registered parent character sheet into generation.

**Why:** Sending only the outfit asset to Seedance image-to-video gives the model no direct multi-view character-sheet reference, so identity can drift between independently generated scenes.

**How to apply:** Character-consistent generation must explicitly send both the approved character-sheet reference and the approved outfit reference through a model/request mode that supports multiple references.

Temporary Atlas references shared by several paid operations need durable ownership of every dependent operation before the first submit. Cleanup must claim under the same row lock used to fence submission, leave permanent per-job operation tombstones after deletion, and wait for explicit terminal prediction states.

**Why:** In-memory cleanup loses assets on process death, while age-only sweeping can delete a reference during slow activation. Removing the claim after DELETE lets a stale runner submit a deleted reference, and copying ownership into a child lets either job delete an asset still used by the other.

**How to apply:** Record all not-yet-checkpointed dependents up front. Never copy temporary ownership or its tombstones into recovery, repair, or fresh-restart children. Treat unsubmitted dependencies as cleanup-safe only at a live runner's known terminal boundary or after job terminalization; keep ambiguous submits and unknown states fenced. Reclaim interrupted processing children, and make provider DELETE 404 idempotent.

Atlas character/outfit registration leases must identify the API process that owns them. After a restart, a known numeric record in `Processing` is reclaimed immediately for GET-only activation polling; same-process claims remain exclusive.

**Why:** A restart after persisting the numeric outfit record left a fresh ten-minute lease owned by a dead worker. The next attempt correctly avoided a duplicate POST but failed before the lease aged out instead of polling the known record.

**How to apply:** Prefix asset lease owners with a process-lifetime ID. A different or legacy owner makes only known-ID `Processing` work reclaimable; unknown-ID submit fences remain blocked because GET-only recovery is impossible.

Atlas billing exposes exact UTC daily/model cost and usage buckets plus current balance, but no per-transaction charge ledger; completed prediction GETs may omit cost and token receipts.

**Why:** A live account audit could exactly reconcile whole model/day buckets, but individual task amounts had to remain estimates even after polling every known prediction ID.

**How to apply:** Compare each bucket's request count with durable accepted task IDs. Label bucket totals as exact and any per-task allocation as estimated; never invent IDs for unmatched requests or present an allocated share as an Atlas receipt.
