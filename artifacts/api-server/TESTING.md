# API integration tests

Run `pnpm --filter @workspace/api-server test`. PostgreSQL 16 tools (`initdb`,
`pg_ctl`, `createdb`) must be on PATH. Tests fail closed if these are unavailable;
there is no fallback to Preview or production.

Vitest overrides the database connection before setup modules load. Each run
owns an empty local PostgreSQL cluster, reachable only on a private Unix socket
(no TCP listener). Drizzle builds its schema from source. No Preview rows,
credentials, rates, or customer balances are copied. Suites remain serial
because they share singleton fixtures within that run; concurrent invocations
use different clusters.

The scratch database starts with deterministic fixtures: FX at 8,600 paise per
USD, caption/image/video estimates at 10/100/500 paise, and the two built-in
lip-sync model prices. These are test inputs, not live rates. Tests for
unconfigured pricing explicitly clear them.

Normal teardown discards the cluster. A separate guardian discards it if the
runner is killed, including SIGKILL. A container restart also terminates local
PostgreSQL; subsequent runs always start fresh rather than reusing stale data.
No snapshot restoration writes to Preview, so concurrent admin edits survive.

Legacy `.credentials-guard-snapshot.json` files are not replayed by this runner.
Keep any pre-isolation snapshot for manual investigation, not automatic restore:
its contents may predate legitimate admin edits.

To verify Preview remains unchanged during billing tests:

```
cd artifacts/api-server
node scripts/verify-preview-billing-isolation.mjs
```

The observer uses a read-only connection and compares settings, rate-card, and
balance fingerprints during the run without printing their contents. An actual
concurrent admin edit or real customer charge will correctly flag a difference;
investigate that activity rather than restoring an old snapshot.
