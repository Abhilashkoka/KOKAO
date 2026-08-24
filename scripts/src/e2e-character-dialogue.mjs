/* eslint-disable no-console */
// Real-browser Character Dialogue regression:
// - provisions a throwaway Clerk user and tenant
// - seeds a tenant-owned character/outfits, active cloned-voice Brand Kit, and
//   retryable failed Character Dialogue job
// - intercepts only the paid/write endpoints so no provider call or generation
//   starts, while all fixture reads still come from the real API and database
// - verifies Telugu setup, long-script approval/consent, final payload, and retry
// Usage: pnpm run test:e2e:character-dialogue
import { chromium } from "playwright";
import { createRequire } from "node:module";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const pg = createRequire(
  new URL("../../artifacts/api-server/package.json", import.meta.url),
)("pg");

const BASE = `https://${process.env.REPLIT_DEV_DOMAIN}`;
const CLERK_KEY = process.env.CLERK_SECRET_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
const RUN_ID = Date.now().toString(36);
const EMAIL = `e2e-character-dialogue-${RUN_ID}@example.com`;
const CHARACTER_NAME = `Maya Dialogue ${RUN_ID}`;
const OUTFIT_NAME = `Presentation Look ${RUN_ID}`;
const KIT_NAME = `Dialogue Voice ${RUN_ID}`;
const TOPIC =
  "తెలుగులో చిన్న వ్యాపారాల కోసం స్థిరమైన కస్టమర్ సంబంధాలను ఎలా నిర్మించాలో వివరించండి";
const LONG_SCRIPT = [
  "నమస్కారం! ప్రతి మంచి వ్యాపారం ఒక నిజమైన సంభాషణతో ప్రారంభమవుతుంది.",
  "మీ కస్టమర్లు ఏమి కోరుకుంటున్నారో శ్రద్ధగా వినండి, వారి ప్రశ్నలకు స్పష్టంగా సమాధానం ఇవ్వండి, మరియు ఇచ్చిన మాటను ప్రతి సారి నిలబెట్టుకోండి.",
  "వారానికి ఒకసారి ఉపయోగకరమైన సూచనను పంచుకోండి, కొనుగోలు తర్వాత వారి అనుభవాన్ని అడగండి, మరియు వచ్చిన అభిప్రాయాన్ని తదుపరి సేవలో కనిపించే మార్పుగా మార్చండి.",
  "ఈ చిన్న అలవాట్లు నమ్మకాన్ని పెంచుతాయి, మళ్లీ వచ్చే కస్టమర్లను సృష్టిస్తాయి, మరియు మీ బ్రాండ్‌ను మనుషులకు దగ్గరగా ఉంచుతాయి.",
].join(" ");

if (!process.env.REPLIT_DEV_DOMAIN) throw new Error("REPLIT_DEV_DOMAIN missing");
if (!CLERK_KEY) throw new Error("CLERK_SECRET_KEY missing");
if (!DATABASE_URL) throw new Error("DATABASE_URL missing");

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
let browser;
let clerkUser;
let tenantId;

const assert = (condition, message) => {
  if (!condition) throw new Error(`ASSERT FAIL: ${message}`);
  console.log(`[ok] ${message}`);
};

function resolveChromiumExecutable() {
  const configured = process.env.CHROMIUM_BIN;
  if (configured) {
    if (!existsSync(configured)) {
      throw new Error(`CHROMIUM_BIN does not exist: ${configured}`);
    }
    return configured;
  }
  const playwrightPath = chromium.executablePath();
  if (existsSync(playwrightPath)) return playwrightPath;
  const nixChromium = readdirSync("/nix/store")
    .filter((entry) => !entry.includes("ungoogled") && /-chromium-\d/.test(entry))
    .map((entry) => ({
      path: join("/nix/store", entry, "bin", "chromium"),
      major: Number(entry.match(/-chromium-(\d+)/)?.[1] ?? 0),
    }))
    .sort((a, b) => b.major - a.major)
    .map(({ path }) => path)
    .find((candidate) => existsSync(candidate));
  if (nixChromium) return nixChromium;
  throw new Error(
    "Chromium is unavailable. Set CHROMIUM_BIN or install the Chromium system dependency.",
  );
}

