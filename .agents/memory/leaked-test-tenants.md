---
name: Leaked test tenants bloat the shared dev DB
description: Crashed api-server test runs leak `test_<uuid>` tenants (many superadmin); alert fan-out then makes sweep-notification tests slow and flaky.
---
Crashed/killed api-server test runs skip `deleteTenant` cleanup, leaking tenants
whose `clerk_user_id` starts with `test_`. Superadmin alert fan-out (sweep
fail-streak/stalled notifications) then inserts one row + email lookup per
leaked superadmin — hundreds of rows per alert — making connectionSweep tests
slow (2-5x) and their count/dedupe assertions flaky.
**Why:** hit when validation kept failing on sweep-alert tests; DB had ~300
leaked test tenants (282 superadmin) and 100k+ sweep notifications.
**How to apply:** when sweep/notification tests get slow or flaky, purge
`tenants WHERE clerk_user_id LIKE 'test_%' AND created_at < now()-interval '30 minutes'`
(plus their notifications/connections/audit rows) — but only while no test run
is active. Concurrent sessions' sweeps also resolve fail-streak alerts globally;
tests asserting unread alerts must retry the scenario on fresh tenants.
