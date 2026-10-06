import { E2E_BASE_URL } from "./e2e-target.mjs";
import { chromium } from "playwright";
import { readdirSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
const { Client } = createRequire(new URL("../../artifacts/api-server/package.json", import.meta.url))("pg");
const db = new Client({ connectionString: process.env.DATABASE_URL });
async function clerk(path, body, method = "POST") {
  const r = await fetch(`https://api.clerk.com/v1${path}`, {
    method, headers: { Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!r.ok) throw new Error(`Clerk test setup failed (${r.status})`);
  return r.status === 204 ? null : r.json();
}
let user, browser;
try {
  await db.connect();
  user = await clerk("/users", { email_address: [process.env.E2E_ADMIN_EMAIL],
    skip_password_requirement: true, skip_password_checks: true });
  const ticket = await clerk("/sign_in_tokens", { user_id: user.id, expires_in_seconds: 120 });
  const fallback = readdirSync("/nix/store").filter(n => !n.includes("ungoogled") && /-chromium-\d/.test(n))
    .sort((a, b) => Number(b.match(/-chromium-(\d+)/)[1]) - Number(a.match(/-chromium-(\d+)/)[1]))
    .map(n => `/nix/store/${n}/bin/chromium`).find(existsSync);
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_BIN ||
    (existsSync(chromium.executablePath()) ? chromium.executablePath() : fallback), args: ["--no-sandbox"] });
  const page = await browser.newPage();
  page.on("pageerror", error => console.error("Browser error:", error.message));
  page.on("console", message => {
    if (message.type() === "error") console.error("Browser console:", message.text().slice(0, 300));
  });
  await page.goto(E2E_BASE_URL);
  await page.waitForFunction(() => window.Clerk?.loaded, null, { timeout: 90000 });
  await page.evaluate(async token => {
    const result = await window.Clerk.client.signIn.create({ strategy: "ticket", ticket: token });
    await window.Clerk.setActive({ session: result.createdSessionId });
  }, ticket.token);
  await page.reload();
  await page.waitForFunction(() => window.Clerk?.session, null, { timeout: 30000 });
  const result = await page.evaluate(async () => {
    const headers = { "Content-Type": "application/json" };
    const me = await fetch("/api/me", { headers });
    if (!me.ok) throw new Error(`Tenant provisioning failed: ${me.status}`);
    const r = await fetch("/api/app-brand", { method: "PUT", headers,
      body: JSON.stringify({ appName: "Isolated admin edit" }) });
    return { status: r.status, body: await r.json() };
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal((await db.query("SELECT app_name FROM app_brand_settings WHERE id=1")).rows[0].app_name, "Isolated admin edit");
  console.info("PASS: Chromium loaded Clerk, signed in, and changed a singleton through the real admin route in the private database.");
} finally {
  await browser?.close();
  if (user) await clerk(`/users/${user.id}`, null, "DELETE");
  await db.end();
}
