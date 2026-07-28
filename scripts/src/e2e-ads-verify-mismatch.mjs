/* eslint-disable no-console */
// Browser e2e (task verification): approve a Meta ad-set BID draft while the
// Graph mock silently ignores bid fields (ignoreBidUpdates), and watch the UI
// surface the verify-mismatch: destructive "Change didn't stick" toast and a
// "Verify mismatch" badge in the change history.
// Usage: node scripts/src/e2e-ads-verify-mismatch.mjs <email>
import { chromium } from "playwright";

const email = process.argv[2];
if (!email) {
  console.error("usage: node e2e-ads-verify-mismatch.mjs <email>");
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
    last_name: "Mismatch",
    skip_password_requirement: true,
  });
}

const shot = async (page, name) => {
  await page.screenshot({ path: `/tmp/e2e-adsmm-${name}.png` });
  console.log(`[shot] /tmp/e2e-adsmm-${name}.png`);
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
    // Just provision the tenant (first authed page load), then exit.
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
  await page.getByTestId("tab-campaigns").waitFor({ timeout: 30000 });

  // Open campaign detail → edit the seeded ad set → draft a bid change.
  await page.getByTestId("link-campaign-120000000000001").click();
  await page.getByTestId("button-edit-adset-130000000000001").waitFor({ timeout: 30000 });
  await shot(page, "02-campaign-detail");
  await page.getByTestId("button-edit-adset-130000000000001").click();
  await page.getByTestId("select-draft-bid-strategy").waitFor({ timeout: 15000 });
  await page.getByTestId("select-draft-bid-strategy").click();
  await page.getByRole("option", { name: /cost cap/i }).first().click();
  await page.getByTestId("input-draft-bid-amount").fill("2.5");
  await shot(page, "03-bid-draft-form");
  await page.getByTestId("button-submit-draft").click();
  await page.getByText(/draft created/i).first().waitFor({ timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await shot(page, "04-draft-created");

  // Flip the mock into "silently ignore bid updates" mode.
  const ctl = await fetch(`${MOCK}/__control`, {
    method: "POST",
    body: JSON.stringify({ ignoreBidUpdates: true }),
  }).then((r) => r.json());
  console.log("[mock] control:", JSON.stringify(ctl));

  // Approve the draft from the Approvals tab. Close the draft dialog and the
  // campaign-detail dialog (both may be stacked open).
  for (let i = 0; i < 5; i++) {
    if ((await page.locator('[role="dialog"]').count()) === 0) break;
    await page.keyboard.press("Escape");
    await page.waitForTimeout(700);
  }
  await page.getByTestId("tab-approvals").click();
  const approveBtn = page.locator('[data-testid^="button-approve-draft-"]').first();
  await approveBtn.waitFor({ timeout: 20000 });
  await shot(page, "05-approvals-tab");
  await approveBtn.click();
  await page.getByTestId("button-confirm-approve").click();

  // EXPECT: destructive "Change didn't stick" toast, NOT "Change applied".
  await page.getByText("Change didn't stick", { exact: false }).first().waitFor({ timeout: 30000 });
  console.log("[ui] TOAST: Change didn't stick ✓");
  const cleanSuccess = await page
    .getByText("Change applied", { exact: false })
    .count();
  console.log("[ui] 'Change applied' visible:", cleanSuccess);
  await shot(page, "06-mismatch-toast");
  if (cleanSuccess > 0) throw new Error("FAIL: clean success toast shown");

  // EXPECT: History tab shows the Verify mismatch badge.
  await page.getByTestId("tab-history").click();
  await page.getByText("Verify mismatch", { exact: false }).first().waitFor({ timeout: 20000 });
  console.log("[ui] HISTORY: Verify mismatch badge ✓");
  await shot(page, "07-history-mismatch");

  await browser.close();
  console.log("ADS VERIFY-MISMATCH E2E PASS");
};

main().catch((e) => {
  console.error("E2E FAILED:", e);
  process.exit(1);
});
