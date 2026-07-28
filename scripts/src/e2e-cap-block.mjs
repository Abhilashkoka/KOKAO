/* eslint-disable no-console */
// Browser e2e (task 702): approve a lifetime-budget draft AFTER the owner
// tightened the lifetime cap → destructive toast containing "current lifetime
// budget cap" (via apiErrorMessage) and the draft stays pending, no reload.
// Usage: node scripts/src/e2e-cap-block.mjs <email> [signin-only|full]
import { chromium } from "playwright";

const email = process.argv[2];
if (!email) {
  console.error("usage: node e2e-cap-block.mjs <email> [step]");
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
    first_name: "Cap",
    last_name: "Block",
    skip_password_requirement: true,
  });
}

const shot = async (page, name) => {
  await page.screenshot({ path: `/tmp/e2e-capblock-${name}.png` });
  console.log(`[shot] /tmp/e2e-capblock-${name}.png`);
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
  const page = await (
    await browser.newContext({ viewport: { width: 1440, height: 900 } })
  ).newPage();
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
  await shot(page, "01-ads-page");
  if ((await page.getByTestId("tab-campaigns").count()) === 0) {
    // Sometimes the direct load lands on the studio page — use the sidebar.
    await page.locator('a[href="/ads"], a:has-text("Ads")').first().click().catch(() => {});
    await page.waitForTimeout(4000);
    await dismissDialogs(page);
    await shot(page, "01b-ads-page-retry");
  }
  await page.getByTestId("tab-campaigns").waitFor({ timeout: 30000 });

  // 1. Draft a lifetime-budget change on the seeded campaign (cap is clear).
  await page.getByTestId("button-edit-campaign-120000000000001").waitFor({ timeout: 30000 });
  await page.getByTestId("button-edit-campaign-120000000000001").click();
  await page.getByTestId("input-draft-lifetime-budget").waitFor({ timeout: 15000 });
  await page.getByTestId("input-draft-lifetime-budget").fill("500"); // $500 = 50000 minor
  await shot(page, "02-draft-form");
  await page.getByTestId("button-submit-draft").click();
  await page.getByText(/draft created/i).first().waitFor({ timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await shot(page, "03-draft-created");

  // 2. Owner tightens the lifetime cap to $100 (10000 minor) via the API,
  //    authenticated with the browser session cookie (same as Budget caps UI).
  const capRes = await page.evaluate(async () => {
    const res = await fetch("/api/ads/budget-caps", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ maxDailyBudget: null, maxLifetimeBudget: 10000 }),
    });
    return { status: res.status, body: await res.text() };
  });
  console.log("[api] PUT budget-caps:", JSON.stringify(capRes));
  if (capRes.status !== 200) throw new Error("cap tighten failed");

  // 3. Approve from the Approvals tab (close any stacked dialogs first).
  for (let i = 0; i < 5; i++) {
    if ((await page.locator('[role="dialog"]').count()) === 0) break;
    await page.keyboard.press("Escape");
    await page.waitForTimeout(700);
  }
  await page.getByTestId("tab-approvals").click();
  const approveBtn = page.locator('[data-testid^="button-approve-draft-"]').first();
  await approveBtn.waitFor({ timeout: 20000 });
  const draftTestId = await approveBtn.getAttribute("data-testid");
  console.log("[ui] approving", draftTestId);
  await shot(page, "04-approvals-tab");
  await approveBtn.click();
  // The confirm dialog may require acknowledging a budget increase.
  await page.getByTestId("button-confirm-approve").waitFor({ timeout: 15000 });
  const ack = page.getByTestId("checkbox-acknowledge-budget-increase");
  if ((await ack.count()) > 0) {
    await ack.click();
    console.log("[ui] acknowledged budget increase");
  }
  await shot(page, "05-confirm-dialog");
  // Arm the toast wait atomically with the click (toasts auto-dismiss ~5s).
  const toastWait = page
    .getByText("current lifetime budget cap", { exact: false })
    .first()
    .waitFor({ timeout: 30000 });
  await page.getByTestId("button-confirm-approve").click();
  await toastWait;
  console.log("[ui] TOAST contains 'current lifetime budget cap' ✓");
  const genericOnly = await page
    .getByText("Could not apply the change", { exact: false })
    .count();
  console.log("[ui] toast title 'Could not apply the change' visible:", genericOnly);
  await shot(page, "06-cap-toast");

  // 4. Draft must still be listed as awaiting approval — no reload.
  await page.waitForTimeout(1500);
  const stillPending = await page.locator(`[data-testid="${draftTestId}"]`).count();
  console.log("[ui] draft still pending (approve button present):", stillPending);
  await shot(page, "07-still-pending");
  if (stillPending === 0) throw new Error("FAIL: draft no longer listed as pending");

  await browser.close();
  console.log("CAP-BLOCK E2E PASS");
};

main().catch((e) => {
  console.error("E2E FAILED:", e);
  process.exit(1);
});
