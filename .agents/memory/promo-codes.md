---
name: Promo codes module
description: Design invariants for the promo code / credit redemption feature.
---

- All redemption eligibility checks AND the credit grant run in ONE transaction holding `SELECT ... FOR UPDATE` on the promo row. **Why:** concurrent submits (double-click, replays) must serialize per code so a capped code can never be oversubscribed or double-credited — verified by a parallel-redeem test. **How to apply:** never move a check or the grant outside that transaction; any new eligibility rule goes inside it.
- Codes are stored and matched in trimmed UPPERCASE only (`normalizePromoCode`); generated codes use an unambiguous alphabet (no 0/O/1/I/L).
- Admin "delete" is a soft deactivate (active=false), keeping redemption history and attribution intact.
- Rejected attempts are logged best-effort to `promo_redemption_failures` — logging must never fail or block the request.
- New admin audit actions must be added in THREE places: `AdminAuditAction` in lib/adminAudit.ts, the `AUDIT_ACTIONS` filter set in routes/admin.ts, and `AUDIT_ACTION_LABELS` in the admin audit tab — the filter set silently rejects unknown actions otherwise.

## Referral codes (gamification layer)
- Personal referral codes ARE promo codes (campaign "referral", ownerTenantId set); referrer payout happens inside the same redemption transaction.
- **Kill switch rule:** when referrals are off (globally or for the owner's plan), redemption must be REJECTED entirely (`referrals_disabled`), not just zero the referrer cut — otherwise circulating codes keep minting referee credits while "disabled".
- One ACTIVE referral code per owner is enforced by a partial unique index (ownerTenantId where campaign='referral' AND active); minting uses onConflictDoNothing + re-select to survive concurrent first requests.
