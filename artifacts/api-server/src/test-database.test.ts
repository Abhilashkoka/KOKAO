import { spawn } from "node:child_process";
import fs from "node:fs";
import { once } from "node:events";
import pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { assertTestDatabase } from "./test-database";

describe("isolated API database lifecycle", () => {
  it("fails closed if a caller substitutes a non-isolated connection", () => {
    vi.stubEnv("DATABASE_URL", "postgresql://example.invalid/preview");
    try { expect(() => assertTestDatabase()).toThrow("non-isolated"); }
    finally { vi.unstubAllEnvs(); }
  });

  it.each(["clean", "killed"])("preserves concurrent admin edits with %s teardown", async (exitMode) => {
    // The parent is ALSO disposable. This regression never mutates Preview.
    const parent = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await parent.connect();
    await parent.query(`INSERT INTO credit_meter_settings (id, mode) VALUES (1, 'shadow')
      ON CONFLICT (id) DO UPDATE SET mode = 'shadow'`);
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import setup, { configureTestDatabase } from './src/test-database.ts';
      import pg from 'pg';
      configureTestDatabase();
      const cleanup = await setup();
      const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
      const { rows } = await client.query('SELECT count(*)::int AS n FROM tenants');
      if (rows[0].n !== 0) throw new Error('customer rows were copied');
      await client.query("INSERT INTO credit_meter_settings (id, mode) VALUES (1, 'enforce')");
      await client.query("INSERT INTO credit_rates (key, label, credits_milli) VALUES ('isolated_probe', 'Test', 1)");
      await client.end();
      console.log('READY:' + process.env.KOKAO_TEST_DATABASE_DIR);
      process.stdin.once('data', async () => { await cleanup(); process.exit(0); });
    `], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    const ready = new Promise<string>((resolve, reject) => {
      child.stdout.on("data", (chunk) => {
        output += String(chunk);
        const match = output.match(/READY:([^\n]+)/);
        if (match) resolve(match[1]);
      });
      child.once("exit", () => reject(new Error("isolation child exited before readiness")));
      child.once("error", reject);
    });
    // Drain without logging potentially sensitive error details.
    child.stderr.resume();
    try {
      const directory = await ready;
      expect((await parent.query("SELECT mode FROM credit_meter_settings WHERE id = 1")).rows[0].mode).toBe("shadow");
      expect((await parent.query("SELECT * FROM credit_rates WHERE key = 'isolated_probe'")).rowCount).toBe(0);
      // Represent an admin edit while the test run is in flight.
      await parent.query("UPDATE credit_meter_settings SET mode = 'off' WHERE id = 1");
      const exited = once(child, "exit");
      if (exitMode === "killed") child.kill("SIGKILL");
      else child.stdin.end("stop");
      await exited;
      await vi.waitFor(() => expect(fs.existsSync(directory)).toBe(false), { timeout: 10_000, interval: 100 });
      expect((await parent.query("SELECT mode FROM credit_meter_settings WHERE id = 1")).rows[0].mode).toBe("off");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await parent.query("DELETE FROM credit_meter_settings WHERE id = 1");
      await parent.end();
    }
  }, 60_000);
});
