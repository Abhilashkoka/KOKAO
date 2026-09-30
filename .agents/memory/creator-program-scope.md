---
name: Creator program scope
description: Supplied Program B boundaries and financial interpretation constraints.
---
Program B ships disabled. Subsequent requests authorized the dashboard, buyer code entry, hashed payout identities, and manual payout accounting. Automated bank transfers, KYC verification, and refund-hook wiring remain deferred.

**Why:** the payout bundle explicitly chooses human-reviewed manual payments, not a gateway integration. TDS treatment still needs the operator's accountant to confirm it.

**How to apply:** do not enable the program or send funds implicitly. A masked CSV is review-only, not bank-executable instructions: hashed account numbers cannot be recovered. Verify the full destination independently before manual payment.

The PII HMAC secret must remain stable once identities exist; changing it breaks cross-account PAN deduplication.

**Why:** stored hashes cannot be re-keyed without the original sensitive values, which are deliberately not persisted.

**How to apply:** use the secure secrets flow, fail closed without a valid key, and never rotate it casually or log raw identity input.

Consumption eligibility currently uses cumulative net credit spend after each purchase, not allocation of spend to individual purchased lots. Buyer bonus expiry inherits the shared promotional-credit bucket limitation.

**Why:** the existing credit ledger lacks per-purchase consumption lots and independent grant expiry.

**How to apply:** do not claim independent lot-level consumption or exact bonus expiry; payout readiness requires separate accounting review.