async function clerkApi(path, body, method = "POST") {
  const response = await fetch(`https://api.clerk.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${CLERK_KEY}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Clerk ${path} ${response.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

async function createUser() {
  return clerkApi("/users", {
    email_address: [EMAIL],
    first_name: "Dialogue",
    last_name: "Browser",
    skip_password_requirement: true,
  });
}

async function signIn(page, userId) {
  const { token } = await clerkApi("/sign_in_tokens", {
    user_id: userId,
    expires_in_seconds: 600,
  });
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.Clerk?.loaded, null, { timeout: 60_000 });
  const status = await page.evaluate(async (ticket) => {
    const result = await window.Clerk.client.signIn.create({
      strategy: "ticket",
      ticket,
    });
    if (result.status !== "complete") return result.status;
    await window.Clerk.setActive({ session: result.createdSessionId });
    return "complete";
  }, token);
  assert(status === "complete", `Clerk ticket sign-in completed (${status})`);
}

async function waitForTenant(page, userId) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await pool.query(
      "SELECT id FROM tenants WHERE clerk_user_id = $1 OR lower(email) = lower($2) ORDER BY id DESC LIMIT 1",
      [userId, EMAIL],
    );
    if (result.rows[0]?.id) return Number(result.rows[0].id);
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1_000);
  }
  throw new Error("tenant was not provisioned");
}

function brandKitPayload(tenant) {
  return {
    identity: {
      brand_name: KIT_NAME,
      brand_slug: `dialogue-voice-${RUN_ID}`,
      tagline: "Clear conversations in every language",
      description: "Provider-free browser fixture",
      industry: "Software",
      audience: ["Small businesses"],
    },
    logos: {
      primary: null,
      secondary: null,
      icon_mark: null,
      favicon: null,
      usage_rules: [],
    },
    colors: { primary: [], secondary: [], neutral: [], semantic: [] },
    typography: {
      heading_font: "Inter",
      body_font: "Inter",
      fallback_fonts: ["sans-serif"],
      scale: {
        h1: "2rem",
        h2: "1.5rem",
        h3: "1.25rem",
        h4: "1rem",
        body: "1rem",
        small: "0.875rem",
        caption: "0.75rem",
      },
      weights: { regular: 400, medium: 500, semibold: 600, bold: 700 },
    },
    voice: {
      traits: ["clear", "helpful"],
      dos: ["Use plain language"],
      donts: ["Overpromise"],
      caption_style: "Concise",
      cta_style: "Inviting",
    },
    visual_style: {
      imagery_style: ["clean"],
      icon_style: "simple",
      illustration_style: "minimal",
      motion_style: "calm",
    },
    layout_tokens: {
      base_unit: "4px",
      radius: { sm: "4px", md: "8px", lg: "12px" },
      shadow: { sm: "none", md: "none", lg: "none" },
    },
    channel_rules: {},
    brand_voice: {
      mode: "cloned",
      preset_voice: "nova",
      delivery_style: "Warm and clear",
      provider: "elevenlabs",
      provider_voice_id: `fixture-voice-${RUN_ID}`,
      sample_asset_path: `/objects/${tenant}/uploads/dialogue-voice-sample.wav`,
      cloned_label: "Fixture voice",
      cloned_accent: "indian_english",
      cloned_at: new Date().toISOString(),
    },
    base_videos: [],
    brand_controls: {
      approved: true,
      approval_status: "approved",
      allowed_use_cases: ["marketing"],
      restricted_terms: [],
    },
  };
}

async function seedFixture(userId, tenant) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO user_consents
        (clerk_user_id, analytics, device_details, location_coarse, location_precise, carrier, responded_at)
       VALUES ($1, false, false, false, false, false, now())
       ON CONFLICT (clerk_user_id)
       DO UPDATE SET responded_at = now(), updated_at = now()`,
      [userId],
    );
    await client.query(
      "UPDATE tenants SET brand_onboarding_complete = true, updated_at = now() WHERE id = $1",
      [tenant],
    );

    const character = (
      await client.query(
        `INSERT INTO characters (tenant_id, name, description, reference_image_path)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [
          tenant,
          CHARACTER_NAME,
          "A friendly fictional product educator",
          `/objects/${tenant}/uploads/dialogue-character.png`,
        ],
      )
    ).rows[0];
    await client.query(
      `INSERT INTO character_outfits
        (tenant_id, character_id, name, description, reference_image_path, is_default)
       VALUES ($1, $2, $3, $4, $5, true)`,
      [
        tenant,
        character.id,
        `Default ${RUN_ID}`,
        "Smart casual clothes",
        `/objects/${tenant}/uploads/dialogue-character.png`,
      ],
    );
    const outfit = (
      await client.query(
        `INSERT INTO character_outfits
          (tenant_id, character_id, name, description, reference_image_path, is_default)
         VALUES ($1, $2, $3, $4, $5, false) RETURNING id`,
        [
          tenant,
          character.id,
          OUTFIT_NAME,
          "A presentation-ready blue jacket",
          `/objects/${tenant}/uploads/dialogue-character-presentation.png`,
        ],
      )
    ).rows[0];

    const kit = (
      await client.query(
        `INSERT INTO brand_kits
          (tenant_id, name, slug, brand_type, status, is_default, is_archived, created_by)
         VALUES ($1, $2, $3, 'primary', 'active', true, false, $4) RETURNING id`,
        [tenant, KIT_NAME, `dialogue-voice-${RUN_ID}`, userId],
      )
    ).rows[0];
    const version = (
      await client.query(
        `INSERT INTO brand_kit_versions
          (tenant_id, brand_kit_id, version_number, source_type, source_notes,
           approval_status, json_payload, created_by)
         VALUES ($1, $2, 1, 'manual', 'Character Dialogue browser fixture',
           'approved', $3::jsonb, $4) RETURNING id`,
        [tenant, kit.id, JSON.stringify(brandKitPayload(tenant)), userId],
      )
    ).rows[0];
    await client.query(
      "UPDATE brand_kits SET active_version_id = $1, updated_at = now() WHERE id = $2",
      [version.id, kit.id],
    );

    const failedOptions = {
      aspectRatio: "9:16",
      dialogue: LONG_SCRIPT,
      aiPersonConsent: true,
      brandKitId: kit.id,
      subtitles: true,
      characterDialogue: {
        version: 1,
        scriptApproved: true,
        locale: "te",
        modelId: "eleven_v3",
        direction: "ltr",
        script: "Telugu",
        scriptName: "Telugu",
        fontCandidates: ["Noto Sans Telugu", "Noto Serif Telugu"],
        characterId: character.id,
        outfitId: outfit.id,
        brandKitId: kit.id,
        scenes: [
          {
            id: `fixture-${RUN_ID}-1`,
            text: LONG_SCRIPT.slice(0, Math.floor(LONG_SCRIPT.length / 2)),
            visualPrompt: "The saved character speaks to camera in a bright studio.",
            estimatedDurationSec: 20,
            checkpoint: {
              narrationPath: `/objects/${tenant}/uploads/dialogue-narration.wav`,
              narrationDurationSec: 20,
              platePath: `/objects/${tenant}/uploads/dialogue-plate.mp4`,
              visualEvent: {
                provider: "fixture",
                model: "fixture",
                durationSec: 20,
                requestBytes: 1,
                label: "character_plate:fixture",
                costPaise: 0,
                accounted: true,
              },
              lipSyncPath: `/objects/${tenant}/uploads/dialogue-lipsync.mp4`,
              lipSyncEvent: {
                provider: "fixture",
                model: "fixture",
                durationSec: 20,
                requestBytes: 1,
                label: "lip_sync:fixture",
                costPaise: 0,
                accounted: true,
              },
            },
          },
          {
            id: `fixture-${RUN_ID}-2`,
            text: LONG_SCRIPT.slice(Math.floor(LONG_SCRIPT.length / 2)),
            visualPrompt: "The saved character continues speaking to camera.",
            estimatedDurationSec: 20,
          },
        ],
      },
    };
    const failedJob = (
      await client.query(
        `INSERT INTO video_generations
          (tenant_id, engine, status, prompt, options, funding, error)
         VALUES ($1, 'dialogue_lip_sync', 'failed', $2, $3::jsonb, 'credit', $4)
         RETURNING id`,
        [
          tenant,
          "A saved character explains practical customer relationships",
          JSON.stringify(failedOptions),
          "The second scene was interrupted by the fixture.",
        ],
      )
    ).rows[0];

    await client.query("COMMIT");
    return {
      characterId: Number(character.id),
      outfitId: Number(outfit.id),
      brandKitId: Number(kit.id),
      failedJobId: Number(failedJob.id),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const videoJobResponse = (id, status, units) => ({
  id,
  engine: "dialogue_lip_sync",
  status,
  prompt: TOPIC,
  aiPrompt: null,
  sourceImagePaths: [],
  aspectRatio: "9:16",
  videoPath: null,
  thumbnailPath: null,
  provider: null,
  model: null,
  error: null,
  stage: null,
  durationMs: null,
  units,
  retryable: false,
  chargedRatePaise: null,
  spendPaise: null,
  storyboard: null,
  storyboardExpiresAt: null,
  localizedResult: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

async function waitForCapture(readValue, label) {
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    const value = readValue();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function runBrowser(page, fixture) {
  let draftRequest = null;
  let generateRequest = null;
  let retryRequest = null;

  await page.route("**/api/ai/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (
      request.method() === "POST" &&
      pathname.endsWith("/api/ai/spokesperson-script")
    ) {
      draftRequest = request.postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ script: LONG_SCRIPT }),
      });
      return;
    }
    if (
      request.method() === "POST" &&
      pathname.endsWith("/api/ai/generate-video")
    ) {
      generateRequest = request.postDataJSON();
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify(videoJobResponse(fixture.failedJobId, "queued", 8)),
      });
      return;
    }
    if (
      request.method() === "POST" &&
      pathname.endsWith(`/api/ai/video-jobs/${fixture.failedJobId}/retry`)
    ) {
      retryRequest = { method: request.method(), pathname, body: request.postData() };
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify(videoJobResponse(fixture.failedJobId + 1_000_000, "queued", 2)),
      });
      return;
    }
    await route.continue();
  });

  await page.goto(`${BASE}/studio?tab=video`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("tab-topic-to-video").waitFor({ timeout: 30_000 });
  await page.getByTestId("tab-topic-to-video").click();
  await page.getByTestId("toggle-visuals-character").click();
  await page.getByTestId("toggle-character-mode-dialogue").click();

  await page.getByTestId("select-character-dialogue-locale").waitFor();
  assert(
    (await page.getByTestId("dialogue-setup-guidance").count()) === 0,
    "tenant fixture satisfies Character Dialogue prerequisites",
  );

  await page.getByTestId("select-character").click();
  await page.getByRole("option", { name: CHARACTER_NAME, exact: true }).click();
  await page.getByTestId("select-outfit").click();
  await page.getByRole("option", { name: OUTFIT_NAME, exact: true }).click();

  await page.getByTestId("select-character-dialogue-locale").click();
  await page.getByRole("option", { name: "Telugu", exact: true }).click();
  await page.getByTestId("select-character-dialogue-brand-kit").click();
  await page.getByRole("option", { name: KIT_NAME, exact: true }).click();
  await page.getByTestId("input-spokesperson-topic").fill(TOPIC);
  await page.getByTestId("button-generate-spokesperson-script").click();

  const capturedDraft = await waitForCapture(() => draftRequest, "script draft request");
  assert(capturedDraft.topic === TOPIC, "script draft sends the entered topic");
  assert(capturedDraft.targetLocale === "te", "script draft sends Telugu as targetLocale");

  const scriptEditor = page.getByTestId("input-spokesperson-script");
  await scriptEditor.waitFor();
  assert((await scriptEditor.inputValue()) === LONG_SCRIPT, "long Telugu script is shown for review");
  await page.getByTestId("text-character-dialogue-scene-count").waitFor();
  assert(
    (await page.getByTestId("text-character-dialogue-runtime").innerText()).includes("video units"),
    "long script shows its multi-scene unit estimate",
  );

  const generateButton = page.getByTestId("button-generate-video");
  await page.getByTestId("button-approve-spokesperson-script").click();
  assert(await generateButton.isDisabled(), "Generate stays disabled until consent is accepted");
  await page.getByTestId("checkbox-lipsync-consent").click();
  assert(!(await generateButton.isDisabled()), "consent enables Character Dialogue generation");
  await generateButton.click();

  const capturedGenerate = await waitForCapture(
    () => generateRequest,
    "final generation request",
  );
  const finalPayloadProjection = {
    engine: capturedGenerate.engine,
    prompt: capturedGenerate.prompt,
    sourceImagePaths: capturedGenerate.sourceImagePaths,
    aspectRatio: capturedGenerate.aspectRatio,
    subtitles: capturedGenerate.subtitles,
    visualsSource: capturedGenerate.visualsSource,
    characterId: capturedGenerate.characterId,
    outfitId: capturedGenerate.outfitId,
    wardrobeNotes: capturedGenerate.wardrobeNotes,
    brandKitId: capturedGenerate.brandKitId,
    sourceVideoPath: capturedGenerate.sourceVideoPath,
    presenterVideoPath: capturedGenerate.presenterVideoPath,
    lipSyncConsent: capturedGenerate.lipSyncConsent,
    dialogue: capturedGenerate.dialogue,
    aiPersonConsent: capturedGenerate.aiPersonConsent,
    characterDialogue: capturedGenerate.characterDialogue,
    styleProfileId: capturedGenerate.styleProfileId,
    shotCount: capturedGenerate.shotCount,
  };
  const expectedFinalPayloadProjection = {
    engine: "dialogue_lip_sync",
    prompt: TOPIC,
    sourceImagePaths: [],
    aspectRatio: "9:16",
    subtitles: true,
    visualsSource: "stock",
    characterId: fixture.characterId,
    outfitId: fixture.outfitId,
    wardrobeNotes: null,
    brandKitId: fixture.brandKitId,
    sourceVideoPath: null,
    presenterVideoPath: null,
    lipSyncConsent: true,
    dialogue: LONG_SCRIPT,
    aiPersonConsent: true,
    characterDialogue: { scriptApproved: true, locale: "te" },
    styleProfileId: null,
    shotCount: 1,
  };
  assert(
    JSON.stringify(finalPayloadProjection) ===
      JSON.stringify(expectedFinalPayloadProjection),
    "final request matches the approved Telugu Character Dialogue payload",
  );
  assert(!Object.hasOwn(capturedGenerate, "voice"), "payload does not fall back to a stock voice");

  await page.getByTestId(`job-card-${fixture.failedJobId}`).click();
  const retryButton = page.getByTestId("button-retry-video");
  await retryButton.waitFor();
  assert(
    (await retryButton.innerText()).includes("Resume unfinished scenes"),
    "retryable failed job shows Resume unfinished scenes",
  );
  await retryButton.click();
  const capturedRetry = await waitForCapture(() => retryRequest, "retry request");
  assert(capturedRetry.method === "POST", "resume uses POST");
  assert(
    capturedRetry.pathname === `/api/ai/video-jobs/${fixture.failedJobId}/retry`,
    "resume targets the seeded tenant-owned failed job",
  );
  assert(
    capturedRetry.body === null || capturedRetry.body === "",
    "resume sends no unexpected retry payload",
  );

  const count = await pool.query(
    "SELECT count(*)::int AS count FROM video_generations WHERE tenant_id = $1",
    [tenantId],
  );
  assert(
    Number(count.rows[0].count) === 1,
    "intercepted requests started no generation and created no retry child",
  );
  await page.screenshot({
    path: `/tmp/e2e-character-dialogue-${RUN_ID}.png`,
    fullPage: false,
  });
  console.log(`[shot] /tmp/e2e-character-dialogue-${RUN_ID}.png`);
}

async function cleanup() {
  const failures = [];
  const attempt = async (label, action) => {
    try {
      await action();
    } catch (error) {
      failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      console.error(`[cleanup] ${label} FAILED`);
    }
  };
  const tenantIds = new Set(Number.isInteger(tenantId) ? [tenantId] : []);

  if (clerkUser?.id) {
    await attempt("discover fixture tenants", async () => {
      const tenantRows = await pool.query(
        "SELECT id FROM tenants WHERE clerk_user_id = $1 OR lower(email) = lower($2)",
        [clerkUser.id, EMAIL],
      );
      for (const row of tenantRows.rows) tenantIds.add(Number(row.id));
    });
    for (const id of tenantIds) {
      await attempt(`delete video jobs for tenant ${id}`, () =>
        pool.query("DELETE FROM video_generations WHERE tenant_id = $1", [id]),
      );
      await attempt(`delete character outfits for tenant ${id}`, () =>
        pool.query("DELETE FROM character_outfits WHERE tenant_id = $1", [id]),
      );
      await attempt(`delete characters for tenant ${id}`, () =>
        pool.query("DELETE FROM characters WHERE tenant_id = $1", [id]),
      );
      await attempt(`delete Brand Kit versions for tenant ${id}`, () =>
        pool.query("DELETE FROM brand_kit_versions WHERE tenant_id = $1", [id]),
      );
      await attempt(`delete Brand Kits for tenant ${id}`, () =>
        pool.query("DELETE FROM brand_kits WHERE tenant_id = $1", [id]),
      );
      await attempt(`delete fixture tenant ${id}`, async () => {
        await pool.query("DELETE FROM tenants WHERE id = $1", [id]);
        console.log(`[cleanup] deleted fixture tenant ${id}`);
      });
    }
    await attempt("delete fixture analytics", () =>
      pool.query("DELETE FROM analytics_events WHERE clerk_user_id = $1", [clerkUser.id]),
    );
    await attempt("delete fixture consent", () =>
      pool.query("DELETE FROM user_consents WHERE clerk_user_id = $1", [clerkUser.id]),
    );
    await attempt("delete fixture Clerk user", async () => {
      await clerkApi(`/users/${clerkUser.id}`, undefined, "DELETE");
      console.log(`[cleanup] deleted fixture Clerk user ${clerkUser.id}`);
    });
  }

  await attempt("close browser", () => browser?.close());
  await attempt("close database pool", () => pool.end());
  if (failures.length > 0) throw new Error(`cleanup incomplete: ${failures.join("; ")}`);
}

async function main() {
  let runError = null;
  try {
    clerkUser = await createUser();
    browser = await chromium.launch({
      executablePath: resolveChromiumExecutable(),
      args: ["--no-sandbox"],
    });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    page.on("console", (message) => {
      if (message.type() === "error") {
        console.log("[browser console.error]", message.text().slice(0, 400));
      }
    });
    page.on("pageerror", (error) =>
      console.log("[browser pageerror]", String(error).slice(0, 500)),
    );

    await signIn(page, clerkUser.id);
    tenantId = await waitForTenant(page, clerkUser.id);
    console.log(`[fixture] tenant ${tenantId}`);
    const fixture = await seedFixture(clerkUser.id, tenantId);
    console.log("[fixture]", fixture);
    await runBrowser(page, fixture);
    console.log("E2E Character Dialogue PASS");
  } catch (error) {
    runError = error;
  }

  try {
    await cleanup();
  } catch (error) {
    if (runError) {
      runError = new Error(`${runError.message}; cleanup failed: ${error.message}`);
    } else {
      runError = error;
    }
  }
  if (runError) throw runError;
}

main().catch((error) => {
  console.error("E2E Character Dialogue FAIL:", error);
  process.exit(1);
});