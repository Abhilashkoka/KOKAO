/* eslint-disable no-console */
// Browser e2e (task 714): after a verify-mismatch apply, the durable
// "Ad change didn't stick" notification shows in the alerts area with a
// "View change history" link, and clicking it lands on the Change history
// tab — both from another page and while already on /ads (in-place switch).
// Usage: node scripts/src/e2e-ads-mismatch-notification.mjs <email> [step]
import { chromium } from "playwright";

const email = process.argv[2];
if (!email) {
  console.error("usage: node e2e-ads-mismatch-notification.mjs <email> [step]");
  process.exit(2);
}
const BASE = `https://${process.env.REPLIT_DEV_DOMAIN}`;
const MOCK = "http://localhost:9000";
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
    first_name: "Ads",
    last_name: "MismatchBell",
    password: `E2e-${Math.random().toString(36).slice(2)}-Aa1!`,
  });
}

const shot = async (page, name) => {
  await page.screenshot({ path: `/tmp/e2e-adsbell-${name}.png` });
  console.log(`[shot] /tmp/e2e-adsbell-${name}.png`);
};

const dismissDialogs = async (page) => {
  for (let i = 0; i < 6; i++) {
    const dlg = page.locator('[role="dialog"]');
    if ((await dlg.count()) === 0) break;
    const btn = dlg
      .first()
      .locator("button", { hasText: /^(continue|close|skip|got it|not now)/i });
    if ((await btn.count()) > 0) await btn.first().click().catch(() => {});
    else break;
    await page.waitForTimeout(1000);
  }
};

const main = async () => {
  const step = process.argv[3] || "full";
  const user = await getOrCreateUser();
  console.log("[clerk] user", user.id);
  const token = await clerkApi("/sign_in_tokens", { user_id: user.id, expires_in_seconds: 600 });

  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_BIN || "chromium",
    args: ["--no-sandbox"],
  });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on("console", (m) => {
    if (m.type() === "error") console.log("[console.error]", m.text().slice(0, 300));
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

  if (step === "signin-only") {
    await page.goto(`${BASE}/ads`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(5000);
    await browser.close();
    console.log("SIGNIN-ONLY DONE");
    return;
  }

  await page.goto(`${BASE}/ads`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);
  await dismissDialogs(page);
  await shot(page, "00-ads-page");
  // page.goto can land on the studio page — use the sidebar link as fallback.
  if ((await page.getByTestId("tab-campaigns").count()) === 0) {
    const adsLink = page.locator('a[href="/ads"]').first();
    if ((await adsLink.count()) > 0) {
      await adsLink.click();
      await page.waitForTimeout(3000);
      await dismissDialogs(page);
    }
  }
  await shot(page, "00b-ads-page");
  await page.getByTestId("tab-campaigns").waitFor({ timeout: 30000 });

  // Draft a bid change on the seeded ad set.
  await page.getByTestId("link-campaign-120000000000001").click();
  await page.getByTestId("button-edit-adset-130000000000001").waitFor({ timeout: 30000 });
  await page.getByTestId("button-edit-adset-130000000000001").click();
  await page.getByTestId("select-draft-bid-strategy").waitFor({ timeout: 15000 });
  await page.getByTestId("select-draft-bid-strategy").click();
  await page.getByRole("option", { name: /cost cap/i }).first().click();
  await page.getByTestId("input-draft-bid-amount").fill("2.5");
  await page.getByTestId("button-submit-draft").click();
  await page.waitForTimeout(1500);
  await shot(page, "01-draft-created");

  // Mock silently ignores bid updates from now on.
  const ctl = await fetch(`${MOCK}/__control`, {
    method: "POST",
    body: JSON.stringify({ ignoreBidUpdates: true }),
  }).then((r) => r.json());
  console.log("[mock] control:", JSON.stringify(ctl));

  for (let i = 0; i < 5; i++) {
    if ((await page.locator('[role="dialog"]').count()) === 0) break;
    await page.keyboard.press("Escape");
    await page.waitForTimeout(700);
  }
  await page.getByTestId("tab-approvals").click();
  const approveBtn = page.locator('[data-testid^="button-approve-draft-"]').first();
  await approveBtn.waitFor({ timeout: 20000 });
  await approveBtn.click();
  await page.getByTestId("button-confirm-approve").click();
  await page.getByText("Change didn't stick", { exact: false }).first().waitFor({ timeout: 30000 });
  console.log("[ui] TOAST: Change didn't stick ✓");
  await shot(page, "02-mismatch-toast");

  // Go to the dashboard: fresh mount refetches notifications → the durable
  // alert must appear with the "View change history" link.
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.getByText("Ad change didn't stick", { exact: false }).first().waitFor({ timeout: 30000 });
  console.log("[ui] ALERT on dashboard: Ad change didn't stick ✓");
  const link = page.getByText("View change history", { exact: true }).first();
  await link.waitFor({ timeout: 10000 });
  console.log("[ui] link label: View change history ✓");
  await shot(page, "03-dashboard-alert");

  // Click it → land on /ads with the Change history tab active + mismatch row.
  await link.click();
  await page.getByTestId("tab-history").waitFor({ timeout: 30000 });
  const histState1 = await page.getByTestId("tab-history").getAttribute("data-state");
  console.log("[ui] tab-history state after cross-page click:", histState1);
  if (histState1 !== "active") throw new Error("FAIL: history tab not active after link click");
  await page.getByText("Verify mismatch", { exact: false }).first().waitFor({ timeout: 20000 });
  console.log("[ui] HISTORY: Verify mismatch badge ✓");
  await shot(page, "04-history-from-dashboard");

  // Now prove the in-place switch: flip to Campaigns, then click the same
  // alert link while ALREADY on /ads — the tab must switch without a reload.
  await page.getByTestId("tab-campaigns").click();
  await page.waitForTimeout(500);
  await page.evaluate(() => { window.__noReloadMarker = true; });
  const link2 = page.getByText("View change history", { exact: true }).first();
  await link2.waitFor({ timeout: 15000 });
  await link2.click();
  await page.waitForTimeout(1000);
  const histState2 = await page.getByTestId("tab-history").getAttribute("data-state");
  const marker = await page.evaluate(() => window.__noReloadMarker === true);
  console.log("[ui] tab-history state after in-place click:", histState2, "noReload:", marker);
  if (histState2 !== "active") throw new Error("FAIL: history tab not active on in-place click");
  if (!marker) throw new Error("FAIL: page reloaded on in-place click");
  await page.getByText("Verify mismatch", { exact: false }).first().waitFor({ timeout: 20000 });
  await shot(page, "05-history-in-place");

  await browser.close();
  console.log("ADS MISMATCH NOTIFICATION E2E PASS");
};

main().catch((e) => {
  console.error("E2E FAILED:", e);
  process.exit(1);
});
