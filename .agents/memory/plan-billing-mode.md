---
name: Plan default billing mode
description: How a plan's default billing mode (quota vs wallet) propagates to tenants and how manual overrides work
---

- Each plan carries `billingMode` ("quota" | "wallet"); DEFAULT_PLANS: only `payg` is wallet. Admin Plans tab exposes a "Wallet billing" switch; plan create defaults quota, update keeps previous when omitted; audit payloads include it.
- `applyPlanBillingMode(tenantId, planId)` must be called after EVERY `tenants.plan` write: subscription verify, switch-to-payg, webhook activation, webhook downgrade-to-free, superadmin plan assign. New provisioning stays free/quota — no backfill of existing tenants.
- **Why** fail-soft + strict lookup: a billing-mode sync failure must never fail a paid plan change, and an unknown/deleted plan id must no-op — `getPlan` falls back to the default plan, so the helper uses a strict `listPlans().find` instead.
- Manual superadmin billing-mode changes stamp `tenants.billingModeOverriddenAt`; the helper updates only `WHERE billingModeOverriddenAt IS NULL`, so a manual choice sticks across all future plan changes (no "reset to plan default" endpoint by design — flip it manually).
- **How to apply:** any new code path that writes `tenants.plan` must also call `applyPlanBillingMode`, or wallet plans silently stop converting tenants.
