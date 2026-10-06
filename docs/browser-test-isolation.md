# Browser and manual E2E isolation

## Status

The database/app isolation, concurrent-request checks, and real Chromium
cookie-authentication smoke test pass. `scripts/src/e2e-admin-isolation.mjs`
creates a throwaway development Clerk user, signs in, reloads, and changes
branding through the real cookie-authenticated admin route, checking the
private database afterward. Its `finally` deletes the Clerk user.
The runner selects the newest regular Nix Chromium when `CHROMIUM_BIN` is not
provided: the previous directory-order fallback selected an older browser that
failed to retain Clerk's partitioned cookies. No authentication bypass or new
hosted test origin is needed.

The disposable frontend uses a private Vite build (not the cold development
server), clears inherited deployed Clerk proxy settings, and removes the API's
default CSP only from its frontend responses. Preview headers are unchanged.

## Required invocation

From the workspace root:

```sh
pnpm test:e2e:isolated -- node scripts/src/e2e-fx-stale.mjs <test-admin-email>
pnpm test:e2e:isolated -- node artifacts/api-server/scripts/mobile-signup-credits-e2e.mjs
pnpm test:e2e:character-dialogue
pnpm test:e2e:isolated -- node scripts/src/e2e-admin-isolation.mjs
```

The command runs inside a fresh local PostgreSQL cluster plus a private,
loopback-only API/Vite app on a random port. `E2E_BASE_URL`, `API_BASE`,
`DATABASE_URL`, and PG connection defaults all refer to that run. The frontend
and API share one origin. Nothing is mounted over the active Preview.

The API uses the normal Clerk middleware, tenant authorization, and routes.
There is no test login bypass. Use a dedicated development Clerk identity.
Configure its email through the existing `SUPERADMIN_EMAILS` setting when an
admin is needed. Authentication credentials are inherited, not printed.
The runner does not create or alter Clerk users itself; a test creating users
must delete them in its own `finally`.

Tests must seed their own tenants and singleton settings. The database contains
source schema and the API harness's deterministic pricing fixtures, **not**
Preview data. Scripts that historically relied on pre-seeded Preview fixtures
now need explicit setup within the same run. To combine setup and browser work:

```sh
pnpm test:e2e:isolated -- sh -c 'node my-fixture.mjs && node my-browser-test.mjs'
```

Import `scripts/src/e2e-target.mjs` first in any new fixture/browser script.
Use its `E2E_BASE_URL`; never use `REPLIT_DEV_DOMAIN`, port 80, a published URL,
or an independently supplied database connection for state-changing tests.
The guard checks the local socket database, live runner marker, matching app/API
origin, and the app's per-run identity endpoint before allowing script work.
There is intentionally no shared-Preview override.

The runtime does not call `serverRuntime`, so boot/periodic production workers
are not started. Paid-provider/payment/storage credentials are not inherited;
the eagerly constructed OpenAI SDK points at a disabled local endpoint.
Mock provider behavior explicitly for tests needing it. This harness is for
local admin/UI fixtures, not paid-provider live verification.

On normal exit or SIGINT/SIGTERM the runner stops the child process group,
closes the local web server and deletes its cluster. The existing database
guardian discards an abandoned cluster after a hard kill. No shared settings
are ever snapshotted or restored. Vite caches also live in the disposable
directory, not in the active app's cache.

## Entry-point audit

* All existing 14 `scripts/src/e2e-*.mjs` browser scenarios plus the new admin smoke test import the guard and
  use the private origin. This includes FX refresh and annual-plan tests,
  which change singleton settings, plus the character, onboarding, image,
  video, capacity, lost-order, and ads scenarios.
* The three `artifacts/api-server/scripts/mobile-*-e2e.mjs` programs use the
  same guard and private API. Signup/referral fixture changes cannot reach
  active settings.
* `src/test/seedMetaAdsE2E.ts` is guarded before its database imports.
* API Vitest remains on its existing independent empty-cluster harness.
* Graph/LinkedIn mock servers are local protocol mocks, not database seeders.
* `seed-prompt-kit.ts`, historical fixture quarantine, reviewed credit rollout,
  and likeness backfill are deliberate maintenance commands, not E2E setup.
  They were not run or redirected as part of this change.
* Ad-hoc SQL and externally supplied browser automation cannot be made safe
  by renaming a URL. Run them as children of this harness and import the guard.
  Never copy Preview credentials/data into fixtures, and never replay old
  shared-setting snapshots.

## Verification

```sh
# No Preview access: two independent running apps, singleton writes and requests
pnpm test:e2e:isolated -- node artifacts/api-server/scripts/verify-browser-target.mjs

# Optional: also observe the running Preview using a read-only SQL session
node artifacts/api-server/scripts/observe-preview-browser-isolation.mjs
```

The first check exercises target rejection, real API/frontend responses, and
concurrent singleton changes across two disposable apps. It proves cleanup
does not overwrite the other app's concurrent admin-setting edits without
performing a test edit on the real Preview.

The second additionally samples Preview health and hashes of FX/credit settings
and rates before, during, and after testing. It does not query or change customer
balances. If a real admin changes one of those settings during observation, the
check reports a change; investigate it, **never restore a baseline**.

Verified locally: API typecheck passed; two private apps completed 51 concurrent
edit/request samples; active Preview completed 56 read-only samples unchanged.
No enforcement run against customer balances and no production mutation.
