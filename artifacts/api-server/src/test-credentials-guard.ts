// Vitest globalSetup: snapshot & restore admin-owned configuration tables.
//
// The integration tests hit the real dev database, and several suites delete
// rows from these tables in their beforeEach hooks so they can test the
// unconfigured/default path. Without this guard, every full test run silently
// wipes configuration a superadmin saved in the admin dashboard — API keys
// ("my key gets deleted on every restart") and provider/model selections
// (an admin's video model override vanishing mid-day).
//
// fileParallelism is off (see vitest.config.ts), so a run-level snapshot here
// and a restore in teardown is race-free: no test file is still running when
// the teardown executes. A session advisory lock also prevents two separate
// API vitest invocations from racing on the same singleton rows.
//
// Crash safety: the snapshot is also persisted to a file on disk BEFORE any
// suite runs. If the vitest process is force-killed (OOM, double Ctrl-C,
// container restart) the teardown never runs — but the next run's setup finds
// the orphaned snapshot file and restores it first, so admin-entered keys
// wiped by the interrupted run come back. On a clean run the file is deleted
// in teardown after the in-memory restore succeeds.
//
// Uses its own pg client rather than the shared @workspace/db pool: another
// globalSetup teardown (or a suite's afterAll) may have already ended the
// shared pool by the time this teardown runs.
import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Admin-configuration tables tests are allowed to mutate but a run must never
 * destroy. Only add tables here that hold superadmin-entered configuration —
 * NOT tenant/test data tables, which suites intentionally clean up.
 */
const GUARDED_TABLES = [
  "app_credentials",
  "video_gen_settings",
  "image_gen_settings",
  "text_gen_settings",
  "asr_settings",
  "ads_settings",
  "plan_settings",
  "signup_credit_settings",
  "ai_cost_settings",
  "wallet_settings",
] as const;

const API_TEST_RUN_ADVISORY_LOCK_KEY = 913_874_220;

interface TableSnapshot {
  table: string;
  columns: string[];
  rows: Record<string, unknown>[];
}

