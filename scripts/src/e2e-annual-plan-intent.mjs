/**
 * E2E: buyer picks Annual on /pricing → Clerk sign-up → lands on Settings →
 * Billing with Yearly cycle active and the chosen plan "Selected"; a reload
 * shows the intent is consumed.
 *
 * Self-contained and restore-exact: if no plan already has a yearly price it
 * snapshots the existing `pro` plan_settings row (or its absence), applies
 * test prices, and on cleanup restores the exact original row / deletes only
 * a row it inserted itself. ALL state-changing setup happens inside the
 * try/finally so any failure (token mint, browser launch, journey) still
 * cleans up. Also deletes the test Clerk user + tenant row.
 *
 * Requires: dev servers on localhost:80, CLERK_SECRET_KEY, DATABASE_URL.
 */
import { chromium } from "playwright";
import { execSync } from "node:child_process";

const CLERK_SECRET = process.env.CLERK_SECRET_KEY;
if (!CLERK_SECRET) throw new Error("CLERK_SECRET_KEY missing");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL missing");
const BASE = "http://localhost:80";
const FAPI_HOST = "sought-chipmunk-83.clerk.accounts.dev";
const EMAIL = `annualintent${Date.now()}+clerk_test@example.com`;
const PASSWORD = "E2e-Annual-Intent-9x!";
const TEST_PRICE = 249900; // ₹2,499 / mo in paise
const TEST_PRICE_YEARLY = 2499000; // ₹24,990 / yr in paise

function log(...a) { console.log("[e2e]", ...a); }

function psql(sqlText) {
  return execSync(`psql "$DATABASE_URL" -tA -f -`, {
    shell: "/bin/bash",
    input: sqlText,
  }).toString().trim();
}

function sqlLit(v) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return `'${s.replace(/'/g, "''")}'`;
}

async function fetchPlans() {
  const r = await fetch(`${BASE}/api/plans`);
  if (!r.ok) throw new Error(`GET /api/plans ${r.status} — is the dev server running?`);
  return r.json();
}

