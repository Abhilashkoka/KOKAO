/* eslint-disable no-console */
// Browser e2e (task 711): web credit-pack checkout with an order id the
// Razorpay mock does NOT know must surface the clear lost-order message.
// Usage: node scripts/src/e2e-lost-order.mjs <email>
import { chromium } from "playwright";
import { createHmac } from "node:crypto";

const email = process.argv[2];
if (!email) {
  console.error("usage: node e2e-lost-order.mjs <email>");
  process.exit(2);
}
const BASE = `https://${process.env.REPLIT_DEV_DOMAIN}`;
const CLERK_KEY = process.env.CLERK_SECRET_KEY;
const KEY_SECRET = "test_key_secret_e2e711";
const FAKE_ORDER = "order_LOST0000E2E711"; // never created on the mock
const FAKE_PAYMENT = "pay_E2E711LOST";
const SIGNATURE = createHmac("sha256", KEY_SECRET)
  .update(`${FAKE_ORDER}|${FAKE_PAYMENT}`)
  .digest("hex");

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
    first_name: "Lost",
    last_name: "Order",
    skip_password_requirement: true,
  });
}
const shot = async (page, name) => {
  await page.screenshot({ path: `/tmp/e2e711-${name}.png` });
  console.log(`[shot] /tmp/e2e711-${name}.png`);
};

const main = async () => {
  const user = await getOrCreateUser();
  console.log("[clerk] user", user.id);
  const token = await clerkApi("/sign_in_tokens", { user_id: user.id, expires_in_seconds: 600 });

  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_BIN || "chromium",
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  // Stub Razorpay Checkout BEFORE any page script: openCheckout sees
  // window.Razorpay and never loads the CDN script. open() immediately
  // "completes" the payment with an order id the mock does not know.
  await context.addInitScript(
    ({ orderId, paymentId, signature }) => {
      window.Razorpay = class {
        constructor(options) {
          this.options = options;
        }
        open() {
          setTimeout(() => {
            this.options.handler({
              razorpay_order_id: orderId,
              razorpay_payment_id: paymentId,
              razorpay_signature: signature,
            });
          }, 300);
        }
      };
    },
    { orderId: FAKE_ORDER, paymentId: FAKE_PAYMENT, signature: SIGNATURE },
  );
  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") console.log("[console.error]", m.text().slice(0, 300));
  });
  page.on("response", (r) => {
    if (r.url().includes("/billing/")) console.log("[api]", r.status(), r.url().split("/api")[1]);
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

  await page.goto(`${BASE}/settings?tab=billing`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);
  // First-load may redirect to the studio; navigate via the sidebar.
  for (let i = 0; i < 6; i++) {
    const dlg = page.locator('[role="dialog"]');
    if ((await dlg.count()) === 0) break;
    const btn = dlg
      .first()
      .locator("button", { hasText: /^(continue|close|skip|got it|not now)/i });
    if ((await btn.count()) > 0) await btn.first().click().catch(() => {});
    else await page.keyboard.press("Escape");
    await page.waitForTimeout(1200);
  }
  if (!/\/settings/.test(page.url())) {
    await page.locator("a,button", { hasText: /^Settings$/ }).first().click();
    await page.waitForTimeout(2000);
  }
  const billingTab = page.locator('[role="tab"]', { hasText: /^Billing$/ }).first();
  await billingTab.waitFor({ timeout: 30000 });
  await billingTab.click();
  await page.waitForTimeout(1500);
  await shot(page, "billing-tab");

  const buy = page.locator("button", { hasText: /^Buy$/ }).first();
  await buy.waitFor({ timeout: 30000 });
  await buy.click();
  console.log("[e2e] clicked Buy");

  // Toast should carry the exact lost-order message via apiErrorMessage.
  const msg = page
    .getByText("Razorpay no longer recognizes this order", { exact: false })
    .first();
  await msg.waitFor({ timeout: 30000 });
  await shot(page, "lost-order-toast");
  const full = await msg.textContent();
  console.log("[e2e] TOAST TEXT:", full);
  console.log("RESULT: PASS");
  await browser.close();
};

main().catch(async (e) => {
  console.error("RESULT: FAIL", e);
  process.exit(1);
});
