// This entrypoint is bundled separately; it is never part of the Preview server.
import { configureTestDatabase, default as isolatedDatabase } from "../src/test-database";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import http from "node:http";
import { createRequire } from "node:module";

// Do not pass provider, storage, payment, or shared database credentials to tests.
const keep = new Set(["PATH", "HOME", "TMPDIR", "LANG", "TERM", "CHROMIUM_BIN",
  "CLERK_SECRET_KEY", "CLERK_PUBLISHABLE_KEY", "CLERK_PROXY_URL",
  "VITE_CLERK_PUBLISHABLE_KEY", "VITE_CLERK_PROXY_URL", "SUPERADMIN_EMAILS"]);
for (const key of Object.keys(process.env)) if (!keep.has(key)) delete process.env[key];
process.env.NODE_ENV = "test";
// Development Clerk instances use their FAPI directly, never the deployed proxy.
delete process.env.CLERK_PROXY_URL;
process.env.VITE_CLERK_PROXY_URL = "";
process.env.SESSION_SECRET = randomUUID();
// Directory order can select old/ungoogled Chromium builds whose cookie
// behavior breaks Clerk. Give every legacy browser script the same modern binary.
if (!process.env.CHROMIUM_BIN && fs.existsSync("/nix/store")) {
  process.env.CHROMIUM_BIN = fs.readdirSync("/nix/store")
    .filter(name => !name.includes("ungoogled") && /-chromium-\d/.test(name))
    .sort((a, b) => Number(b.match(/-chromium-(\d+)/)![1]) - Number(a.match(/-chromium-(\d+)/)![1]))
    .map(name => path.join("/nix/store", name, "bin/chromium"))
    .find(file => fs.existsSync(file));
  if (!process.env.CHROMIUM_BIN) delete process.env.CHROMIUM_BIN;
}
process.env.E2E_ADMIN_EMAIL = `e2e-isolation-${randomUUID()}@example.com`;
process.env.SUPERADMIN_EMAILS = [process.env.SUPERADMIN_EMAILS, process.env.E2E_ADMIN_EMAIL].filter(Boolean).join(",");
// Satisfy eager SDK construction without granting access to a paid provider.
process.env.AI_INTEGRATIONS_OPENAI_BASE_URL = "http://127.0.0.1:1/disabled";
process.env.AI_INTEGRATIONS_OPENAI_API_KEY = "isolated-test-disabled";
configureTestDatabase();
const cleanup = await isolatedDatabase();
let server: http.Server | undefined;
let child: ReturnType<typeof spawn> | undefined;
let stopping = false;
async function stop(code: number) {
  if (stopping) return;
  stopping = true;
  if (child?.pid) {
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ }
  }
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
  await cleanup();
  process.exit(code);
}
process.on("SIGTERM", () => void stop(143));
process.on("SIGINT", () => void stop(130));
try {
  // Import only after the database and safe environment are in place.
  const { default: app } = await import("../src/app");
  const frontRequire = createRequire(path.resolve("artifacts/socialforge/package.json"));
  const { build } = await import(frontRequire.resolve("vite"));
  const { default: express } = await import("express");
  const baseToken = randomUUID();
  app.get("/__e2e_target", (_req, res) => res.json({ token: baseToken }));
  const outputDir = path.join(process.env.KOKAO_TEST_DATABASE_DIR!, "web");
  process.env.NODE_ENV = "production";
  const viteConfig = {
    configFile: false,
    cacheDir: path.join(process.env.KOKAO_TEST_DATABASE_DIR!, "vite-cache"),
    root: path.resolve("artifacts/socialforge"),
    base: "/",
    mode: "production",
    // NODE_ENV=test is for the API, not browser SDKs (which disable cookie
    // persistence in test mode). Keep real browser behavior in the private SPA.
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: { outDir: outputDir, emptyOutDir: true },
    plugins: [(await import(frontRequire.resolve("@vitejs/plugin-react"))).default(),
      (await import(frontRequire.resolve("@tailwindcss/vite"))).default()],
    resolve: {
      alias: { "@": path.resolve("artifacts/socialforge/src"), "@assets": path.resolve("attached_assets") },
      dedupe: ["react", "react-dom"],
    },
    appType: "spa" as const,
  };
  await build(viteConfig);
  process.env.NODE_ENV = "test";
  // API Helmet defaults are not a frontend policy: they block Vite's inline
  // bootstrap and Clerk's SDK. Remove CSP only for the disposable frontend.
  // This middleware is not imported by Preview or production.
  app.use((_req, res, next) => {
    res.removeHeader("Content-Security-Policy");
    next();
  });
  app.use(express.static(outputDir));
  app.use((_req, res) => res.sendFile(path.join(outputDir, "index.html")));
  server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as { port: number };
  const base = `http://localhost:${address.port}`;
  process.env.E2E_BASE_URL = base;
  process.env.API_BASE = `${base}/api`;
  fs.writeFileSync(path.join(process.env.KOKAO_TEST_DATABASE_DIR!, "browser-target.json"),
    JSON.stringify({ pid: process.pid, base, token: baseToken }), { mode: 0o600 });
  console.info(`[browser-tests] Disposable app ready at ${base}; Preview is not a test target.`);
  const args = process.argv.slice(2).filter((arg, index) => index !== 0 || arg !== "--");
  if (!args.length) {
    console.info("[browser-tests] Supply a command (for example: node scripts/src/e2e-fx-stale.mjs <test-admin-email>).");
    await stop(2);
  } else {
    child = spawn(args[0], args.slice(1), { stdio: "inherit", env: process.env, detached: true });
    child.once("error", () => void stop(1));
    child.once("exit", (code) => void stop(code ?? 1));
  }
} catch (error) {
  console.error(error);
  await stop(1);
}
