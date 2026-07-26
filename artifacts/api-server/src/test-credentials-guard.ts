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
// the teardown executes.
//
// Uses its own pg client rather than the shared @workspace/db pool: another
// globalSetup teardown (or a suite's afterAll) may have already ended the
// shared pool by the time this teardown runs.
import pg from "pg";

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
] as const;

interface TableSnapshot {
  table: string;
  columns: string[];
  rows: Record<string, unknown>[];
}

export default async function credentialsGuard(): Promise<() => Promise<void>> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const snapshots: TableSnapshot[] = [];
  try {
    for (const table of GUARDED_TABLES) {
      const res = await client.query(`SELECT * FROM ${table}`);
      snapshots.push({
        table,
        columns: res.fields.map((f) => f.name),
        rows: res.rows as Record<string, unknown>[],
      });
    }
  } finally {
    await client.end();
  }

  return async () => {
    const restore = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await restore.connect();
    try {
      // Drop whatever the tests left behind (fake rows inserted by fixtures
      // would otherwise masquerade as real admin configuration) and put back
      // exactly the rows that existed before the run.
      for (const snap of snapshots) {
        await restore.query(`DELETE FROM ${snap.table}`);
        for (const row of snap.rows) {
          const cols = snap.columns.map((c) => `"${c}"`).join(", ");
          const params = snap.columns.map((_, i) => `$${i + 1}`).join(", ");
          await restore.query(
            `INSERT INTO ${snap.table} (${cols}) VALUES (${params})`,
            snap.columns.map((c) => row[c]),
          );
        }
      }
    } finally {
      await restore.end();
    }
  };
}
