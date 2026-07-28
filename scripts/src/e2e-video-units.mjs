/* eslint-disable no-console */
// Browser e2e for task 708: multiplied AI amount for multi-scene video jobs.
// Usage: node scripts/src/e2e-video-units.mjs <email> <phase>
// phase 1: seed rate 750, jobs (4-unit + 1-unit) -> expect ₹30.00 and ₹7.50
// phase 2: rate zero -> line hidden
// phase 3: rate 750 back, aiSpend flag OFF -> line hidden
import { chromium } from "playwright";
import { execSync } from "node:child_process";

const email = process.argv[2];
const phase = process.argv[3] || "1";
if (!email) {
  console.error("usage: node e2e-video-units.mjs <email> <phase>");
  process.exit(2);
}
const BASE = `https://${process.env.REPLIT_DEV_DOMAIN}`;
const CLERK_KEY = process.env.CLERK_SECRET_KEY;

const psql = (q) =>
  execSync(`psql "$DATABASE_URL" -t -A -c ${JSON.stringify(q.replace(/\s+/g, " "))}`)
    .toString()
    .trim();

async function clerkApi(path, body) {
  const res = await fetch(`https://api.clerk.com/v1${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${CLERK_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`clerk ${path} ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

async function getOrCreateUser() {
  const listRes = await fetch(
    `https://api.clerk.com/v1/users?email_address=${encodeURIComponent(email)}`,
    { headers: { Authorization: `Bearer ${CLERK_KEY}` } },
  );
  const list = await listRes.json();
  if (Array.isArray(list) && list.length > 0) return list[0];
  return clerkApi("/users", {
    email_address: [email],
    first_name: "Vid",
    last_name: "Units",
    skip_password_requirement: true,
  });
}

const shot = async (page, name) => {
  await page.screenshot({ path: `/tmp/e2e-vu-${phase}-${name}.png` });
  console.log(`[shot] /tmp/e2e-vu-${phase}-${name}.png`);
};

const dismissDialogs = async (page) => {
  await page.waitForTimeout(3500);
  for (let i = 0; i < 6; i++) {
    const dlg = page.locator('[role="dialog"]');
    if ((await dlg.count()) === 0) break;
    const btn = dlg.first().locator("button", { hasText: /^(continue|close|skip|got it|not now)/i });
    if ((await btn.count()) > 0) await btn.first().click().catch(() => {});
    else await page.keyboard.press("Escape");
    await page.waitForTimeout(1000);
  }
};

const main = async () => {
  const user = await getOrCreateUser();
  const token = await clerkApi("/sign_in_tokens", { user_id: user.id, expires_in_seconds: 600 });

  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_BIN || "chromium",
    args: ["--no-sandbox"],
  });
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 900 } })).newPage();
  page.on("console", (m) => {
    if (m.type() === "error") console.log("[console.error]", m.text().slice(0, 200));
  });

  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.Clerk && window.Clerk.loaded, null, { timeout: 60000 });
  const signedIn = await page.evaluate(async (ticket) => {
    if (window.Clerk.user) return "already";
    const res = await window.Clerk.client.signIn.create({ strategy: "ticket", ticket });
    if (res.status !== "complete") return `status:${res.status}`;
    await window.Clerk.setActive({ session: res.createdSessionId });
    return "complete";
  }, token.token);
  console.log("[clerk] sign-in:", signedIn);
  if (signedIn !== "complete" && signedIn !== "already") throw new Error("sign-in failed");

  // Resolve tenant by lowercased email, polling (provisioning may lag).
  let tenantId = "";
  for (let i = 0; i < 15 && !tenantId; i++) {
    tenantId = psql(`SELECT id FROM tenants WHERE lower(email) = lower('${email}')`);
    if (!tenantId) {
      await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2000);
    }
  }
  if (!tenantId) throw new Error("tenant not provisioned");
  console.log("[db] tenant", tenantId);

  // Phase-specific seeding.
  if (phase === "1") {
    psql(`UPDATE ai_spend_settings SET video_cost_paise = 750, fee_percent = 0`);
    psql(`DELETE FROM feature_flags WHERE feature = 'aiSpend'`);
    psql(`DELETE FROM video_generations WHERE tenant_id = ${tenantId}`);
    psql(`INSERT INTO video_generations (tenant_id, engine, status, prompt, options, video_path, funding, wallet_reserved_units)
      VALUES (${tenantId}, 'text_to_video', 'succeeded', 'multi scene character epic',
        '{"aspectRatio":"9:16","durationSec":5,"shotCount":4}', '/objects/${tenantId}/uploads/multi.mp4', 'wallet', 4)`);
    psql(`INSERT INTO video_generations (tenant_id, engine, status, prompt, options, video_path)
      VALUES (${tenantId}, 'text_to_video', 'succeeded', 'single shot clip',
        '{"aspectRatio":"9:16","durationSec":5,"shotCount":1}', '/objects/${tenantId}/uploads/single.mp4')`);
  } else if (phase === "2") {
    psql(`UPDATE ai_spend_settings SET video_cost_paise = 0`);
  } else if (phase === "3") {
    psql(`UPDATE ai_spend_settings SET video_cost_paise = 750`);
    psql(`INSERT INTO feature_flags (feature, enabled) VALUES ('aiSpend', false)
      ON CONFLICT (feature) DO UPDATE SET enabled = false`);
  }
  const jobIds = psql(
    `SELECT id, prompt FROM video_generations WHERE tenant_id = ${tenantId} ORDER BY id`,
  ).split("\n");
  const multiId = jobIds.find((l) => l.includes("multi"))?.split("|")[0];
  const singleId = jobIds.find((l) => l.includes("single"))?.split("|")[0];
  console.log("[db] jobs multi=", multiId, "single=", singleId);

  if (phase === "3") {
    console.log("[wait] 32s for server feature-flag cache...");
    await page.waitForTimeout(32000);
  }

  await page.goto(`${BASE}/studio?tab=video`, { waitUntil: "domcontentloaded" });
  await dismissDialogs(page);
  await page.getByTestId(`job-card-${multiId}`).waitFor({ timeout: 30000 });
  await page.getByTestId(`job-card-${multiId}`).click();
  await page.waitForTimeout(1500);
  await shot(page, "multi-job");

  const spentLine = page.getByTestId("text-video-ai-spent");
  if (phase === "1") {
    await spentLine.waitFor({ timeout: 15000 });
    const multiText = (await spentLine.innerText()).trim();
    console.log("[ui] multi-unit line:", multiText);
    if (!multiText.includes("30.00")) throw new Error(`expected ₹30.00, got: ${multiText}`);

    await page.getByTestId(`job-card-${singleId}`).click();
    await page.waitForTimeout(1500);
    const singleText = (await spentLine.innerText()).trim();
    console.log("[ui] single-unit line:", singleText);
    await shot(page, "single-job");
    if (!singleText.includes("7.50")) throw new Error(`expected ₹7.50, got: ${singleText}`);
  } else {
    const count = await spentLine.count();
    console.log("[ui] spent-line count (expect 0):", count);
    if (count !== 0) throw new Error(`expected hidden line, found: ${await spentLine.innerText()}`);
    // The video preview itself must still render (line hidden, not the panel).
    const preview = await page.getByTestId("video-preview").count();
    console.log("[ui] video preview present:", preview > 0);
    if (preview === 0) throw new Error("video preview missing — wrong job state");
  }
  await browser.close();
  console.log("PHASE", phase, "PASS");
};

main().catch((err) => {
  console.error("PHASE", phase, "FAIL:", err.message);
  process.exit(1);
});
