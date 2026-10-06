import { E2E_BASE_URL, assertE2ETarget } from "../../../scripts/src/e2e-target.mjs";
import pg from "pg";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
try {
  for (const overrides of [
    { E2E_BASE_URL: "http://localhost:80" },
    { DATABASE_URL: "postgresql://localhost/preview" },
    { API_BASE: "https://preview.invalid/api" },
    { KOKAO_TEST_DATABASE_DIR: undefined },
  ]) assert.throws(() => assertE2ETarget({ ...process.env, ...overrides }), /Refusing/);
  const before = await db.query("SELECT usd_to_inr_paise FROM ai_cost_settings WHERE id=1");
  assert.equal(before.rows[0].usd_to_inr_paise, 8600);
  const health = await fetch(`${E2E_BASE_URL}/api/healthz`);
  assert.equal(health.status, 200);
  const html = await (await fetch(E2E_BASE_URL)).text();
  assert.match(html, /id="root"/);
  // A second disposable app represents an independent admin session. Changing
  // its singleton repeatedly must not affect this app, even during requests.
  if (process.argv.includes("--inner")) {
    await db.query("UPDATE ai_cost_settings SET usd_to_inr_paise=9999 WHERE id=1");
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.equal((await db.query("SELECT usd_to_inr_paise FROM ai_cost_settings WHERE id=1")).rows[0].usd_to_inr_paise, 9999);
  } else {
    const child = spawn("pnpm", ["test:e2e:isolated", "--", "node",
      "artifacts/api-server/scripts/verify-browser-target.mjs", "--inner"], { stdio: "inherit" });
    let ended = false;
    const exit = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", code => { ended = true; resolve(code); });
    });
    let samples = 0;
    while (!ended) {
      // Legitimate concurrent admin edits in this independent app survive the
      // other run's setup, mutations, and cleanup (no snapshot restore).
      const value = 8700 + samples++;
      await db.query("UPDATE ai_cost_settings SET usd_to_inr_paise=$1 WHERE id=1", [value]);
      assert.equal((await fetch(`${E2E_BASE_URL}/api/healthz`)).status, 200);
      assert.equal((await db.query("SELECT usd_to_inr_paise FROM ai_cost_settings WHERE id=1")).rows[0].usd_to_inr_paise, value);
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    assert.equal(await exit, 0);
    const value = 8700 + samples - 1;
    assert.equal((await db.query("SELECT usd_to_inr_paise FROM ai_cost_settings WHERE id=1")).rows[0].usd_to_inr_paise, value);
    console.info(`PASS: independent singleton edits and HTTP requests survived ${samples} concurrent samples.`);
  }
  assert.ok(fs.existsSync(path.join(process.env.KOKAO_TEST_DATABASE_DIR, "browser-target.json")));
} finally { await db.end(); }
