---
name: Shared Razorpay creds race in validation
description: Concurrent task validations race on the single global "razorpay" app_credentials row — suites that need it must re-seed beforeEach.
---

Historical context: API suites once shared Preview's singleton credentials.
API test invocations now use separate empty PostgreSQL clusters; see
[database isolation](test-database-isolation.md). Do not diagnose cross-run
credential races without first checking whether a caller bypassed isolation.

**Why:** Multiple task agents run `pnpm run test` validations concurrently against the same DB. Another run's afterAll restore (possibly to null) mid-suite makes every billing route answer 503 RazorpayNotConfigured — mass spurious 400→503 failures despite passing locally.

**How to apply:** suites should still seed their own deterministic credential
fixtures rather than depend on another suite's residue. A 503 is no longer
sufficient evidence of a cross-run race; inspect the isolated fixture first.
