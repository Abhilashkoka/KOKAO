// Read-only observation of Preview while a separately isolated billing run
// executes. No values, identifiers, or connection strings are printed.
import pg from "pg";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
await client.query("SET default_transaction_read_only = on");
const fingerprint = async () => (await client.query(`
  SELECT
    (SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY id)::text, '[]')) FROM credit_meter_settings t) AS settings,
    (SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY id)::text, '[]')) FROM credit_rates t) AS rates,
    (SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY tenant_id)::text, '[]')) FROM credit_accounts t) AS balances
`)).rows[0];
try {
  const baseline = await fingerprint();
  const child = spawn("pnpm", ["exec", "vitest", "run",
    "src/lib/creditEnforcement.test.ts", "src/lib/meter.test.ts",
    "src/lib/creditRates.transaction.test.ts", "src/routes/credits.test.ts",
    "src/lib/videoGen/funding.test.ts", "src/test-database.test.ts",
    "src/test-credentials-guard.test.ts",
  ], { stdio: "inherit" });
  let done = false;
  const exit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => { done = true; resolve(code); });
  });
  let samples = 0;
  let changed = false;
  while (!done) {
    changed ||= JSON.stringify(await fingerprint()) !== JSON.stringify(baseline);
    samples++;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(await exit, 0, "Billing tests failed");
  assert.deepEqual(await fingerprint(), baseline, "Preview billing changed after testing");
  assert.equal(changed, false, "Preview billing changed during testing (check for concurrent admin activity)");
  console.log(`Preview settings, rates and credit balances unchanged across ${samples} read-only samples.`);
} finally {
  await client.end();
}
