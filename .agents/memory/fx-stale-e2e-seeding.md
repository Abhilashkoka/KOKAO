---
name: FX stale-alert e2e seeding
description: Seeding a stale fx-rate alert for browser verification; the api-server boot sweep un-seeds it.
---
Rule: the api-server runs an fx-rate refresh ~30s after every boot; a successful boot refresh resets rate_auto_updated_at AND marks all unread fx_rate_stale notifications read. Seed the stale state (old rate_auto_updated_at on ai_cost_settings id=1, unread fx_rate_stale notification for the superadmin tenant) AFTER the workflow has been up >30s, not before a restart.
**Why:** first e2e run failed with "banner missing" because the restart's boot sweep resolved the seeded alert before the browser loaded.
**How to apply:** restart workflows first, wait for the boot refresh, then seed and drive the browser. The notification banner only refetches on explicit query invalidation — the Refresh-now button's onSuccess must invalidate the notifications query key or the banner never clears live.
