---
name: sign_up vs consent race
description: Why immediate-send lifecycle events must check the ingest body's accepted count, not just res.ok.
---
Rule: the analytics ingest endpoint answers HTTP 200 even when stored consent drops the whole batch (`{accepted: 0}`). Any client that commits a "sent once" dedupe marker (e.g. sign_up) must require a POSITIVE acknowledgement — parsed numeric `accepted > 0`; ok-status with an empty/malformed body is NOT delivered — and must re-attempt when the stored consent loads/changes.
**Why:** lifecycle events can fire before the user answers the consent dialog; committing the marker on res.ok alone permanently loses the event for every fresh user, silently zeroing the funnel's first step.
**How to apply:** any immediately-flushed lifecycle event with a persisted dedupe marker, on web or mobile.

Related rules:
- `track()` drops events client-side only on an EXPLICIT opt-out (responded && !analytics). While the decision is unresolved (consent not loaded, or the dialog still open), events must queue and `flush()` must HOLD the batch — flushing pre-consent gets a 200/accepted:0 and silently loses the batch (e.g. onboarding_started when the dialog stays open past one flush interval). Opt-in triggers an immediate flush of held events.
- Any UI that WRITES consent must sync the tracker's in-memory consent state immediately on success — relying on query invalidation alone leaves a refetch-latency window where events fired right after consenting (e.g. an immediate skip) are silently lost.
