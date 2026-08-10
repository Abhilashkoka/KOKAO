---
name: Activation funnel instrumentation
description: Rules for adding steps/metrics to the superadmin activation funnel and client analytics events.
---

- The funnels endpoint counts DISTINCT actors per step, so duplicate client events are harmless there — but don't rely on that elsewhere.
- OAuth "status flip" polling effects (X/LinkedIn/YouTube/Threads on the Accounts page) fire immediately on a RECONNECT because the cached status is already `connected: true`. Any analytics emit in those effects must be gated on a pre-flow `wasConnectedRef` captured in the connect handler, or cancelled reconnects count as fresh connections.
- The funnel array is strictly sequential (drop-off is clamped at 0%). A count that can legitimately exceed earlier steps (e.g. "connected an account" — can happen anytime) must be returned as an independent field (`accountsConnected`), never inserted as a funnel step.
- `avgTimeBetween(fromEvent, toEvent)` helper in the funnels route computes avg seconds between each user's first occurrences (causally ordered); reuse it for new time metrics instead of new inline SQL.

**Why:** architect review caught both the reconnect inflation and the misleading drop-off when the step was inline.
