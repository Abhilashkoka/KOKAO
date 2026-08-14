/* eslint-disable no-console */
// Browser e2e (task: onboarding → activation funnel).
// User A: fresh user, analytics consent ON, full interview run →
//   verifies analytics_events rows: onboarding_started, question_answered x4,
//   onboarding_interview_completed, onboarding_brand_kit_created,
//   caption_generated{source:onboarding}, content_saved{source:onboarding},
//   onboarding_first_post_generated, onboarding_completed.
// User B: fresh user, analytics consent ON, skips at the welcome step →
//   verifies onboarding_skipped{stage:welcome}.
// Then calls /api/analytics/funnels as superadmin (drilled into user A's
// tenant) and asserts the user is counted through "Generated first content"
// and "Saved to library".
// Usage: node scripts/src/e2e-onboarding-funnel.mjs
import { chromium } from "playwright";
import { createRequire } from "node:module";
// Resolve pg through the api-server package (workspace-relative, not absolute).
const pg = createRequire(
  new URL("../../artifacts/api-server/package.json", import.meta.url),
)("pg");

const BASE = `https://${process.env.REPLIT_DEV_DOMAIN}`;
const CLERK_KEY = process.env.CLERK_SECRET_KEY;
const run = Date.now().toString(36);
const EMAIL_A = `e2e-onb-a-${run}@example.com`;
const EMAIL_B = `e2e-onb-b-${run}@example.com`;

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });

const assert = (cond, msg) => {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
  console.log(`[ok] ${msg}`);
};

