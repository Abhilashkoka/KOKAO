---
name: Provider pricing freshness
description: Rules for scheduled refreshes and stale alerts for authoritative provider pricing snapshots.
---

Scheduled official-rate refreshes must preserve the last-known snapshot on every fetch or parse failure. Staleness is measured from the newest successful provider source timestamp, and a later success resolves and re-arms the deduplicated alert. Do not alert when no successful baseline exists.

**Why:** Failure counts reset across process restarts and can raise misleading alerts; the durable source timestamp measures the actual period during which cost tracking may have drifted. With no baseline, there is no old snapshot whose age can be stated truthfully.

**How to apply:** For provider-owned pricing catalogs, use an overlap guard, a bounded schedule, atomic replacement after complete validation, and a stale threshold longer than the normal refresh interval.