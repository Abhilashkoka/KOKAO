import { describe, it, expect, afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";

vi.mock("@clerk/express", async () => {
  const { authState } = await import("../test/authState");
  return {
    getAuth: () =>
      authState.userId
        ? {
            userId: authState.userId,
            sessionClaims: { userId: authState.userId },
          }
        : {},
    clerkClient: {
      users: {
        getUser: async (id: string) => {
          const u = authState.users[id];
          if (!u) throw new Error("user not found");
          return u;
        },
      },
    },
    clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) =>
      next(),
  };
});

// The heavy work (providers, ffmpeg, object storage) is exercised by its own
// tests; here the runner is captured so route behavior (validation, funding,
// tenancy) is tested deterministically.
const runnerState = vi.hoisted(() => ({
  calls: [] as { jobId: number; funding: string }[],
  resumed: [] as number[],
  previews: [] as { jobId: number; sceneId: string }[],
  /** Set by a test to make the next preview regeneration throw. */
  previewError: null as unknown,
  repairs: [] as number[],
}));
const objectStorageState = vi.hoisted(() => ({
  missingPaths: new Set<string>(),
}));

/**
 * Controls the stub text-gen client used by decideShotCountFromBrief.
 * - shotCountResponse: number → the LLM returns {"shotCount": <n>}
 * - shotCountResponse: null  → the LLM call throws (triggers fallback)
 */
const textGenState = vi.hoisted(() => ({
  shotCountResponse: null as number | null,
  spokespersonResponse: '{"script":"A clear generated spokesperson script."}' as string | Error,
  lastSpokespersonPrompt: null as string | null,
}));
const presenterPlanState = vi.hoisted(() => ({
  beatCount: 1,
}));
const presenterAsrState = vi.hoisted(() => ({
  transcript: "This is the exact script spoken in my presenter take.",
}));
vi.mock("../lib/videoGen/jobRunner", () => ({
  STORYBOARD_REGENERATIONS_PER_SCENE: 2,
  runVideoGenerationJob: vi.fn(async (jobId: number, funding: string) => {
    runnerState.calls.push({ jobId, funding });
  }),
    runVideoRepairJob: vi.fn(async (jobId: number) => {
      runnerState.repairs.push(jobId);
    }),
  resumeVideoGenerationJob: vi.fn(async (job: { id: number }) => {
    runnerState.resumed.push(job.id);
  }),
  fundPlannedTemplateVisualWork: vi.fn(async (job: any) => ({
    funded: true,
    job,
    error: null,
  })),
  // Mirrors the real function's contract: swap in a fresh still for the one
  // scene, leaving the rest of the plan (including the regenerations counter,
  // which the route spends atomically before calling this) alone.
  refreshStoryboardScenePreview: vi.fn(
    async (
      job: { id: number; tenantId: number },
      storyboard: VideoStoryboard,
      scene: VideoStoryboardScene,
    ) => {
      if (runnerState.previewError) throw runnerState.previewError;
      runnerState.previews.push({ jobId: job.id, sceneId: scene.id });
      return {
        ...storyboard,
        scenes: storyboard.scenes.map((s) =>
          s.id === scene.id
            ? { ...s, previewPath: `/objects/${job.tenantId}/uploads/reroll-${s.id}.png` }
            : s,
        ),
      };
    },
  ),
}));

// Music library: the Openverse client + SSRF guard have their own tests
// (lib/musicLibrary.test.ts); routes are tested with stubs.
vi.mock("../lib/musicLibrary", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/musicLibrary")>();
  return {
    ...actual,
    searchLibraryMusic: vi.fn(async () => [
      {
        id: "trk1",
        title: "Sunny Drive",
        creator: "Jane",
        license: "by",
        licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
        durationSec: 154,
        audioUrl: "https://cdn.example.com/sunny.mp3",
      },
    ]),
    downloadLibraryTrack: vi.fn(async (url: string) => {
      if (url.includes("bad")) throw new actual.MusicLibraryError("Track downloads must use https.");
      return Buffer.from("audio-bytes");
    }),
  };
});
vi.mock("../lib/objectStorage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/objectStorage")>();
  class FakeObjectStorageService {
    async getObjectEntityUploadURL(tenantId: number): Promise<string> {
      return `https://storage.example.com/objects/${tenantId}/uploads/music-uuid`;
    }
    normalizeObjectEntityPath(uploadURL: string): string {
      return new URL(uploadURL).pathname;
    }
    async getObjectEntityFile(objectPath: string) {
      if (objectStorageState.missingPaths.has(objectPath)) {
        throw new actual.ObjectNotFoundError();
      }
      return {
        getMetadata: async () => [{ size: 1024, contentType: "video/mp4" }],
        download: async () => [Buffer.from("presenter-video")],
      };
    }
  }
  return { ...actual, ObjectStorageService: FakeObjectStorageService };
});

vi.mock("../lib/videoGen/presenterBroll", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/videoGen/presenterBroll")>();
  return {
    ...actual,
    probePresenterDurationMs: vi.fn(async () => 8_000),
    planPresenterBrollTimeline: vi.fn(async () => ({
      version: 1 as const,
      durationMs: 8_000,
      lines: [
        { index: 1, startMs: 0, endMs: 4_000, text: "Opening line." },
        { index: 2, startMs: 4_000, endMs: 8_000, text: "Closing line." },
      ],
      beats: Array.from({ length: presenterPlanState.beatCount }, (_, index) => ({
        id: `pb${index + 1}`,
        startMs: index * 1_000,
        endMs: (index + 1) * 1_000,
        query: `weekly planning desk ${index + 1}`,
        kind: "lifestyle" as const,
        opacity: 0.55,
        lineIndexes: [1],
        assetPath: null,
        previewPath: null,
        assetKind: "video" as const,
        provider: null,
      })),
      notes: [],
    })),
  };
});

vi.mock("../lib/baseVideoAudio", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/baseVideoAudio")>()),
  extractVoiceSampleFromVideo: vi.fn(async () => Buffer.from("presenter-audio")),
}));

vi.mock("../lib/asr", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/asr")>()),
  transcribeAudio: vi.fn(async () => ({
    text: presenterAsrState.transcript,
    provider: "openai",
    model: "whisper-1",
    segments: [
      {
        startMs: 250,
        endMs: 7_750,
        text: presenterAsrState.transcript,
      },
    ],
  })),
}));

// Stub the text-gen client used by decideShotCountFromBrief.
// shotCountResponse controls what the LLM "returns"; null makes it throw so
// the fallback path is exercised. Tests that never send shotCount 0 are
// unaffected — decideShotCountFromBrief is never called for them.
vi.mock("../lib/textGen", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/textGen")>();
  return {
    ...actual,
    getTextGenClient: vi.fn(async () => ({
      client: {
        chat: {
          completions: {
            create: vi.fn(async (request: { messages?: { role?: string; content?: string }[] }) => {
              const isSpokespersonDraft = request.messages?.some((message) =>
                message.content?.includes("write a direct-to-camera spokesperson script"),
              );
              if (isSpokespersonDraft) {
                textGenState.lastSpokespersonPrompt =
                  request.messages?.find((message) => message.role === "user")?.content ?? null;
                if (textGenState.spokespersonResponse instanceof Error) {
                  throw textGenState.spokespersonResponse;
                }
                return {
                  choices: [{ message: { content: textGenState.spokespersonResponse } }],
                  usage: { prompt_tokens: 80, completion_tokens: 24, total_tokens: 104 },
                };
              }
              if (textGenState.shotCountResponse === null) {
                throw new Error("LLM unavailable (stubbed)");
              }
              return {
                choices: [
                  {
                    message: {
                      content: JSON.stringify({ shotCount: textGenState.shotCountResponse }),
                    },
                  },
                ],
                usage: null,
              };
            }),
          },
        },
      },
      model: "gpt-4o-stub",
      provider: "openai",
    })),
  };
});

import {
  db,
  featureFlagsTable,
  videoGenerationsTable,
  contentItemsTable,
  tenantsTable,
  creditBalancesTable,
  creditLedgerTable,
  charactersTable,
  characterOutfitsTable,
  walletBalancesTable,
  walletLedgerTable,
  walletProviderOperationsTable,
  usageEventsTable,
  videoStyleProfilesTable,
  aiModelPricesTable,
  type VideoStoryboard,
  type VideoStoryboardScene,
  type VideoJobOptions,
  type AiSpendSettings,
  type WalletSettings,
} from "@workspace/db";
import {
  VideoGenProviderError,
  setStoredVideoGenKey,
  clearStoredVideoGenKey,
  setVideoGenSelection,
  getVideoGenSelection,
  getVideoGenProviderDef,
  isVideoGenProviderConfigured,
} from "../lib/videoGen";
import { grantCredits, getCreditBalances } from "../lib/credits";
import { getAiSpendRates, setAiSpendConfig } from "../lib/aiSpend";
import { setWalletConfig } from "../lib/wallet";
import { and, eq, inArray } from "drizzle-orm";
import { requireTenant } from "../middlewares/requireTenant";
import videosRouter from "./videos";
import { actAs, resetAuthState } from "../test/authState";
import {
  createTenant,
  deleteTenant,
  snapshotAiSpendSettings,
  restoreAiSpendSettings,
  snapshotWalletSettings,
  restoreWalletSettings,
  type TestTenant,
} from "../test/dbHelpers";
import { waitForPendingJobs } from "../lib/backgroundJobs";
import { invalidateFeatureFlagCache } from "../lib/featureFlags";
import { getUsage } from "../lib/usage";
import { videoJobFullUnits, videoJobUnits } from "../lib/videoGen/units";
import { addVersion, createKit } from "../lib/brandKit/service";
import {
  deleteModelPrice,
  findModelPrice,
  upsertModelPrice,
} from "../lib/aiCost";

function createVideosTestApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: Record<string, () => void> }).log = {
      info() {},
      error() {},
      warn() {},
      debug() {},
    };
    next();
  });
  app.use("/api", requireTenant, videosRouter);
  return app;
}

const app = createVideosTestApp();
const createdTenants: TestTenant[] = [];
const createdStyleProfileIds: number[] = [];
const HIGH_LIP_SYNC_MODEL = "sync/lipsync-2";

async function restoreHighLipSyncPrice(
  existing: Awaited<ReturnType<typeof findModelPrice>>,
): Promise<void> {
  if (!existing) return;
  await upsertModelPrice({
    kind: "video",
    provider: existing.provider,
    model: existing.model,
    inputUsdPerMtok: existing.inputUsdPerMtok,
    outputUsdPerMtok: existing.outputUsdPerMtok,
    usdPerImage: existing.usdPerImage,
    usdPerSecond: existing.usdPerSecond,
    usdPerVideo: existing.usdPerVideo,
  });
}

async function installHighLipSyncTestPrice(): Promise<() => Promise<void>> {
  const existing = await findModelPrice(
    "video",
    "replicate",
    HIGH_LIP_SYNC_MODEL,
    { exactProviderOnly: true },
  );
  const row = await upsertModelPrice({
    kind: "video",
    provider: "replicate",
    model: HIGH_LIP_SYNC_MODEL,
    inputUsdPerMtok: null,
    outputUsdPerMtok: null,
    usdPerImage: null,
    usdPerSecond: 0.05,
    usdPerVideo: null,
  });
  return async () => {
    if (existing) await restoreHighLipSyncPrice(existing);
    else await deleteModelPrice(row.id);
  };
}

async function installVideoTestPrice(model: string): Promise<() => Promise<void>> {
  const match = and(
    eq(aiModelPricesTable.kind, "video"),
    eq(aiModelPricesTable.provider, "replicate"),
    eq(aiModelPricesTable.model, model),
  );
  const existing = await db.select().from(aiModelPricesTable).where(match);
  if (existing.length > 0) {
    await db
      .delete(aiModelPricesTable)
      .where(inArray(aiModelPricesTable.id, existing.map((row) => row.id)));
  }
  await upsertModelPrice({
    kind: "video",
    provider: "replicate",
    model,
    inputUsdPerMtok: null,
    outputUsdPerMtok: null,
    usdPerImage: null,
    usdPerSecond: null,
    usdPerVideo: 0.1,
  });
  return async () => {
    await db.delete(aiModelPricesTable).where(match);
    for (const row of existing) {
      await upsertModelPrice({
        kind: "video",
        provider: row.provider,
        model: row.model,
        inputUsdPerMtok: row.inputUsdPerMtok,
        outputUsdPerMtok: row.outputUsdPerMtok,
        usdPerImage: row.usdPerImage,
        usdPerSecond: row.usdPerSecond,
        usdPerVideo: row.usdPerVideo,
        variantCriteria: row.variantCriteria ?? undefined,
      });
    }
  };
}
let restoreDefaultTextVideoPrice: (() => Promise<void>) | null = null;
let restoreDefaultImageVideoPrice: (() => Promise<void>) | null = null;
let restoreVideoGenSelection: (() => Promise<void>) | null = null;

beforeAll(async () => {
  const existingSelection = await getVideoGenSelection();
  restoreVideoGenSelection = () => setVideoGenSelection(existingSelection);
  await setVideoGenSelection({
    provider: "replicate",
    textToVideoModel: null,
    imageToVideoModel: null,
    enabledModelIds: null,
    lipSyncPortraitModel: null,
  });
  restoreDefaultTextVideoPrice = await installVideoTestPrice("wan-video/wan-2.2-t2v-fast");
  restoreDefaultImageVideoPrice = await installVideoTestPrice("wan-video/wan-2.2-i2v-fast");
});
const VIDEO_MODE_CASES = [
  {
    engine: "text_to_video",
    feature: "videoTextToVideo",
    body: { engine: "text_to_video", prompt: "A calm ocean at dusk" },
  },
  {
    engine: "image_to_video",
    feature: "videoAnimatePhoto",
    body: { engine: "image_to_video", sourceImagePaths: [] },
  },
  {
    engine: "slideshow",
    feature: "videoSlideshow",
    body: { engine: "slideshow", sourceImagePaths: [] },
  },
  {
    engine: "topic_to_video",
    feature: "videoTopicToVideo",
    body: { engine: "topic_to_video", prompt: "How sourdough rises" },
  },
] as const;

async function setVideoModeFlag(feature: string, enabled: boolean): Promise<void> {
  await db
    .insert(featureFlagsTable)
    .values({ feature, enabled })
    .onConflictDoUpdate({
      target: featureFlagsTable.feature,
      set: { enabled },
    });
  invalidateFeatureFlagCache();
}

async function clearVideoModeFlags(): Promise<void> {
  await db
    .delete(featureFlagsTable)
    .where(inArray(featureFlagsTable.feature, VIDEO_MODE_CASES.map((item) => item.feature)));
  invalidateFeatureFlagCache();
}

async function newTenant(plan = "free"): Promise<TestTenant> {
  const tenant = await createTenant();
  if (plan !== "free") {
    await db.update(tenantsTable).set({ plan }).where(eq(tenantsTable.id, tenant.tenantId));
  }
  createdTenants.push(tenant);
  actAs(tenant.clerkUserId);
  return tenant;
}

/**
 * The route preflights job dependencies before it funds anything, so the test
 * deployment needs the keys a real one has. The providers themselves are never
 * called here — the runner is mocked — but a job with no configured video or
 * stock source is refused before funding, which is the point of the preflight.
 */
const PROVIDER_ENV: Record<string, string> = {
  REPLICATE_API_TOKEN: "test-replicate-token",
  PEXELS_API_KEY: "test-pexels-key",
  // Lip-sync preflight also demands a narration (text-to-speech) provider.
  ELEVENLABS_API_KEY: "test-elevenlabs-key",
};
const savedProviderEnv = Object.fromEntries(
  Object.keys(PROVIDER_ENV).map((k) => [k, process.env[k]]),
);

beforeEach(() => {
  resetAuthState();
  runnerState.calls.length = 0;
  runnerState.resumed.length = 0;
  runnerState.previews.length = 0;
  runnerState.previewError = null;
  runnerState.repairs.length = 0;
  objectStorageState.missingPaths.clear();
  // Default: make the LLM throw so tests that don't set this are unaffected
  // (decideShotCountFromBrief is only called when shotCount === 0).
  textGenState.shotCountResponse = null;
  textGenState.spokespersonResponse =
    '{"script":"A clear generated spokesperson script."}';
  textGenState.lastSpokespersonPrompt = null;
  presenterPlanState.beatCount = 1;
  presenterAsrState.transcript =
    "This is the exact script spoken in my presenter take.";
  for (const [key, value] of Object.entries(PROVIDER_ENV)) process.env[key] = value;
});

async function seedCharacter(tenantId: number): Promise<{ characterId: number; outfitId: number; gymOutfitId: number }> {
  const character = (
    await db
      .insert(charactersTable)
      .values({
        tenantId,
        name: "Maya",
        description: "cheerful founder",
        referenceImagePath: `/objects/${tenantId}/uploads/maya.png`,
      })
      .returning()
  )[0]!;
  const defaultOutfit = (
    await db
      .insert(characterOutfitsTable)
      .values({
        tenantId,
        characterId: character.id,
        name: "Default",
        description: "casual",
        referenceImagePath: `/objects/${tenantId}/uploads/maya.png`,
        isDefault: true,
      })
      .returning()
  )[0]!;
  const gym = (
    await db
      .insert(characterOutfitsTable)
      .values({
        tenantId,
        characterId: character.id,
        name: "Gym wear",
        description: "leggings and top",
        referenceImagePath: `/objects/${tenantId}/uploads/maya-gym.png`,
        isDefault: false,
      })
      .returning()
  )[0]!;
  return { characterId: character.id, outfitId: defaultOutfit.id, gymOutfitId: gym.id };
}

async function seedPresenterTemplate(presenterRequired = true) {
  const row = (
    await db
      .insert(videoStyleProfilesTable)
      .values({
        tenantId: null,
        scope: "platform",
        sourceKind: "curated",
        published: true,
        name: `Presenter B-roll ${Date.now()}-${createdStyleProfileIds.length}`,
        summary: "Talking-head presenter with timed supporting B-roll.",
        slots: [
          {
            kind: "presenter_video",
            required: presenterRequired,
            label: "A presenter video",
          },
          {
            kind: "script",
            required: true,
            label: "The script spoken in the video",
          },
        ],
        jobDefaults: {
          aspectRatio: "9:16",
          visualsSource: "stock",
          captionStyle: "dynamic",
          reviewStoryboard: true,
        },
        sourceVideoPath: null,
        payload: {
          version: 1,
          hookShape: "presenter opens direct to camera",
          pacing: { sceneCount: 1, avgSceneSec: 60, wordsPerMinute: 145 },
          captionStyle: "dynamic",
          energy: "clear",
          visualNotes: ["upper-frame B-roll"],
          scriptGuidance: "Use the submitted script exactly.",
          sourceDurationSec: 60,
          transcriptExcerpt: "",
        },
      })
      .returning()
  )[0]!;
  createdStyleProfileIds.push(row.id);
  return row;
}

