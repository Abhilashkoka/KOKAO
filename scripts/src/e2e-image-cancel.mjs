/* eslint-disable no-console */
// Browser e2e for cancelling async image jobs (task verification harness).
// Usage: node scripts/src/e2e-image-cancel.mjs <A|B> <email>
// Scenario A: cancel while queued (requires IMAGE_JOB_CLAIM_DELAY_MS on the API server).
// Scenario B: late cancel (no delay) -> "Too late to cancel", image still lands.
import { chromium } from "playwright";

const scenario = process.argv[2];
const email = process.argv[3];
if (!["A", "B"].includes(scenario) || !email) {
  console.error("usage: node e2e-image-cancel.mjs <A|B> <email>");
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
    first_name: "Img",
    last_name: "Cancel",
    skip_password_requirement: true,
  });
}

const shot = async (page, name) => {
  await page.screenshot({ path: `/tmp/e2e-${scenario}-${name}.png`, fullPage: false });
  console.log(`[shot] /tmp/e2e-${scenario}-${name}.png`);
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
  if (signedIn !== "complete" && signedIn !== "already") throw new Error("sign-in failed " + signedIn);

  await page.goto(`${BASE}/studio`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("tab-studio-image").waitFor({ timeout: 60000 });
  // Dismiss the consent/onboarding dialog (may appear with a delay).
  await page.waitForTimeout(4000);
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
  await page.getByTestId("tab-studio-image").click();
  const prompt =
    scenario === "A" ? "a red bicycle on a sunny beach" : "a blue sailboat at sunset";
  await page.locator("textarea").first().fill(prompt);
  await shot(page, "before-generate");

  const cancelBtn = page.getByTestId("button-cancel-image-job");
  await page.getByTestId("button-generate-image").click();

  if (scenario === "A") {
    // Job stays queued for 30s (claim delay). Confirm queued state, then cancel.
    await page.getByTestId("image-job-progress").waitFor({ timeout: 15000 });
    const status = await page.getByTestId("text-image-job-status").innerText();
    console.log("[ui] status before cancel:", status.trim());
    await shot(page, "queued");
    await cancelBtn.click();
    await page.getByText("Generation cancelled", { exact: false }).first().waitFor({ timeout: 15000 });
    console.log("[ui] TOAST: Generation cancelled ✓");
    await shot(page, "cancelled-toast");
    // Runner wakes at ~30s and must lose the claim: nothing may land afterwards.
    let landed = false;
    try {
      await page.getByText("Image generated!", { exact: false }).first().waitFor({ timeout: 45000 });
      landed = true;
    } catch {}
    console.log("[ui] image landed after cancel:", landed);
    await shot(page, "after-wait");
    if (landed) throw new Error("FAIL: image delivered despite cancel");
  } else {
    // Claim happens in ms; the client believes "queued" until its first 2s poll.
    // Click cancel immediately -> server answers 409 -> "Too late to cancel".
    await cancelBtn.waitFor({ timeout: 5000 });
    await cancelBtn.click();
    console.log("[ui] clicked cancel immediately");
    await page.getByText("Too late to cancel", { exact: false }).first().waitFor({ timeout: 15000 });
    console.log("[ui] TOAST: Too late to cancel ✓");
    await shot(page, "too-late-toast");
    await page.getByText("Image generated!", { exact: false }).first().waitFor({ timeout: 240000 });
    console.log("[ui] TOAST: Image generated! ✓ (image still landed)");
    await shot(page, "image-landed");
  }
  await browser.close();
  console.log("SCENARIO", scenario, "PASS");
};

main().catch(async (err) => {
  console.error("SCENARIO", scenario, "FAIL:", err.message);
  process.exit(1);
});
