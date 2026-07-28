---
name: Shared Razorpay creds race in validation
description: Concurrent task validations race on the single global "razorpay" app_credentials row — suites that need it must re-seed beforeEach.
---

Several api-server suites (billing mock roundtrip, wallet roundtrip, razorpay webhook) snapshot/set/restore the SAME global `app_credentials` "razorpay" row in the shared dev DB, each with different key secrets.

**Why:** Multiple task agents run `pnpm run test` validations concurrently against the same DB. Another run's afterAll restore (possibly to null) mid-suite makes every billing route answer 503 RazorpayNotConfigured — mass spurious 400→503 failures despite passing locally.

**How to apply:** Any suite depending on the seeded razorpay row should re-seed it in a `beforeEach` (cheap upsert), not just `beforeAll`. When validation fails with 503s in razorpay-dependent tests but the suite passes alone, it's this race — re-run rather than change route code. Same pattern applies to any other global app_credentials provider row.
