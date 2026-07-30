/* eslint-disable no-console */
// Browser e2e: saved text + logo layers survive closing and reopening the image editor.
// Flow: seed a post with an uploaded base image -> open editor -> add text + logo
// layers -> save (flatten) -> Save Changes (persist) -> verify persisted doc
// (basePath = ORIGINAL image, layers intact) -> reopen editor -> layers listed
// and still editable -> edit text, save again -> basePath unchanged.
// Usage: node scripts/src/e2e-image-layers-persist.mjs <email>
import { chromium } from "playwright";

const email = process.argv[2];
if (!email) {
  console.error("usage: node e2e-image-layers-persist.mjs <email>");
  process.exit(2);
}
const BASE = `https://${process.env.REPLIT_DEV_DOMAIN}`;
const CLERK_KEY = process.env.CLERK_SECRET_KEY;

// 1x1 red PNG (valid, decodable) used as the uploaded "logo" element.
const LOGO_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

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
    first_name: "Layer",
    last_name: "Persist",
    skip_password_requirement: true,
  });
}

const shot = async (page, name) => {
  await page.screenshot({ path: `/tmp/e2e-layers-${name}.png`, fullPage: false });
  console.log(`[shot] /tmp/e2e-layers-${name}.png`);
};

const dismissDialogs = async (page) => {
  await page.waitForTimeout(3000);
  for (let i = 0; i < 6; i++) {
    const dlg = page.locator('[role="dialog"]');
    if ((await dlg.count()) === 0) break;
    const btn = dlg.first().locator("button", { hasText: /^(continue|close|skip|got it|not now)/i });
    if ((await btn.count()) > 0) await btn.first().click().catch(() => {});
    else await page.keyboard.press("Escape");
    await page.waitForTimeout(1000);
  }
};

const assert = (cond, msg) => {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
  console.log(`[ok] ${msg}`);
};

const openEditorForItem = async (page, itemId) => {
  await page.goto(`${BASE}/library`, { waitUntil: "domcontentloaded" });
  await page.getByTestId(`card-content-${itemId}`).waitFor({ timeout: 60000 });
  await dismissDialogs(page);
  await shot(page, `library-before-open-${itemId}`);
  const card = page.getByTestId(`card-content-${itemId}`);
  await card.scrollIntoViewIfNeeded();
  // Cards open their edit dialog on DOUBLE-click (title text is a safe target).
  await card.locator("h3").dblclick({ timeout: 15000 }).catch(async (e) => {
    await shot(page, `click-fail-${itemId}`);
    throw e;
  });
  await page.getByTestId("button-open-image-editor").waitFor({ timeout: 15000 });
  await page.getByTestId("button-open-image-editor").click();
  await page.getByTestId("image-editor-dialog").waitFor({ timeout: 15000 });
  // Wait for the base image to load (Save enabled only once baseImg exists).
  await page.waitForFunction(
    () => {
      const btn = document.querySelector('[data-testid="editor-save"]');
      return btn && !btn.disabled;
    },
    null,
    { timeout: 30000 },
  );
};

const saveEditorAndPost = async (page) => {
  await page.getByTestId("editor-save").click();
  await page.getByText("Image updated", { exact: false }).first().waitFor({ timeout: 30000 });
  console.log("[ui] editor saved (flattened + uploaded)");
  await page.getByRole("button", { name: "Save Changes" }).click();
  await page.getByText("Content updated", { exact: false }).first().waitFor({ timeout: 15000 });
  console.log("[ui] post saved");
  // Let the edit dialog close.
  await page.waitForTimeout(1000);
};

