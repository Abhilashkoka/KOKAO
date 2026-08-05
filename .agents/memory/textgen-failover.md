---
name: Text-gen outage failover
description: How text generation fails over to builtin on provider outages without weakening no-silent-fallback.
---

Text generation (openrouter/replicate) fails over ONLY to the built-in provider on TRANSIENT errors (429/5xx/network) or an open breaker — never on misconfiguration (still 503) or permanent 4xx errors.

**Why:** the no-silent-fallback design must survive: builtin is the only always-configured target with an admin-approved model set, and cross-mapping OpenRouter↔Replicate model ids is unsafe.

**How to apply:**
- The failover wrapper mutates the shared client object's provider/model so cost capture bills the provider that actually served — call sites must keep passing that same object to cost capture.
- Pricing gate: no price row for the substitute → no failover.
- Admin alerts and their auto-resolve on recovery are scoped PER failing provider (`textgen:<provider>` key); resolving must never clear another provider's live outage banner.
- Surfaces that exist to show the true provider behavior (admin playground) must opt out of failover.
