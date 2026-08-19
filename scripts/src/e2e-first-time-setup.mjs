// First-time-user regression: consent → onboarding skip → /brand-kits renders.
// Usage: node scripts/src/e2e-first-time-setup.mjs [email] [mode]
//   mode: "skip" (default) = skip onboarding at the welcome step
// Creates a fresh Clerk user unless an email is given.
import { chromium } from "playwright";
import { createRequire } from "node:module";
// Resolve pg through the api-server package (workspace-relative, not absolute).
const pg = createRequire(
  new URL("../../artifacts/api-server/package.json", import.meta.url),
)("pg");

const BASE = `https://${process.env.REPLIT_DEV_DOMAIN}`;
const CLERK_SECRET_KEY = process.env.CLERK_SECRET_KEY;
if (!CLERK_SECRET_KEY) throw new Error("CLERK_SECRET_KEY missing");

const email =
  process.argv[2] || `test_first_time_${Date.now()}@example.com`;
console.log("BASE:", BASE, "email:", email);

async function clerk(path, opts = {}) {
  const res = await fetch(`https://api.clerk.com${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${CLERK_SECRET_KEY}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Clerk ${path} ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

async function getOrCreateUser() {
  const found = await clerk(`/v1/users?email_address=${encodeURIComponent(email)}`);
  if (Array.isArray(found) && found.length) return found[0];
  return clerk("/v1/users", {
    method: "POST",
    body: JSON.stringify({
      email_address: [email],
      first_name: "First",
      last_name: "Timer",
      skip_password_requirement: true,
    }),
  });
}

const fail = (msg) => {
  console.error("FAIL:", msg);
  process.exitCode = 1;
};

const user = await getOrCreateUser();
console.log("clerk user:", user.id);
const { token } = await clerk("/v1/sign_in_tokens", {
  method: "POST",
  body: JSON.stringify({ user_id: user.id, expires_in_seconds: 600 }),
});

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_BIN || "chromium",
  args: ["--no-sandbox"],
});
try {
  const page = await (await browser.newContext()).newPage();
  page.on("console", (m) => {
    if (m.type() === "error") console.log("[console.error]", m.text().slice(0, 300));
  });
  page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 500)));

  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.Clerk?.loaded, null, { timeout: 60000 });
  const status = await page.evaluate(async (ticket) => {
    const res = await window.Clerk.client.signIn.create({ strategy: "ticket", ticket });
    if (res.status === "complete") {
      await window.Clerk.setActive({ session: res.createdSessionId });
      return "complete";
    }
    return res.status;
  }, token);
  if (status !== "complete") throw new Error(`sign-in status ${status}`);
  console.log("signed in");

  await page.goto(`${BASE}/brand-kits`, { waitUntil: "domcontentloaded" });

  // --- Consent step ---
  const continueBtn = page.getByRole("button", { name: "Continue" });
  await continueBtn.waitFor({ timeout: 30000 });
  console.log("consent dialog visible");
  await continueBtn.click();

  // Continue must not stay disabled/spinning: welcome step should appear.
  const skipBtn = page.getByRole("button", { name: "Skip for now" });
  try {
    await skipBtn.waitFor({ timeout: 20000 });
    console.log("welcome step visible");
  } catch {
    fail("welcome step never appeared after consent Continue (stuck loading?)");
    throw new Error("stuck at consent");
  }

  // --- Skip onboarding ---
  await skipBtn.click();
  await page
    .locator("[role=dialog]")
    .waitFor({ state: "detached", timeout: 20000 })
    .catch(() => fail("onboarding dialog never closed after Skip"));
  console.log("onboarding dismissed");

  // --- /brand-kits renders after setup ---
  await page.goto(`${BASE}/brand-kits`, { waitUntil: "domcontentloaded" });
  await page
    .getByRole("heading", { name: /brand kits/i })
    .first()
    .waitFor({ timeout: 30000 })
    .catch(async () => {
      fail("/brand-kits did not render a Brand Kits heading (blank screen?)");
      console.log("body text:", (await page.textContent("body"))?.slice(0, 500));
    });

  // The wizard must not reappear after completion.
  const dialogCount = await page.locator("[role=dialog]").count();
  if (dialogCount > 0) {
    const txt = await page.locator("[role=dialog]").first().textContent();
    if (/Your data, your choice|Welcome to KOKAO/.test(txt || ""))
      fail("onboarding/consent overlay reappeared after completion");
  }

  // --- Create a kit, then edit it ---
  const newBrandBtn = page.getByRole("button", { name: /new brand|create brand/i }).first();
  if ((await newBrandBtn.count()) === 0) {
    fail("no create affordance on /brand-kits");
  } else {
    await newBrandBtn.click();
    const dialog = page.locator("[role=dialog]");
    await dialog.getByPlaceholder(/acme|name/i).first().fill("First Timer Co").catch(async () => {
      await dialog.locator("input").first().fill("First Timer Co");
    });
    await dialog.getByRole("button", { name: /create brand/i }).click();
    // Kit card appears.
    await page.getByText("First Timer Co").first().waitFor({ timeout: 30000 })
      .catch(() => fail("created kit card never appeared"));

    // The page may auto-open the edit dialog after create; otherwise use the pencil.
    const editOpen = await page
      .getByText("Edit Brand")
      .first()
      .waitFor({ timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    if (!editOpen) {
      const editBtn = page.locator("button[title=Edit]").first();
      await editBtn.waitFor({ timeout: 15000 }).catch(() => fail("no Edit button on kit card"));
      if (!process.exitCode) {
        await editBtn.click();
        await page.getByText("Edit Brand").first().waitFor({ timeout: 15000 })
          .catch(() => fail("Edit Brand dialog did not open"));
      }
    }
  }

  console.log(process.exitCode ? "RESULT: FAIL" : "RESULT: PASS");
} finally {
  await browser.close();
  // Scoped cleanup: remove ONLY this run's throwaway Clerk user and its DB
  // rows (tenant FKs cascade). Cleanup failure fails the run so leaks are
  // never silent (leaked test_ tenants make sweep tests flaky).
  if (!process.argv[2]) {
    try {
      await clerk(`/v1/users/${user.id}`, { method: "DELETE" });
      const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
      try {
        const { rows } = await pool.query(
          "SELECT id FROM tenants WHERE clerk_user_id = $1 OR email = $2",
          [user.id, email],
        );
        for (const r of rows) {
          await pool.query("DELETE FROM tenants WHERE id = $1", [r.id]);
          console.log("cleanup: deleted tenant", r.id);
        }
        await pool.query("DELETE FROM user_consents WHERE clerk_user_id = $1", [user.id]);
        await pool.query("DELETE FROM analytics_events WHERE clerk_user_id = $1", [user.id]);
      } finally {
        await pool.end();
      }
      console.log("cleanup: done");
    } catch (e) {
      console.error("cleanup FAILED:", String(e).slice(0, 300));
      process.exitCode = 1;
    }
  }
}
