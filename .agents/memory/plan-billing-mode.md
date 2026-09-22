---
name: Plan default billing mode
description: How configured plan billing modes propagate to tenants and how manual overrides work
---

- Apply the configured plan billing mode, including unified credits; do not assume a saved plan still uses its built-in default. **Why:** credit rollout can override legacy quota/wallet defaults without changing a plan's identifier.
- `applyPlanBillingMode(tenantId, planId)` must be called after EVERY existing-tenant `tenants.plan` write: subscription verify, switch-to-payg, webhook activation, webhook downgrade-to-free, superadmin plan assign. New personal tenants start on Free and inherit Free's currently configured billing mode at the tenant INSERT boundary; this avoids exposing the schema's legacy quota default on the first request and makes the concurrent INSERT winner authoritative. Do not backfill existing tenants.
- **Why** fail-soft + strict lookup: a billing-mode sync failure must never fail a paid plan change, and an unknown/deleted plan id must no-op — `getPlan` falls back to the default plan, so the helper uses a strict `listPlans().find` instead.
- Manual superadmin billing-mode changes stamp `tenants.billingModeOverriddenAt`; the helper updates only `WHERE billingModeOverriddenAt IS NULL`, so a manual choice sticks across all future plan changes (no "reset to plan default" endpoint by design — flip it manually).
- **How to apply:** any new code path that changes an existing tenant's `tenants.plan` must also call `applyPlanBillingMode`, or wallet plans silently stop converting tenants. Initial provisioning instead writes both Free's id and its resolved billing mode in the same INSERT.
