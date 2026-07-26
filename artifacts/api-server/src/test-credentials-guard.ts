// Vitest globalSetup: snapshot & restore the app_credentials table.
//
// The integration tests hit the real dev database, and several suites delete
// provider-key rows (videogen_%, imagegen_%, asr_%, stock_%, textgen_%) in
// their beforeEach hooks so they can test the unconfigured path. Without this
// guard, every full test run silently wipes API keys a superadmin saved in
// the admin dashboard — which looks to the user like "my key gets deleted on
// every restart".
//
// fileParallelism is off (see vitest.config.ts), so a run-level snapshot here
// and a restore in teardown is race-free: no test file is still running when
// the teardown executes.
//
// Uses its own pg client rather than the shared @workspace/db pool: another
// globalSetup teardown (or a suite's afterAll) may have already ended the
// shared pool by the time this teardown runs.
import pg from "pg";

interface CredRow {
  provider: string;
  encrypted_credentials: string;
  last_test_status: string | null;
  last_tested_at: Date | null;
  last_test_error: string | null;
  created_at: Date;
  updated_at: Date;
}

export default async function credentialsGuard(): Promise<() => Promise<void>> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const snapshot = (await client.query<CredRow>("SELECT * FROM app_credentials")).rows;
  await client.end();

  return async () => {
    const restore = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await restore.connect();
    try {
      // Drop whatever the tests left behind (fake keys inserted by fixtures
      // would otherwise masquerade as real admin configuration) and put back
      // exactly the rows that existed before the run.
      await restore.query("DELETE FROM app_credentials");
      for (const row of snapshot) {
        await restore.query(
          `INSERT INTO app_credentials
             (provider, encrypted_credentials, last_test_status, last_tested_at, last_test_error, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            row.provider,
            row.encrypted_credentials,
            row.last_test_status,
            row.last_tested_at,
            row.last_test_error,
            row.created_at,
            row.updated_at,
          ],
        );
      }
    } finally {
      await restore.end();
    }
  };
}
