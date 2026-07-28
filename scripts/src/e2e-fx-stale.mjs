/* eslint-disable no-console */
// Browser e2e (task #697 verification): with a seeded unread fx_rate_stale
// notification and rate_auto_updated_at > 3 days old, the superadmin sees
// both the notification banner and the AI-tab stale warning; clicking
// "Refresh now" clears BOTH without a manual dismiss.
// Usage: node scripts/src/e2e-fx-stale.mjs <superadmin-email>
import { chromium } from "playwright";

const email = process.argv[2];
if (!email) {
  console.error("usage: node e2e-fx-stale.mjs <email>");
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

async function getUser() {
  const listRes = await fetch(
    `https://api.clerk.com/v1/users?email_address=${encodeURIComponent(email)}`,
    { headers: { Authorization: `Bearer ${CLERK_KEY}` } },
  );
  const list = await listRes.json();
  if (Array.isArray(list) && list.length > 0) return list[0];
  throw new Error("superadmin user not found in Clerk");
}

const shot = async (page, name) => {
  await page.screenshot({ path: `/tmp/e2e-fx-${name}.png` });
  console.log(`[shot] /tmp/e2e-fx-${name}.png`);
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
  const user = await getUser();
  console.log("[clerk] user", user.id);
  const token = await clerkApi("/sign_in_tokens", { user_id: user.id, expires_in_seconds: 600 });

  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_BIN || "chromium",
    args: ["--no-sandbox"],
  });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 950 } })).newPage();
  page.on("console", (m) => {
    if (m.type() === "error") console.log("[console.error]", m.text().slice(0, 300));
  });

  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.Clerk && window.Clerk.loaded, null, { timeout: 60000 });
  const signedIn = await page.evaluate(async (ticket) => {
    if (window.Clerk.user) return "already";
    const res = await window.Clerk.client.signIn.create({ strategy: "ticket", ticket });
    await window.Clerk.setActive({ session: res.createdSessionId });
    return res.status;
  }, token.token);
  console.log("[clerk] signIn:", signedIn);
  await page.waitForTimeout(3000);
  await dismissDialogs(page);

  // Step 1: /admin — notification banner shows the stale-rate alert.
  await page.goto(`${BASE}/admin`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  await dismissDialogs(page);
  const banner = page.getByText(/USD.?INR rate is stale/i).first();
  await banner.waitFor({ state: "visible", timeout: 20000 });
  console.log("[ok] notification banner visible on /admin");
  await shot(page, "1-banner");

  // Step 2: AI tab — stale warning visible.
  await page.locator('[data-testid="tab-ai"]').click();
  const warning = page.locator('[data-testid="text-ai-cost-rate-stale"]');
  await warning.waitFor({ state: "visible", timeout: 20000 });
  console.log("[ok] AI-tab stale warning:", (await warning.innerText()).slice(0, 120));
  await shot(page, "2-ai-warning");

  // Step 3: click Refresh now.
  await page.locator('[data-testid="button-refresh-ai-cost-rate"]').click();
  await page
    .getByText(/Rate refreshed from the live market rate/i)
    .first()
    .waitFor({ state: "visible", timeout: 30000 });
  console.log("[ok] refresh success toast");

  // Step 4: both indicators clear WITHOUT any dismiss click.
  await warning.waitFor({ state: "hidden", timeout: 20000 });
  console.log("[ok] AI-tab stale warning gone");
  await page
    .getByText(/USD.?INR rate is stale/i)
    .first()
    .waitFor({ state: "hidden", timeout: 20000 })
    .catch(async () => {
      // strict-mode / multiple matches fallback: assert zero visible matches
      const n = await page.getByText(/USD.?INR rate is stale/i).count();
      if (n > 0) throw new Error(`banner still present (${n} matches)`);
    });
  console.log("[ok] notification banner gone without dismiss");
  await shot(page, "3-cleared");

  await browser.close();
  console.log("PASS");
};

main().catch((e) => {
  console.error("FAIL:", e.message);
  process.exit(1);
});
