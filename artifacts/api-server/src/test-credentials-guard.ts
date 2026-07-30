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
] as const;

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
}

/** Restore an orphaned snapshot left behind by a force-killed previous run. */
async function restoreOrphanedSnapshot(client: pg.Client): Promise<void> {
  if (!fs.existsSync(SNAPSHOT_FILE)) return;
  let parsed: SnapshotFile;
  try {
    parsed = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, "utf8")) as SnapshotFile;
  } catch {
    // Corrupt (e.g. killed mid-write). Nothing recoverable; don't let a bad
    // file block every future run.
    console.warn(
      "[credentials-guard] Ignoring corrupt orphaned snapshot file:",
      SNAPSHOT_FILE,
    );
    fs.rmSync(SNAPSHOT_FILE, { force: true });
    return;
  }
  if (parsed.version !== 1 || !Array.isArray(parsed.snapshots)) {
    fs.rmSync(SNAPSHOT_FILE, { force: true });
    return;
  }
  console.warn(
    `[credentials-guard] Found orphaned snapshot from ${parsed.createdAt} ` +
      "(previous test run was killed before teardown); restoring admin configuration.",
  );
  await restoreSnapshots(client, parsed.snapshots);
  fs.rmSync(SNAPSHOT_FILE, { force: true });
}

export default async function credentialsGuard(): Promise<() => Promise<void>> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const snapshots: TableSnapshot[] = [];
  try {
    // If a previous run died before its teardown, put its snapshot back
    // BEFORE taking ours — otherwise we'd snapshot (and later "restore")
    // the wiped state.
    await restoreOrphanedSnapshot(client);

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

  // Persist before any suite runs, atomically (write temp + rename) so a
  // kill mid-write can't leave a half-written file that parses as valid.
  const fileBody: SnapshotFile = {
    version: 1,
    createdAt: new Date().toISOString(),
    snapshots,
  };
  const tmp = `${SNAPSHOT_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(fileBody));
  fs.renameSync(tmp, SNAPSHOT_FILE);

  return async () => {
    const restore = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await restore.connect();
    try {
      await restoreSnapshots(restore, snapshots);
    } finally {
      await restore.end();
    }
    // Only after a successful restore — if the restore above threw, the file
    // stays and the next run repairs the damage.
    fs.rmSync(SNAPSHOT_FILE, { force: true });
  };
}
