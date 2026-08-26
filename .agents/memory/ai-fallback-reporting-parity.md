---
name: AI fallback reporting parity
description: Rules for keeping admin fallback diagnostics faithful to the provider routes that execution actually uses.
---

An admin fallback report must derive candidate order, limits, configuration, breaker health, capability caveats, and pricing eligibility from the same runtime helpers or predicates used by execution.

**Why:** A plausible static catalog can be dangerously misleading during outages. In particular, a stored price row does not make a video model usable when the runtime cannot compute a cost for the duration and current FX state, and provider families can have separate per-job routes rather than one global chain.

**How to apply:** For every reported family or use case, show the actual runtime attempt order and label job-selected alternatives as alternatives rather than fallbacks. Gate video eligibility with runtime cost computability for an explicitly disclosed representative duration.