async function waitForPlanPrices(id, want) {
  const deadline = Date.now() + 60000; // API plan cache TTL is 30s
  for (;;) {
    const p = (await fetchPlans()).find((x) => x.id === id);
    const priced = p && p.priceInr > 0 && p.priceInrYearly > 0;
    if (priced === want) return;
    if (Date.now() > deadline) throw new Error(`plan '${id}' priced=${want} never reflected in /api/plans`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}

// ---- Plan seeding state (mutations happen inside the try block only) ----
let planId = null;
let planSeedMode = null; // null | "inserted" | "updated"
let originalProRow = null; // full row snapshot when planSeedMode === "updated"

async function seedPlanIfNeeded() {
  const plans = await fetchPlans();
  const priced = plans.find((p) => p.priceInr > 0 && p.priceInrYearly > 0);
  if (priced) {
    planId = priced.id;
    log(`using existing priced plan '${planId}' — no seeding needed`);
    return;
  }
  planId = "pro";
  const snap = psql("SELECT row_to_json(t) FROM plan_settings t WHERE id='pro'");
  if (snap) {
    originalProRow = JSON.parse(snap);
    planSeedMode = "updated";
    psql(`UPDATE plan_settings SET price_inr=${TEST_PRICE}, price_inr_yearly=${TEST_PRICE_YEARLY}, archived=false WHERE id='pro'`);
    log("existing pro override found — snapshotted row and applied test prices");
  } else {
    planSeedMode = "inserted";
    psql(
      `INSERT INTO plan_settings (id, name, price_label, captions, images, videos, watermark, billing_mode, brand_kits, scheduled_posts, features, team_seats, price_inr, price_inr_yearly, sort_order)
       VALUES ('pro','Pro','₹2,499 / mo',500,200,50,false,'quota',10,200,'["500 AI captions / month","200 AI images / month","10 brand kits","Schedule up to 200 posts","Priority generation"]'::jsonb,0,${TEST_PRICE},${TEST_PRICE_YEARLY},2)`,
    );
    log("no pro override existed — inserted a test-priced row");
  }
  log("waiting for the API's 30s plan cache…");
  await waitForPlanPrices("pro", true);
  log("plan cache refreshed; pro has monthly + yearly prices");
}

function restorePlanRow() {
  if (planSeedMode === "inserted") {
    psql("DELETE FROM plan_settings WHERE id='pro'");
    log("removed the plan row this harness inserted");
  } else if (planSeedMode === "updated" && originalProRow) {
    const cols = Object.keys(originalProRow);
    const sets = cols
      .filter((c) => c !== "id")
      .map((c) => {
        const v = originalProRow[c];
        // jsonb columns need an explicit cast; features/limits-ish objects.
        const lit = sqlLit(v);
        return typeof v === "object" && v !== null ? `${c}=${lit}::jsonb` : `${c}=${lit}`;
      })
      .join(", ");
    psql(`UPDATE plan_settings SET ${sets} WHERE id='pro'`);
    // Verify exact restoration.
    const after = JSON.parse(psql("SELECT row_to_json(t) FROM plan_settings t WHERE id='pro'"));
    const drift = cols.filter((c) => JSON.stringify(after[c]) !== JSON.stringify(originalProRow[c]));
    if (drift.length) throw new Error(`pro row restore drift on columns: ${drift.join(", ")}`);
    log("restored the pre-existing pro row exactly (verified column-by-column)");
  }
  planSeedMode = null;
}

// Clerk user id captured at sign-up time so cleanup never depends on a
// (possibly failing) list-by-email lookup.
let createdClerkUserId = null;

async function deleteTestUser() {
  let ids = createdClerkUserId ? [createdClerkUserId] : [];
  if (ids.length === 0) {
    // Fallback lookup; a failed list response is an error, not "no users".
    const r = await fetch(
      `https://api.clerk.com/v1/users?email_address=${encodeURIComponent(EMAIL)}`,
      { headers: { Authorization: `Bearer ${CLERK_SECRET}` } },
    );
    if (!r.ok) throw new Error(`Clerk user list failed: ${r.status} ${await r.text()}`);
    const users = await r.json();
    ids = (Array.isArray(users) ? users : []).map((u) => u.id);
  }
  for (const id of ids) {
    // Tenant first: if the DB delete fails we still know the user via Clerk
    // on a retry; the reverse order would leave an unfindable orphan tenant.
    const deleted = psql(`DELETE FROM tenants WHERE clerk_user_id=${sqlLit(id)} RETURNING id`);
    log(`deleted tenant row(s) for ${id}:`, deleted || "(none)");
    const dr = await fetch(`https://api.clerk.com/v1/users/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${CLERK_SECRET}` },
    });
    if (!dr.ok && dr.status !== 404) {
      throw new Error(`Clerk user delete failed for ${id}: ${dr.status} ${await dr.text()}`);
    }
    log("deleted test Clerk user", id);
  }
}

async function mintTestingToken() {
  const r = await fetch("https://api.clerk.com/v1/testing_tokens", {
    method: "POST",
    headers: { Authorization: `Bearer ${CLERK_SECRET}` },
  });
  if (!r.ok) throw new Error(`testing token: ${r.status} ${await r.text()}`);
  return (await r.json()).token;
}

