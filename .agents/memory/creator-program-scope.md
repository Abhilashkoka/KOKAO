---
name: Creator program scope
description: Supplied Program B boundaries and financial interpretation constraints.
---
Program B ships disabled. Subsequent requests authorized the dashboard, buyer code entry, hashed payout identities, manual payout accounting, and refund reconciliation. Automated bank transfers and KYC verification remain deferred.

**Why:** the payout bundle explicitly chooses human-reviewed manual payments, not a gateway integration. TDS treatment still needs the operator's accountant to confirm it.

**How to apply:** do not enable the program or send funds implicitly. A masked CSV is review-only, not bank-executable instructions: hashed account numbers cannot be recovered. Verify the full destination independently before manual payment.

The PII HMAC secret must remain stable once identities exist; changing it breaks cross-account PAN deduplication.

**Why:** stored hashes cannot be re-keyed without the original sensitive values, which are deliberately not persisted.

**How to apply:** use the secure secrets flow, fail closed without a valid key, and never rotate it casually or log raw identity input.

Consumption eligibility currently uses cumulative net credit spend after each purchase, not allocation of spend to individual purchased lots. Buyer bonus expiry inherits the shared promotional-credit bucket limitation.

**Why:** the existing credit ledger lacks per-purchase consumption lots and independent grant expiry.

**How to apply:** do not claim independent lot-level consumption or exact bonus expiry; payout readiness requires separate accounting review.

Refund reconciliation leaves buyer and referral bonus credits untouched by explicit bundle policy. In-flight payout ambiguity requires operator reconciliation rather than automatic reversal.

**Why:** an exported manual batch does not prove whether funds moved; clawing it back without knowing can double-deduct or miss money.

**How to apply:** retain durable refund review records and block affected new batches until resolved. Do not infer bank matches from VPAs, opaque card IDs, or last four digits; compare only identifiers of the same meaning and normalization.