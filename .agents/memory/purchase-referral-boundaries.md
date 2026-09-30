---
name: Purchase referral accounting boundaries
description: Uploaded Program A business semantics and compatibility constraints.
---
Preserve the uploaded ladder's qualifying-purchase count, not distinct referred workspaces. The fifth rewarded purchase still uses the initial rung; the sixth uses the next rung.

**Why:** the supplied setup explicitly defines purchase-count boundaries despite naming thresholds “referrals.”

**How to apply:** label customer/admin counts as purchases. Do not silently reinterpret thresholds during later reporting work.

Referral expiry currently inherits the aggregate promotional-credit bucket policy; later or nonexpiring balances can extend an individual award's effective lifetime.

**Why:** changing this silently would risk existing credit balances; per-grant expiry requires a separate accounting migration. Refund clawback was explicitly excluded from the supplied bundle.

**How to apply:** do not promise exact per-award expiry or automatic refund reversals until those systems exist.

Paid-event replays must reach independently idempotent referral settlement even when purchase credits were already applied.

**Why:** a transient referral failure must not be permanently hidden behind the original purchase ledger's duplicate guard.

**How to apply:** keep canonical paid verification on replay, but do not skip all downstream hooks just because the original credit grant is a duplicate.