let browser = null;
let failed = false;
try {
  await seedPlanIfNeeded();

  const token = await mintTestingToken();
  log("testing token minted");

  browser = await chromium.launch({
    executablePath: execSync("which chromium").toString().trim(),
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext({ serviceWorkers: "block" });
  const page = await context.newPage();

  // Append testing token to all Clerk FAPI requests; rewrite the environment
  // response's Turnstile sitekey to Cloudflare's always-pass test key.
  await context.route(`**://${FAPI_HOST}/v1/**`, async (route) => {
    const url = new URL(route.request().url());
    url.searchParams.set("__clerk_testing_token", token);
    if (url.pathname === "/v1/environment") {
      const resp = await route.fetch({ url: url.toString() });
      let body = await resp.text();
      try {
        const j = JSON.parse(body);
        if (j.display_config) {
          j.display_config.captcha_public_key = "1x00000000000000000000AA";
          j.display_config.captcha_public_key_invisible = "1x00000000000000000000AA";
          j.display_config.captcha_widget_type = "invisible";
        }
        body = JSON.stringify(j);
      } catch { /* keep raw */ }
      return route.fulfill({ response: resp, body });
    }
    return route.continue({ url: url.toString() });
  });

  // ---- Step 1: /pricing, toggle Annual, click the plan CTA ----
  await page.goto(`${BASE}/pricing`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("billing-cycle-yearly").click({ timeout: 20000 });
  await page.getByTestId(`pricing-plan-${planId}-yearly-price`).waitFor({ timeout: 10000 });
  log("Annual toggle active; yearly price shown");
  await page.getByTestId(`pricing-plan-${planId}-cta`).click();
  await page.waitForURL(new RegExp(`/sign-up\\?plan=${planId}&cycle=yearly`), { timeout: 10000 });
  log("navigated to", page.url());

  // Confirm the intent got stashed in localStorage by the /sign-up page.
  await page.waitForFunction(
    () => !!localStorage.getItem("kokao.signup-plan-intent"),
    null,
    { timeout: 10000 },
  );
  const stored = await page.evaluate(() => localStorage.getItem("kokao.signup-plan-intent"));
  log("stored intent:", stored);
  const intent = JSON.parse(stored);
  if (intent.planId !== planId || intent.cycle !== "yearly") {
    throw new Error(`wrong stored intent: ${stored}`);
  }

  // ---- Step 2: Clerk sign-up ----
  await page.waitForSelector(".cl-signUp-root, .cl-rootBox", { timeout: 30000 });
  const emailInput = page.locator('input[name="emailAddress"]');
  await emailInput.waitFor({ timeout: 20000 });
  await emailInput.fill(EMAIL);
  const pwInput = page.locator('input[name="password"]');
  if (await pwInput.count()) await pwInput.fill(PASSWORD);
  await page.locator("button.cl-formButtonPrimary").first().click();
  log("sign-up submitted");

  // Email verification code: type after focusing the real OTP input —
  // clicking the visible segment div is pointer-intercepted.
  const otpInput = page.locator("input[data-input-otp]").first();
  await otpInput.waitFor({ state: "attached", timeout: 30000 });
  await otpInput.focus();
  await page.keyboard.type("424242", { delay: 60 });
  log("OTP entered");

  // ---- Step 3: land on Settings → Billing with Yearly + Selected ----
  await page.waitForURL(/\/settings\?tab=billing/, { timeout: 60000 });
  log("landed on", page.url());

  // Record the created user's id immediately for reliable cleanup.
  createdClerkUserId = await page.evaluate(() => window.Clerk?.user?.id ?? null);
  log("created Clerk user id:", createdClerkUserId);

  await page.getByTestId(`billing-plan-${planId}-selected`).waitFor({ timeout: 30000 });
  log(`'Selected' badge visible on the ${planId} card`);

  // Yearly cycle button must be the active one (active = bg-background class).
  const yearlyBtn = page.locator("button", { hasText: "Yearly" }).first();
  await yearlyBtn.waitFor({ timeout: 10000 });
  const yearlyClass = await yearlyBtn.getAttribute("class");
  if (!yearlyClass.includes("bg-background")) {
    throw new Error(`Yearly toggle not active: class="${yearlyClass}"`);
  }
  log("Yearly cycle is active");

  // Intent must already be consumed from localStorage.
  const afterConsume = await page.evaluate(() => localStorage.getItem("kokao.signup-plan-intent"));
  if (afterConsume !== null) throw new Error(`intent not cleared: ${afterConsume}`);
  log("intent cleared from localStorage");

  // ---- Step 4: reload /settings — no lingering highlight ----
  await page.goto(`${BASE}/settings?tab=billing`, { waitUntil: "domcontentloaded" });
  await page.getByTestId(`billing-plan-${planId}`).waitFor({ timeout: 30000 });
  if (await page.getByTestId(`billing-plan-${planId}-selected`).count()) {
    throw new Error("Selected badge still present after reload — intent not consumed");
  }
  const yearlyClass2 = await page.locator("button", { hasText: "Yearly" }).first().getAttribute("class");
  if (yearlyClass2.includes("bg-background")) {
    throw new Error("Yearly still preselected after reload — intent lingering");
  }
  log("after reload: no Selected badge, cycle back to Monthly default");

  console.log("E2E PASS: plan =", planId, "email =", EMAIL);
} catch (e) {
  failed = true;
  console.error("[e2e] FAILED:", e);
} finally {
  if (browser) await browser.close().catch(() => {});
  try {
    restorePlanRow();
  } catch (e) {
    failed = true;
    console.error("[e2e] plan-row restore error:", e.message);
  }
  try {
    await deleteTestUser();
  } catch (e) {
    failed = true;
    console.error("[e2e] user cleanup error:", e.message);
  }
}
if (failed) process.exit(1);