async function clerkApi(path, body, method = "POST") {
  const res = await fetch(`https://api.clerk.com/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${CLERK_KEY}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`clerk ${path} ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

async function getOrCreateUser(email, first) {
  const listRes = await fetch(
    `https://api.clerk.com/v1/users?email_address=${encodeURIComponent(email)}`,
    { headers: { Authorization: `Bearer ${CLERK_KEY}` } },
  );
  const list = await listRes.json();
  if (Array.isArray(list) && list.length > 0) return list[0];
  return clerkApi("/users", {
    email_address: [email],
    first_name: first,
    last_name: "E2E",
    skip_password_requirement: true,
  });
}

async function signIn(page, email, first) {
  const user = await getOrCreateUser(email, first);
  const token = await clerkApi("/sign_in_tokens", { user_id: user.id, expires_in_seconds: 600 });
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.Clerk && window.Clerk.loaded, null, { timeout: 60000 });
  const result = await page.evaluate(async (ticket) => {
    if (window.Clerk.user) return "already";
    const res = await window.Clerk.client.signIn.create({ strategy: "ticket", ticket });
    if (res.status !== "complete") return `status:${res.status}`;
    await window.Clerk.setActive({ session: res.createdSessionId });
    return "complete";
  }, token.token);
  if (result !== "complete" && result !== "already") throw new Error(`sign-in failed: ${result}`);
  console.log(`[clerk] ${email} signed in (${result})`, user.id);
  return user;
}

const shot = (page, name) =>
  page.screenshot({ path: `/tmp/e2e-onb-${name}.png` }).then(() => console.log(`[shot] /tmp/e2e-onb-${name}.png`));

// Wait for the onboarding wizard dialog, enable "Usage analytics", Continue.
// `delayMs` keeps the consent dialog open past the 10s flush interval to
// exercise the pre-consent hold path (events must NOT be lost to a flush
// that happens while consent is unresolved).
async function consentWithAnalytics(page, delayMs = 0) {
  const dlg = page.locator('[role="dialog"]');
  await page.getByText("Your data, your choice").first().waitFor({ timeout: 60000 });
  if (delayMs > 0) {
    console.log(`[ui] holding consent dialog open for ${delayMs}ms (flush-interval race)`);
    await page.waitForTimeout(delayMs);
  }
  await dlg.first().locator('button[role="switch"][aria-label="Usage analytics"]').click();
  await dlg.first().locator("button", { hasText: "Continue" }).click();
  await page.getByText("Welcome to KOKAO").first().waitFor({ timeout: 30000 });
  console.log("[ui] consent submitted with analytics ON; welcome step shown");
}

// Poll until every event in `requiredNames` has a row (or timeout).
async function pollEvents(clerkUserId, requiredNames, timeoutMs = 120000) {
  const start = Date.now();
  for (;;) {
    const { rows } = await pool.query(
      "SELECT event_name, params, tenant_id, created_at FROM analytics_events WHERE clerk_user_id = $1 ORDER BY created_at",
      [clerkUserId],
    );
    const present = new Set(rows.map((r) => r.event_name));
    if (requiredNames.every((n) => present.has(n))) return rows;
    if (Date.now() - start > timeoutMs) return rows;
    await new Promise((r) => setTimeout(r, 3000));
  }
}

const names = (rows) => rows.map((r) => r.event_name);
const has = (rows, name, pred) =>
  rows.some((r) => r.event_name === name && (!pred || pred(r.params ?? {})));

async function runUserA(browser) {
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 900 } })).newPage();
  page.on("console", (m) => {
    if (m.type() === "error") console.log("[A console.error]", m.text().slice(0, 200));
  });
  const user = await signIn(page, EMAIL_A, "Interview");
  createdUsers.push({ ...user, email: EMAIL_A });
  // Test hook: verify failure-path cleanup (user registered above must
  // still be fully removed when the run dies mid-flow).
  if (process.env.E2E_INDUCE_FAILURE === "after-signin") {
    await page.waitForTimeout(8000); // let the tenant provision
    throw new Error("induced failure after sign-in (E2E_INDUCE_FAILURE)");
  }
  // Sit on the consent dialog past the 10s flush interval: pre-consent
  // events (onboarding_started) must survive the intervening flush tick.
  await consentWithAnalytics(page, 13000);

  await page.locator("button", { hasText: "Let's do it" }).click();

  // Q1 name (input)
  await page.getByPlaceholder("e.g. Acme Coffee").fill("Sunrise Pottery");
  await page.locator("button", { hasText: /^Next/ }).click();
  // Q2 business (textarea)
  await page
    .getByPlaceholder("e.g. We roast small-batch coffee and ship it across India.")
    .fill("We handcraft ceramic mugs and planters in small batches.");
  await page.locator("button", { hasText: /^Next/ }).click();
  // Q3 audience (textarea)
  await page
    .getByPlaceholder("e.g. Young professionals who love specialty coffee.")
    .fill("Home decor lovers and gift shoppers in India.");
  await page.locator("button", { hasText: /^Next/ }).click();
  // Q4 tone (chips)
  await page.locator("button", { hasText: /^Friendly$/ }).click();
  await shot(page, "a-interview-last");
  await page.locator("button", { hasText: "Create my brand & first post" }).click();
  console.log("[ui] interview submitted; waiting for setup to finish…");

  // Either success ("Your first post is ready") or the graceful failure toast.
  await page
    .getByText(/Your first post is ready|Brand created/)
    .first()
    .waitFor({ timeout: 180000 });
  const success = (await page.getByText("Your first post is ready").count()) > 0;
  console.log(`[ui] setup finished; first post ${success ? "GENERATED" : "FAILED (fallback toast)"}`);
  await shot(page, "a-after-setup");

  // Let the analytics queue flush (10s interval), then force one more page
  // nav (flush on pagehide) and poll the DB.
  await page.waitForTimeout(12000);
  await page.goto(`${BASE}/library`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(12000);

  const rows = await pollEvents(user.id, [
    "sign_up",
    "onboarding_started",
    "onboarding_interview_completed",
    "onboarding_brand_kit_created",
    "caption_generated",
    "content_saved",
    "onboarding_first_post_generated",
    "onboarding_completed",
  ]);
  console.log("[db] user A events:", JSON.stringify(names(rows)));

  assert(has(rows, "sign_up"), "A: sign_up recorded");
  assert(has(rows, "onboarding_started"), "A: onboarding_started recorded");
  const answered = rows.filter((r) => r.event_name === "onboarding_question_answered");
  assert(answered.length === 4, `A: 4 onboarding_question_answered (got ${answered.length})`);
  assert(has(rows, "onboarding_interview_completed"), "A: onboarding_interview_completed recorded");
  assert(has(rows, "onboarding_brand_kit_created"), "A: onboarding_brand_kit_created recorded");
  assert(success, "A: first post generation succeeded in the UI");
  assert(
    has(rows, "caption_generated", (p) => p.source === "onboarding"),
    'A: caption_generated with source "onboarding"',
  );
  assert(
    has(rows, "content_saved", (p) => p.source === "onboarding"),
    'A: content_saved with source "onboarding"',
  );
  assert(has(rows, "onboarding_first_post_generated"), "A: onboarding_first_post_generated recorded");
  assert(has(rows, "onboarding_completed"), "A: onboarding_completed recorded");
  assert(!has(rows, "onboarding_skipped"), "A: no onboarding_skipped (did not skip)");

  const tenantId = rows.find((r) => r.tenant_id != null)?.tenant_id;
  assert(tenantId != null, `A: events carry a tenant id (${tenantId})`);
  await page.context().close();
  return { user, tenantId };
}

async function runUserB(browser) {
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 900 } })).newPage();
  const user = await signIn(page, EMAIL_B, "Skipper");
  createdUsers.push({ ...user, email: EMAIL_B });
  await consentWithAnalytics(page);
  await page.locator("button", { hasText: "Skip for now" }).click();
  // Wizard closes once /me refreshes.
  await page.getByText("Welcome to KOKAO").first().waitFor({ state: "detached", timeout: 30000 });
  console.log("[ui] B skipped onboarding at the welcome step");
  await page.waitForTimeout(12000);
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(12000);

  const rows = await pollEvents(user.id, [
    "sign_up",
    "onboarding_started",
    "onboarding_skipped",
  ]);
  console.log("[db] user B events:", JSON.stringify(names(rows)));
  assert(has(rows, "onboarding_started"), "B: onboarding_started recorded");
  assert(
    has(rows, "onboarding_skipped", (p) => p.stage === "welcome"),
    'B: onboarding_skipped with stage "welcome"',
  );
  assert(!has(rows, "onboarding_completed"), "B: skip did NOT emit onboarding_completed");
  await page.context().close();
  return { user };
}