afterAll(async () => {
  for (const [key, value] of Object.entries(savedProviderEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await waitForPendingJobs();
  if (createdStyleProfileIds.length > 0) {
    await db
      .delete(videoStyleProfilesTable)
      .where(inArray(videoStyleProfilesTable.id, createdStyleProfileIds));
  }
  // The suite creates one isolated tenant per case. Cleaning them strictly
  // serially turns hundreds of independent DELETEs into a multi-minute hook,
  // so drain a bounded batch at a time without overwhelming the shared pool.
  for (let offset = 0; offset < createdTenants.length; offset += 8) {
    await Promise.all(
      createdTenants.slice(offset, offset + 8).map(async (tenant) => {
        await db
          .delete(characterOutfitsTable)
          .where(eq(characterOutfitsTable.tenantId, tenant.tenantId));
        await db.delete(charactersTable).where(eq(charactersTable.tenantId, tenant.tenantId));
        await db
          .delete(videoGenerationsTable)
          .where(eq(videoGenerationsTable.tenantId, tenant.tenantId));
        await db
          .delete(creditBalancesTable)
          .where(eq(creditBalancesTable.tenantId, tenant.tenantId));
        await db
          .delete(creditLedgerTable)
          .where(eq(creditLedgerTable.tenantId, tenant.tenantId));
        await db
          .delete(usageEventsTable)
          .where(eq(usageEventsTable.tenantId, tenant.tenantId));
        await deleteTenant(tenant.tenantId);
      }),
    );
  }
  await restoreDefaultTextVideoPrice?.();
  await restoreDefaultImageVideoPrice?.();
  await restoreVideoGenSelection?.();
}, 120_000);

describe("POST /api/ai/generate-video", () => {
  it("persists a resolved creative brief snapshot for legacy-default topic jobs", async () => {
    await newTenant();
    const res = await request(app).post("/api/ai/generate-video").send({
      engine: "topic_to_video",
      prompt: "How sourdough rises",
    });
    expect(res.status).toBe(201);
    const [row] = await db
      .select()
      .from(videoGenerationsTable)
      .where(eq(videoGenerationsTable.id, res.body.id));
    expect(row?.options?.resolvedCreativeBrief).toMatchObject({
      version: 1,
      topic: "How sourdough rises",
      direction: { version: 1 },
    });
  });

  describe("individual Video Studio controls", () => {
    afterEach(clearVideoModeFlags);

    it("rejects every disabled mode before funding or queueing while other modes remain enabled", async () => {
      for (const item of VIDEO_MODE_CASES) {
        const tenant = await newTenant();
        await setVideoModeFlag(item.feature, false);
        const sourcePath = `/objects/${tenant.tenantId}/uploads/source.png`;
        const body =
          item.engine === "image_to_video" || item.engine === "slideshow"
            ? { ...item.body, sourceImagePaths: [sourcePath] }
            : item.body;

        const blocked = await request(app).post("/api/ai/generate-video").send(body);

        expect(blocked.status, item.engine).toBe(403);
        expect(blocked.body.code, item.engine).toBe("feature_disabled");
        expect(runnerState.calls, item.engine).toHaveLength(0);
        const jobs = await db
          .select()
          .from(videoGenerationsTable)
          .where(eq(videoGenerationsTable.tenantId, tenant.tenantId));
        expect(jobs, item.engine).toHaveLength(0);

        await setVideoModeFlag(item.feature, true);
      }
    });
  });

  it("rejects text-to-video without a prompt before reserving any funding", async () => {
    await newTenant();
    const res = await request(app)
      .post("/api/ai/generate-video")
      .send({ engine: "text_to_video" });
    expect(res.status).toBe(400);
    expect(runnerState.calls).toHaveLength(0);
  });

  it("rejects a slideshow with no photos", async () => {
    await newTenant();
    const res = await request(app)
      .post("/api/ai/generate-video")
      .send({ engine: "slideshow", sourceImagePaths: [] });
    expect(res.status).toBe(400);
  });

  it("rejects source paths outside the caller's workspace", async () => {
    const tenant = await newTenant();
    const res = await request(app)
      .post("/api/ai/generate-video")
      .send({
        engine: "slideshow",
        sourceImagePaths: [`/objects/${tenant.tenantId + 1}/uploads/stolen`],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/source image path/i);
  });

  describe("camera moves, seeds and the wider aspect ratios", () => {
    it("serves the preset catalog to a signed-in workspace, grouped for a picker", async () => {
      await newTenant();
      const res = await request(app).get("/api/ai/video-motion-presets");
      expect(res.status).toBe(200);
      expect(res.body.presets.length).toBeGreaterThan(20);
      const ids = res.body.presets.map((p: { id: string }) => p.id);
      expect(ids).toContain("dolly-in");
      expect(new Set(ids).size).toBe(ids.length);
      // Every preset's category is one the response also declares, so a client
      // can group the list without a second source of truth.
      const categories = new Set(res.body.categories.map((c: { id: string }) => c.id));
      for (const preset of res.body.presets) {
        expect(categories.has(preset.category)).toBe(true);
      }
    });

    it("rejects an unknown camera move before reserving any funding", async () => {
      await newTenant();
      const res = await request(app).post("/api/ai/generate-video").send({
        engine: "text_to_video",
        prompt: "a slow reveal of the product",
        motionPreset: "teleport-through-wall",
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/camera move/i);
      expect(runnerState.calls).toHaveLength(0);
    });

    it("persists the camera move and seed on the job options", async () => {
      await newTenant();
      const res = await request(app).post("/api/ai/generate-video").send({
        engine: "text_to_video",
        prompt: "a slow reveal of the product",
        motionPreset: "crash-zoom-in",
        seed: 4242,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const row = (
        await db
          .select()
          .from(videoGenerationsTable)
          .where(eq(videoGenerationsTable.id, res.body.id))
      )[0];
      expect(row?.options?.motionPreset).toBe("crash-zoom-in");
      expect(row?.options?.seed).toBe(4242);
    });

    it("drops a camera move on a slideshow, which runs no model to move", async () => {
      const tenant = await newTenant("pro");
      const res = await request(app)
        .post("/api/ai/generate-video")
        .send({
          engine: "slideshow",
          sourceImagePaths: [`/objects/${tenant.tenantId}/uploads/a.png`],
          motionPreset: "crash-zoom-in",
          seed: 7,
        });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const row = (
        await db
          .select()
          .from(videoGenerationsTable)
          .where(eq(videoGenerationsTable.id, res.body.id))
      )[0];
      expect(row?.options?.motionPreset).toBeNull();
      expect(row?.options?.seed).toBeNull();
    });

    it("leaves a job without a camera move exactly as it was before presets", async () => {
      await newTenant();
      const res = await request(app)
        .post("/api/ai/generate-video")
        .send({ engine: "text_to_video", prompt: "a slow reveal of the product" });
      expect(res.status).toBe(201);
      const row = (
        await db
          .select()
          .from(videoGenerationsTable)
          .where(eq(videoGenerationsTable.id, res.body.id))
      )[0];
      expect(row?.options?.motionPreset).toBeNull();
    });

    it("accepts 4:5 and the other new frames", async () => {
      for (const aspectRatio of ["4:5", "4:3", "3:4", "21:9"]) {
        await newTenant();
        const res = await request(app)
          .post("/api/ai/generate-video")
          .send({ engine: "text_to_video", prompt: "a product on a table", aspectRatio });
        expect(res.status, `${aspectRatio}: ${JSON.stringify(res.body)}`).toBe(201);
        expect(res.body.aspectRatio).toBe(aspectRatio);
      }
    });

    it("still rejects a frame that is not in the contract", async () => {
      await newTenant();
      const res = await request(app)
        .post("/api/ai/generate-video")
        .send({ engine: "text_to_video", prompt: "a product", aspectRatio: "7:3" });
      expect(res.status).toBe(400);
    });
  });

  describe("optics, portraits and end frames", () => {
    it("serves the optics catalog", async () => {
      await newTenant();
      const res = await request(app).get("/api/ai/video-cinematography");
      expect(res.status).toBe(200);
      expect(res.body.cameras.length).toBeGreaterThan(0);
      expect(res.body.lenses.length).toBeGreaterThan(0);
      expect(res.body.focalLengths.length).toBeGreaterThan(0);
      expect(res.body.apertures.length).toBeGreaterThan(0);
    });

    it("persists optics, dropping an axis that is not in the catalog", async () => {
      await newTenant();
      const res = await request(app).post("/api/ai/generate-video").send({
        engine: "text_to_video",
        prompt: "a product on a table",
        cinematography: { camera: "16mm-film", aperture: "f1.4" },
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const row = (
        await db
          .select()
          .from(videoGenerationsTable)
          .where(eq(videoGenerationsTable.id, res.body.id))
      )[0];
      expect(row?.options?.cinematography).toEqual({
        camera: "16mm-film",
        lens: null,
        focalLengthMm: null,
        aperture: "f1.4",
      });
    });

    it("rejects optics that are not in the catalog before funding", async () => {
      await newTenant();
      const res = await request(app).post("/api/ai/generate-video").send({
        engine: "text_to_video",
        prompt: "a product on a table",
        cinematography: { camera: "a-phone" },
      });
      expect(res.status).toBe(400);
      expect(runnerState.calls).toHaveLength(0);
    });

    it("accepts a lip-sync job that brings its own recording, with no script", async () => {
      const tenant = await newTenant();
      const res = await request(app)
        .post("/api/ai/generate-video")
        .send({
          engine: "lip_sync",
          sourceVideoPath: `/objects/${tenant.tenantId}/uploads/me.mp4`,
          audioPath: `/objects/${tenant.tenantId}/uploads/voice.mp3`,
          lipSyncConsent: true,
        });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const row = (
        await db
          .select()
          .from(videoGenerationsTable)
          .where(eq(videoGenerationsTable.id, res.body.id))
      )[0];
      expect(row?.options?.audioPath).toBe(`/objects/${tenant.tenantId}/uploads/voice.mp3`);
    });

    it("refuses a portrait until an admin configures a portrait model", async () => {
      // Video-mode lip sync is pinned in source; portrait mode needs a model
      // that takes an image plus audio, and refusing here costs nothing while
      // failing four minutes into a paid job costs a refund and the wait.
      await setStoredVideoGenKey("replicate", "test-token");
      await setVideoGenSelection({
        provider: "replicate",
        textToVideoModel: null,
        imageToVideoModel: null,
        lipSyncPortraitModel: null,
      });
      const tenant = await newTenant();
      const res = await request(app)
        .post("/api/ai/generate-video")
        .send({
          engine: "lip_sync",
          prompt: "Hello from the founder.",
          sourceImagePath: `/objects/${tenant.tenantId}/uploads/face.png`,
          lipSyncConsent: true,
        });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/portrait lip sync is not set up/i);
      expect(runnerState.calls).toHaveLength(0);
      await clearStoredVideoGenKey("replicate");
    });

    it("accepts a portrait instead of a video once one is configured", async () => {
      const restorePrice = await installVideoTestPrice("acme/talking-head:abc123");
      await setStoredVideoGenKey("replicate", "test-token");
      await setVideoGenSelection({
        provider: "replicate",
        textToVideoModel: null,
        imageToVideoModel: null,
        lipSyncPortraitModel: "acme/talking-head:abc123",
      });
      const tenant = await newTenant();
      const res = await request(app)
        .post("/api/ai/generate-video")
        .send({
          engine: "lip_sync",
          prompt: "Hello from the founder.",
          sourceImagePath: `/objects/${tenant.tenantId}/uploads/face.png`,
          lipSyncConsent: true,
        });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const row = (
        await db
          .select()
          .from(videoGenerationsTable)
          .where(eq(videoGenerationsTable.id, res.body.id))
      )[0];
      expect(row?.options?.sourceImagePath).toBe(
        `/objects/${tenant.tenantId}/uploads/face.png`,
      );
      await restorePrice();
      expect(row?.options?.sourceVideoPath).toBeNull();
      await setVideoGenSelection({
        provider: "replicate",
        textToVideoModel: null,
        imageToVideoModel: null,
        lipSyncPortraitModel: null,
      });
      await clearStoredVideoGenKey("replicate");
    });

    it("refuses both a video and a portrait", async () => {
      const tenant = await newTenant();
      const res = await request(app)
        .post("/api/ai/generate-video")
        .send({
          engine: "lip_sync",
          prompt: "Hello.",
          sourceVideoPath: `/objects/${tenant.tenantId}/uploads/me.mp4`,
          sourceImagePath: `/objects/${tenant.tenantId}/uploads/face.png`,
          lipSyncConsent: true,
        });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/not both/i);
    });

    it("still refuses a lip-sync job with neither a script nor a recording", async () => {
      const tenant = await newTenant();
      const res = await request(app)
        .post("/api/ai/generate-video")
        .send({
          engine: "lip_sync",
          sourceVideoPath: `/objects/${tenant.tenantId}/uploads/me.mp4`,
          lipSyncConsent: true,
        });
      expect(res.status).toBe(400);
    });

    it("keeps the consent gate on portraits, where it matters more", async () => {
      const tenant = await newTenant();
      const res = await request(app)
        .post("/api/ai/generate-video")
        .send({
          engine: "lip_sync",
          prompt: "Hello.",
          sourceImagePath: `/objects/${tenant.tenantId}/uploads/face.png`,
        });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/permission/i);
    });

    it("refuses an end frame on a model that cannot blend two stills", async () => {
      await setStoredVideoGenKey("replicate", "test-token");
      await setVideoGenSelection({
        provider: "replicate",
        textToVideoModel: null,
        imageToVideoModel: null,
        enabledModelIds: null,
      });
      const tenant = await newTenant();
      const res = await request(app)
        .post("/api/ai/generate-video")
        .send({
          engine: "image_to_video",
          sourceImagePaths: [
            `/objects/${tenant.tenantId}/uploads/a.png`,
            `/objects/${tenant.tenantId}/uploads/b.png`,
          ],
          modelId: "wan-2.2-fast",
        });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/end frame/i);
      await clearStoredVideoGenKey("replicate");
    });

    it("accepts an end frame on a model that can", async () => {
      const restorePrice = await installVideoTestPrice("kwaivgi/kling-v2.1-standard");
      await setStoredVideoGenKey("replicate", "test-token");
      await setVideoGenSelection({
        provider: "replicate",
        textToVideoModel: null,
        imageToVideoModel: null,
        enabledModelIds: null,
      });
      const tenant = await newTenant();
      const res = await request(app)
        .post("/api/ai/generate-video")
        .send({
          engine: "image_to_video",
          sourceImagePaths: [
            `/objects/${tenant.tenantId}/uploads/a.png`,
            `/objects/${tenant.tenantId}/uploads/b.png`,
          ],
          modelId: "kling-2.1-standard",
        });
      expect(res.status).toBe(201);
      await clearStoredVideoGenKey("replicate");
      await restorePrice();
    });
  });

  describe("picking a model, and what it costs", () => {
    let restoreWan25Price: (() => Promise<void>) | null = null;
    let restoreVeo3Price: (() => Promise<void>) | null = null;
    // availableVideoModels() only offers models whose provider has a key
    // saved, so the suite saves one. The credentials guard snapshots and
    // restores app_credentials around the whole run.
    beforeEach(async () => {
      restoreWan25Price = await installVideoTestPrice("wan-video/wan-2.5-t2v");
      restoreVeo3Price = await installVideoTestPrice("google/veo-3");
      await setStoredVideoGenKey("replicate", "test-token");
      await setVideoGenSelection({
        provider: "replicate",
        textToVideoModel: null,
        imageToVideoModel: null,
        enabledModelIds: null,
      });
    });
    afterEach(async () => {
      await clearStoredVideoGenKey("replicate");
      await setVideoGenSelection({
        provider: "replicate",
        textToVideoModel: null,
        imageToVideoModel: null,
        enabledModelIds: null,
      });
      await restoreWan25Price?.();
      await restoreVeo3Price?.();
      restoreWan25Price = null;
      restoreVeo3Price = null;
    });

    it("lists only models whose provider is configured", async () => {
      await newTenant();
      const res = await request(app).get("/api/ai/video-models");
      expect(res.status).toBe(200);
      const providers = new Set(res.body.models.map((m: { provider: string }) => m.provider));
      expect(providers.has("replicate")).toBe(true);
      for (const provider of providers) {
        const def = getVideoGenProviderDef(String(provider));
        expect(def).toBeTruthy();
        expect(await isVideoGenProviderConfigured(def!)).toBe(true);
      }
    });

    it("reports each model's capabilities and unit price", async () => {
      await newTenant();
      const res = await request(app).get("/api/ai/video-models");
      const wan = res.body.models.find((m: { id: string }) => m.id === "wan-2.2-fast");
      expect(wan).toBeTruthy();
      expect(wan.unitMultiplier).toBe(1);
      expect(wan.durations.length).toBeGreaterThan(0);
      expect(wan.resolutions.length).toBeGreaterThan(0);
      const veo = res.body.models.find((m: { id: string }) => m.id === "veo-3");
      expect(veo.unitMultiplier).toBe(4);
      expect(veo.canGenerateAudio).toBe(true);
    });

    it("honours the admin allowlist", async () => {
      await setVideoGenSelection({
        provider: "replicate",
        textToVideoModel: null,
        imageToVideoModel: null,
        enabledModelIds: ["wan-2.2-fast"],
      });
      await newTenant();
      const res = await request(app).get("/api/ai/video-models");
      expect(res.body.models.map((m: { id: string }) => m.id)).toEqual(["wan-2.2-fast"]);

      const rejected = await request(app).post("/api/ai/generate-video").send({
        engine: "text_to_video",
        prompt: "a product on a table",
        modelId: "veo-3",
      });
      expect(rejected.status).toBe(400);
      expect(rejected.body.error).toMatch(/not available/i);
      expect(runnerState.calls).toHaveLength(0);
    });

    it("rejects an unknown model before reserving any funding", async () => {
      await newTenant();
      const res = await request(app).post("/api/ai/generate-video").send({
        engine: "text_to_video",
        prompt: "a product on a table",
        modelId: "gpt-video-9",
      });
      expect(res.status).toBe(400);
      expect(runnerState.calls).toHaveLength(0);
    });

    it("rejects a model on a slideshow, which runs no model at all", async () => {
      const tenant = await newTenant();
      const res = await request(app)
        .post("/api/ai/generate-video")
        .send({
          engine: "slideshow",
          sourceImagePaths: [`/objects/${tenant.tenantId}/uploads/a.png`],
          modelId: "wan-2.2-fast",
        });
      expect(res.status).toBe(400);
    });

    it("persists the model and its resolution on the job", async () => {
      await newTenant();
      const res = await request(app).post("/api/ai/generate-video").send({
        engine: "text_to_video",
        prompt: "a product on a table",
        modelId: "wan-2.5",
        resolution: "480p",
      });
      expect(res.status).toBe(201);
      expect(res.body.modelId).toBe("wan-2.5");
      expect(res.body.resolution).toBe("480p");
      const row = (
        await db
          .select()
          .from(videoGenerationsTable)
          .where(eq(videoGenerationsTable.id, res.body.id))
      )[0];
      expect(row?.options?.modelId).toBe("wan-2.5");
      expect(row?.options?.resolution).toBe("480p");
    });

    it("charges a draft model exactly what an unpicked job costs", async () => {
      await newTenant(); // free plan: 3 videos/month
      const plain = await request(app)
        .post("/api/ai/generate-video")
        .send({ engine: "text_to_video", prompt: "a product on a table" });
      expect(plain.body.units).toBe(1);

      const draft = await request(app).post("/api/ai/generate-video").send({
        engine: "text_to_video",
        prompt: "a product on a table",
        modelId: "wan-2.2-fast",
      });
      expect(draft.body.units).toBe(1);
    });

    it("charges a premium model its multiplier, and 402s when it does not fit", async () => {
      await newTenant(); // free plan: 3 videos/month
      const res = await request(app).post("/api/ai/generate-video").send({
        engine: "text_to_video",
        prompt: "a product on a table",
        modelId: "veo-3",
      });
      // 4 units against a 3-video plan, with no credits: refused BEFORE any
      // job row exists, so nothing is left behind to refund.
      expect(res.status).toBe(402);
      expect(runnerState.calls).toHaveLength(0);
    });

    it("reserves the multiplied units when the plan can cover them", async () => {
      const tenant = await newTenant();
      await grantCredits({
        tenantId: tenant.tenantId,
        captionCredits: 0,
        imageCredits: 0,
        videoCredits: 8,
        kind: "admin_grant",
      });
      const res = await request(app).post("/api/ai/generate-video").send({
        engine: "text_to_video",
        prompt: "a product on a table",
        modelId: "wan-2.5",
        shotCount: 2,
      });
      expect(res.status).toBe(201);
      // 2 shots x standard tier = 4 generations' worth.
      expect(res.body.units).toBe(4);
    });
  });

  it("creates a queued job funded by the plan quota and hands it to the runner", async () => {
    const tenant = await newTenant(); // free plan: 3 videos/month
    const res = await request(app)
      .post("/api/ai/generate-video")
      .send({
        engine: "slideshow",
        sourceImagePaths: [`/objects/${tenant.tenantId}/uploads/a.png`],
        aspectRatio: "1:1",
        slideDurationSec: 2,
      });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("queued");
    expect(res.body.engine).toBe("slideshow");
    expect(res.body.aspectRatio).toBe("1:1");

    await waitForPendingJobs();
    expect(runnerState.calls).toEqual([{ jobId: res.body.id, funding: "quota" }]);

    const row = (
      await db
        .select()
        .from(videoGenerationsTable)
        .where(eq(videoGenerationsTable.id, res.body.id))
    )[0];
    expect(row?.tenantId).toBe(tenant.tenantId);
  });

  it("freezes the per-unit AI-spend display rate on the job at charge time", async () => {
    const tenant = await newTenant();
    // Whatever the (shared) admin display rate is right now is what the job
    // must snapshot — so a later rate change never rewrites this job's cost.
    const { videoPaise } = await getAiSpendRates();
    const res = await request(app)
      .post("/api/ai/generate-video")
      .send({
        engine: "slideshow",
        sourceImagePaths: [`/objects/${tenant.tenantId}/uploads/a.png`],
        slideDurationSec: 2,
      });
    expect(res.status).toBe(201);
    expect(res.body.chargedRatePaise).toBe(videoPaise);
    const row = (
      await db
        .select()
        .from(videoGenerationsTable)
        .where(eq(videoGenerationsTable.id, res.body.id))
    )[0];
    expect(row?.chargedRatePaise).toBe(videoPaise);
  });

  it("rejects topic-to-video without a topic before reserving any funding", async () => {
    await newTenant();
    const res = await request(app)
      .post("/api/ai/generate-video")
      .send({ engine: "topic_to_video", prompt: "   " });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/topic/i);
    expect(runnerState.calls).toHaveLength(0);
  });

  it("creates a topic-to-video job persisting its narration options", async () => {
    const tenant = await newTenant(); // free plan: 3 videos/month
    const res = await request(app)
      .post("/api/ai/generate-video")
      .send({
        engine: "topic_to_video",
        prompt: "5 morning habits that transform your day",
        aspectRatio: "9:16",
        voice: "nova",
        paragraphCount: 2,
        subtitles: false,
        captionStyle: "dynamic",
        stockSource: "pexels",
        musicPath: `/objects/${tenant.tenantId}/uploads/track.mp3`,
      });
    expect(res.status).toBe(201);
    expect(res.body.engine).toBe("topic_to_video");
    expect(res.body.status).toBe("queued");

    await waitForPendingJobs();
    expect(runnerState.calls).toEqual([{ jobId: res.body.id, funding: "quota" }]);

    const row = (
      await db
        .select()
        .from(videoGenerationsTable)
        .where(eq(videoGenerationsTable.id, res.body.id))
    )[0];
    expect(row?.options).toMatchObject({
      voice: "nova",
      paragraphCount: 2,
      subtitles: false,
      captionStyle: "dynamic",
      stockSource: "pexels",
      musicPath: `/objects/${tenant.tenantId}/uploads/track.mp3`,
      // Storyboard review is on unless the caller turns it off.
      reviewStoryboard: true,
    });
  });

  describe("curated presenter-and-B-roll templates", () => {
    it("requires the presenter asset before funding or queueing", async () => {
      await newTenant();
      const template = await seedPresenterTemplate();
      const before = runnerState.calls.length;
      const res = await request(app).post("/api/ai/generate-video").send({
        engine: "topic_to_video",
        prompt: "This is the exact script spoken in my presenter take.",
        styleProfileId: template.id,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/presenter video/i);
      expect(runnerState.calls).toHaveLength(before);
    });

    it("rejects another workspace's presenter path before funding", async () => {
      const tenant = await newTenant();
      const template = await seedPresenterTemplate();
      const before = runnerState.calls.length;
      const res = await request(app).post("/api/ai/generate-video").send({
        engine: "topic_to_video",
        prompt: "This is the exact script spoken in my presenter take.",
        styleProfileId: template.id,
        presenterVideoPath: `/objects/${tenant.tenantId + 1}/uploads/stolen.mp4`,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/presenter video path/i);
      expect(runnerState.calls).toHaveLength(before);
    });

    it("rejects a curated template whose presenter slot is optional", async () => {
      const tenant = await newTenant();
      const template = await seedPresenterTemplate(false);
      const before = runnerState.calls.length;
      const res = await request(app).post("/api/ai/generate-video").send({
        engine: "topic_to_video",
        prompt: "This is the exact script spoken in my presenter take.",
        styleProfileId: template.id,
        presenterVideoPath: `/objects/${tenant.tenantId}/uploads/presenter.mp4`,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/presenter video slot must be required/i);
      expect(runnerState.calls).toHaveLength(before);
    });

    it("rejects a presenter take whose spoken words do not match the submitted script", async () => {
      const tenant = await newTenant();
      const template = await seedPresenterTemplate();
      presenterAsrState.transcript =
        "This recording discusses a completely different product launch.";
      const before = runnerState.calls.length;
      const res = await request(app).post("/api/ai/generate-video").send({
        engine: "topic_to_video",
        prompt: "This is the exact script spoken in my presenter take.",
        styleProfileId: template.id,
        presenterVideoPath: `/objects/${tenant.tenantId}/uploads/presenter.mp4`,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/does not closely match/i);
      expect(runnerState.calls).toHaveLength(before);
    });

    it("uses the pre-funded generated beat count as the exact reservation", async () => {
      const tenant = await newTenant(); // free plan has three video units
      const template = await seedPresenterTemplate();
      presenterPlanState.beatCount = 4;
      const before = runnerState.calls.length;
      const res = await request(app).post("/api/ai/generate-video").send({
        engine: "topic_to_video",
        prompt: "This is the exact script spoken in my presenter take.",
        styleProfileId: template.id,
        presenterVideoPath: `/objects/${tenant.tenantId}/uploads/presenter.mp4`,
        visualsSource: "ai",
      });
      expect(res.status).toBe(402);
      expect(res.body.error).toMatch(/4 video units/i);
      expect(runnerState.calls).toHaveLength(before);
    });

    it("queues a presenter job with safe template defaults and an immutable asset pointer", async () => {
      const tenant = await newTenant();
      const template = await seedPresenterTemplate();
      const presenterVideoPath = `/objects/${tenant.tenantId}/uploads/presenter.mp4`;
      const res = await request(app).post("/api/ai/generate-video").send({
        engine: "topic_to_video",
        prompt: "This is the exact script spoken in my presenter take.",
        styleProfileId: template.id,
        presenterVideoPath,
      });
      expect(res.status).toBe(201);
      await waitForPendingJobs();
      const row = (
        await db
          .select()
          .from(videoGenerationsTable)
          .where(eq(videoGenerationsTable.id, res.body.id))
      )[0]!;
      expect(row.options).toMatchObject({
        presenterVideoPath,
        videoTemplateId: template.id,
        visualsSource: "stock",
        captionStyle: "dynamic",
        reviewStoryboard: true,
        presenterBroll: {
          durationMs: 8_000,
          beats: [{ id: "pb1", assetPath: null, previewPath: null }],
        },
      });
      expect(runnerState.calls).toEqual([{ jobId: res.body.id, funding: "quota" }]);
    });
  });

  it("keeps voice omitted so the job runner can resolve the brand kit voice", async () => {
    await newTenant();
    const res = await request(app).post("/api/ai/generate-video").send({
      engine: "topic_to_video",
      prompt: "why sourdough rises",
    });
    expect(res.status).toBe(201);
    const row = (
      await db
        .select()
        .from(videoGenerationsTable)
        .where(eq(videoGenerationsTable.id, res.body.id))
    )[0];
    // Regression: the request schema must NOT default voice to "alloy" —
    // an inserted default reads as an explicit stock choice and silently
    // overrides the kit's cloned/preset brand voice in the job runner.
    expect((row?.options as unknown as Record<string, unknown>).voice).toBeUndefined();
  });

  it("honours a caller that turns storyboard review off", async () => {
    await newTenant();
    const res = await request(app).post("/api/ai/generate-video").send({
      engine: "topic_to_video",
      prompt: "why sourdough rises",
      visualsSource: "ai",
      reviewStoryboard: false,
    });
    expect(res.status).toBe(201);
    const row = (
      await db.select().from(videoGenerationsTable).where(eq(videoGenerationsTable.id, res.body.id))
    )[0];
    expect(row?.options?.reviewStoryboard).toBe(false);
  });

  describe("reusing a saved plan (planSource)", () => {
    /** A finished topic job whose storyboard captured the AI's raw plan. */
    async function seedPlannedJob(
      tenantId: number,
      aiPlan: NonNullable<VideoStoryboard["aiPlan"]>,
    ) {
      const board = storyboardFixture(tenantId);
      return (
        await db
          .insert(videoGenerationsTable)
          .values({
            tenantId,
            engine: "topic_to_video",
            status: "succeeded",
            funding: "quota",
            options: { aspectRatio: "9:16", visualsSource: "character", paragraphCount: 1 },
            storyboard: { ...board, aiPlan },
          })
          .returning()
      )[0]!;
    }

    it("reuses the saved plan as-is and persists it on the new job's options", async () => {
      const tenant = await newTenant();
      const source = await seedPlannedJob(tenant.tenantId, {
        flow: "broll",
        raw: { style: "warm", prompts: ["flour", "dough"] },
        capturedAt: new Date().toISOString(),
      });
      const res = await request(app).post("/api/ai/generate-video").send({
        engine: "topic_to_video",
        prompt: "baking bread",
        visualsSource: "ai",
        planSource: { jobId: source.id },
      });
      expect(res.status).toBe(201);
      const row = await readJob(res.body.id);
      expect(row.options?.suppliedPlan).toEqual({
        flow: "broll",
        raw: { style: "warm", prompts: ["flour", "dough"] },
      });
    });

    it("prefers an edited plan over the saved one, validated strictly", async () => {
      const tenant = await newTenant();
      const source = await seedPlannedJob(tenant.tenantId, {
        flow: "broll",
        raw: { prompts: ["original"] },
        capturedAt: new Date().toISOString(),
      });
      const ok = await request(app)
        .post("/api/ai/generate-video")
        .send({
          engine: "topic_to_video",
          prompt: "baking bread",
          visualsSource: "ai",
          planSource: { jobId: source.id, plan: { prompts: ["edited close-up"] } },
        });
      expect(ok.status).toBe(201);
      expect((await readJob(ok.body.id)).options?.suppliedPlan).toEqual({
        flow: "broll",
        raw: { prompts: ["edited close-up"] },
      });

      // A malformed edit is rejected with a pointed message, never "fixed",
      // and no job row or funding spend happens.
      const before = runnerState.calls.length;
      const bad = await request(app)
        .post("/api/ai/generate-video")
        .send({
          engine: "topic_to_video",
          prompt: "baking bread",
          visualsSource: "ai",
          planSource: { jobId: source.id, plan: { prompts: ["ok", 7] } },
        });
      expect(bad.status).toBe(400);
      expect(bad.body.error).toMatch(/Prompt 2/);
      expect(runnerState.calls).toHaveLength(before);
    });

    it("rejects flow mismatches, missing plans, wrong engines, and stock visuals", async () => {
      const tenant = await newTenant();
      const character = await seedPlannedJob(tenant.tenantId, {
        flow: "character",
        raw: { scenes: [{ visual: "gym" }] },
        capturedAt: new Date().toISOString(),
      });
      // Character plan requested with AI-imagery visuals.
      const mismatch = await request(app).post("/api/ai/generate-video").send({
        engine: "topic_to_video",
        prompt: "topic",
        visualsSource: "ai",
        planSource: { jobId: character.id },
      });
      expect(mismatch.status).toBe(400);
      expect(mismatch.body.error).toMatch(/character visuals/i);

      // Source job without any saved plan.
      const bare = await seedPausedJob(tenant.tenantId, { status: "succeeded" });
      const missing = await request(app).post("/api/ai/generate-video").send({
        engine: "topic_to_video",
        prompt: "topic",
        visualsSource: "ai",
        planSource: { jobId: bare.id },
      });
      expect(missing.status).toBe(400);
      expect(missing.body.error).toMatch(/no saved plan/i);

      // Wrong engine and stock visuals both refuse the option outright.
      const wrongEngine = await request(app)
        .post("/api/ai/generate-video")
        .send({
          engine: "text_to_video",
          prompt: "clip",
          planSource: { jobId: character.id },
        });
      expect(wrongEngine.status).toBe(400);
      expect(wrongEngine.body.error).toMatch(/topic videos/i);
      const stock = await request(app).post("/api/ai/generate-video").send({
        engine: "topic_to_video",
        prompt: "topic",
        visualsSource: "stock",
        planSource: { jobId: character.id },
      });
      expect(stock.status).toBe(400);
      expect(stock.body.error).toMatch(/stock/i);
    });

    it("cannot reuse another workspace's plan", async () => {
      const victim = await newTenant();
      const theirs = await seedPlannedJob(victim.tenantId, {
        flow: "broll",
        raw: { prompts: ["private"] },
        capturedAt: new Date().toISOString(),
      });
      await newTenant(); // switches auth to a fresh tenant
      const res = await request(app).post("/api/ai/generate-video").send({
        engine: "topic_to_video",
        prompt: "topic",
        visualsSource: "ai",
        planSource: { jobId: theirs.id },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/no longer exists/i);
    });
  });

  it("stores a brand kit on a topic video and drops it on other engines", async () => {
    const tenant = await newTenant();
    const topic = await request(app).post("/api/ai/generate-video").send({
      engine: "topic_to_video",
      prompt: "Why your morning routine keeps failing",
      brandKitId: 4321,
    });
    expect(topic.status).toBe(201);
    await waitForPendingJobs();
    const topicRow = (
      await db
        .select()
        .from(videoGenerationsTable)
        .where(eq(videoGenerationsTable.id, topic.body.id))
    )[0];
    // A foreign/unknown id is stored as-is; the job runner resolves it
    // tenant-scoped and simply renders unbranded when it does not match.
    expect(topicRow?.options?.brandKitId).toBe(4321);

    const text = await request(app).post("/api/ai/generate-video").send({
      engine: "text_to_video",
      prompt: "A calm ocean at dusk",
      brandKitId: 4321,
    });
    expect(text.status).toBe(201);
    await waitForPendingJobs();
    const textRow = (
      await db
        .select()
        .from(videoGenerationsTable)
        .where(eq(videoGenerationsTable.id, text.body.id))
    )[0];
    expect(textRow?.options?.brandKitId).toBeNull();
    expect(tenant.tenantId).toBeGreaterThan(0);
  });

  it("stores a style profile on a topic video and drops it on other engines", async () => {
    const tenant = await newTenant();
    const topic = await request(app).post("/api/ai/generate-video").send({
      engine: "topic_to_video",
      prompt: "Why your morning routine keeps failing",
      styleProfileId: 99,
    });
    expect(topic.status).toBe(201);
    await waitForPendingJobs();
    const topicRow = (
      await db
        .select()
        .from(videoGenerationsTable)
        .where(eq(videoGenerationsTable.id, topic.body.id))
    )[0];
    // Stored as-is; the job runner resolves it tenant-scoped and renders
    // without reference styling when it does not match.
    expect(topicRow?.options?.styleProfileId).toBe(99);

    const slideshow = await request(app)
      .post("/api/ai/generate-video")
      .send({
        engine: "slideshow",
        sourceImagePaths: [`/objects/${tenant.tenantId}/uploads/a.png`],
        styleProfileId: 99,
      });
    expect(slideshow.status).toBe(201);
    await waitForPendingJobs();
    const slideshowRow = (
      await db
        .select()
        .from(videoGenerationsTable)
        .where(eq(videoGenerationsTable.id, slideshow.body.id))
    )[0];
    expect(slideshowRow?.options?.styleProfileId).toBeNull();
  });

  it("rejects missing required template inputs before creating or funding a job", async () => {
    await newTenant();
    const [template] = await db
      .insert(videoStyleProfilesTable)
      .values({
        tenantId: null,
        scope: "platform",
        sourceKind: "curated",
        published: true,
        name: `Required brand template ${Date.now()}`,
        summary: "A template that needs workspace branding.",
        slots: [
          { kind: "script", required: true, label: "Your topic or script" },
          { kind: "brand_kit", required: true, label: "A brand kit" },
        ],
        jobDefaults: {
          aspectRatio: "9:16",
          paragraphCount: 1,
          visualsSource: "stock",
        },
        payload: {
          version: 1,
          hookShape: "Open with the benefit.",
          pacing: { sceneCount: 3, avgSceneSec: 10, wordsPerMinute: 140 },
          captionStyle: "dynamic",
          energy: "clear",
          visualNotes: [],
          scriptGuidance: "Explain one useful idea.",
          sourceDurationSec: 30,
          transcriptExcerpt: "",
        },
      })
      .returning();
    try {
      const runnerCallsBefore = runnerState.calls.length;
      const jobsBefore = await db.select({ id: videoGenerationsTable.id }).from(videoGenerationsTable);
      const res = await request(app).post("/api/ai/generate-video").send({
        engine: "topic_to_video",
        prompt: "How to make a useful product demo",
        styleProfileId: template!.id,
        brandKitId: 999_999_999,
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/requires a brand kit/i);
      expect(runnerState.calls).toHaveLength(runnerCallsBefore);
      const jobsAfter = await db.select({ id: videoGenerationsTable.id }).from(videoGenerationsTable);
      expect(jobsAfter).toHaveLength(jobsBefore.length);
    } finally {
      await db.delete(videoStyleProfilesTable).where(eq(videoStyleProfilesTable.id, template!.id));
    }
  });

  it("rejects a topic-to-video music path outside the caller's workspace", async () => {
    const tenant = await newTenant();
    const res = await request(app)
      .post("/api/ai/generate-video")
      .send({
        engine: "topic_to_video",
        prompt: "healthy meal prep for busy weeks",
        musicPath: `/objects/${tenant.tenantId + 1}/uploads/stolen.mp3`,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/music path/i);
    expect(runnerState.calls).toHaveLength(0);
  });

  it("requires a character for a character-mode topic video", async () => {
    await newTenant();
    const res = await request(app)
      .post("/api/ai/generate-video")
      .send({
        engine: "topic_to_video",
        prompt: "a day in the life of a founder",
        visualsSource: "character",
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/character/i);
    expect(runnerState.calls).toHaveLength(0);
  });

  it("rejects a character that does not belong to the caller", async () => {
    const other = await newTenant();
    const seeded = await seedCharacter(other.tenantId);
    await newTenant();
    const res = await request(app)
      .post("/api/ai/generate-video")
      .send({
        engine: "topic_to_video",
        prompt: "a day in the life",
        visualsSource: "character",
        characterId: seeded.characterId,
      });
    expect(res.status).toBe(400);
    expect(runnerState.calls).toHaveLength(0);
  });

  it("reserves one video unit per scene for character story videos", async () => {
    const tenant = await newTenant("payg"); // 0 videos/month
    const seeded = await seedCharacter(tenant.tenantId);
    await grantCredits({
      tenantId: tenant.tenantId,
      captionCredits: 0,
      imageCredits: 0,
      videoCredits: 8,
      kind: "admin_grant",
      note: "test",
    });
    const res = await request(app)
      .post("/api/ai/generate-video")
      .send({
        engine: "topic_to_video",
        prompt: "a day in the life of a founder",
        visualsSource: "character",
        characterId: seeded.characterId,
        outfitId: seeded.gymOutfitId,
        wardrobeNotes: "gym wear for the workout scenes",
        paragraphCount: 2, // Medium = 8 scenes = 8 units
      });
    expect(res.status).toBe(201);

    await waitForPendingJobs();
    expect(runnerState.calls).toEqual([{ jobId: res.body.id, funding: "credit" }]);
    expect((await getCreditBalances(tenant.tenantId)).videoCredits).toBe(0);

    const row = (
      await db
        .select()
        .from(videoGenerationsTable)
        .where(eq(videoGenerationsTable.id, res.body.id))
    )[0];
    expect(row?.options).toMatchObject({
      visualsSource: "character",
      characterId: seeded.characterId,
      outfitId: seeded.gymOutfitId,
      wardrobeNotes: "gym wear for the workout scenes",
    });
  });

  it("402s a character video the plan and credits cannot cover", async () => {
    const tenant = await newTenant("payg");
    const seeded = await seedCharacter(tenant.tenantId);
    await grantCredits({
      tenantId: tenant.tenantId,
      captionCredits: 0,
      imageCredits: 0,
      videoCredits: 3, // Short character video needs 4
      kind: "admin_grant",
      note: "test",
    });
    const res = await request(app)
      .post("/api/ai/generate-video")
      .send({
        engine: "topic_to_video",
        prompt: "a day in the life",
        visualsSource: "character",
        characterId: seeded.characterId,
      });
    expect(res.status).toBe(402);
    expect(res.body.error).toMatch(/4 video units/);
    // The all-or-nothing reserve left the partial balance untouched.
    expect((await getCreditBalances(tenant.tenantId)).videoCredits).toBe(3);
  });

  it("resolves the default outfit for a character text-to-video clip", async () => {
    const tenant = await newTenant();
    const seeded = await seedCharacter(tenant.tenantId);
    const res = await request(app)
      .post("/api/ai/generate-video")
      .send({
        engine: "text_to_video",
        prompt: "sipping chai on a balcony at sunrise",
        characterId: seeded.characterId,
      });
    expect(res.status).toBe(201);
    const row = (
      await db
        .select()
        .from(videoGenerationsTable)
        .where(eq(videoGenerationsTable.id, res.body.id))
    )[0];
    expect(row?.options).toMatchObject({
      characterId: seeded.characterId,
      outfitId: seeded.outfitId, // default outfit resolved server-side
    });
  });

  it("402s when the plan has no video quota and no credits", async () => {
    await newTenant("payg"); // 0 videos/month, credit-funded only
    const res = await request(app)
      .post("/api/ai/generate-video")
      .send({ engine: "text_to_video", prompt: "a calm ocean at dusk" });
    expect(res.status).toBe(402);
    expect(runnerState.calls).toHaveLength(0);
  });

  it("prices a multi-shot clip at one unit per shot", async () => {
    // Each shot is its own generation, so the reservation has to scale with the
    // count — otherwise a 3-shot job renders three clips on one unit's funding.
    const tenant = await newTenant("payg");
    await grantCredits({
      tenantId: tenant.tenantId,
      captionCredits: 0,
      imageCredits: 0,
      videoCredits: 2, // a 3-shot clip needs 3
      kind: "admin_grant",
      note: "test",
    });
    const short = await request(app)
      .post("/api/ai/generate-video")
      .send({ engine: "text_to_video", prompt: "a calm ocean at dusk", shotCount: 3 });
    expect(short.status).toBe(402);
    expect(short.body.error).toMatch(/3 video units/);
    expect((await getCreditBalances(tenant.tenantId)).videoCredits).toBe(2);

    const ok = await request(app)
      .post("/api/ai/generate-video")
      .send({ engine: "text_to_video", prompt: "a calm ocean at dusk", shotCount: 2 });
    expect(ok.status).toBe(201);
    expect((await getCreditBalances(tenant.tenantId)).videoCredits).toBe(0);
  });

  it("pins shot count at enqueue, and only on the engine that splits shots", async () => {
    const tenant = await newTenant();
    const capped = await request(app)
      .post("/api/ai/generate-video")
      .send({ engine: "text_to_video", prompt: "a calm ocean at dusk", shotCount: 2 });
    expect(capped.status).toBe(201);
    const clip = (
      await db
        .select()
        .from(videoGenerationsTable)
        .where(eq(videoGenerationsTable.id, capped.body.id))
    )[0];
    expect(clip?.options?.shotCount).toBe(2);

    // A slideshow has no shots to split; sending one must not price the job up.
    const slides = await request(app)
      .post("/api/ai/generate-video")
      .send({
        engine: "slideshow",
        sourceImagePaths: [`/objects/${tenant.tenantId}/uploads/a.png`],
        shotCount: 5,
      });
    expect(slides.status).toBe(201);
    const row = (
      await db
        .select()
        .from(videoGenerationsTable)
        .where(eq(videoGenerationsTable.id, slides.body.id))
    )[0];
    expect(row?.options?.shotCount).toBe(1);
  });

  it("reserves a video credit when the quota is exhausted", async () => {
    const tenant = await newTenant("payg");
    await grantCredits({
      tenantId: tenant.tenantId,
      captionCredits: 0,
      imageCredits: 0,
      videoCredits: 1,
      kind: "admin_grant",
      note: "test",
    });
    const res = await request(app)
      .post("/api/ai/generate-video")
      .send({ engine: "text_to_video", prompt: "a calm ocean at dusk" });
    expect(res.status).toBe(201);

    await waitForPendingJobs();
    expect(runnerState.calls).toEqual([{ jobId: res.body.id, funding: "credit" }]);
    // Reserved atomically up front — the balance is already debited.
    expect((await getCreditBalances(tenant.tenantId)).videoCredits).toBe(0);
    // Funding is persisted at creation, not at the runner's claim: a restart
    // before the claim would otherwise leave a queued orphan the sweep cannot
    // refund.
    expect((await readJob(res.body.id)).funding).toBe("credit");
  });
});

describe("Auto shot-count (shotCount 0) for text_to_video", () => {
  it("persists the AI-decided count and charges exactly that many units", async () => {
    // Give the tenant exactly 7 video credits — matches what the LLM returns.
    // If the route reserved fewer or more, the credit deduction won't match.
    const tenant = await newTenant("payg");
    await grantCredits({
      tenantId: tenant.tenantId,
      captionCredits: 0,
      imageCredits: 0,
      videoCredits: 7,
      kind: "admin_grant",
      note: "test",
    });
    textGenState.shotCountResponse = 7;

    const res = await request(app)
      .post("/api/ai/generate-video")
      .send({ engine: "text_to_video", prompt: "A sunrise timelapse over a mountain range", shotCount: 0 });
    expect(res.status).toBe(201);

    await waitForPendingJobs();
    expect(runnerState.calls).toEqual([{ jobId: res.body.id, funding: "credit" }]);

    // The resolved count must be persisted on options so videoJobUnits and the
    // storyboard planner both price from the same value.
    const row = (
      await db
        .select()
        .from(videoGenerationsTable)
        .where(eq(videoGenerationsTable.id, res.body.id))
    )[0];
    expect(row?.options?.shotCount).toBe(7);

    // All 7 credits deducted → the reservation used exactly 7 units.
    expect((await getCreditBalances(tenant.tenantId)).videoCredits).toBe(0);
  });

  it("falls back to 3 shots when the LLM call fails, and never rejects the enqueue", async () => {
    // textGenState.shotCountResponse stays null → getTextGenClient().create() throws.
    const tenant = await newTenant("payg");
    await grantCredits({
      tenantId: tenant.tenantId,
      captionCredits: 0,
      imageCredits: 0,
      videoCredits: 3,
      kind: "admin_grant",
      note: "test",
    });

    const res = await request(app)
      .post("/api/ai/generate-video")
      .send({ engine: "text_to_video", prompt: "A product unboxing in four acts", shotCount: 0 });
    expect(res.status).toBe(201);

    await waitForPendingJobs();
    expect(runnerState.calls).toEqual([{ jobId: res.body.id, funding: "credit" }]);

    const row = (
      await db
        .select()
        .from(videoGenerationsTable)
        .where(eq(videoGenerationsTable.id, res.body.id))
    )[0];
    // Fallback is AUTO_SHOT_FALLBACK = 3.
    expect(row?.options?.shotCount).toBe(3);
    // 3 credits spent — reservation matched the fallback count.
    expect((await getCreditBalances(tenant.tenantId)).videoCredits).toBe(0);
  });

  it("clamps a model reply above MAX_CLIP_SHOTS (10) down to 10", async () => {
    const tenant = await newTenant("payg");
    await grantCredits({
      tenantId: tenant.tenantId,
      captionCredits: 0,
      imageCredits: 0,
      videoCredits: 10,
      kind: "admin_grant",
      note: "test",
    });
    // Model returns 15 — well above the ceiling.
    textGenState.shotCountResponse = 15;

    const res = await request(app)
      .post("/api/ai/generate-video")
      .send({ engine: "text_to_video", prompt: "An epic journey in many acts", shotCount: 0 });
    expect(res.status).toBe(201);

    const row = (
      await db
        .select()
        .from(videoGenerationsTable)
        .where(eq(videoGenerationsTable.id, res.body.id))
    )[0];
    expect(row?.options?.shotCount).toBe(10);
    // Exactly 10 credits deducted — not 15.
    expect((await getCreditBalances(tenant.tenantId)).videoCredits).toBe(0);
  });

  it("treats a sub-1 model reply as the fallback count (3), not 0 or negative", async () => {
    const tenant = await newTenant("payg");
    await grantCredits({
      tenantId: tenant.tenantId,
      captionCredits: 0,
      imageCredits: 0,
      videoCredits: 3,
      kind: "admin_grant",
      note: "test",
    });
    // Model returns 0 — invalid, should fall back to AUTO_SHOT_FALLBACK.
    textGenState.shotCountResponse = 0;

    const res = await request(app)
      .post("/api/ai/generate-video")
      .send({ engine: "text_to_video", prompt: "A single moment captured", shotCount: 0 });
    expect(res.status).toBe(201);

    const row = (
      await db
        .select()
        .from(videoGenerationsTable)
        .where(eq(videoGenerationsTable.id, res.body.id))
    )[0];
    expect(row?.options?.shotCount).toBe(3);
    expect((await getCreditBalances(tenant.tenantId)).videoCredits).toBe(0);
  });

  it("402 names the AI-resolved shot count when credits can't cover it", async () => {
    // LLM resolves to 5 shots, but the tenant only has 4 credits → 402.
    // The error must say "5 video units", not 0 (the raw request value).
    const tenant = await newTenant("payg");
    await grantCredits({
      tenantId: tenant.tenantId,
      captionCredits: 0,
      imageCredits: 0,
      videoCredits: 4,
      kind: "admin_grant",
      note: "test",
    });
    textGenState.shotCountResponse = 5;

    const res = await request(app)
      .post("/api/ai/generate-video")
      .send({ engine: "text_to_video", prompt: "A dramatic storm rolling in over the sea", shotCount: 0 });

    expect(res.status).toBe(402);
    expect(res.body.error).toMatch(/5 video units/);
    // Credits untouched — the all-or-nothing reserve left the balance intact.
    expect((await getCreditBalances(tenant.tenantId)).videoCredits).toBe(4);
  });

  it("402 names the clamped shot count (10) not the raw model reply (12)", async () => {
    // LLM returns 12 but the ceiling is 10 (MAX_CLIP_SHOTS). The tenant only
    // has 9 credits. The error must quote the clamped value, not 12 or 0.
    const tenant = await newTenant("payg");
    await grantCredits({
      tenantId: tenant.tenantId,
      captionCredits: 0,
      imageCredits: 0,
      videoCredits: 9,
      kind: "admin_grant",
      note: "test",
    });
    textGenState.shotCountResponse = 12;

    const res = await request(app)
      .post("/api/ai/generate-video")
      .send({ engine: "text_to_video", prompt: "An odyssey across many landscapes", shotCount: 0 });

    expect(res.status).toBe(402);
    expect(res.body.error).toMatch(/10 video units/);
    expect((await getCreditBalances(tenant.tenantId)).videoCredits).toBe(9);
  });
});

describe("Auto shot-count (shotCount 0) – wallet-funded tenants", () => {
  // Pricing snapshots: these settings are global so we restore them after the
  // suite to avoid polluting other suites that run in the same process.
  let aiSpendSnapshot: AiSpendSettings | null = null;
  let walletSettingsSnapshot: WalletSettings | null = null;

  beforeAll(async () => {
    aiSpendSnapshot = await snapshotAiSpendSettings();
    walletSettingsSnapshot = await snapshotWalletSettings();
    // 100 paise (₹1) per video unit, 0% fee → easy integer arithmetic.
    await setAiSpendConfig({
      captionCostPaise: 100,
      imageCostPaise: 100,
      videoCostPaise: 100,
      feePercent: 0,
    });
    await setWalletConfig({
      gstPercent: 0,
      minTopupPaise: 1_000,
      lowBalanceThresholdPaise: 500,
      videoCostPaise: 100,
    });
  });

  afterAll(async () => {
    await restoreAiSpendSettings(aiSpendSnapshot);
    await restoreWalletSettings(walletSettingsSnapshot);
  });

  async function enableWalletFlag(): Promise<void> {
    await db
      .insert(featureFlagsTable)
      .values({ feature: "wallet", enabled: true })
      .onConflictDoUpdate({
        target: featureFlagsTable.feature,
        set: { enabled: true, updatedAt: new Date() },
      });
    invalidateFeatureFlagCache();
  }

  afterEach(async () => {
    // Disable the wallet flag so other suites that don't expect wallet billing
    // are not affected by it running in the same process.
    await db.delete(featureFlagsTable).where(eq(featureFlagsTable.feature, "wallet"));
    invalidateFeatureFlagCache();
  });

  /**
   * Create a payg tenant in wallet billing mode with 10 000 paise (₹100)
   * of balance — enough to cover up to 100 shots at ₹1 each.
   */
  async function makeWalletTenant(): Promise<TestTenant> {
    const tenant = await newTenant("payg");
    await db
      .update(tenantsTable)
      .set({ billingMode: "wallet" })
      .where(eq(tenantsTable.id, tenant.tenantId));
    await db
      .insert(walletBalancesTable)
      .values({ tenantId: tenant.tenantId, balancePaise: 10_000 });
    return tenant;
  }

  it("walletReservedUnits equals the AI-decided shot count when the LLM returns 6", async () => {
    await enableWalletFlag();
    const tenant = await makeWalletTenant();
    textGenState.shotCountResponse = 6;

    const res = await request(app)
      .post("/api/ai/generate-video")
      .send({
        engine: "text_to_video",
        prompt: "A stormy seascape across six dramatic acts",
        shotCount: 0,
      });
    expect(res.status).toBe(201);

    const row = (
      await db
        .select()
        .from(videoGenerationsTable)
        .where(eq(videoGenerationsTable.id, res.body.id))
    )[0];

    // The AI-resolved count must flow all the way to the wallet reservation —
    // not the raw shotCount 0 request value or a fixed default.
    expect(row?.options?.shotCount).toBe(6);
    expect(row?.walletReservedUnits).toBe(6);

    // Direct clip jobs reserve the exact selected model variant, not the
    // generic ₹1 display fallback. The resolved shot count still multiplies
    // that one-call amount exactly.
    const [balance] = await db
      .select()
      .from(walletBalancesTable)
      .where(eq(walletBalancesTable.tenantId, tenant.tenantId));
    expect(row?.walletReservedPaise).toBeGreaterThan(0);
    expect(row!.walletReservedPaise! % 6).toBe(0);
    expect(balance?.balancePaise).toBe(10_000 - row!.walletReservedPaise!);
  });

  it("walletReservedUnits equals the fallback count (3) when the LLM call fails", async () => {
    await enableWalletFlag();
    const tenant = await makeWalletTenant();
    // textGenState.shotCountResponse is null (reset in beforeEach) so the LLM
    // stub throws, triggering AUTO_SHOT_FALLBACK = 3.

    const res = await request(app)
      .post("/api/ai/generate-video")
      .send({
        engine: "text_to_video",
        prompt: "A silent forest at dawn",
        shotCount: 0,
      });
    expect(res.status).toBe(201);

    const row = (
      await db
        .select()
        .from(videoGenerationsTable)
        .where(eq(videoGenerationsTable.id, res.body.id))
    )[0];

    // The fallback count must also reach the wallet reservation unchanged.
    expect(row?.options?.shotCount).toBe(3);
    expect(row?.walletReservedUnits).toBe(3);

    // The fallback count also multiplies the exact selected variant.
    const [balance] = await db
      .select()
      .from(walletBalancesTable)
      .where(eq(walletBalancesTable.tenantId, tenant.tenantId));
    expect(row?.walletReservedPaise).toBeGreaterThan(0);
    expect(row!.walletReservedPaise! % 3).toBe(0);
    expect(balance?.balancePaise).toBe(10_000 - row!.walletReservedPaise!);
  });

  it("402 names the AI-resolved shot count when the wallet cannot cover it", async () => {
    await enableWalletFlag();
    const tenant = await makeWalletTenant();
    // Five exact model calls cost more than this balance, so reservation fails.
    await db
      .update(walletBalancesTable)
      .set({ balancePaise: 400 })
      .where(eq(walletBalancesTable.tenantId, tenant.tenantId));
    textGenState.shotCountResponse = 5;

    const res = await request(app)
      .post("/api/ai/generate-video")
      .send({
        engine: "text_to_video",
        prompt: "A dramatic storm rolling in over the sea",
        shotCount: 0,
      });

    expect(res.status).toBe(402);
    expect(res.body.error).toContain("5 generations");
    expect(res.body.error).not.toContain("0 generations");
  });

  it("402 names the clamped AI shot count when the wallet cannot cover it", async () => {
    await enableWalletFlag();
    const tenant = await makeWalletTenant();
    // The model's 12-shot reply is clamped to 10; 10 shots cost 1,000 paise.
    await db
      .update(walletBalancesTable)
      .set({ balancePaise: 900 })
      .where(eq(walletBalancesTable.tenantId, tenant.tenantId));
    textGenState.shotCountResponse = 12;

    const res = await request(app)
      .post("/api/ai/generate-video")
      .send({
        engine: "text_to_video",
        prompt: "An odyssey across many landscapes",
        shotCount: 0,
      });

    expect(res.status).toBe(402);
    expect(res.body.error).toContain("10 generations");
    expect(res.body.error).not.toContain("12 generations");
  });

  it("charges each successful script draft once and records the exact wallet display amount", async () => {
    await enableWalletFlag();
    const tenant = await makeWalletTenant();
    textGenState.spokespersonResponse =
      '{"script":"Open clearly. Explain the idea. End with one useful action."}';

    const res = await request(app)
      .post("/api/ai/spokesperson-script")
      .send({ topic: "A practical weekly planning habit" });

    expect(res.status).toBe(200);
    const [balance] = await db
      .select()
      .from(walletBalancesTable)
      .where(eq(walletBalancesTable.tenantId, tenant.tenantId));
    expect(balance?.balancePaise).toBe(9_900);
    const ledger = await db
      .select()
      .from(walletLedgerTable)
      .where(eq(walletLedgerTable.tenantId, tenant.tenantId));
    expect(ledger.map((row) => row.kind)).toEqual(["reserve", "settle"]);
    expect(ledger.reduce((sum, row) => sum + row.amountPaise, 0)).toBe(-100);
    const operations = await db
      .select()
      .from(walletProviderOperationsTable)
      .where(eq(walletProviderOperationsTable.tenantId, tenant.tenantId));
    expect(operations).toEqual([
      expect.objectContaining({
        operationKind: "video_script_draft",
        status: "settled",
        targetChargePaise: 100,
      }),
    ]);
    const telemetry = await db
      .select()
      .from(usageEventsTable)
      .where(eq(usageEventsTable.tenantId, tenant.tenantId));
    expect(telemetry).toEqual([
      expect.objectContaining({
        kind: "caption",
        funding: "wallet",
        displayPaise: 100,
      }),
    ]);
  });
});

describe("lip-sync (spokesperson) videos", () => {
  async function setLipSyncFlag(enabled: boolean): Promise<void> {
    await db
      .insert(featureFlagsTable)
      .values({ feature: "lipSync", enabled })
      .onConflictDoUpdate({ target: featureFlagsTable.feature, set: { enabled } });
    invalidateFeatureFlagCache();
  }
  afterEach(async () => {
    await db.delete(featureFlagsTable).where(eq(featureFlagsTable.feature, "lipSync"));
    invalidateFeatureFlagCache();
  });

  function lipSyncBody(tenantId: number) {
    return {
      engine: "lip_sync",
      prompt: "Hey everyone, big sale this week!",
      sourceVideoPath: `/objects/${tenantId}/uploads/me.mp4`,
      lipSyncConsent: true,
    };
  }

  it("drafts a reviewable script without creating or funding a video job", async () => {
    const tenant = await newTenant();
    const usageBefore = await getUsage(tenant.tenantId);
    textGenState.spokespersonResponse =
      'Here is the result:\n```json\n{"script":"Start with a useful hook. Explain the idea simply. End with one clear takeaway."}\n```';

    const res = await request(app)
      .post("/api/ai/spokesperson-script")
      .send({ topic: "How founders can make weekly planning less stressful" });

    expect(res.status).toBe(200);
    expect(res.body.script).toBe(
      "Start with a useful hook. Explain the idea simply. End with one clear takeaway.",
    );
    // A flat script (no beats) still answers, so older clients keep working.
    expect(res.body.beats).toBeUndefined();
    expect(res.body.meta).toEqual(
      expect.objectContaining({ wordCount: 14, openItems: [] }),
    );
    expect(runnerState.calls).toHaveLength(0);
    const rows = await db
      .select()
      .from(videoGenerationsTable)
      .where(eq(videoGenerationsTable.tenantId, tenant.tenantId));
    expect(rows).toHaveLength(0);
    const usageAfter = await getUsage(tenant.tenantId);
    expect(usageAfter.captions).toBe(usageBefore.captions);
    const telemetry = await db
      .select()
      .from(usageEventsTable)
      .where(eq(usageEventsTable.tenantId, tenant.tenantId));
    expect(telemetry).toEqual([
      expect.objectContaining({
        kind: "caption",
        funding: "unmetered",
        displayPaise: null,
        provider: "openai",
        inputTokens: 80,
        outputTokens: 24,
      }),
    ]);
  });

  it("advertises server-owned Eleven v3 locales and only accepts them for script drafting", async () => {
    await newTenant();
    const restoreHighPrice = await installHighLipSyncTestPrice();
    const capabilities = await request(app).get("/api/ai/video-capabilities");
    await restoreHighPrice();
    expect(capabilities.status).toBe(200);
    expect(capabilities.body.characterDialogueLocales).toHaveLength(74);
    expect(capabilities.body.characterDialogueLocales).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "te", bcp47: "te-IN", modelId: "eleven_v3" }),
      ]),
    );
    expect(capabilities.body.costModels).toEqual({
      textToVideo: expect.objectContaining({
        provider: expect.any(String),
        model: expect.any(String),
        paisePerSecond: expect.toSatisfy((value: unknown) => value === null || Number.isInteger(value)),
        paisePerVideo: expect.toSatisfy((value: unknown) => value === null || Number.isInteger(value)),
      }),
      imageToVideo: expect.objectContaining({
        provider: expect.any(String),
        model: expect.any(String),
        paisePerSecond: expect.toSatisfy((value: unknown) => value === null || Number.isInteger(value)),
        paisePerVideo: expect.toSatisfy((value: unknown) => value === null || Number.isInteger(value)),
      }),
      lipSync: expect.objectContaining({
        provider: "replicate",
        model: "bytedance/latentsync",
        paisePerSecond: expect.toSatisfy((value: unknown) => value === null || Number.isInteger(value)),
        paisePerVideo: expect.toSatisfy((value: unknown) => value === null || Number.isInteger(value)),
      }),
      lipSyncHigh: expect.objectContaining({
        provider: "replicate",
        model: HIGH_LIP_SYNC_MODEL,
        paisePerSecond: expect.any(Number),
        paisePerVideo: null,
      }),
    });

    const rejected = await request(app).post("/api/ai/spokesperson-script").send({
      topic: "How to make weekly planning less stressful",
      targetLocale: "not-a-language",
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toMatch(/unsupported target locale/i);

    const accepted = await request(app).post("/api/ai/spokesperson-script").send({
      topic: "How to make weekly planning less stressful",
      targetLocale: "te",
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body.script).toContain("generated spokesperson script");
    expect(textGenState.lastSpokespersonPrompt).toMatch(/Telugu|te-IN/i);
  });

  it("rejects a blank or undersized spokesperson topic", async () => {
    await newTenant();
    const res = await request(app)
      .post("/api/ai/spokesperson-script")
      .send({ topic: "  " });
    expect(res.status).toBe(400);
    expect(runnerState.calls).toHaveLength(0);
  });

  it("surfaces script-provider failures without creating a video job", async () => {
    const tenant = await newTenant();
    textGenState.spokespersonResponse = new Error("provider unavailable");

    const res = await request(app)
      .post("/api/ai/spokesperson-script")
      .send({ topic: "Why customer interviews matter for early products" });

    expect(res.status, JSON.stringify(res.body)).toBe(502);
    expect(res.body.error).toMatch(/failed|try again/i);
    const rows = await db
      .select()
      .from(videoGenerationsTable)
      .where(eq(videoGenerationsTable.tenantId, tenant.tenantId));
    expect(rows).toHaveLength(0);
    const telemetry = await db
      .select()
      .from(usageEventsTable)
      .where(eq(usageEventsTable.tenantId, tenant.tenantId));
    expect(telemetry).toHaveLength(0);
  });

  it("blocks script drafting while the spokesperson feature is off", async () => {
    await newTenant();
    await setLipSyncFlag(false);
    const res = await request(app)
      .post("/api/ai/spokesperson-script")
      .send({ topic: "How to prepare for a product launch" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("feature_disabled");
  });

  it("is refused with 403 while the kill switch is off, before any funding", async () => {
    const tenant = await newTenant();
    await setLipSyncFlag(false);
    const res = await request(app)
      .post("/api/ai/generate-video")
      .send(lipSyncBody(tenant.tenantId));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("feature_disabled");
    expect(runnerState.calls).toHaveLength(0);
  });

  it("rejects a missing script", async () => {
    const tenant = await newTenant();
    const res = await request(app)
      .post("/api/ai/generate-video")
      .send({ ...lipSyncBody(tenant.tenantId), prompt: "   " });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/script/i);
  });

  it("rejects a missing base video", async () => {
    const tenant = await newTenant();
    const res = await request(app)
      .post("/api/ai/generate-video")
      .send({ ...lipSyncBody(tenant.tenantId), sourceVideoPath: null });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/base video/i);
  });

  it("rejects without explicit likeness consent — a hard gate, not a default", async () => {
    const tenant = await newTenant();
    const res = await request(app)
      .post("/api/ai/generate-video")
      .send({ ...lipSyncBody(tenant.tenantId), lipSyncConsent: false });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/permission/i);
    expect(runnerState.calls).toHaveLength(0);
  });

  it("rejects a base video path outside the caller's workspace", async () => {
    const tenant = await newTenant();
    const res = await request(app)
      .post("/api/ai/generate-video")
      .send({
        ...lipSyncBody(tenant.tenantId),
        sourceVideoPath: `/objects/${tenant.tenantId + 1}/uploads/stolen.mp4`,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/base video path/i);
  });

  it("creates a queued job persisting the consent, base video, and brand kit", async () => {
    const tenant = await newTenant();
    const res = await request(app)
      .post("/api/ai/generate-video")
      .send({ ...lipSyncBody(tenant.tenantId), brandKitId: 12345 });
    expect(res.status).toBe(201);
    expect(res.body.engine).toBe("lip_sync");

    await waitForPendingJobs();
    expect(runnerState.calls).toEqual([{ jobId: res.body.id, funding: "quota" }]);

    const row = (
      await db
        .select()
        .from(videoGenerationsTable)
        .where(eq(videoGenerationsTable.id, res.body.id))
    )[0];
    expect(row?.options?.sourceVideoPath).toBe(`/objects/${tenant.tenantId}/uploads/me.mp4`);
    expect(row?.options?.lipSyncConsent).toBe(true);
    expect(row?.options?.lipSyncQuality).toBe("standard");
    expect(row?.options?.brandKitId).toBe(12345);
  });

  it("persists an explicitly selected High Quality model before enqueue", async () => {
    const restoreHighPrice = await installHighLipSyncTestPrice();
    try {
      const tenant = await newTenant();
      const res = await request(app)
        .post("/api/ai/generate-video")
        .send({ ...lipSyncBody(tenant.tenantId), lipSyncQuality: "high" });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const [row] = await db
        .select()
        .from(videoGenerationsTable)
        .where(eq(videoGenerationsTable.id, res.body.id));
      expect(row?.options?.lipSyncQuality).toBe("high");
    } finally {
      await restoreHighPrice();
    }
  });

  it("rejects High Quality before funding when its real model price is unavailable", async () => {
    const existing = await findModelPrice(
      "video",
      "replicate",
      HIGH_LIP_SYNC_MODEL,
      { exactProviderOnly: true },
    );
    if (existing) await deleteModelPrice(existing.id);
    try {
      const tenant = await newTenant();
      const res = await request(app)
        .post("/api/ai/generate-video")
        .send({ ...lipSyncBody(tenant.tenantId), lipSyncQuality: "high" });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/pricing.*unavailable/i);
      expect(runnerState.calls).toHaveLength(0);
    } finally {
      await restoreHighLipSyncPrice(existing);
    }
  });

  it("rejects High Quality when only a flat per-video price is configured", async () => {
    const existing = await findModelPrice(
      "video",
      "replicate",
      HIGH_LIP_SYNC_MODEL,
      { exactProviderOnly: true },
    );
    const flatOnly = await upsertModelPrice({
      kind: "video",
      provider: "replicate",
      model: HIGH_LIP_SYNC_MODEL,
      inputUsdPerMtok: null,
      outputUsdPerMtok: null,
      usdPerImage: null,
      usdPerSecond: null,
      usdPerVideo: 1,
    });
    try {
      const tenant = await newTenant();
      const res = await request(app)
        .post("/api/ai/generate-video")
        .send({ ...lipSyncBody(tenant.tenantId), lipSyncQuality: "high" });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/pricing.*unavailable/i);
      expect(runnerState.calls).toHaveLength(0);
    } finally {
      if (existing) await restoreHighLipSyncPrice(existing);
      else await deleteModelPrice(flatOnly.id);
    }
  });

  it("rejects High Quality with a portrait before funding", async () => {
    const tenant = await newTenant();
    const res = await request(app)
      .post("/api/ai/generate-video")
      .send({
        engine: "lip_sync",
        prompt: "Hello from the founder.",
        sourceImagePath: `/objects/${tenant.tenantId}/uploads/face.png`,
        lipSyncConsent: true,
        lipSyncQuality: "high",
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/needs a video source/i);
    expect(runnerState.calls).toHaveLength(0);
  });

  it("rejects unknown lip-sync quality values", async () => {
    const tenant = await newTenant();
    const res = await request(app)
      .post("/api/ai/generate-video")
      .send({ ...lipSyncBody(tenant.tenantId), lipSyncQuality: "ultra" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/lipSyncQuality/i);
    expect(runnerState.calls).toHaveLength(0);
  });
});

describe("single-speaker AI dialogue lip-sync videos", () => {
  async function setDialogueFeature(feature: string, enabled: boolean): Promise<void> {
    await db
      .insert(featureFlagsTable)
      .values({ feature, enabled })
      .onConflictDoUpdate({ target: featureFlagsTable.feature, set: { enabled } });
    invalidateFeatureFlagCache();
  }

  afterEach(async () => {
    await db
      .delete(featureFlagsTable)
      .where(inArray(featureFlagsTable.feature, ["videoGen", "lipSync", "brandVoiceClone"]));
    invalidateFeatureFlagCache();
  });

  const body = {
    engine: "dialogue_lip_sync",
    prompt: "A fictional friendly product expert speaking to camera in a bright studio",
    dialogue: "Welcome. Here is what our new product can do for your team.",
    voice: "nova",
    aiPersonConsent: true,
    durationSec: 8,
    reviewStoryboard: false,
  };

  async function seedDialogueKit(tenant: TestTenant, clonedVoice = false): Promise<number> {
    const kit = await createKit({
      tenantId: tenant.tenantId,
      plan: "pro",
      createdBy: tenant.clerkUserId,
      name: `Dialogue ${Date.now()}`,
    });
    const payload = structuredClone(kit!.activeVersion!.payload);
    if (clonedVoice) {
      payload.brand_voice = {
        ...payload.brand_voice,
        mode: "cloned",
        provider: "elevenlabs",
        provider_voice_id: "voice-dialogue",
      } as NonNullable<typeof payload.brand_voice>;
    }
    await addVersion({
      tenantId: tenant.tenantId,
      brandKitId: kit!.id,
      createdBy: tenant.clerkUserId,
      payload,
      sourceType: "manual",
      sourceNotes: "Dialogue test",
      approvalStatus: "approved",
      activate: true,
    });
    return kit!.id;
  }

  function savedCharacterBody(characterId: number, outfitId: number, brandKitId: number) {
    return {
      ...body,
      dialogue: "తెలుగు సంభాషణ. ఇది ఆమోదించబడిన పొడవైన స్క్రిప్ట్.",
      characterId,
      outfitId,
      brandKitId,
      characterDialogue: { scriptApproved: true, locale: "te" },
    };
  }

  it("requires explicit AI-person likeness consent before funding", async () => {
    await newTenant();
    const res = await request(app)
      .post("/api/ai/generate-video")
      .send({ ...body, aiPersonConsent: false });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/authorized|likeness/i);
    expect(runnerState.calls).toHaveLength(0);
  });

  it("gates the combined engine on video, lip-sync, and Brand Voice switches", async () => {
    for (const feature of ["videoGen", "lipSync", "brandVoiceClone"]) {
      await newTenant();
      await setDialogueFeature(feature, false);
      const res = await request(app).post("/api/ai/generate-video").send(body);
      expect(res.status, feature).toBe(403);
      expect(res.body.code, feature).toBe("feature_disabled");
      expect(runnerState.calls, feature).toHaveLength(0);
      await setDialogueFeature(feature, true);
    }
  });

  it("queues the dialogue and immutable consent snapshot with stock fallback", async () => {
    const tenant = await newTenant();
    const res = await request(app).post("/api/ai/generate-video").send(body);

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.engine).toBe("dialogue_lip_sync");
    expect(res.body.units).toBe(2);
    await waitForPendingJobs();
    expect(runnerState.calls).toEqual([{ jobId: res.body.id, funding: "quota" }]);

    const [row] = await db
      .select()
      .from(videoGenerationsTable)
      .where(eq(videoGenerationsTable.id, res.body.id));
    expect(row?.tenantId).toBe(tenant.tenantId);
    expect(row?.prompt).toBe(body.prompt);
    expect(row?.options).toMatchObject({
      dialogue: body.dialogue,
      voice: "nova",
      aiPersonConsent: true,
      brandKitId: null,
      reviewStoryboard: false,
      lipSyncQuality: "standard",
    });
  });

  it("freezes the selected High Quality model into a saved-character dialogue job", async () => {
    const restoreHighPrice = await installHighLipSyncTestPrice();
    try {
      const tenant = await newTenant();
      const character = await seedCharacter(tenant.tenantId);
      const brandKitId = await seedDialogueKit(tenant, true);
      const res = await request(app)
        .post("/api/ai/generate-video")
        .send({
          ...savedCharacterBody(character.characterId, character.outfitId, brandKitId),
          lipSyncQuality: "high",
        });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const [row] = await db
        .select()
        .from(videoGenerationsTable)
        .where(eq(videoGenerationsTable.id, res.body.id));
      expect(row?.options?.lipSyncQuality).toBe("high");
      expect(row?.options?.characterDialogue?.lipSyncModel).toBe("sync/lipsync-2");
    } finally {
      await restoreHighPrice();
    }
  });

  it("rejects dialogue that cannot fit the requested AI-person plate before funding", async () => {
    await newTenant();
    const res = await request(app).post("/api/ai/generate-video").send({
      ...body,
      dialogue: "One two three four five six seven eight nine ten eleven twelve.",
      durationSec: 3,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least.*seconds/i);
    expect(runnerState.calls).toHaveLength(0);
  });

  it("rejects a Brand Voice outside the tenant before funding", async () => {
    await newTenant();
    const res = await request(app)
      .post("/api/ai/generate-video")
      .send({ ...body, brandKitId: 2_147_000_000 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Brand Voice.*workspace/i);
    expect(runnerState.calls).toHaveLength(0);
  });

  it("rejects invalid saved-character dialogue dependencies before funding", async () => {
    const tenant = await newTenant();
    const own = await seedCharacter(tenant.tenantId);
    const foreignTenant = await newTenant();
    const foreign = await seedCharacter(foreignTenant.tenantId);
    actAs(tenant.clerkUserId);
    const kitWithoutClone = await seedDialogueKit(tenant);

    const cases = [
      [{ ...savedCharacterBody(own.characterId, own.outfitId, kitWithoutClone), characterDialogue: { scriptApproved: true, locale: "zz" } }, /unsupported locale/i],
      [{ ...savedCharacterBody(own.characterId, own.outfitId, kitWithoutClone), characterDialogue: { scriptApproved: false, locale: "te" } }, /approve the script/i],
      [savedCharacterBody(foreign.characterId, foreign.outfitId, kitWithoutClone), /character does not exist/i],
      [savedCharacterBody(own.characterId, foreign.outfitId, kitWithoutClone), /outfit does not exist/i],
      [{ ...savedCharacterBody(own.characterId, own.outfitId, kitWithoutClone), brandKitId: 2_147_000_000 }, /Brand Voice.*workspace/i],
      [savedCharacterBody(own.characterId, own.outfitId, kitWithoutClone), /cloned ElevenLabs voice/i],
    ] as const;
    for (const [input, error] of cases) {
      const res = await request(app).post("/api/ai/generate-video").send(input);
      expect(res.status, JSON.stringify(input)).toBe(400);
      expect(res.body.error, JSON.stringify(input)).toMatch(error);
    }
    expect(runnerState.calls).toHaveLength(0);
  });

  it("freezes the approved locale, character, effective outfit, Brand Voice, and exact scene plan", async () => {
    const tenant = await newTenant();
    const character = await seedCharacter(tenant.tenantId);
    const brandKitId = await seedDialogueKit(tenant, true);
    const res = await request(app).post("/api/ai/generate-video").send(
      savedCharacterBody(character.characterId, character.gymOutfitId, brandKitId),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.units).toBe(2);
    const row = (await db.select().from(videoGenerationsTable)
      .where(eq(videoGenerationsTable.id, res.body.id)))[0]!;
    expect(row.options?.characterDialogue).toMatchObject({
      locale: "te",
      modelId: "eleven_v3",
      direction: "ltr",
      fontCandidates: ["Noto Sans Telugu", "Noto Serif Telugu"],
      characterId: character.characterId,
      outfitId: character.gymOutfitId,
      brandKitId,
      scriptApproved: true,
    });
    expect(row.options?.characterDialogue?.scenes).toEqual([
      expect.objectContaining({
        text: "తెలుగు సంభాషణ. ఇది ఆమోదించబడిన పొడవైన స్క్రిప్ట్.",
        visualPrompt: expect.stringContaining(body.prompt),
      }),
    ]);
  });

  it("lets a saved character fill a presenter template and snapshots reviewable B-roll", async () => {
    const tenant = await newTenant();
    const character = await seedCharacter(tenant.tenantId);
    const brandKitId = await seedDialogueKit(tenant, true);
    const template = await seedPresenterTemplate();

    const res = await request(app).post("/api/ai/generate-video").send({
      ...savedCharacterBody(character.characterId, character.outfitId, brandKitId),
      styleProfileId: template.id,
      reviewStoryboard: false,
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.units).toBe(2);
    const row = await readJob(res.body.id);
    expect(row.options).toMatchObject({
      videoTemplateId: template.id,
      styleProfileId: template.id,
      presenterVideoPath: null,
      reviewStoryboard: true,
      presenterBroll: {
        version: 1,
        beats: [
          expect.objectContaining({
            id: "cdb1",
            query: expect.stringContaining("తెలుగు"),
            assetPath: null,
          }),
        ],
      },
    });
  });

  it("accepts Character Dialogue durations longer than 30 seconds", async () => {
    const tenant = await newTenant();
    const character = await seedCharacter(tenant.tenantId);
    const brandKitId = await seedDialogueKit(tenant, true);
    const res = await request(app).post("/api/ai/generate-video").send({
      ...savedCharacterBody(character.characterId, character.gymOutfitId, brandKitId),
      durationSec: 90,
    });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });

  it("retains approved character-dialogue whitespace byte-for-byte", async () => {
    const tenant = await newTenant();
    const character = await seedCharacter(tenant.tenantId);
    const brandKitId = await seedDialogueKit(tenant, true);
    const dialogue = " \nతెలుగు సంభాషణ.\n  రెండవ వాక్యం. \t";
    const response = await request(app).post("/api/ai/generate-video").send({
      ...savedCharacterBody(character.characterId, character.gymOutfitId, brandKitId),
      dialogue,
    });
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    const [row] = await db.select().from(videoGenerationsTable)
      .where(eq(videoGenerationsTable.id, response.body.id));
    expect(row?.options?.dialogue).toBe(dialogue);
    expect(row?.options?.characterDialogue?.scenes.map((scene) => scene.text).join("")).toBe(dialogue);
  });
});

describe("POST /api/ai/video-jobs/:jobId/retry", () => {
  it("separates a recovery attempt reservation from the full multiplied chain budget", () => {
    const options: VideoJobOptions = {
      aspectRatio: "9:16",
      shotCount: 2,
      modelId: "kling-3.0-pro",
      musicPrompt: "ambient score",
      recovery: {
        version: 1,
        chainId: 10,
        sourceJobId: 11,
        fundedUnits: 4,
        mode: "resume",
        state: "creating",
        reusable: ["first premium shot", "music"],
        regenerated: ["second premium shot"],
      },
    };

    expect(videoJobUnits("text_to_video", options)).toBe(4);
    expect(videoJobFullUnits("text_to_video", options)).toBe(9);
  });

  async function seedRecoveryDialogueKit(tenant: TestTenant): Promise<number> {
    const kit = await createKit({
      tenantId: tenant.tenantId,
      plan: "pro",
      createdBy: tenant.clerkUserId,
      name: `Recovery dialogue ${Date.now()}`,
    });
    const payload = structuredClone(kit!.activeVersion!.payload);
    payload.brand_voice = {
      ...payload.brand_voice,
      mode: "cloned",
      provider: "elevenlabs",
      provider_voice_id: "voice-recovery",
    } as NonNullable<typeof payload.brand_voice>;
    await addVersion({
      tenantId: tenant.tenantId,
      brandKitId: kit!.id,
      createdBy: tenant.clerkUserId,
      payload,
      sourceType: "manual",
      sourceNotes: "Recovery test",
      approvalStatus: "approved",
      activate: true,
    });
    return kit!.id;
  }

  function failedOptions(completedScenes = 0) {
    return {
      aspectRatio: "9:16" as const,
      dialogue: "First scene. Second scene.",
      aiPersonConsent: true,
      musicPath: null,
      musicPrompt: null,
      brandKitId: 1,
      characterDialogue: {
        version: 1 as const, scriptApproved: true as const, locale: "en",
        modelId: "eleven_v3" as const, direction: "ltr" as const,
        script: "Latin", scriptName: "Latin", fontCandidates: ["Noto Sans"],
        characterId: 1, outfitId: 2, brandKitId: 1,
        scenes: [0, 1].map((index) => ({
          id: `retry-${index}`, text: `Scene ${index}.`, visualPrompt: `Scene ${index}`,
          estimatedDurationSec: 4,
          ...(index < completedScenes ? {
            checkpoint: {
              narrationPath: `/objects/1/uploads/n-${index}.wav`, narrationDurationSec: 4,
              platePath: `/objects/1/uploads/p-${index}.mp4`,
              visualEvent: { provider: "replicate", model: "visual", durationSec: 4, requestBytes: 1, label: `character_plate:retry-${index}`, costPaise: 1, accounted: true },
              lipSyncPath: `/objects/1/uploads/l-${index}.mp4`,
              lipSyncEvent: { provider: "replicate", model: "latentsync", durationSec: 4, requestBytes: 1, label: `lip_sync:retry-${index}`, costPaise: 1, accounted: true },
            },
          } : {}),
        })),
      },
    };
  }

  async function seedFailed(tenant: TestTenant, completedScenes = 0) {
    const tenantId = tenant.tenantId;
    const character = await seedCharacter(tenantId);
    const brandKitId = await seedRecoveryDialogueKit(tenant);
    const options = failedOptions(completedScenes);
    options.brandKitId = brandKitId;
    options.characterDialogue.characterId = character.characterId;
    options.characterDialogue.outfitId = character.outfitId;
    options.characterDialogue.brandKitId = brandKitId;
    for (const scene of options.characterDialogue.scenes) {
      if (scene.checkpoint) {
        scene.checkpoint.narrationPath = scene.checkpoint.narrationPath!.replace("/objects/1/", `/objects/${tenantId}/`);
        scene.checkpoint.platePath = scene.checkpoint.platePath!.replace("/objects/1/", `/objects/${tenantId}/`);
        scene.checkpoint.lipSyncPath = scene.checkpoint.lipSyncPath!.replace("/objects/1/", `/objects/${tenantId}/`);
      }
    }
    return (await db.insert(videoGenerationsTable).values({
      tenantId, engine: "dialogue_lip_sync", status: "failed",
      prompt: "Saved character topic", options, funding: "credit", error: "Interrupted",
    }).returning())[0]!;
  }

  it("is tenant-scoped and accepts ordinary supported video engines", async () => {
    const owner = await newTenant();
    const source = await seedFailed(owner);
    const other = await newTenant();
    expect((await request(app).post(`/api/ai/video-jobs/${source.id}/retry`)).status).toBe(404);
    actAs(owner.clerkUserId);
    const ordinary = (await db.insert(videoGenerationsTable).values({
      tenantId: owner.tenantId, engine: "slideshow", status: "failed",
      options: { aspectRatio: "9:16" }, error: "failed",
    }).returning())[0]!;
    const recovered = await request(app).post(`/api/ai/video-jobs/${ordinary.id}/retry`);
    expect(recovered.status).toBe(201);
    expect(recovered.body.recovery).toMatchObject({
      mode: "saved_inputs",
      sourceJobId: ordinary.id,
    });
  });

  it("allows only one concurrent child and funds only missing operations", async () => {
    const tenant = await newTenant();
    const source = await seedFailed(tenant, 1);
    const replies = await Promise.all([
      request(app).post(`/api/ai/video-jobs/${source.id}/retry`),
      request(app).post(`/api/ai/video-jobs/${source.id}/retry`),
    ]);
    expect(replies.map((reply) => reply.status).sort()).toEqual([201, 409]);
    const created = replies.find((reply) => reply.status === 201)!;
    expect(created.body.units).toBe(2);
    const [child] = await db.select().from(videoGenerationsTable)
      .where(eq(videoGenerationsTable.id, created.body.id));
    expect(child?.options?.characterDialogue?.retry).toMatchObject({
      sourceJobId: source.id, fundedUnits: 2, state: "queued",
    });
  });

  it("creates a zero-unit compositor-only retry when all paid artifacts exist", async () => {
    const tenant = await newTenant();
    const source = await seedFailed(tenant, 2);
    const reply = await request(app).post(`/api/ai/video-jobs/${source.id}/retry`);
    expect(reply.status, JSON.stringify(reply.body)).toBe(201);
    expect(reply.body.units).toBe(0);
  });

  it("returns actionable codes for foreign and incomplete saved checkpoints", async () => {
    const tenant = await newTenant();
    const [foreign] = await db.insert(videoGenerationsTable).values({
      tenantId: tenant.tenantId,
      engine: "image_to_video",
      status: "failed",
      sourceImagePaths: [`/objects/${tenant.tenantId + 1}/uploads/foreign.png`],
      options: { aspectRatio: "9:16" },
      error: "Interrupted",
    }).returning();
    const foreignResponse = await request(app).post(`/api/ai/video-jobs/${foreign!.id}/retry`);
    expect(foreignResponse.status).toBe(410);
    expect(foreignResponse.body.code).toBe("recovery_asset_forbidden");

    const character = await seedCharacter(tenant.tenantId);
    const brandKitId = await seedRecoveryDialogueKit(tenant);
    const invalidOptions = failedOptions(0) as VideoJobOptions;
    invalidOptions.brandKitId = brandKitId;
    invalidOptions.characterDialogue!.characterId = character.characterId;
    invalidOptions.characterDialogue!.outfitId = character.outfitId;
    invalidOptions.characterDialogue!.brandKitId = brandKitId;
    invalidOptions.characterDialogue!.scenes[0]!.checkpoint = {
      platePath: `/objects/${tenant.tenantId}/uploads/plate-without-receipt.mp4`,
    };
    const [invalid] = await db.insert(videoGenerationsTable).values({
      tenantId: tenant.tenantId,
      engine: "dialogue_lip_sync",
      status: "failed",
      options: invalidOptions,
      error: "Interrupted",
    }).returning();
    const invalidResponse = await request(app).post(`/api/ai/video-jobs/${invalid!.id}/retry`);
    expect(invalidResponse.status).toBe(410);
    expect(invalidResponse.body.code).toBe("recovery_checkpoint_invalid");
  });

  it("does not deduct a paid receipt whose provider artifact never uploaded", async () => {
    const tenant = await newTenant("pro");
    const [source] = await db.insert(videoGenerationsTable).values({
      tenantId: tenant.tenantId,
      engine: "text_to_video",
      status: "failed",
      prompt: "Lost provider output",
      options: {
        aspectRatio: "9:16",
        renderCheckpoint: {
          stage: "provider_raw",
          path: "",
          provider: "replicate",
          model: "visual-model",
          durationSec: 5,
          providerEvents: [{
            eventId: "video-chain:lost:text_to_video:job:1",
            provider: "replicate",
            model: "visual-model",
            durationSec: 5,
            requestBytes: 20,
            label: "text_to_video",
            costPaise: 10,
          }],
        },
      },
      error: "Provider succeeded but checkpoint upload failed",
    }).returning();

    const response = await request(app).post(`/api/ai/video-jobs/${source!.id}/retry`);

    expect(response.status).toBe(201);
    expect(response.body.units).toBe(1);
    expect(response.body.recovery.regenerated).toContain("1 missing provider operation");
  });

  it("deep-copies the approved storyboard and all scene checkpoints into the child", async () => {
    const tenant = await newTenant("pro");
    const storyboard: VideoStoryboard = {
      version: 1,
      visualsSource: "prompt",
      timelineLocked: false,
      durationBounds: { minSec: 1, maxSec: 10 },
      model: "planner",
      provider: "builtin",
      regenerations: 0,
      narration: {
        audioPath: `/objects/${tenant.tenantId}/uploads/narration.wav`,
        totalDurationSec: 8,
        cues: [{ text: "One", startSec: 0, endSec: 4 }],
      },
      scenes: [
        {
          id: "s1",
          text: "One",
          visual: "Completed scene",
          durationSec: 4,
          previewPath: `/objects/${tenant.tenantId}/uploads/s1.png`,
          outfitId: null,
          providerCheckpoint: {
            path: `/objects/${tenant.tenantId}/uploads/s1.mp4`,
            provider: "replicate",
            model: "visual-model",
            durationSec: 4,
            event: {
              eventId: "video-chain:board:scene:s1:job:1",
              provider: "replicate",
              model: "visual-model",
              durationSec: 4,
              requestBytes: 10,
              label: "storyboard_scene:s1",
              costPaise: 10,
            },
          },
        },
        {
          id: "s2",
          text: "Two",
          visual: "Missing scene",
          durationSec: 4,
          previewPath: `/objects/${tenant.tenantId}/uploads/s2.png`,
          outfitId: null,
        },
      ],
    };
    const [source] = await db.insert(videoGenerationsTable).values({
      tenantId: tenant.tenantId,
      engine: "text_to_video",
      status: "failed",
      prompt: "Two approved shots",
      options: { aspectRatio: "9:16", shotCount: 2, reviewStoryboard: true },
      storyboard,
      error: "Second scene failed",
    }).returning();
    const immutableSnapshot = structuredClone(storyboard);

    const response = await request(app).post(`/api/ai/video-jobs/${source!.id}/retry`);

    expect(response.status).toBe(201);
    expect(response.body.units).toBe(1);
    const [sourceAfter, child] = await Promise.all([
      db.select().from(videoGenerationsTable).where(eq(videoGenerationsTable.id, source!.id)),
      db.select().from(videoGenerationsTable).where(eq(videoGenerationsTable.id, response.body.id)),
    ]);
    expect(sourceAfter[0]?.storyboard).toEqual(immutableSnapshot);
    expect(child[0]?.storyboard).toEqual(immutableSnapshot);
    expect(child[0]?.storyboard).not.toBe(sourceAfter[0]?.storyboard);
  });

  it.each([
    ["quota", "pro"],
    ["credit", "payg"],
    ["wallet", "payg"],
  ] as const)(
    "rebuilds the full baseline on a second recovery hop using the %s rail",
    async (expectedFunding, plan) => {
      const tenant = await newTenant(plan);
      if (expectedFunding === "credit") {
        await grantCredits({
          tenantId: tenant.tenantId,
          captionCredits: 0,
          imageCredits: 0,
          videoCredits: 1,
          kind: "admin_grant",
          note: "two-hop recovery",
        });
      } else if (expectedFunding === "wallet") {
        await db.insert(featureFlagsTable).values({ feature: "wallet", enabled: true })
          .onConflictDoUpdate({
            target: featureFlagsTable.feature,
            set: { enabled: true, updatedAt: new Date() },
          });
        invalidateFeatureFlagCache();
        await db.update(tenantsTable)
          .set({ billingMode: "wallet" })
          .where(eq(tenantsTable.id, tenant.tenantId));
        await db.insert(walletBalancesTable)
          .values({ tenantId: tenant.tenantId, balancePaise: 100_000_000 });
      }
      const [failedChild] = await db.insert(videoGenerationsTable).values({
        tenantId: tenant.tenantId,
        engine: "text_to_video",
        status: "failed",
        prompt: "Two-hop partial render",
        funding: expectedFunding,
        options: {
          aspectRatio: "9:16",
          shotCount: 2,
          reviewStoryboard: true,
          recovery: {
            version: 1,
            chainId: 700,
            sourceJobId: 700,
            fundedUnits: 1,
            mode: "resume",
            state: "creating",
            reusable: ["scene s1"],
            regenerated: ["scene s2"],
          },
        },
        storyboard: {
          version: 1,
          visualsSource: "prompt",
          timelineLocked: false,
          durationBounds: { minSec: 1, maxSec: 10 },
          model: null,
          provider: null,
          regenerations: 0,
          narration: null,
          scenes: [
            {
              id: "s1",
              text: "",
              visual: "complete",
              durationSec: 4,
              previewPath: null,
              outfitId: null,
              providerCheckpoint: {
                path: `/objects/${tenant.tenantId}/uploads/s1.mp4`,
                provider: "replicate",
                model: "visual-model",
                durationSec: 4,
                event: {
                  eventId: "video-chain:700:storyboard_scene:s1:job:700",
                  provider: "replicate",
                  model: "visual-model",
                  durationSec: 4,
                  requestBytes: 10,
                  label: "storyboard_scene:s1",
                  costPaise: 10,
                  accounted: true,
                },
              },
            },
            {
              id: "s2",
              text: "",
              visual: "missing",
              durationSec: 4,
              previewPath: null,
              outfitId: null,
            },
          ],
        },
        error: "Failed before generating scene s2",
      }).returning();

      const response = await request(app).post(`/api/ai/video-jobs/${failedChild!.id}/retry`);

      expect(response.status, JSON.stringify(response.body)).toBe(201);
      expect(response.body.units).toBe(1);
      const [secondChild] = await db.select().from(videoGenerationsTable)
        .where(eq(videoGenerationsTable.id, response.body.id));
      expect(secondChild?.funding).toBe(expectedFunding);
      expect(secondChild?.options?.recovery).toMatchObject({
        chainId: 700,
        sourceJobId: failedChild!.id,
        fundedUnits: 1,
      });
      if (expectedFunding === "credit") {
        expect((await getCreditBalances(tenant.tenantId)).videoCredits).toBe(0);
      } else if (expectedFunding === "wallet") {
        expect(secondChild?.walletReservedUnits).toBe(1);
        await db.delete(featureFlagsTable).where(eq(featureFlagsTable.feature, "wallet"));
        invalidateFeatureFlagCache();
      }
    },
  );

  it.each([
    ["topic video", "topic_to_video", { prompt: "Saved topic" }],
    ["character story", "topic_to_video", { prompt: "Saved story", visualsSource: "character" }],
    ["presenter B-roll", "topic_to_video", {
      prompt: "Saved presenter script",
      presenterVideoPath: null,
      presenterBroll: {
        version: 1,
        durationMs: 1000,
        lines: [],
        beats: [],
        notes: [],
      },
    }],
    ["text-to-video", "text_to_video", { prompt: "Saved clip" }],
    ["image-to-video", "image_to_video", { prompt: "Saved motion" }],
    ["slideshow", "slideshow", {}],
    ["ordinary lip-sync", "lip_sync", { prompt: "Saved script", lipSyncConsent: true }],
  ] as const)(
    "copies immutable saved inputs for %s into a linked child",
    async (_label, engine, extra) => {
      const tenant = await newTenant("pro");
      const options: VideoJobOptions = structuredClone({
        aspectRatio: "9:16" as const,
        ...extra,
      }) as VideoJobOptions;
      const [source] = await db.insert(videoGenerationsTable).values({
        tenantId: tenant.tenantId,
        engine,
        status: "failed",
        prompt: "Original prompt",
        sourceImagePaths: [],
        options,
        error: "Interrupted",
      }).returning();
      const before = structuredClone(source!.options);

      const response = await request(app).post(`/api/ai/video-jobs/${source!.id}/retry`);

      expect(response.status, JSON.stringify(response.body)).toBe(201);
      const [unchanged, child] = await Promise.all([
        db.select().from(videoGenerationsTable).where(eq(videoGenerationsTable.id, source!.id)),
        db.select().from(videoGenerationsTable).where(eq(videoGenerationsTable.id, response.body.id)),
      ]);
      expect(unchanged[0]?.options).toEqual(before);
      expect(child[0]?.prompt).toBe(source!.prompt);
      expect(child[0]?.options).toMatchObject(options);
      expect(child[0]?.options?.recovery).toMatchObject({
        chainId: source!.id,
        sourceJobId: source!.id,
        state: "queued",
      });
    },
  );
});

describe("localized_dub videos", () => {
  async function setLocalizationFlag(enabled: boolean): Promise<void> {
    await db
      .insert(featureFlagsTable)
      .values({ feature: "videoLocalization", enabled })
      .onConflictDoUpdate({ target: featureFlagsTable.feature, set: { enabled } });
    invalidateFeatureFlagCache();
  }
  async function setBrandVoiceFlag(enabled: boolean): Promise<void> {
    await db
      .insert(featureFlagsTable)
      .values({ feature: "brandVoiceClone", enabled })
      .onConflictDoUpdate({ target: featureFlagsTable.feature, set: { enabled } });
    invalidateFeatureFlagCache();
  }
  afterEach(async () => {
    await db
      .delete(featureFlagsTable)
      .where(inArray(featureFlagsTable.feature, ["videoLocalization", "brandVoiceClone"]));
    invalidateFeatureFlagCache();
  });

  function dubBody(tenantId: number) {
    return {
      engine: "localized_dub",
      sourceVideoPath: `/objects/${tenantId}/uploads/source.mp4`,
      lipSyncConsent: true,
      localizedTrack: {
        scriptApproved: true,
        locale: "te",
        voice: "nova",
        cues: [
          { index: 1, startMs: 0, endMs: 2000, text: "నమస్కారం, ఇది ఒక పరీక్ష." },
          { index: 2, startMs: 2500, endMs: 5000, text: "మళ్ళీ కలుద్దాం." },
        ],
      },
    };
  }

  it("is refused with 403 while the videoLocalization kill switch is off, before funding", async () => {
    const tenant = await newTenant();
    await setLocalizationFlag(false);
    const res = await request(app)
      .post("/api/ai/generate-video")
      .send(dubBody(tenant.tenantId));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("feature_disabled");
    expect(runnerState.calls).toHaveLength(0);
  });

  it("rejects when sourceVideoPath is missing, before funding", async () => {
    const tenant = await newTenant();
    const res = await request(app)
      .post("/api/ai/generate-video")
      .send({ ...dubBody(tenant.tenantId), sourceVideoPath: null });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/source video/i);
    expect(runnerState.calls).toHaveLength(0);
  });

  it("rejects when localizedTrack is missing, before funding", async () => {
    const tenant = await newTenant();
    const res = await request(app)
      .post("/api/ai/generate-video")
      .send({ ...dubBody(tenant.tenantId), localizedTrack: undefined });
    expect(res.status).toBe(400);
    expect(runnerState.calls).toHaveLength(0);
  });

  it("rejects missing likeness consent before funding", async () => {
    const tenant = await newTenant();
    const res = await request(app)
      .post("/api/ai/generate-video")
      .send({ ...dubBody(tenant.tenantId), lipSyncConsent: false });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/permission/i);
    expect(runnerState.calls).toHaveLength(0);
  });

  it("requires a brand kit when brand-voice dubbing is selected", async () => {
    const tenant = await newTenant();
    const body = dubBody(tenant.tenantId);
    const res = await request(app)
      .post("/api/ai/generate-video")
      .send({
        ...body,
        localizedTrack: {
          ...body.localizedTrack,
          voice: undefined,
          voiceMode: "brand_voice",
        },
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/brand kit/i);
    expect(runnerState.calls).toHaveLength(0);
  });

  it("accepts source-speaker dubbing only when ElevenLabs is configured", async () => {
    const tenant = await newTenant();
    const body = dubBody(tenant.tenantId);
    const originalKey = process.env.ELEVENLABS_API_KEY;
    process.env.ELEVENLABS_API_KEY = "test-elevenlabs-key";
    let res;
    try {
      res = await request(app)
        .post("/api/ai/generate-video")
        .send({
          ...body,
          localizedTrack: {
            ...body.localizedTrack,
            voice: undefined,
            voiceMode: "source_voice",
          },
        });
    } finally {
      if (originalKey === undefined) delete process.env.ELEVENLABS_API_KEY;
      else process.env.ELEVENLABS_API_KEY = originalKey;
    }
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const row = (
      await db
        .select()
        .from(videoGenerationsTable)
        .where(eq(videoGenerationsTable.id, res.body.id))
    )[0];
    expect(row?.options?.localizedTrack).toMatchObject({
      locale: "te",
      voiceMode: "source_voice",
      lipSyncConsent: true,
    });
    expect(row?.options?.localizedTrack?.provider).toBeUndefined();
  });

  it("blocks source-speaker dubbing before funding when voice cloning is off", async () => {
    const tenant = await newTenant();
    const body = dubBody(tenant.tenantId);
    await setBrandVoiceFlag(false);

    const res = await request(app)
      .post("/api/ai/generate-video")
      .send({
        ...body,
        localizedTrack: {
          ...body.localizedTrack,
          voice: undefined,
          voiceMode: "source_voice",
        },
      });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("feature_disabled");
    expect(runnerState.calls).toHaveLength(0);
  });

  it("rejects when scriptApproved is false — a hard gate before funding", async () => {
    const tenant = await newTenant();
    const body = {
      ...dubBody(tenant.tenantId),
      localizedTrack: { ...dubBody(tenant.tenantId).localizedTrack, scriptApproved: false },
    };
    const res = await request(app)
      .post("/api/ai/generate-video")
      .send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/approve/i);
    expect(runnerState.calls).toHaveLength(0);
  });

  it("rejects a sourceVideoPath outside the caller's tenant namespace", async () => {
    const tenant = await newTenant();
    const res = await request(app)
      .post("/api/ai/generate-video")
      .send({
        ...dubBody(tenant.tenantId),
        sourceVideoPath: `/objects/${tenant.tenantId + 1}/uploads/stolen.mp4`,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/base video path/i);
    expect(runnerState.calls).toHaveLength(0);
  });

  it("rejects a whitespace-only cue text before funding", async () => {
    const tenant = await newTenant();
    const body = {
      ...dubBody(tenant.tenantId),
      localizedTrack: {
        ...dubBody(tenant.tenantId).localizedTrack,
        cues: [{ index: 1, startMs: 0, endMs: 2000, text: "   " }],
      },
    };
    const res = await request(app)
      .post("/api/ai/generate-video")
      .send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/blank/i);
    expect(runnerState.calls).toHaveLength(0);
  });

  it("rejects overlapping cues before funding", async () => {
    const tenant = await newTenant();
    const body = {
      ...dubBody(tenant.tenantId),
      localizedTrack: {
        ...dubBody(tenant.tenantId).localizedTrack,
        cues: [
          { index: 1, startMs: 0, endMs: 2000, text: "First." },
          { index: 2, startMs: 1500, endMs: 3000, text: "Overlaps first." },
        ],
      },
    };
    const res = await request(app)
      .post("/api/ai/generate-video")
      .send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/overlaps/i);
    expect(runnerState.calls).toHaveLength(0);
  });

  it("rejects a cue with endMs not greater than startMs, before funding", async () => {
    const tenant = await newTenant();
    const body = {
      ...dubBody(tenant.tenantId),
      localizedTrack: {
        ...dubBody(tenant.tenantId).localizedTrack,
        cues: [{ index: 1, startMs: 1000, endMs: 1000, text: "Bad timing." }],
      },
    };
    const res = await request(app)
      .post("/api/ai/generate-video")
      .send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/endMs must be greater/i);
    expect(runnerState.calls).toHaveLength(0);
  });

  it("rejects fractional cue timing before funding", async () => {
    const tenant = await newTenant();
    const body = {
      ...dubBody(tenant.tenantId),
      localizedTrack: {
        ...dubBody(tenant.tenantId).localizedTrack,
        cues: [{ index: 1, startMs: 0.5, endMs: 2000, text: "Bad timing." }],
      },
    };
    const res = await request(app).post("/api/ai/generate-video").send(body);
    expect(res.status).toBe(400);
    expect(runnerState.calls).toHaveLength(0);
  });

  it("rejects cue timing beyond the 30-minute render limit before funding", async () => {
    const tenant = await newTenant();
    const body = {
      ...dubBody(tenant.tenantId),
      localizedTrack: {
        ...dubBody(tenant.tenantId).localizedTrack,
        cues: [
          {
            index: 1,
            startMs: 0,
            endMs: 30 * 60 * 1000 + 1,
            text: "Too long.",
          },
        ],
      },
    };
    const res = await request(app).post("/api/ai/generate-video").send(body);
    expect(res.status).toBe(400);
    expect(runnerState.calls).toHaveLength(0);
  });

  it("creates a queued job, enqueues the runner, and persists the full localized track in options", async () => {
    const tenant = await newTenant();
    const res = await request(app)
      .post("/api/ai/generate-video")
      .send(dubBody(tenant.tenantId));

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.engine).toBe("localized_dub");

    await waitForPendingJobs();
    expect(runnerState.calls).toEqual([{ jobId: res.body.id, funding: "quota" }]);

    const row = (
      await db
        .select()
        .from(videoGenerationsTable)
        .where(eq(videoGenerationsTable.id, res.body.id))
    )[0];
    expect(row?.options?.sourceVideoPath).toBe(`/objects/${tenant.tenantId}/uploads/source.mp4`);
    expect(row?.options?.localizedTrack?.scriptApproved).toBe(true);
    expect(row?.options?.localizedTrack?.lipSyncConsent).toBe(true);
    expect(row?.options?.localizedTrack?.locale).toBe("te");
    expect(row?.options?.localizedTrack?.provider).toBe("openai");
    expect(row?.options?.localizedTrack?.model).toBe("gpt-audio");
    expect(row?.options?.localizedTrack?.speaker).toBe("nova");
    expect(row?.options?.localizedTrack?.voice).toBe("nova");
    expect(row?.options?.localizedTrack?.cues).toHaveLength(2);
    expect(row?.options?.localizedTrack?.cues[0]?.text).toBe("నమస్కారం, ఇది ఒక పరీక్ష.");
    // reviewStoryboard must be false — localized_dub never goes through storyboard review.
    expect(row?.options?.reviewStoryboard).toBe(false);
  });

  it("accepts Sarvam bulbul:v3 and snapshots its provider, model, locale, and speaker", async () => {
    const tenant = await newTenant();
    const legacy = dubBody(tenant.tenantId);
    const originalSarvamKey = process.env.SARVAM_API_KEY;
    process.env.SARVAM_API_KEY = "test-sarvam-key";
    let res;
    try {
      res = await request(app)
        .post("/api/ai/generate-video")
        .send({
          ...legacy,
          localizedTrack: {
            ...legacy.localizedTrack,
            voice: undefined,
            provider: "sarvam",
            model: "bulbul:v3",
            speaker: "priya",
          },
        });
    } finally {
      if (originalSarvamKey === undefined) delete process.env.SARVAM_API_KEY;
      else process.env.SARVAM_API_KEY = originalSarvamKey;
    }

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const row = (
      await db
        .select()
        .from(videoGenerationsTable)
        .where(eq(videoGenerationsTable.id, res.body.id))
    )[0];
    expect(row?.options?.localizedTrack).toMatchObject({
      locale: "te",
      provider: "sarvam",
      model: "bulbul:v3",
      speaker: "priya",
    });
    expect(row?.options?.localizedTrack?.voice).toBeUndefined();
  });

  it.each([
    [{ provider: "sarvam", model: "gpt-audio", speaker: "priya" }, /bulbul:v3/i],
    [{ provider: "sarvam", model: "bulbul:v3", speaker: "not-a-speaker" }, /speaker/i],
    [{ provider: "openai", model: "bulbul:v3", speaker: "nova" }, /gpt-audio/i],
  ])("rejects an invalid provider-aware narration combination before funding", async (selection, message) => {
    const tenant = await newTenant();
    const legacy = dubBody(tenant.tenantId);
    const res = await request(app)
      .post("/api/ai/generate-video")
      .send({
        ...legacy,
        localizedTrack: {
          ...legacy.localizedTrack,
          voice: undefined,
          ...selection,
        },
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(message);
    expect(runnerState.calls).toHaveLength(0);
  });

  it("charges exactly one video unit through the existing quota funding rail", async () => {
    const tenant = await newTenant();
    const res = await request(app)
      .post("/api/ai/generate-video")
      .send(dubBody(tenant.tenantId));
    expect(res.status).toBe(201);
    await waitForPendingJobs();
    // Exactly one runner call with quota funding — the same rail as every
    // other single-unit engine (slideshow, lip_sync, image_to_video, etc.).
    expect(runnerState.calls).toHaveLength(1);
    expect(runnerState.calls[0]).toEqual({ jobId: res.body.id, funding: "quota" });

    // Confirm the row's funding column matches.
    const row = (
      await db
        .select()
        .from(videoGenerationsTable)
        .where(eq(videoGenerationsTable.id, res.body.id))
    )[0];
    expect(row?.funding).toBe("quota");
  });
});

describe("GET /api/ai/video-jobs", () => {
  it("lists only the caller's jobs and 404s on cross-tenant reads", async () => {
    const other = await newTenant();
    const otherJob = (
      await db
        .insert(videoGenerationsTable)
        .values({ tenantId: other.tenantId, engine: "slideshow", status: "succeeded" })
        .returning()
    )[0]!;

    const mine = await newTenant();
    const mineJob = (
      await db
        .insert(videoGenerationsTable)
        .values({ tenantId: mine.tenantId, engine: "text_to_video", status: "queued" })
        .returning()
    )[0]!;

    const list = await request(app).get("/api/ai/video-jobs");
    expect(list.status).toBe(200);
    const ids = list.body.map((j: { id: number }) => j.id);
    expect(ids).toContain(mineJob.id);
    expect(ids).not.toContain(otherJob.id);

    const crossRead = await request(app).get(`/api/ai/video-jobs/${otherJob.id}`);
    expect(crossRead.status).toBe(404);
  });
});

/**
 * Storyboard review. Every mutation is a status-guarded UPDATE, so these tests
 * lean hardest on the two things that cost money or cannot be undone: that a
 * plan can only be claimed once, and that a discard refunds exactly once.
 */
function storyboardFixture(tenantId: number, sceneCount = 2): VideoStoryboard {
  return {
    version: 1,
    visualsSource: "character",
    timelineLocked: true,
    model: "kwaivgi/kling-v1.6-standard",
    provider: "replicate",
    regenerations: 0,
    narration: {
      audioPath: `/objects/${tenantId}/uploads/narration.wav`,
      totalDurationSec: 6 * sceneCount,
      cues: Array.from({ length: sceneCount }, (_, i) => ({
        text: `Line ${i + 1}`,
        startSec: i * 6,
        endSec: (i + 1) * 6,
      })),
    },
    scenes: Array.from({ length: sceneCount }, (_, i) => ({
      id: `s${i + 1}`,
      text: `Line ${i + 1}`,
      visual: `wide shot ${i + 1}`,
      durationSec: 6,
      previewPath: `/objects/${tenantId}/uploads/shot-${i + 1}.png`,
      outfitId: null,
    })),
  };
}

/**
 * A plan from one of the three engines that voice nothing. No narration is what
 * frees the timeline, so lengths are editable and bounded per plan kind.
 */
function clipBoardFixture(
  tenantId: number,
  visualsSource: VideoStoryboard["visualsSource"],
  sceneCount = 2,
): VideoStoryboard {
  const bounds =
    visualsSource === "slide" ? { minSec: 1, maxSec: 10 } : { minSec: 3, maxSec: 10 };
  return {
    version: 1,
    visualsSource,
    timelineLocked: false,
    durationBounds: bounds,
    model: null,
    provider: null,
    regenerations: 0,
    narration: null,
    scenes: Array.from({ length: sceneCount }, (_, i) => ({
      id: `s${i + 1}`,
      text: "",
      visual: visualsSource === "slide" ? `caption ${i + 1}` : `shot ${i + 1}`,
      durationSec: 4,
      previewPath: visualsSource === "prompt" ? null : `/objects/${tenantId}/uploads/p${i + 1}.png`,
      outfitId: null,
    })),
  };
}

async function seedPausedJob(
  tenantId: number,
  overrides: Partial<typeof videoGenerationsTable.$inferInsert> = {},
  storyboard: VideoStoryboard = storyboardFixture(tenantId),
) {
  return (
    await db
      .insert(videoGenerationsTable)
      .values({
        tenantId,
        engine: "topic_to_video",
        status: "awaiting_review",
        funding: "quota",
        options: { aspectRatio: "9:16", visualsSource: "character", paragraphCount: 1 },
        storyboard,
        storyboardExpiresAt: new Date(Date.now() + 60_000),
        ...overrides,
      })
      .returning()
  )[0]!;
}

async function readJob(id: number) {
  return (
    await db.select().from(videoGenerationsTable).where(eq(videoGenerationsTable.id, id)).limit(1)
  )[0]!;
}

describe("PATCH /api/ai/video-jobs/:jobId/storyboard", () => {
  it("rewrites the edited scene's prompt and leaves the others untouched", async () => {
    const tenant = await newTenant();
    const job = await seedPausedJob(tenant.tenantId);

    const res = await request(app)
      .patch(`/api/ai/video-jobs/${job.id}/storyboard`)
      .send({ scenes: [{ id: "s2", visual: "  close up on her hands  " }] });
    expect(res.status).toBe(200);
    expect(res.body.storyboard.scenes[0].visual).toBe("wide shot 1");
    expect(res.body.storyboard.scenes[1].visual).toBe("close up on her hands");
    // Editing a prompt does not touch its still — the redraw button does that.
    expect(res.body.storyboard.scenes[1].previewPath).toBe(
      `/objects/${tenant.tenantId}/uploads/shot-2.png`,
    );
    expect((await readJob(job.id)).storyboard?.scenes[1]?.visual).toBe("close up on her hands");
  });

  it("locks approved Character Dialogue text but saves its visual and B-roll directions", async () => {
    const tenant = await newTenant();
    const board: VideoStoryboard = {
      ...clipBoardFixture(tenant.tenantId, "character", 1),
      mode: "character_dialogue",
      timelineLocked: true,
      durationBounds: null,
      scenes: [
        {
          id: "cd1",
          text: "Approved dialogue stays exact.",
          visual: "front-facing presenter",
          brollVisual: "weekly planning desk",
          durationSec: 4,
          previewPath: null,
          outfitId: 7,
        },
      ],
    };
    const job = await seedPausedJob(
      tenant.tenantId,
      {
        engine: "dialogue_lip_sync",
        options: {
          aspectRatio: "9:16",
          aiPersonConsent: true,
          characterDialogue: {
            version: 1,
            scriptApproved: true,
            locale: "en",
            modelId: "eleven_v3",
            direction: "ltr",
            script: "Approved dialogue stays exact.",
            fontCandidates: ["Inter"],
            scriptName: "English",
            characterId: 6,
            outfitId: 7,
            brandKitId: 8,
            scenes: [
              {
                id: "cd1",
                text: "Approved dialogue stays exact.",
                visualPrompt: "front-facing presenter",
                estimatedDurationSec: 4,
              },
            ],
          },
        },
      },
      board,
    );

    const rejected = await request(app)
      .patch(`/api/ai/video-jobs/${job.id}/storyboard`)
      .send({ scenes: [{ id: "cd1", text: "Changed dialogue" }] });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toMatch(/cannot be changed/i);

    const saved = await request(app)
      .patch(`/api/ai/video-jobs/${job.id}/storyboard`)
      .send({
        scenes: [
          {
            id: "cd1",
            visual: "tight frontal close-up",
            brollVisual: "launch metrics on a laptop",
          },
        ],
      });
    expect(saved.status).toBe(200);
    expect(saved.body.storyboard.scenes[0]).toMatchObject({
      text: "Approved dialogue stays exact.",
      visual: "tight frontal close-up",
      brollVisual: "launch metrics on a laptop",
    });

    const redraw = await request(app).post(
      `/api/ai/video-jobs/${job.id}/storyboard/scenes/cd1/preview`,
    );
    expect(redraw.status).toBe(400);
    expect(runnerState.previews).toHaveLength(0);
  });

  it("rejects an edit naming a scene that is not in the plan", async () => {
    const tenant = await newTenant();
    const job = await seedPausedJob(tenant.tenantId);
    const res = await request(app)
      .patch(`/api/ai/video-jobs/${job.id}/storyboard`)
      .send({ scenes: [{ id: "s9", visual: "a scene that does not exist" }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not in this storyboard/i);
    expect((await readJob(job.id)).storyboard?.scenes[0]?.visual).toBe("wide shot 1");
  });

  it("refuses a length edit while the timeline is locked to the narration", async () => {
    const tenant = await newTenant();
    const job = await seedPausedJob(tenant.tenantId);
    const res = await request(app)
      .patch(`/api/ai/video-jobs/${job.id}/storyboard`)
      .send({ scenes: [{ id: "s1", durationSec: 10 }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/narration timing/i);
    expect((await readJob(job.id)).storyboard?.scenes[0]?.durationSec).toBe(6);
  });

  it("clamps an edited length into what the plan can actually deliver", async () => {
    // Rejecting an in-contract length would mean losing the edit; a client that
    // asks for the schema's 20s ceiling meant "the longest you can do", and what
    // a slideshow can do is 10.
    const tenant = await newTenant();
    const job = await seedPausedJob(
      tenant.tenantId,
      { engine: "slideshow" },
      clipBoardFixture(tenant.tenantId, "slide"),
    );
    const res = await request(app)
      .patch(`/api/ai/video-jobs/${job.id}/storyboard`)
      .send({
        scenes: [
          { id: "s1", durationSec: 20 },
          { id: "s2", durationSec: 1 },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.storyboard.scenes.map((s: { durationSec: number }) => s.durationSec)).toEqual([
      10, 1,
    ]);

    // A clip cannot read as motion under three seconds, so that plan floors higher.
    const clip = await seedPausedJob(
      tenant.tenantId,
      { engine: "text_to_video" },
      clipBoardFixture(tenant.tenantId, "prompt"),
    );
    const clipRes = await request(app)
      .patch(`/api/ai/video-jobs/${clip.id}/storyboard`)
      .send({ scenes: [{ id: "s1", durationSec: 1 }] });
    expect(clipRes.status).toBe(200);
    expect(clipRes.body.storyboard.scenes[0].durationSec).toBe(3);
  });

  it("clears an emptied slide caption but leaves an emptied prompt alone", async () => {
    // On a slideshow the visual is text burned over the photo, so removing it is
    // a real edit. Everywhere else it is the generation prompt, and a scene with
    // no prompt has nothing to generate.
    const tenant = await newTenant();
    const slides = await seedPausedJob(
      tenant.tenantId,
      { engine: "slideshow" },
      clipBoardFixture(tenant.tenantId, "slide"),
    );
    const cleared = await request(app)
      .patch(`/api/ai/video-jobs/${slides.id}/storyboard`)
      .send({ scenes: [{ id: "s1", visual: "   " }] });
    expect(cleared.status).toBe(200);
    expect(cleared.body.storyboard.scenes[0].visual).toBe("");
    expect((await readJob(slides.id)).storyboard?.scenes[0]?.visual).toBe("");

    const clip = await seedPausedJob(
      tenant.tenantId,
      { engine: "text_to_video" },
      clipBoardFixture(tenant.tenantId, "prompt"),
    );
    const kept = await request(app)
      .patch(`/api/ai/video-jobs/${clip.id}/storyboard`)
      .send({ scenes: [{ id: "s1", visual: "   " }] });
    expect(kept.status).toBe(200);
    expect(kept.body.storyboard.scenes[0].visual).toBe("shot 1");
  });

  it("400s on a job that is not paused for review", async () => {
    const tenant = await newTenant();
    const job = await seedPausedJob(tenant.tenantId, { status: "processing" });
    const res = await request(app)
      .patch(`/api/ai/video-jobs/${job.id}/storyboard`)
      .send({ scenes: [{ id: "s1", visual: "nope" }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not waiting for storyboard review/i);
  });

  it("404s on another tenant's storyboard", async () => {
    const other = await newTenant();
    const job = await seedPausedJob(other.tenantId);
    await newTenant();
    const res = await request(app)
      .patch(`/api/ai/video-jobs/${job.id}/storyboard`)
      .send({ scenes: [{ id: "s1", visual: "not mine" }] });
    expect(res.status).toBe(404);
  });

  it("rewrites a narrated scene's text and never blanks it", async () => {
    const tenant = await newTenant();
    const job = await seedPausedJob(tenant.tenantId);
    const res = await request(app)
      .patch(`/api/ai/video-jobs/${job.id}/storyboard`)
      .send({ scenes: [{ id: "s1", text: "A brand new opening line." }, { id: "s2", text: "   " }] });
    expect(res.status).toBe(200);
    expect(res.body.storyboard.scenes[0].text).toBe("A brand new opening line.");
    // Blank leaves the narration alone: a scene with no words has no length.
    expect(res.body.storyboard.scenes[1].text).toBe("Line 2");
  });

  it("accepts Character Story script edits before narration is generated", async () => {
    const tenant = await newTenant();
    const board = storyboardFixture(tenant.tenantId);
    board.mode = "character_story";
    board.timelineLocked = false;
    board.narration = null;
    board.scenes = board.scenes.map((scene) => ({ ...scene, previewPath: null }));
    const job = await seedPausedJob(tenant.tenantId, {}, board);

    const res = await request(app)
      .patch(`/api/ai/video-jobs/${job.id}/storyboard`)
      .send({ scenes: [{ id: "s1", text: "Use this approved opening instead." }] });

    expect(res.status).toBe(200);
    expect(res.body.storyboard.scenes[0].text).toBe("Use this approved opening instead.");
    expect((await readJob(job.id)).storyboard?.narration).toBeNull();
  });

  it("rejects text edits on a plan that voices no script", async () => {
    const tenant = await newTenant();
    const clip = await seedPausedJob(
      tenant.tenantId,
      { engine: "text_to_video", options: { aspectRatio: "9:16", shotCount: 2 } },
      clipBoardFixture(tenant.tenantId, "prompt"),
    );
    const res = await request(app)
      .patch(`/api/ai/video-jobs/${clip.id}/storyboard`)
      .send({ scenes: [{ id: "s1", text: "invented narration" }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no narration/i);
  });
});

describe("animate-photo aiPrompt transparency", () => {
  const suffix = (sec: number) =>
    `\n\nTarget clip length: about ${sec} seconds of continuous action, paced to fill the full duration.`;

  it("mirrors the exact provider prompt for a direct job and a storyboard job", async () => {
    const tenant = await newTenant();
    // (a) Direct job (no storyboard): user prompt + options duration.
    const direct = await seedPausedJob(tenant.tenantId, {
      engine: "image_to_video",
      status: "processing",
      storyboard: null,
      storyboardExpiresAt: null,
      prompt: "make her wave",
      options: { aspectRatio: "9:16", durationSec: 8 },
    });
    // (b) Storyboard job with an edited scene prompt and an out-of-bounds
    // duration: aiPrompt must track the scene (what actually renders) with
    // the duration clamped the same way the renderer clamps it.
    const board = clipBoardFixture(tenant.tenantId, "photo", 1);
    board.scenes[0]!.visual = "she slowly smiles at the camera";
    board.scenes[0]!.durationSec = 99;
    const withBoard = await seedPausedJob(
      tenant.tenantId,
      { engine: "image_to_video", prompt: "original brief" },
      board,
    );

    const res = await request(app).get("/api/ai/video-jobs");
    expect(res.status).toBe(200);
    const byId = new Map(res.body.map((j: { id: number; aiPrompt: string | null }) => [j.id, j]));
    expect((byId.get(direct.id) as { aiPrompt: string }).aiPrompt).toBe(
      `make her wave${suffix(8)}`,
    );
    expect((byId.get(withBoard.id) as { aiPrompt: string }).aiPrompt).toBe(
      `she slowly smiles at the camera${suffix(10)}`,
    );
    // Other engines expose per-scene prompts via the storyboard instead.
    const topic = await seedPausedJob(tenant.tenantId);
    const res2 = await request(app).get("/api/ai/video-jobs");
    const topicJob = res2.body.find((j: { id: number }) => j.id === topic.id);
    expect(topicJob.aiPrompt).toBeNull();
  });
});

describe("POST /api/ai/video-jobs/:jobId/storyboard/scenes", () => {
  it("does not fund or draw a new topic scene while Topic to Video is disabled", async () => {
    const tenant = await newTenant();
    await grantCredits({
      tenantId: tenant.tenantId,
      captionCredits: 0,
      imageCredits: 0,
      videoCredits: 1,
      kind: "admin_grant",
    });
    const job = await seedPausedJob(tenant.tenantId, { funding: "credit" });
    await setVideoModeFlag("videoTopicToVideo", false);

    try {
      const blocked = await request(app)
        .post(`/api/ai/video-jobs/${job.id}/storyboard/scenes`)
        .send({ text: "This scene must never be funded or drawn." });

      expect(blocked.status).toBe(403);
      expect(blocked.body.code).toBe("feature_disabled");
      expect((await getCreditBalances(tenant.tenantId)).videoCredits).toBe(1);
      expect((await readJob(job.id)).storyboard?.scenes).toHaveLength(2);
      expect(runnerState.previews).toHaveLength(0);
    } finally {
      await setVideoModeFlag("videoTopicToVideo", true);
    }
  });

  it("appends a scene at the end, draws its preview and records the extra unit", async () => {
    // Pro: a quota-funded insert needs quota headroom for the extra unit
    // (free's 3 videos/month are already below this 4-scene board's price).
    const tenant = await newTenant("pro");
    const job = await seedPausedJob(tenant.tenantId);
    const res = await request(app)
      .post(`/api/ai/video-jobs/${job.id}/storyboard/scenes`)
      .send({ text: "A closing thought.", visual: "sunset over the city" });
    expect(res.status).toBe(200);
    const scenes = res.body.storyboard.scenes;
    expect(scenes).toHaveLength(3);
    expect(scenes[2].id).toBe("s3");
    expect(scenes[2].text).toBe("A closing thought.");
    expect(scenes[2].visual).toBe("sunset over the city");
    expect(scenes[2].previewPath).toBe(`/objects/${tenant.tenantId}/uploads/reroll-s3.png`);
    // The extra unit lives in options so every refund path reprices with it.
    expect((await readJob(job.id)).options?.addedScenes).toBe(1);
    expect(runnerState.previews).toEqual([{ jobId: job.id, sceneId: "s3" }]);
  });

  it("inserts after a named scene, and at the start for afterSceneId null", async () => {
    const tenant = await newTenant("pro");
    const job = await seedPausedJob(tenant.tenantId);
    const mid = await request(app)
      .post(`/api/ai/video-jobs/${job.id}/storyboard/scenes`)
      .send({ afterSceneId: "s1", text: "A bridge between the two." });
    expect(mid.status).toBe(200);
    expect(mid.body.storyboard.scenes.map((s: { id: string }) => s.id)).toEqual([
      "s1",
      "s3",
      "s2",
    ]);
    const front = await request(app)
      .post(`/api/ai/video-jobs/${job.id}/storyboard/scenes`)
      .send({ afterSceneId: null, text: "A cold open." });
    expect(front.status).toBe(200);
    expect(front.body.storyboard.scenes.map((s: { id: string }) => s.id)).toEqual([
      "s4",
      "s1",
      "s3",
      "s2",
    ]);
    expect((await readJob(job.id)).options?.addedScenes).toBe(2);
  });

  it("rejects an unknown afterSceneId and boards that are not narrated", async () => {
    const tenant = await newTenant();
    const job = await seedPausedJob(tenant.tenantId);
    const unknown = await request(app)
      .post(`/api/ai/video-jobs/${job.id}/storyboard/scenes`)
      .send({ afterSceneId: "s9", text: "lost" });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toMatch(/not in this storyboard/i);

    const clip = await seedPausedJob(
      tenant.tenantId,
      { engine: "text_to_video", options: { aspectRatio: "9:16", shotCount: 2 } },
      clipBoardFixture(tenant.tenantId, "prompt"),
    );
    const res = await request(app)
      .post(`/api/ai/video-jobs/${clip.id}/storyboard/scenes`)
      .send({ text: "no recording to extend" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/narrated topic storyboards/i);
  });

  it("spends one credit on credit-funded jobs and refunds it when the preview fails", async () => {
    const tenant = await newTenant();
    await grantCredits({
      tenantId: tenant.tenantId,
      captionCredits: 0,
      imageCredits: 0,
      videoCredits: 2,
      kind: "admin_grant",
    });
    const job = await seedPausedJob(tenant.tenantId, { funding: "credit" });

    runnerState.previewError = new VideoGenProviderError("The image provider failed.");
    const failed = await request(app)
      .post(`/api/ai/video-jobs/${job.id}/storyboard/scenes`)
      .send({ text: "This one never draws." });
    expect(failed.status).toBe(502);
    expect((await getCreditBalances(tenant.tenantId)).videoCredits).toBe(2);
    expect((await readJob(job.id)).storyboard?.scenes).toHaveLength(2);
    expect((await readJob(job.id)).options?.addedScenes).toBeUndefined();

    runnerState.previewError = null;
    const ok = await request(app)
      .post(`/api/ai/video-jobs/${job.id}/storyboard/scenes`)
      .send({ text: "This one lands." });
    expect(ok.status).toBe(200);
    expect((await getCreditBalances(tenant.tenantId)).videoCredits).toBe(1);
  });

  it("402s a credit-funded job with no credits left", async () => {
    const tenant = await newTenant();
    const job = await seedPausedJob(tenant.tenantId, { funding: "credit" });
    const res = await request(app)
      .post(`/api/ai/video-jobs/${job.id}/storyboard/scenes`)
      .send({ text: "cannot pay for this" });
    expect(res.status).toBe(402);
    expect((await readJob(job.id)).storyboard?.scenes).toHaveLength(2);
  });

  it("refuses to grow past the scene cap", async () => {
    const tenant = await newTenant();
    const job = await seedPausedJob(
      tenant.tenantId,
      {},
      storyboardFixture(tenant.tenantId, 16),
    );
    const res = await request(app)
      .post(`/api/ai/video-jobs/${job.id}/storyboard/scenes`)
      .send({ text: "one too many" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/maximum/i);
  });

  it("404s on another tenant's storyboard", async () => {
    const other = await newTenant();
    const job = await seedPausedJob(other.tenantId);
    await newTenant();
    const res = await request(app)
      .post(`/api/ai/video-jobs/${job.id}/storyboard/scenes`)
      .send({ text: "not mine" });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/ai/video-jobs/:jobId/storyboard/scenes/:sceneId/preview", () => {
  it("does not re-roll a topic preview while Topic to Video is disabled", async () => {
    const tenant = await newTenant();
    const job = await seedPausedJob(tenant.tenantId);
    await setVideoModeFlag("videoTopicToVideo", false);

    try {
      const blocked = await request(app).post(
        `/api/ai/video-jobs/${job.id}/storyboard/scenes/s1/preview`,
      );

      expect(blocked.status).toBe(403);
      expect(blocked.body.code).toBe("feature_disabled");
      expect((await readJob(job.id)).storyboard?.regenerations).toBe(0);
      expect(runnerState.previews).toHaveLength(0);
    } finally {
      await setVideoModeFlag("videoTopicToVideo", true);
    }
  });

  it("re-rolls one still and counts the regeneration", async () => {
    const tenant = await newTenant();
    const job = await seedPausedJob(tenant.tenantId);

    const res = await request(app).post(
      `/api/ai/video-jobs/${job.id}/storyboard/scenes/s1/preview`,
    );
    expect(res.status).toBe(200);
    expect(runnerState.previews).toEqual([{ jobId: job.id, sceneId: "s1" }]);
    expect(res.body.storyboard.regenerations).toBe(1);
    expect(res.body.storyboard.scenes[0].previewPath).toBe(
      `/objects/${tenant.tenantId}/uploads/reroll-s1.png`,
    );
    expect(res.body.storyboard.scenes[1].previewPath).toBe(
      `/objects/${tenant.tenantId}/uploads/shot-2.png`,
    );
    expect((await readJob(job.id)).storyboard?.regenerations).toBe(1);
  });

  it("400s on a scene id that is not in the plan", async () => {
    const tenant = await newTenant();
    const job = await seedPausedJob(tenant.tenantId);
    const res = await request(app).post(
      `/api/ai/video-jobs/${job.id}/storyboard/scenes/s9/preview`,
    );
    expect(res.status).toBe(400);
    expect(runnerState.previews).toHaveLength(0);
  });

  it("stops re-rolling at two per scene and says how many that was", async () => {
    const tenant = await newTenant();
    // Two scenes, so the cap is four; start already spent.
    const spent = storyboardFixture(tenant.tenantId);
    spent.regenerations = 4;
    const job = await seedPausedJob(tenant.tenantId, {}, spent);

    const res = await request(app).post(
      `/api/ai/video-jobs/${job.id}/storyboard/scenes/s1/preview`,
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("all 4 free preview re-rolls");
    expect(runnerState.previews).toHaveLength(0);
  });

  it("grants only the re-rolls left under the cap when requests race", async () => {
    const tenant = await newTenant();
    // Two scenes → cap 4; three already spent, so exactly one re-roll remains.
    const spent = storyboardFixture(tenant.tenantId);
    spent.regenerations = 3;
    const job = await seedPausedJob(tenant.tenantId, {}, spent);

    const [a, b] = await Promise.all([
      request(app).post(`/api/ai/video-jobs/${job.id}/storyboard/scenes/s1/preview`),
      request(app).post(`/api/ai/video-jobs/${job.id}/storyboard/scenes/s2/preview`),
    ]);
    // The atomic claim lets exactly one through; the loser sees the cap error.
    expect([a.status, b.status].sort()).toEqual([200, 400]);
    expect(runnerState.previews).toHaveLength(1);
    expect((await readJob(job.id)).storyboard?.regenerations).toBe(4);
  });

  it("400s a redraw on a plan whose stills are the user's own photos", async () => {
    // Only "character" and "ai" previews were drawn, so only those can be
    // redrawn. A slide or photo preview is the upload itself, and a prompt plan
    // has no still at all — re-rolling any of them would replace or invent
    // something the user did not ask for.
    const tenant = await newTenant();
    for (const [engine, source] of [
      ["slideshow", "slide"],
      ["image_to_video", "photo"],
      ["text_to_video", "prompt"],
    ] as const) {
      const job = await seedPausedJob(
        tenant.tenantId,
        { engine },
        clipBoardFixture(tenant.tenantId, source),
      );
      const res = await request(app).post(
        `/api/ai/video-jobs/${job.id}/storyboard/scenes/s1/preview`,
      );
      expect(res.status, source).toBe(400);
      expect(res.body.error).toMatch(/your own photos/i);
      expect(runnerState.previews).toHaveLength(0);
      expect((await readJob(job.id)).storyboard?.regenerations).toBe(0);
    }
  });

  it("502s when the image provider fails, leaving the plan as it was", async () => {
    const tenant = await newTenant();
    const job = await seedPausedJob(tenant.tenantId);
    runnerState.previewError = new VideoGenProviderError("Replicate is over capacity.", 503);

    const res = await request(app).post(
      `/api/ai/video-jobs/${job.id}/storyboard/scenes/s1/preview`,
    );
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("Replicate is over capacity.");
    const row = await readJob(job.id);
    expect(row.status).toBe("awaiting_review");
    expect(row.storyboard?.regenerations).toBe(0);
  });
});

describe("POST /api/ai/video-jobs/:jobId/storyboard/approve", () => {
  describe("individual Video Studio controls", () => {
    afterEach(clearVideoModeFlags);

    it("does not claim or resume a paused storyboard after its mode is disabled", async () => {
      for (const item of VIDEO_MODE_CASES) {
        const tenant = await newTenant();
        const job = await seedPausedJob(tenant.tenantId, { engine: item.engine });
        await setVideoModeFlag(item.feature, false);

        const blocked = await request(app).post(
          `/api/ai/video-jobs/${job.id}/storyboard/approve`,
        );

        expect(blocked.status, item.engine).toBe(403);
        expect(blocked.body.code, item.engine).toBe("feature_disabled");
        expect((await readJob(job.id)).status, item.engine).toBe("awaiting_review");
        expect(runnerState.resumed, item.engine).not.toContain(job.id);

        await setVideoModeFlag(item.feature, true);
      }
    });
  });

  it("claims the plan once, hands it to the runner and clears the expiry", async () => {
    const tenant = await newTenant();
    const job = await seedPausedJob(tenant.tenantId);

    const res = await request(app).post(`/api/ai/video-jobs/${job.id}/storyboard/approve`);
    expect(res.status).toBe(202);
    expect(res.body.status).toBe("processing");
    expect(res.body.storyboardExpiresAt).toBeNull();

    await waitForPendingJobs();
    expect(runnerState.resumed).toEqual([job.id]);
    const row = await readJob(job.id);
    expect(row.status).toBe("processing");
    expect(row.storyboardExpiresAt).toBeNull();
    // The plan is kept as the record of what was approved.
    expect(row.storyboard?.scenes).toHaveLength(2);

    // A second approve finds nothing left to claim, so no second render.
    const again = await request(app).post(`/api/ai/video-jobs/${job.id}/storyboard/approve`);
    expect(again.status).toBe(400);
    await waitForPendingJobs();
    expect(runnerState.resumed).toEqual([job.id]);
  });

  it("renders once when two approvals arrive together", async () => {
    const tenant = await newTenant();
    const job = await seedPausedJob(tenant.tenantId);

    // Both requests can read awaiting_review before either writes, so the
    // conditional UPDATE is the only thing standing between the user and two
    // renders of the same plan.
    const results = await Promise.all([
      request(app).post(`/api/ai/video-jobs/${job.id}/storyboard/approve`),
      request(app).post(`/api/ai/video-jobs/${job.id}/storyboard/approve`),
    ]);
    expect(results.filter((r) => r.status === 202)).toHaveLength(1);
    expect(results.filter((r) => r.status === 400)).toHaveLength(1);

    await waitForPendingJobs();
    expect(runnerState.resumed).toEqual([job.id]);
  });

  it("400s a job with no plan to approve", async () => {
    const tenant = await newTenant();
    const job = (
      await db
        .insert(videoGenerationsTable)
        .values({ tenantId: tenant.tenantId, engine: "topic_to_video", status: "queued" })
        .returning()
    )[0]!;
    const res = await request(app).post(`/api/ai/video-jobs/${job.id}/storyboard/approve`);
    expect(res.status).toBe(400);
    expect(runnerState.resumed).toHaveLength(0);
  });
});

describe("POST /api/ai/video-jobs/:jobId/storyboard/discard", () => {
  it("fails the job and gives credit funding back exactly once", async () => {
    const tenant = await newTenant("payg");
    await grantCredits({
      tenantId: tenant.tenantId,
      captionCredits: 0,
      imageCredits: 0,
      videoCredits: 0,
      kind: "admin_grant",
      note: "test",
    });
    // A one-paragraph character video costs four units, spent at enqueue.
    const job = await seedPausedJob(tenant.tenantId, { funding: "credit" });

    const res = await request(app).post(`/api/ai/video-jobs/${job.id}/storyboard/discard`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("failed");
    // Serialized jobs expose the true charged unit count so the client can
    // show the real AI amount spent (4 scenes here, not the 1-video rate).
    expect(res.body.units).toBe(4);
    expect(res.body.error).toMatch(/Nothing was charged/i);
    expect((await getCreditBalances(tenant.tenantId)).videoCredits).toBe(4);

    // Discarding twice must not refund twice.
    const again = await request(app).post(`/api/ai/video-jobs/${job.id}/storyboard/discard`);
    expect(again.status).toBe(400);
    expect((await getCreditBalances(tenant.tenantId)).videoCredits).toBe(4);
  });

  it("refunds once when two discards arrive together", async () => {
    const tenant = await newTenant("payg");
    await grantCredits({
      tenantId: tenant.tenantId,
      captionCredits: 0,
      imageCredits: 0,
      videoCredits: 0,
      kind: "admin_grant",
      note: "test",
    });
    const job = await seedPausedJob(tenant.tenantId, { funding: "credit" });

    // Both requests can read awaiting_review before either writes, so only the
    // conditional UPDATE keeps this from refunding eight units for four.
    const results = await Promise.all([
      request(app).post(`/api/ai/video-jobs/${job.id}/storyboard/discard`),
      request(app).post(`/api/ai/video-jobs/${job.id}/storyboard/discard`),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect((await getCreditBalances(tenant.tenantId)).videoCredits).toBe(4);
  });

  it("refunds nothing when the job was funded by the plan quota", async () => {
    const tenant = await newTenant();
    const job = await seedPausedJob(tenant.tenantId, { funding: "quota" });
    const res = await request(app).post(`/api/ai/video-jobs/${job.id}/storyboard/discard`);
    expect(res.status).toBe(200);
    expect((await getCreditBalances(tenant.tenantId)).videoCredits).toBe(0);
    expect((await readJob(job.id)).storyboardExpiresAt).toBeNull();
  });
});

describe("POST /api/ai/video-jobs/:jobId/save-to-library", () => {
  it("rejects saving a job that has not finished", async () => {
    const tenant = await newTenant();
    const job = (
      await db
        .insert(videoGenerationsTable)
        .values({ tenantId: tenant.tenantId, engine: "slideshow", status: "processing" })
        .returning()
    )[0]!;
    const res = await request(app)
      .post(`/api/ai/video-jobs/${job.id}/save-to-library`)
      .send({ title: "My video" });
    expect(res.status).toBe(400);
  });

  it("creates a draft content item carrying the video and its poster", async () => {
    const tenant = await newTenant();
    const job = (
      await db
        .insert(videoGenerationsTable)
        .values({
          tenantId: tenant.tenantId,
          engine: "slideshow",
          status: "succeeded",
          videoPath: `/objects/${tenant.tenantId}/uploads/video.mp4`,
          thumbnailPath: `/objects/${tenant.tenantId}/uploads/poster.png`,
        })
        .returning()
    )[0]!;

    const res = await request(app)
      .post(`/api/ai/video-jobs/${job.id}/save-to-library`)
      .send({ title: "Launch reel", caption: "So it begins", platform: "instagram" });
    expect(res.status).toBe(201);
    expect(res.body.videoPath).toBe(job.videoPath);
    expect(res.body.videoThumbnailPath).toBe(job.thumbnailPath);
    expect(res.body.status).toBe("draft");
    expect(res.body.contentType).toBe("reel");

    const row = (
      await db
        .select()
        .from(contentItemsTable)
        .where(eq(contentItemsTable.id, res.body.id))
    )[0];
    expect(row?.tenantId).toBe(tenant.tenantId);
    expect(row?.videoPath).toBe(job.videoPath);
  });
});

describe("music library routes", () => {
  it("searches the library and returns license-tagged tracks", async () => {
    await newTenant();
    const res = await request(app).get("/api/ai/music/search").query({ q: "sunny pop" });
    expect(res.status).toBe(200);
    expect(res.body.tracks).toHaveLength(1);
    expect(res.body.tracks[0]).toMatchObject({
      id: "trk1",
      title: "Sunny Drive",
      license: "by",
      audioUrl: "https://cdn.example.com/sunny.mp3",
    });
  });

  it("rejects a too-short query", async () => {
    await newTenant();
    const res = await request(app).get("/api/ai/music/search").query({ q: "x" });
    expect(res.status).toBe(400);
  });

  it("imports a track into tenant storage and returns its musicPath", async () => {
    const tenant = await newTenant();
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 200 })) as typeof fetch;
    try {
      const res = await request(app)
        .post("/api/ai/music/import")
        .send({ audioUrl: "https://cdn.example.com/sunny.mp3", title: "Sunny Drive" });
      expect(res.status).toBe(200);
      expect(res.body.title).toBe("Sunny Drive");
      expect(res.body.musicPath).toBe(`/objects/${tenant.tenantId}/uploads/music-uuid`);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("surfaces guarded download failures as a 400", async () => {
    await newTenant();
    const res = await request(app)
      .post("/api/ai/music/import")
      .send({ audioUrl: "https://bad.example.com/a.mp3", title: "Nope" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/https/);
  });
});

describe("AI music funding", () => {
  it("charges one extra unit for an AI-composed bed and persists the prompt", async () => {
    const tenant = await newTenant(); // free plan quota covers it
    const res = await request(app)
      .post("/api/ai/generate-video")
      .send({
        engine: "slideshow",
        sourceImagePaths: [`/objects/${tenant.tenantId}/uploads/a.png`],
        aspectRatio: "9:16",
        musicPrompt: "warm lofi chill beat",
      });
    expect(res.status).toBe(201);
    const row = (
      await db
        .select()
        .from(videoGenerationsTable)
        .where(eq(videoGenerationsTable.id, res.body.id))
    )[0];
    expect(row?.options).toMatchObject({ musicPrompt: "warm lofi chill beat" });
  });

  it("ignores musicPrompt when an uploaded track is provided", async () => {
    const tenant = await newTenant();
    const res = await request(app)
      .post("/api/ai/generate-video")
      .send({
        engine: "slideshow",
        sourceImagePaths: [`/objects/${tenant.tenantId}/uploads/a.png`],
        aspectRatio: "9:16",
        musicPath: `/objects/${tenant.tenantId}/uploads/track.mp3`,
        musicPrompt: "should be ignored",
      });
    expect(res.status).toBe(201);
    const row = (
      await db
        .select()
        .from(videoGenerationsTable)
        .where(eq(videoGenerationsTable.id, res.body.id))
    )[0];
    expect(row?.options?.musicPrompt ?? null).toBeNull();
  });
});

describe("self-service local video repair", () => {
  async function seedRepairableVideo(tenantId: number) {
    return (
      await db
        .insert(videoGenerationsTable)
        .values({
          tenantId,
          engine: "topic_to_video",
          status: "succeeded",
          prompt: "A saved topic video",
          sourceImagePaths: [],
          videoPath: `/objects/${tenantId}/uploads/original.mp4`,
          thumbnailPath: `/objects/${tenantId}/uploads/original.png`,
          spendPaise: 1234,
          options: {
            aspectRatio: "9:16",
            subtitles: true,
            captionStyle: "classic",
          },
          storyboard: {
            version: 1,
            visualsSource: "ai",
            timelineLocked: true,
            regenerations: 0,
            model: "image-model",
            provider: "replicate",
            narration: {
              audioPath: `/objects/${tenantId}/uploads/narration.wav`,
              totalDurationSec: 4,
              cues: [{ startSec: 0, endSec: 4, text: "Saved narration." }],
            },
            scenes: [
              {
                id: "s1",
                text: "Saved narration.",
                visual: "A saved scene",
                durationSec: 4,
                previewPath: `/objects/${tenantId}/uploads/scene.png`,
                outfitId: null,
              },
            ],
          },
        })
        .returning()
    )[0]!;
  }

  it("creates one no-charge child, preserves the source, and deduplicates repeats", async () => {
    const tenant = await newTenant();
    const source = await seedRepairableVideo(tenant.tenantId);
    const first = await request(app)
      .post(`/api/ai/video-jobs/${source.id}/repair`)
      .send({ reason: "audio_visual" });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body).toMatchObject({
      status: "queued",
      spendPaise: 0,
      repairable: false,
      repair: {
        chainId: source.id,
        sourceJobId: source.id,
        reason: "audio_visual",
      },
    });
    await waitForPendingJobs();
    expect(runnerState.repairs).toEqual([first.body.id]);
    const child = (
      await db
        .select()
        .from(videoGenerationsTable)
        .where(eq(videoGenerationsTable.id, first.body.id))
    )[0]!;
    expect(child.funding).toBeNull();
    expect(child.chargedRatePaise).toBe(0);
    expect(child.options?.renderCheckpoint).toBeNull();
    const unchanged = (
      await db
        .select()
        .from(videoGenerationsTable)
        .where(eq(videoGenerationsTable.id, source.id))
    )[0]!;
    expect(unchanged.videoPath).toBe(`/objects/${tenant.tenantId}/uploads/original.mp4`);
    expect(unchanged.spendPaise).toBe(1234);

    const duplicate = await request(app)
      .post(`/api/ai/video-jobs/${source.id}/repair`)
      .send({ reason: "captions" });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe("repair_child_exists");
  });

  it("does not reveal or repair another tenant's completed video", async () => {
    const owner = await newTenant();
    const source = await seedRepairableVideo(owner.tenantId);
    await newTenant();
    const response = await request(app)
      .post(`/api/ai/video-jobs/${source.id}/repair`)
      .send({ reason: "narration" });
    expect(response.status).toBe(404);
    expect(runnerState.repairs).toHaveLength(0);
  });

  it("rejects stock videos and cross-tenant saved paths before creating a child", async () => {
    const tenant = await newTenant();
    const source = await seedRepairableVideo(tenant.tenantId);
    const [row] = await db
      .select()
      .from(videoGenerationsTable)
      .where(eq(videoGenerationsTable.id, source.id));
    await db
      .update(videoGenerationsTable)
      .set({
        storyboard: {
          ...row!.storyboard!,
          narration: {
            ...row!.storyboard!.narration!,
            audioPath: "/objects/999999/uploads/foreign.wav",
          },
        },
      })
      .where(eq(videoGenerationsTable.id, source.id));
    const forbidden = await request(app)
      .post(`/api/ai/video-jobs/${source.id}/repair`)
      .send({ reason: "scene_timing" });
    expect(forbidden.status).toBe(410);
    expect(forbidden.body.code).toBe("repair_asset_forbidden");

    await db
      .update(videoGenerationsTable)
      .set({
        storyboard: {
          ...row!.storyboard!,
          visualsSource: "prompt",
        },
      })
      .where(eq(videoGenerationsTable.id, source.id));
    const stock = await request(app)
      .post(`/api/ai/video-jobs/${source.id}/repair`)
      .send({ reason: "music" });
    expect(stock.status).toBe(400);
    expect(stock.body.code).toBe("repair_not_eligible");
  });

  it("reports a missing saved asset without changing the source or wallet spend", async () => {
    const tenant = await newTenant();
    const source = await seedRepairableVideo(tenant.tenantId);
    const missingPath = `/objects/${tenant.tenantId}/uploads/scene.png`;
    objectStorageState.missingPaths.add(missingPath);
    const response = await request(app)
      .post(`/api/ai/video-jobs/${source.id}/repair`)
      .send({ reason: "captions" });
    expect(response.status).toBe(410);
    expect(response.body).toMatchObject({ code: "repair_asset_missing" });
    expect(response.body.error).toMatch(/original video is unchanged/i);
    const [unchanged] = await db
      .select()
      .from(videoGenerationsTable)
      .where(eq(videoGenerationsTable.id, source.id));
    expect(unchanged!.videoPath).toBe(`/objects/${tenant.tenantId}/uploads/original.mp4`);
    expect(unchanged!.spendPaise).toBe(1234);
    expect(runnerState.repairs).toEqual([]);
  });

  it("allows another repair after a queued repair is cancelled", async () => {
    const tenant = await newTenant();
    const source = await seedRepairableVideo(tenant.tenantId);
    const first = await request(app)
      .post(`/api/ai/video-jobs/${source.id}/repair`)
      .send({ reason: "audio_visual" });
    expect(first.status).toBe(201);
    const cancelled = await request(app)
      .post(`/api/ai/video-jobs/${first.body.id}/cancel`)
      .send({});
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe("cancelled");
    const sourceAfterCancel = await request(app).get(`/api/ai/video-jobs/${source.id}`);
    expect(sourceAfterCancel.status).toBe(200);
    expect(sourceAfterCancel.body.repairable).toBe(true);
    const second = await request(app)
      .post(`/api/ai/video-jobs/${source.id}/repair`)
      .send({ reason: "captions" });
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect(second.body.repair.sourceJobId).toBe(source.id);
    expect(second.body.id).not.toBe(first.body.id);
  });
});
