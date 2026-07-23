---
name: Per-tenant row caps
description: Enforcing "max N rows per tenant" caps race-safely
---

Rule: never enforce a per-tenant cap with a plain SELECT count followed by an INSERT — parallel requests both pass the check and exceed the cap. Wrap count + insert in one transaction that first locks the tenant row (`SELECT id FROM tenants WHERE id = $tenant FOR UPDATE`).

**Why:** code review flagged the race on the characters (5) and visual-assets (7) caps; concurrent creates could bypass both.

**How to apply:** any "max N per tenant" endpoint. If the create path spends quota/credits before insert (e.g. AI generation), keep a fast pre-check before spending, and on cap-fail inside the tx refund the spent funding. Cover with a Promise.all concurrency test asserting exactly N rows created.
