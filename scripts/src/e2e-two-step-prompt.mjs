/* eslint-disable no-console */
// Browser e2e for task 786: two-step governed prompt workflow.
// Multi-shot text_to_video with storyboard review ON -> approve -> renderVisual
// persisted + prompt_compiled trace rows for video_script and video_scene_image.
// Usage: node scripts/src/e2e-two-step-prompt.mjs <email> <baselineLogId>
import { chromium } from "playwright";
import { execSync } from "node:child_process";

const email = process.argv[2];
const baseline = Number(process.argv[3] ?? 0);
if (!email) {
  console.error("usage: node e2e-two-step-prompt.mjs <email> <baselineLogId>");
  process.exit(2);
}
const BASE = `https://${process.env.REPLIT_DEV_DOMAIN}`;
const CLERK_KEY = process.env.CLERK_SECRET_KEY;

const psql = (q) =>
  execSync(`psql "$DATABASE_URL" -t -A -c ${JSON.stringify(q.replace(/\s+/g, " "))}`)
    .toString()
    .trim();

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
    first_name: "Two",
    last_name: "Step",
    skip_password_requirement: true,
  });
}

const shot = async (page, name) => {
  await page.screenshot({ path: `/tmp/e2e-2step-${name}.png`, fullPage: false });
  console.log(`[shot] /tmp/e2e-2step-${name}.png`);
};