async function checkFunnel(browser, tenantId) {
  const superEmail = (process.env.SUPERADMIN_EMAILS || "").split(",")[0]?.trim();
  if (!superEmail) throw new Error("SUPERADMIN_EMAILS not set");
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 900 } })).newPage();
  await signIn(page, superEmail, "Super");
  // In-page authed fetch against the funnels endpoint, drilled into tenant A.
  const from = new Date(Date.now() - 2 * 3600_000).toISOString();
  const to = new Date(Date.now() + 60_000).toISOString();
  const data = await page.evaluate(
    async ({ tenantId, from, to }) => {
      const token = await window.Clerk.session.getToken();
      const res = await fetch(
        `/api/analytics/funnels?tenantId=${tenantId}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) throw new Error(`funnels ${res.status}: ${await res.text()}`);
      return res.json();
    },
    { tenantId, from, to },
  );
  console.log("[api] tenant-scoped funnel:", JSON.stringify(data.funnel), "onboarding:", JSON.stringify(data.onboarding));
  const step = (label) => data.funnel.find((s) => s.step === label);
  assert(step("Signed up")?.count === 1, "funnel: Signed up counts user A");
  assert(step("Completed onboarding")?.count === 1, "funnel: Completed onboarding counts user A");
  assert(step("Generated first content")?.count === 1, 'funnel: "Generated first content" counts user A');
  assert(step("Saved to library")?.count === 1, 'funnel: "Saved to library" counts user A');
  assert(data.onboarding.started === 1 && data.onboarding.completed === 1, "funnel: onboarding started/completed = 1/1");

  // Platform-wide window sanity: skip is captured for the same window.
  const plat = await page.evaluate(
    async ({ from, to }) => {
      const token = await window.Clerk.session.getToken();
      const res = await fetch(
        `/api/analytics/funnels?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!res.ok) throw new Error(`funnels(platform) ${res.status}`);
      return res.json();
    },
    { from, to },
  );
  assert(
    plat.onboarding.started >= 2 && plat.onboarding.completed >= 1,
    "platform funnel window sees both runs (started>=2, completed>=1)",
  );

  // UI check: Analytics → Activation & Funnels renders with the data.
  await page.goto(`${BASE}/admin/analytics?tenantId=${tenantId}`, { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForTimeout(1500);
  await shot(page, "funnels-ui");
  await page.context().close();
}

// Every created Clerk user is registered here IMMEDIATELY after sign-in —
// before any fallible UI step — so cleanup runs even on mid-flow failures.
const createdUsers = [];

// Scoped cleanup: remove ONLY rows created by this run — the Clerk users,
// their tenants (FKs cascade), their analytics events, and their consent
// rows. Tenants are discovered independently of analytics rows (by clerk
// user id, tenant email, AND any tenant ids seen in analytics events) so a
// run that failed before any event was written still cleans up its tenant.
// Cleanup failures are surfaced as run failures.
async function cleanup(users) {
  let failed = false;
  for (const u of users) {
    try {
      await clerkApi(`/users/${u.id}`, undefined, "DELETE");
      console.log("[cleanup] deleted clerk user", u.id);
    } catch (e) {
      failed = true;
      console.log("[cleanup] clerk delete FAILED:", e.message);
    }
    try {
      const { rows } = await pool.query(
        `SELECT id AS tenant_id FROM tenants WHERE clerk_user_id = $1 OR email = $2
         UNION
         SELECT DISTINCT tenant_id FROM analytics_events WHERE clerk_user_id = $1 AND tenant_id IS NOT NULL`,
        [u.id, u.email ?? ""],
      );
      for (const r of rows) {
        await pool.query("DELETE FROM tenants WHERE id = $1", [r.tenant_id]);
        console.log("[cleanup] deleted tenant", r.tenant_id);
      }
      await pool.query("DELETE FROM analytics_events WHERE clerk_user_id = $1", [u.id]);
      await pool.query("DELETE FROM user_consents WHERE clerk_user_id = $1", [u.id]);
      console.log("[cleanup] deleted DB rows for", u.id);
    } catch (e) {
      failed = true;
      console.log("[cleanup] DB cleanup FAILED for", u.id, ":", e.message);
    }
  }
  if (failed) throw new Error("cleanup incomplete — re-run cleanup before trusting results");
}

const main = async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_BIN || "chromium",
    args: ["--no-sandbox"],
  });
  try {
    const a = await runUserA(browser);
    const b = await runUserB(browser);
    void b;
    await checkFunnel(browser, a.tenantId);
    console.log("E2E onboarding-funnel PASS");
  } finally {
    await cleanup(createdUsers);
    await browser.close();
    await pool.end();
  }
};

main().catch((err) => {
  console.error("E2E onboarding-funnel FAIL:", err.message);
  process.exit(1);
});
