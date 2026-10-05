// Never connect to, copy, snapshot, or restore the Preview database.
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const artifactDir = fileURLToPath(new URL("../", import.meta.url));

/** Called during config loading, before any globalSetup/app DB imports. */
export function configureTestDatabase(): void {
  const directory = path.join(os.tmpdir(), `kokao-api-test-${randomUUID()}`);
  process.env.KOKAO_TEST_DATABASE_DIR = directory;
  process.env.DATABASE_URL = `postgresql://kokao_test@localhost/kokao_test?host=${encodeURIComponent(directory)}`;
  // Cover pg clients constructed without a connectionString as well.
  process.env.PGHOST = directory;
  process.env.PGPORT = "5432";
  process.env.PGDATABASE = "kokao_test";
  process.env.PGUSER = "kokao_test";
  delete process.env.PGPASSWORD;
  delete process.env.PGSERVICE;
  delete process.env.PGSERVICEFILE;
  delete process.env.PGOPTIONS;
}

export function assertTestDatabase(): string {
  const directory = process.env.KOKAO_TEST_DATABASE_DIR;
  if (!directory || path.dirname(directory) !== os.tmpdir() ||
      !/^kokao-api-test-[0-9a-f-]{36}$/.test(path.basename(directory))) {
    throw new Error("API tests require the isolated local PostgreSQL harness.");
  }
  const expected = `postgresql://kokao_test@localhost/kokao_test?host=${encodeURIComponent(directory)}`;
  if (process.env.DATABASE_URL !== expected || process.env.PGHOST !== directory) {
    throw new Error("Refusing API tests against a non-isolated database.");
  }
  return directory;
}

export default async function isolatedDatabase(): Promise<() => Promise<void>> {
  const directory = assertTestDatabase();
  const data = path.join(directory, "data");
  fs.mkdirSync(directory, { mode: 0o700 });
  const cleanup = async () => {
    if (fs.existsSync(path.join(data, "postmaster.pid"))) {
      execFileSync("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"], { stdio: "ignore" });
    }
    fs.rmSync(directory, { recursive: true, force: true });
  };
  try {
    // Independent process survives SIGKILL of Vitest and discards only its
    // owned scratch cluster. No shared settings need to be restored.
    const guardian = spawn(process.execPath, [
      path.join(artifactDir, "scripts/test-database-guardian.mjs"),
      directory, String(process.pid),
    ], { detached: true, stdio: "ignore" });
    guardian.unref();
    execFileSync("initdb", ["-D", data, "-U", "kokao_test", "--auth-local=trust", "--auth-host=reject", "--no-locale", "--encoding=UTF8"], { stdio: "pipe" });
    execFileSync("pg_ctl", ["-D", data, "-l", path.join(directory, "postgres.log"),
      "-o", `-h '' -k '${directory}' -F -c max_connections=100`, "-w", "start"], { stdio: "pipe" });
    execFileSync("createdb", ["kokao_test"], { stdio: "pipe" });
    // Build EMPTY tables from source. Never copy customer balances, credentials,
    // or saved admin prices into enforcement tests.
    execFileSync("pnpm", ["--filter", "@workspace/db", "run", "push-force"], {
      cwd: artifactDir, stdio: "pipe", timeout: 120_000,
    });
    // Deterministic fixture, not a live FX fetch or a saved Preview rate.
    // Suites testing unconfigured FX explicitly delete this row themselves.
    execFileSync("psql", ["-X", "-v", "ON_ERROR_STOP=1", "-c", `
      INSERT INTO ai_cost_settings (id, usd_to_inr_paise) VALUES (1, 8600);
      INSERT INTO ai_spend_settings (id, caption_cost_paise, image_cost_paise, video_cost_paise)
        VALUES (1, 10, 100, 500);
      INSERT INTO wallet_settings (id, video_cost_paise) VALUES (1, 500);
      INSERT INTO ai_model_prices (kind, provider, model, usd_per_video)
        VALUES ('video', 'replicate', 'bytedance/latentsync', 0.1);
      INSERT INTO ai_model_prices (kind, provider, model, usd_per_second)
        VALUES ('video', 'replicate', 'sync/lipsync-2', 0.05);
    `], { stdio: "pipe" });
    console.info("[test-database] Empty isolated PostgreSQL ready (no Preview data copied).");
    return cleanup;
  } catch (error) {
    await cleanup();
    throw error;
  }
}
