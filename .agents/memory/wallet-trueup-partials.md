---
name: Wallet true-up partial collections
description: Invariants for after-the-fact price true-ups when a wallet can't cover the shortfall
---

Rule: never stamp a wallet charge as trued-up unless the shortfall was FULLY collected. A partial collection (clamped-at-zero wallet) must leave the row pending so a later trigger (boot sweep, price re-save, the tenant's next top-up) collects the remainder — silence is forgiveness.

**Why:** the balance-clamping ledger discipline means a requested debit can apply only partially; stamping regardless permanently forgave the rest.

**How to apply:** any retryable collection path must (1) count prior partial collections against the same reservation as already-charged, computed inside the same transaction that locks the target row (or concurrent triggers double-collect), and (2) be tenant-scoped when triggered by one tenant's payment — a top-up must never move another tenant's money.
