---
name: Leaked test tenants bloat the shared dev DB
description: Why API tests exclusively lock the shared dev DB and purge synthetic tenants before and after every run.
---
Shared-development-DB tests must prevent synthetic administrators and alerts
from entering operational fan-out, and must own their fixture lifecycle
exclusively for the duration of a run.

**Why:** killed runs and a few incomplete suite teardowns accumulated more than
3,000 synthetic tenants, including over 1,600 superadmins. Every superadmin
alert then performed thousands of sequential notification operations, turning
normally fast seat-request and provider-failover tests into an hour-scale
timeout cascade that ended with administrator-terminated DB connections.

**How to apply:** keep API test files serial/exclusive because they mutate
shared singleton configuration. Give synthetic notifications an unmistakable,
collision-proof scope and delete only that exact test-owned scope — never use
broad type-and-time cleanup that could erase a real alert. If fan-out tests
suddenly slow down, verify stale synthetic admins are absent before changing
assertions. Preserve the separate sweep-suite lock; it protects a different
shared background process.
