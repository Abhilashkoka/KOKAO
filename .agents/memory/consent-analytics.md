---
name: Consent-gated analytics
description: Rules for the consent-based analytics pipeline (ingest enforcement, location semantics, orval hook quirk).
---

- Consent is enforced ONLY at the server ingest choke point from STORED consent; client trackers gating themselves is courtesy, never the boundary. Never add an ingest path that trusts client-sent consent flags.
  **Why:** public batch endpoint; anyone can POST arbitrary context fields.
  **How to apply:** any new gated context column must be nulled in `analyticsIngest.ts` unless the stored flag allows it.
- Location semantics: coarse = geo-IP country/region/city derived server-side from request headers; precise = client-sent lat/long, stored only under the locationPrecise flag. Clients must NOT collect GPS for coarse consent — the server drops it anyway (architect caught this as dead code on mobile).
- Anonymous senders: lifecycle allowlist only (first_open/session_start/page_view/screen_view/sign_up/login), all gated fields stripped; anonymous→user merge happens server-side on the first authenticated batch carrying the anon id.
- Orval hooks with partial `query` options require an explicit `queryKey` (e.g. `getGetConsentQueryKey()`) or TS2741.
- first_open dedupe: partial unique index on analytics_events(anonymous_id) WHERE event_name='first_open'; ingest inserts use ON CONFLICT DO NOTHING and count accepted via RETURNING, so retried/duplicate install signals are reported as dropped.