const dismissDialogs = async (page) => {
  await page.waitForTimeout(3500);
  for (let i = 0; i < 6; i++) {
    const dlg = page.locator('[role="dialog"]');
    if ((await dlg.count()) === 0) break;
    const btn = dlg.first().locator("button", { hasText: /^(continue|close|skip|got it|not now)/i });
    if ((await btn.count()) > 0) await btn.first().click().catch(() => {});
    else await page.keyboard.press("Escape");
    await page.waitForTimeout(1000);
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const main = async () => {
  const user = await getOrCreateUser();
  const token = await clerkApi("/sign_in_tokens", { user_id: user.id, expires_in_seconds: 600 });

  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_BIN || "chromium",
    args: ["--no-sandbox"],
  });
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 900 } })).newPage();
  page.on("console", (m) => {
    if (m.type() === "error") console.log("[console.error]", m.text().slice(0, 200));
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

  let tenantId = "";
  for (let i = 0; i < 15 && !tenantId; i++) {
    tenantId = psql(`SELECT id FROM tenants WHERE lower(email) = lower('${email}')`);
    if (!tenantId) {
      await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
      await sleep(2000);
    }
  }
  if (!tenantId) throw new Error("tenant not provisioned");
  console.log("[db] tenant", tenantId);

  // --- Create the job through the UI (or resume a job already awaiting review) ---
  await page.goto(`${BASE}/studio?tab=video`, { waitUntil: "domcontentloaded" });
  await dismissDialogs(page);
  const existing = psql(
    `SELECT id FROM video_generations WHERE tenant_id=${tenantId} AND status='awaiting_review' AND engine='text_to_video' ORDER BY id DESC LIMIT 1`,
  );
  if (existing) {
    console.log("[db] resuming existing awaiting_review job", existing);
  } else {
  await page.getByTestId("tab-text-to-video").click();
  await page
    .getByTestId("input-video-prompt")
    .fill(
      "A street food vendor in Mumbai makes masala dosa at dawn; customers gather as the griddle sizzles; the first steaming dosa is served with chutney",
    );
  await page.getByTestId("select-shot-count").click();
  await page.getByTestId("option-shots-2").click();
  const costText = (await page.getByTestId("text-shot-cost").innerText()).trim();
  console.log("[ui] shot cost:", costText);
  if (!/2 (clips|video units)/.test(costText) && !costText.includes("2 video units")) {
    throw new Error(`expected 2-unit cost blurb, got: ${costText}`);
  }
  const reviewSwitch = page.getByTestId("switch-review-storyboard");
  const state = await reviewSwitch.getAttribute("data-state");
  console.log("[ui] review toggle:", state);
  if (state !== "checked") {
    await reviewSwitch.click();
    await sleep(300);
  }
  await shot(page, "1-form");
  await page.getByTestId("button-generate-video").click();
  }

  // --- Wait for the awaiting_review pause (video_script split happens here) ---
  let jobId = "";
  let status = "";
  for (let i = 0; i < 60; i++) {
    const row = psql(
      `SELECT id || '|' || status FROM video_generations WHERE tenant_id=${tenantId} ORDER BY id DESC LIMIT 1`,
    );
    if (row) [jobId, status] = row.split("|");
    if (status === "awaiting_review") break;
    if (status === "failed") throw new Error(`job ${jobId} failed during planning`);
    await sleep(3000);
  }
  console.log("[db] job", jobId, "status", status);
  if (status !== "awaiting_review") throw new Error(`job never paused for review (status=${status})`);

  const board = psql(
    `SELECT storyboard->>'visualsSource' || '|' || jsonb_array_length(storyboard->'scenes') FROM video_generations WHERE id=${jobId}`,
  );
  console.log("[db] storyboard:", board);
  if (board !== "prompt|2") throw new Error(`expected prompt|2 storyboard, got ${board}`);

  const scriptLog = psql(
    `SELECT count(*) FROM compiled_prompt_logs c JOIN prompt_case_types p ON p.id=c.case_type_id
     WHERE c.id > ${baseline} AND c.tenant_id=${tenantId} AND p.flow_key='video_script'`,
  );
  console.log("[db] video_script trace rows since baseline:", scriptLog);
  if (Number(scriptLog) < 1) throw new Error("no video_script compiled-prompt trace row");

  // --- Open the storyboard, verify shot cards, approve ---
  if ((await page.getByTestId("storyboard-review").count()) === 0) {
    await page.getByTestId("button-open-storyboard").waitFor({ timeout: 30000 });
    // A dialog (consent or auto-opened) can overlay the page here.
    await dismissDialogs(page);
    if ((await page.getByTestId("storyboard-review").count()) === 0) {
      await page.getByTestId("button-open-storyboard").click();
    }
  }
  await page.getByTestId("storyboard-review").waitFor({ timeout: 20000 });
  const s1 = await page.getByTestId("input-shot-s1").inputValue();
  const s2 = await page.getByTestId("input-shot-s2").inputValue();
  console.log("[ui] shot s1:", s1.slice(0, 90));
  console.log("[ui] shot s2:", s2.slice(0, 90));
  if (!s1.trim() || !s2.trim()) throw new Error("shot texts missing in review UI");
  await shot(page, "2-review");
  await page.getByTestId("button-approve-storyboard").click();
  console.log("[ui] approved");

  // --- renderVisual must persist shortly after approve, before/while rendering ---
  let rv = "";
  for (let i = 0; i < 40; i++) {
    rv = psql(
      `SELECT count(*) FILTER (WHERE coalesce(scene->>'renderVisual','') <> '') || '/' || count(*)
       FROM video_generations, jsonb_array_elements(storyboard->'scenes') scene WHERE id=${jobId}`,
    );
    if (rv === "2/2") break;
    const st = psql(`SELECT status FROM video_generations WHERE id=${jobId}`);
    if (st === "failed" || st === "succeeded") break;
    await sleep(3000);
  }
  console.log("[db] scenes with renderVisual:", rv);
  if (rv !== "2/2") throw new Error(`renderVisual not persisted on all scenes (${rv})`);
  const rvSample = psql(
    `SELECT scene->>'id' || ': ' || left(scene->>'renderVisual', 120)
     FROM video_generations, jsonb_array_elements(storyboard->'scenes') scene WHERE id=${jobId}`,
  );
  console.log("[db] renderVisual sample:\n" + rvSample);

  const polishLog = psql(
    `SELECT count(*) FROM compiled_prompt_logs c JOIN prompt_case_types p ON p.id=c.case_type_id
     WHERE c.id > ${baseline} AND c.tenant_id=${tenantId} AND p.flow_key='video_scene_image'`,
  );
  console.log("[db] video_scene_image trace rows since baseline:", polishLog);
  if (Number(polishLog) < 1) throw new Error("no video_scene_image compiled-prompt trace row");

  // --- Wait for a terminal state (real Replicate render; caller re-polls DB if slow) ---
  const maxPolls = Number(process.env.FINAL_POLLS ?? 40);
  let finalRow = "";
  for (let i = 0; i < maxPolls; i++) {
    finalRow = psql(
      `SELECT status || '|' || coalesce(left(error, 120), '') || '|' || (video_path IS NOT NULL) || '|' || coalesce(funding,'') FROM video_generations WHERE id=${jobId}`,
    );
    const st = finalRow.split("|")[0];
    if (st === "succeeded" || st === "failed") break;
    await sleep(5000);
  }
  console.log("[db] final:", finalRow);
  const [finalStatus, err, hasVideo] = finalRow.split("|");
  if (finalStatus === "succeeded") {
    if (hasVideo !== "t") throw new Error("succeeded but no video_path");
    await page.goto(`${BASE}/studio?tab=video`, { waitUntil: "domcontentloaded" });
    await dismissDialogs(page);
    await page.getByTestId(`job-card-${jobId}`).click().catch(() => {});
    await sleep(2000);
    await shot(page, "3-final");
  } else if (finalStatus === "failed") {
    console.log("[db] job failed (acceptable if funding settled):", err);
    await shot(page, "3-final-failed");
  } else {
    console.log("[db] still rendering after poll budget; caller should keep polling job", jobId);
  }

  await browser.close();
  console.log("RESULT", JSON.stringify({ jobId, finalStatus, hasVideo, scriptLog, polishLog }));
  console.log("PASS");
};

main().catch((err) => {
  console.error("FAIL:", err.message);
  process.exit(1);
});
