---
name: Atlas Cloud provider
description: Safety and lifecycle rules for Atlas Cloud video generation and fictional-character assets.
---

Atlas Cloud is a distinct paid video provider; never reuse BytePlus model contracts, credentials, task IDs, prices, or asset IDs for it.

**Why:** Atlas is an aggregator with its own asynchronous prediction API and account-wide Asset Library. Marketing model names do not imply identical provider behavior.

**How to apply:** Fence every paid submit durably before POST, save accepted prediction IDs immediately, resume polling instead of resubmitting, and send unknown-cost events as NULL. Activation requires an authoritative price.

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