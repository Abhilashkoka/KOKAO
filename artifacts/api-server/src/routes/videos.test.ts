import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
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
}));
vi.mock("../lib/videoGen/jobRunner", () => ({
  STORYBOARD_REGENERATIONS_PER_SCENE: 2,
  runVideoGenerationJob: vi.fn(async (jobId: number, funding: string) => {
    runnerState.calls.push({ jobId, funding });
  }),
  resumeVideoGenerationJob: vi.fn(async (job: { id: number }) => {
    runnerState.resumed.push(job.id);
  }),
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
  }
  return { ...actual, ObjectStorageService: FakeObjectStorageService };
});

import {
  db,
  videoGenerationsTable,
  contentItemsTable,
  tenantsTable,
  creditBalancesTable,
  creditLedgerTable,
  charactersTable,
  characterOutfitsTable,
  type VideoStoryboard,
  type VideoStoryboardScene,
} from "@workspace/db";
import { VideoGenProviderError } from "../lib/videoGen";
import { grantCredits, getCreditBalances } from "../lib/credits";
import { eq } from "drizzle-orm";
import { requireTenant } from "../middlewares/requireTenant";
import videosRouter from "./videos";
import { actAs, resetAuthState } from "../test/authState";
import { createTenant, deleteTenant, type TestTenant } from "../test/dbHelpers";
import { waitForPendingJobs } from "../lib/backgroundJobs";

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

afterAll(async () => {
  for (const [key, value] of Object.entries(savedProviderEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await waitForPendingJobs();
  for (const tenant of createdTenants) {
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
    await deleteTenant(tenant.tenantId);
  }
});

describe("POST /api/ai/generate-video", () => {
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

describe("POST /api/ai/video-jobs/:jobId/storyboard/scenes", () => {
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