interface SnapshotFile {
  version: 1;
  createdAt: string;
  snapshots: TableSnapshot[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

export function isValidSnapshotFile(value: unknown): value is SnapshotFile {
  if (!isPlainObject(value)) return false;
  if (
    value.version !== 1 ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !Array.isArray(value.snapshots)
  ) {
    return false;
  }

  const allowedTables = new Set<string>(GUARDED_TABLES);
  const seenTables = new Set<string>();
  return value.snapshots.every((snapshot) => {
    if (!isPlainObject(snapshot)) return false;
    if (
      typeof snapshot.table !== "string" ||
      !allowedTables.has(snapshot.table) ||
      seenTables.has(snapshot.table) ||
      !Array.isArray(snapshot.columns) ||
      snapshot.columns.length === 0 ||
      !Array.isArray(snapshot.rows)
    ) {
      return false;
    }
    seenTables.add(snapshot.table);

    const columns = snapshot.columns;
    const uniqueColumns = new Set(columns);
    if (
      uniqueColumns.size !== columns.length ||
      !columns.every(
        (column) =>
          typeof column === "string" &&
          /^[A-Za-z_][A-Za-z0-9_]*$/.test(column),
      )
    ) {
      return false;
    }

    return snapshot.rows.every(
      (row) =>
        isPlainObject(row) &&
        Object.keys(row).every((key) => uniqueColumns.has(key)),
    );
  });
}

// Lives next to the artifact (not os.tmpdir()) so it survives container
// restarts; gitignored via the repo root .gitignore.
const SNAPSHOT_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  ".credentials-guard-snapshot.json",
);

async function restoreSnapshots(
  client: pg.Client,
  snapshots: TableSnapshot[],
): Promise<void> {
  // Drop whatever the tests left behind (fake rows inserted by fixtures
  // would otherwise masquerade as real admin configuration) and put back
  // exactly the rows that existed before the run.
  await client.query("BEGIN");
  try {
    for (const snap of snapshots) {
      await client.query(`DELETE FROM ${snap.table}`);
      for (const row of snap.rows) {
        const cols = snap.columns.map((c) => `"${c}"`).join(", ");
        const params = snap.columns.map((_, i) => `$${i + 1}`).join(", ");
        await client.query(
          `INSERT INTO ${snap.table} (${cols}) VALUES (${params})`,
          snap.columns.map((c) => row[c]),
        );
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

/** Restore an orphaned snapshot left behind by a force-killed previous run. */
export async function restoreOrphanedSnapshot(
  client: pg.Client,
  snapshotFile = SNAPSHOT_FILE,
): Promise<void> {
  if (!fs.existsSync(snapshotFile)) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(snapshotFile, "utf8"));
  } catch {
    // Corrupt (e.g. killed mid-write). Nothing recoverable; don't let a bad
    // file block every future run.
    console.warn(
      "[credentials-guard] Ignoring corrupt orphaned snapshot file:",
      snapshotFile,
    );
    fs.rmSync(snapshotFile, { force: true });
    return;
  }
  if (!isValidSnapshotFile(parsed)) {
    console.warn(
      "[credentials-guard] Ignoring invalid orphaned snapshot file:",
      snapshotFile,
    );
    fs.rmSync(snapshotFile, { force: true });
    return;
  }
  console.warn(
    `[credentials-guard] Found orphaned snapshot from ${parsed.createdAt} ` +
      "(previous test run was killed before teardown); restoring admin configuration.",
  );
  try {
    await restoreSnapshots(client, parsed.snapshots);
  } catch (error) {
    // restoreSnapshots is transactional, so a rejected value cannot leave the
    // live configuration half-deleted. The orphan is not safely recoverable;
    // remove it so it cannot block discovery on every subsequent test run.
    console.warn(
      "[credentials-guard] Could not restore orphaned snapshot; " +
        "live configuration was left unchanged and the invalid snapshot was quarantined:",
      snapshotFile,
      error instanceof Error ? error.message : "unknown restore error",
    );
  } finally {
    fs.rmSync(snapshotFile, { force: true });
  }
}

/**
 * Remove fixtures abandoned by killed/timed-out test runs.
 *
 * Superadmin notifications fan out to every matching tenant. A few hundred
 * leaked `test_*` superadmins turn one assertion into thousands of sequential
 * DB writes and email lookups, making the full suite self-amplify into more
 * timeouts and more leaks. The run-level advisory lock guarantees no other API
 * test invocation is active while this deletes pre-existing fixtures.
 */
async function purgeSyntheticTestTenants(client: pg.Client): Promise<void> {
  const stale = await client.query<{ id: number }>(
    `SELECT id
       FROM tenants
      WHERE clerk_user_id LIKE 'test\\_%' ESCAPE '\\'`,
  );
  const tenantIds = stale.rows.map((row) => row.id);
  if (tenantIds.length === 0) return;

  await client.query("BEGIN");
  try {
    for (const [table, column] of [
      ["connected_accounts", "tenant_id"],
      ["ad_account_connections", "tenant_id"],
      ["content_items", "tenant_id"],
      ["notifications", "tenant_id"],
      ["notification_preferences", "tenant_id"],
    ] as const) {
      await client.query(
        `DELETE FROM ${table} WHERE ${column} = ANY($1::int[])`,
        [tenantIds],
      );
    }
    await client.query(
      `DELETE FROM admin_audit_logs
        WHERE actor_tenant_id = ANY($1::int[])
           OR target_tenant_id = ANY($1::int[])`,
      [tenantIds],
    );
    // seat_requests, support_requests, team_invites, and tenant_members have
    // ON DELETE CASCADE foreign keys to tenants.
    await client.query(`DELETE FROM tenants WHERE id = ANY($1::int[])`, [
      tenantIds,
    ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }

  console.warn(
    `[test-fixture-guard] Removed ${tenantIds.length} leaked test tenant fixture(s).`,
  );
}

async function purgeSyntheticFailoverNotifications(
  client: pg.Client,
): Promise<void> {
  const deleted = await client.query(
    `DELETE FROM notifications
      WHERE (
              type = 'textgen_failover'
          AND left(platform, 17) = 'textgen:__test__:'
            )
         OR (
              type = 'videogen_failover'
          AND left(platform, 18) = 'videogen:__test__:'
            )`,
  );
  if ((deleted.rowCount ?? 0) > 0) {
    console.warn(
      `[test-fixture-guard] Removed ${deleted.rowCount} leaked failover notification fixture(s).`,
    );
  }
}

export default async function credentialsGuard(): Promise<() => Promise<void>> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const snapshots: TableSnapshot[] = [];
  try {
    const lock = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS acquired",
      [API_TEST_RUN_ADVISORY_LOCK_KEY],
    );
    if (!lock.rows[0]?.acquired) {
      throw new Error(
        "Another API test run is already using the shared development database. " +
          "Wait for it to finish before starting this run.",
      );
    }

    // If a previous run died before its teardown, put its snapshot back
    // BEFORE taking ours — otherwise we'd snapshot (and later "restore")
    // the wiped state.
    await restoreOrphanedSnapshot(client);
    await purgeSyntheticFailoverNotifications(client);
    await purgeSyntheticTestTenants(client);

    for (const table of GUARDED_TABLES) {
      const res = await client.query(`SELECT * FROM ${table}`);
      snapshots.push({
        table,
        columns: res.fields.map((f) => f.name),
        rows: res.rows as Record<string, unknown>[],
      });
    }
  } catch (error) {
    await client.end();
    throw error;
  }

  // Persist before any suite runs, atomically (write temp + rename) so a
  // kill mid-write can't leave a half-written file that parses as valid.
  const fileBody: SnapshotFile = {
    version: 1,
    createdAt: new Date().toISOString(),
    snapshots,
  };
  const tmp = `${SNAPSHOT_FILE}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(fileBody));
    fs.renameSync(tmp, SNAPSHOT_FILE);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    await client.end();
    throw error;
  }

  return async () => {
    try {
      await restoreSnapshots(client, snapshots);
      await purgeSyntheticFailoverNotifications(client);
      await purgeSyntheticTestTenants(client);
      // Only after a successful restore — if the restore above threw, the file
      // stays and the next run repairs the damage. Fixture cleanup is part of
      // successful teardown too, so a cleanup failure is retried next run.
      fs.rmSync(SNAPSHOT_FILE, { force: true });
    } finally {
      try {
        await client.query("SELECT pg_advisory_unlock($1)", [
          API_TEST_RUN_ADVISORY_LOCK_KEY,
        ]);
      } finally {
        await client.end();
      }
    }
  };
}
