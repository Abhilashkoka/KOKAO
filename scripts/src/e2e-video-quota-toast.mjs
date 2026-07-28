/* eslint-disable no-console */
// Browser e2e for task 705: member vs owner 402 toast copy in the Video Studio.
// Usage: node scripts/src/e2e-video-quota-toast.mjs <provision|member-on|member-off|owner> <email>
import { chromium } from "playwright";

const phase = process.argv[2];
const email = process.argv[3];
if (!["provision", "member-on", "member-off", "owner"].includes(phase) || !email) {
  console.error("usage: node e2e-video-quota-toast.mjs <provision|member-on|member-off|owner> <email>");
  process.exit(2);
}
const BASE = `https://${process.env.REPLIT_DEV_DOMAIN}`;
const CLERK_KEY = process.env.CLERK_SECRET_KEY;

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
    first_name: "Quota",
    last_name: "Toast",
    skip_password_requirement: true,
  });
}

const shot = async (page, name) => {
  await page.screenshot({ path: `/tmp/e2e-quota-${phase}-${name}.png` });
  console.log(`[shot] /tmp/e2e-quota-${phase}-${name}.png`);
};

const main = async () => {
  const user = await getOrCreateUser();
  console.log("[clerk] user", user.id);
  const token = await clerkApi("/sign_in_tokens", { user_id: user.id, expires_in_seconds: 600 });

  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_BIN || "chromium",
    args: ["--no-sandbox"],
  });
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 900 } })).newPage();
  page.on("console", (m) => {
    if (m.type() === "error") console.log("[console.error]", m.text().slice(0, 250));
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
  if (signedIn !== "complete" && signedIn !== "already") throw new Error("sign-in failed " + signedIn);

  if (phase === "provision") {
    // Just load the app so /api/me provisions the tenant.
    await page.goto(`${BASE}/studio`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(8000);
    await shot(page, "provisioned");
    await browser.close();
    console.log("PHASE", phase, "PASS");
    return;
  }

  await page.goto(`${BASE}/studio?tab=video`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("input-video-prompt").waitFor({ timeout: 60000 });
  await page.waitForTimeout(4000);
  for (let i = 0; i < 15; i++) {
    const dlg = page.locator('[role="dialog"]:visible');
    if ((await dlg.count()) === 0) break;
    const btn = dlg
      .last()
      .locator("button", { hasText: /(continue|close|skip|got it|not now|finish|done)/i });
    if ((await btn.count()) > 0) await btn.first().click().catch(() => {});
    else await page.keyboard.press("Escape");
    await page.waitForTimeout(1200);
  }
  const remaining = await page.locator('[role="dialog"]:visible').count();
  console.log("[ui] dialogs remaining:", remaining);

  await page.getByTestId("input-video-prompt").fill("5 morning habits that transform your day");
  await shot(page, "before-generate");
  await page.getByTestId("button-generate-video").click();

  if (phase === "member-on") {
    await page
      .getByText("The workspace has run out of video quota. Ask your workspace owner to upgrade.", { exact: false })
      .first()
      .waitFor({ timeout: 20000 });
    console.log("[ui] member toast copy ✓");
    const actionBtn = page.getByTestId("button-request-upgrade-toast");
    await actionBtn.waitFor({ timeout: 5000 });
    console.log("[ui] button-request-upgrade-toast visible ✓");
    await shot(page, "toast");
  } else if (phase === "member-off") {
    await page
      .getByText("The workspace is out of video quota.", { exact: true })
      .first()
      .waitFor({ timeout: 20000 });
    console.log("[ui] plain member copy ✓");
    const count = await page.getByTestId("button-request-upgrade-toast").count();
    console.log("[ui] request-upgrade button count:", count);
    if (count > 0) throw new Error("FAIL: upgrade-request action shown while flag off");
    await shot(page, "toast");
  } else {
    await page
      .getByText("Monthly video quota reached and no video credits left. Upgrade your plan or buy a credit pack.", { exact: false })
      .first()
      .waitFor({ timeout: 20000 });
    console.log("[ui] owner sees server message ✓");
    const count = await page.getByTestId("button-request-upgrade-toast").count();
    if (count > 0) throw new Error("FAIL: owner saw upgrade-request action");
    await shot(page, "toast");
  }

  await browser.close();
  console.log("PHASE", phase, "PASS");
};

main().catch((err) => {
  console.error("PHASE", phase, "FAIL:", err.message);
  process.exit(1);
});
