// Optional read-only live Preview observation; never edits settings or balances.
import pg from "pg";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
let child;
await db.connect();
await db.query("SET default_transaction_read_only = on");
const fingerprint = async () => (await db.query(`SELECT
  (SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY id)::text,'[]')) FROM ai_cost_settings t) fx,
  (SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY id)::text,'[]')) FROM credit_meter_settings t) settings,
  (SELECT md5(coalesce(jsonb_agg(to_jsonb(t) ORDER BY id)::text,'[]')) FROM credit_rates t) rates
`)).rows[0];
try {
  const before = await fingerprint();
  child = spawn("pnpm", ["test:e2e:isolated", "--", "node",
    "artifacts/api-server/scripts/verify-browser-target.mjs"], { stdio: "inherit" });
  let done = false;
  const exit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => { done = true; resolve(code); });
  });
  let samples = 0, changed = false;
  while (!done) {
    changed ||= JSON.stringify(await fingerprint()) !== JSON.stringify(before);
    const r = await fetch(`https://${process.env.REPLIT_DEV_DOMAIN}/api/healthz`, { signal: AbortSignal.timeout(10000) });
    assert.equal(r.status, 200);
    samples++;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.equal(await exit, 0);
  assert.deepEqual(await fingerprint(), before, "Preview changed; investigate independent admin activity (do not restore).");
  assert.equal(changed, false);
  console.info(`PASS: Preview requests and settings unaffected in ${samples} read-only samples.`);
} finally {
  if (child && child.exitCode === null) child.kill("SIGTERM");
  await db.end();
}
