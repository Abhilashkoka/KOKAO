import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Deliberately no "allow shared Preview" override. Import before any seeding.
export function assertE2ETarget(env = process.env) {
  const dir = env.KOKAO_TEST_DATABASE_DIR;
  const fail = () => { throw new Error("Refusing E2E writes outside the disposable app. Use pnpm test:e2e:isolated -- <command> [args]."); };
  if (!dir || path.dirname(dir) !== os.tmpdir() ||
      !/^kokao-api-test-[0-9a-f-]{36}$/.test(path.basename(dir))) fail();
  const expected = `postgresql://kokao_test@localhost/kokao_test?host=${encodeURIComponent(dir)}`;
  if (env.DATABASE_URL !== expected || env.PGHOST !== dir ||
      env.PGDATABASE !== "kokao_test" || env.PGUSER !== "kokao_test") fail();
  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(path.join(dir, "browser-target.json"), "utf8"));
    process.kill(marker.pid, 0);
  } catch { fail(); }
  if (!/^http:\/\/localhost:\d+$/.test(marker.base) ||
      env.E2E_BASE_URL !== marker.base || env.API_BASE !== `${marker.base}/api`) fail();
  return marker.base;
}

export const E2E_BASE_URL = assertE2ETarget();
const marker = JSON.parse(fs.readFileSync(path.join(process.env.KOKAO_TEST_DATABASE_DIR, "browser-target.json"), "utf8"));
const response = await fetch(`${E2E_BASE_URL}/__e2e_target`, { signal: AbortSignal.timeout(5000), redirect: "error" });
if (!response.ok || (await response.json()).token !== marker.token) {
  throw new Error("Disposable app identity mismatch; refusing E2E writes.");
}