const fetchItem = (page, itemId) =>
  page.evaluate(async (id) => {
    const token = await window.Clerk.session.getToken();
    const res = await fetch(`/api/content/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`GET /content/${id} ${res.status}`);
    return res.json();
  }, itemId);

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

  // ---- Seed: upload a 400x300 base image, create a post that uses it ----
  const seeded = await page.evaluate(async () => {
    const token = await window.Clerk.session.getToken();
    const auth = { Authorization: `Bearer ${token}` };
    const canvas = document.createElement("canvas");
    canvas.width = 400;
    canvas.height = 300;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#2563eb";
    ctx.fillRect(0, 0, 400, 300);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(40, 40, 320, 220);
    const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
    const reqRes = await fetch("/api/storage/uploads/request-url", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "e2e-base.png", size: blob.size, contentType: "image/png" }),
    });
    if (!reqRes.ok) throw new Error(`request-url ${reqRes.status}`);
    const { uploadURL, objectPath } = await reqRes.json();
    const put = await fetch(uploadURL, { method: "PUT", body: blob, headers: { "Content-Type": "image/png" } });
    if (!put.ok) throw new Error(`upload PUT ${put.status}`);
    const createRes = await fetch("/api/content", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        title: `E2E layers persist ${Date.now()}`,
        caption: "e2e image-layer persistence check",
        platform: "instagram",
        status: "draft",
        imagePath: objectPath,
      }),
    });
    if (!createRes.ok) throw new Error(`POST /content ${createRes.status}: ${await createRes.text()}`);
    const item = await createRes.json();
    return { itemId: item.id, originalPath: objectPath };
  });
  console.log("[seed] item", seeded.itemId, "original image", seeded.originalPath);

  // ---- Round 1: open editor, add text + logo layers, save, save post ----
  await openEditorForItem(page, seeded.itemId);
  await shot(page, "editor-open-1");

  await page.getByTestId("editor-add-text").click();
  await page.getByTestId("editor-text-input").waitFor({ timeout: 10000 });
  await page.getByTestId("editor-text-input").fill("E2E LAYER 736");
  console.log("[ui] text layer added");

  const logoBuffer = Buffer.from(LOGO_PNG_B64, "base64");
  await page
    .getByTestId("image-editor-dialog")
    .locator('input[type="file"]')
    .setInputFiles({ name: "e2e-logo.png", mimeType: "image/png", buffer: logoBuffer });
  await page
    .getByTestId("editor-layer-panel")
    .getByText("Element layer", { exact: false })
    .waitFor({ timeout: 30000 });
  console.log("[ui] logo/element layer added");
  await shot(page, "layers-added");

  await saveEditorAndPost(page);

  // ---- Verify the persisted doc: basePath = ORIGINAL image, 2 layers ----
  const after1 = await fetchItem(page, seeded.itemId);
  const doc1 = after1.imageLayers;
  assert(doc1 && doc1.version === 1, "persisted imageLayers doc has version 1");
  assert(doc1.basePath === seeded.originalPath, "doc.basePath is the ORIGINAL pre-flatten image");
  assert(after1.imagePath !== seeded.originalPath, "post imagePath is a NEW flattened object");
  assert(Array.isArray(doc1.layers) && doc1.layers.length === 2, "doc has 2 layers");
  const textLayer1 = doc1.layers.find((l) => l.type === "text");
  const elemLayer1 = doc1.layers.find((l) => l.type === "image");
  assert(textLayer1 && textLayer1.text === "E2E LAYER 736", "text layer persisted with its content");
  assert(elemLayer1 && typeof elemLayer1.objectPath === "string", "logo layer persisted with its objectPath");

  // ---- Round 2: reopen the editor; layers must be present and editable ----
  await openEditorForItem(page, seeded.itemId);
  await shot(page, "editor-reopen");
  const list = page.getByTestId("editor-layer-list");
  await list.waitFor({ timeout: 15000 });
  await list.getByText("Text: E2E LAYER 736", { exact: false }).waitFor({ timeout: 10000 });
  await list.getByText("Element", { exact: true }).waitFor({ timeout: 10000 });
  console.log("[ui] reopened editor lists both saved layers");

  // Editability: select the text layer, its content shows in the input, change it.
  await list.getByText("Text: E2E LAYER 736", { exact: false }).click();
  const textInput = page.getByTestId("editor-text-input");
  await textInput.waitFor({ timeout: 10000 });
  assert((await textInput.inputValue()) === "E2E LAYER 736", "reopened text layer is editable with original content");
  await textInput.fill("E2E LAYER 736 v2");
  await shot(page, "text-edited-on-reopen");

  await saveEditorAndPost(page);

  // ---- Verify round 2: basePath STILL the original, edit stuck, no layer loss ----
  const after2 = await fetchItem(page, seeded.itemId);
  const doc2 = after2.imageLayers;
  assert(doc2 && doc2.version === 1, "round-2 doc has version 1");
  assert(doc2.basePath === seeded.originalPath, "round-2 basePath STILL the original image (never the flattened one)");
  assert(after2.imagePath !== after1.imagePath, "round-2 produced a fresh flattened object");
  assert(doc2.layers.length === 2, "round-2 still has both layers (nothing dropped)");
  const textLayer2 = doc2.layers.find((l) => l.type === "text");
  assert(textLayer2 && textLayer2.text === "E2E LAYER 736 v2", "text edit on reopen persisted");
  const elemLayer2 = doc2.layers.find((l) => l.type === "image");
  assert(elemLayer2 && elemLayer2.objectPath === elemLayer1.objectPath, "logo layer survived the reopen round-trip");

  // Cleanup the seeded post.
  await page.evaluate(async (id) => {
    const token = await window.Clerk.session.getToken();
    await fetch(`/api/content/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
  }, seeded.itemId);

  await browser.close();
  console.log("E2E image-layers-persist PASS");
};

main().catch(async (err) => {
  console.error("E2E image-layers-persist FAIL:", err.message);
  process.exit(1);
});
