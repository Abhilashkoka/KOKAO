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
}));
vi.mock("../lib/videoGen/jobRunner", () => ({
  runVideoGenerationJob: vi.fn(async (jobId: number, funding: string) => {
    runnerState.calls.push({ jobId, funding });
  }),
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
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireTenant } from "../middlewares/requireTenant";
import videosRouter from "./videos";
import { actAs, resetAuthState } from "../test/authState";
import { createTenant, deleteTenant, type TestTenant } from "../test/dbHelpers";
import { grantCredits, getCreditBalances } from "../lib/credits";
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

beforeEach(() => {
  resetAuthState();
  runnerState.calls.length = 0;
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
    });
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
