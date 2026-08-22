import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

/**
 * The storyboard pause, as the runner actually executes it. The three engines
 * that are not topic mode share one plan-and-pause path, and the two ways out of
 * it — approve, or decline review on a job that was still funded for several
 * shots — settle funding differently. That is what is tested here; the planner
 * and the renderer have their own tests (clipStoryboard.test.ts), so both are
 * stubbed and only the wiring between them and the row is exercised.
 */

const state = vi.hoisted(() => ({
  /** Each planClipStoryboard call's source, in order. */
  planned: [] as string[],
  /** Each renderClipStoryboard call's plan, in order. */
  rendered: [] as unknown[],
  /** Set by a test to make the render throw. */
  renderError: null as unknown,
  /** Set by a test to make orchestrateLocalizedDub throw. */
  dubError: null as unknown,
  usage: [] as {
    tenantId: number;
    funding: string | undefined;
    costPaise: number | undefined;
  }[],
  refunds: [] as { tenantId: number; units: number }[],
  music: [] as number[],
  disabledFeature: null as string | null,
}));

vi.mock("../featureFlags", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../featureFlags")>();
  return {
    ...actual,
    isFeatureEnabled: vi.fn(async (id: string) => id !== state.disabledFeature),
  };
});

vi.mock("./clipStoryboard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./clipStoryboard")>();
  return {
    ...actual,
    // The post-approval polish pass has its own tests; here it must not hit a
    // live model or mutate the plan the assertions compare against.
    polishStoryboardPrompts: vi.fn(async () => false),
    planClipStoryboard: vi.fn(
      async ({ source, job }: { source: string; job: { tenantId: number } }) => {
        state.planned.push(source);
        return {
          version: 1 as const,
          visualsSource: source,
          timelineLocked: false,
          durationBounds: actual.clipDurationBounds(
            source as "prompt" | "slide" | "photo" | "character",
          ),
          model: null,
          provider: null,
          regenerations: 0,
          narration: null,
          scenes: [
            {
              id: "s1",
              text: "",
              visual: "planned shot",
              durationSec: 4,
              previewPath: `/objects/${job.tenantId}/uploads/planned.png`,
              outfitId: null,
            },
          ],
        };
      },
    ),
    renderClipStoryboard: vi.fn(async ({ storyboard }: { storyboard: unknown }) => {
      if (state.renderError) throw state.renderError;
      state.rendered.push(storyboard);
      return {
        buffer: Buffer.from("rendered-mp4"),
        provider: "replicate",
        model: "veo-test",
        totalSec: 4,
      };
    }),
  };
});

vi.mock("./qaGate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./qaGate")>()),
  verifyRenderedVideo: vi.fn(async () => ({ durationSec: 8 })),
}));

vi.mock("./slideshow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./slideshow")>()),
  renderSlideshow: vi.fn(async () => ({ buffer: Buffer.from("slides"), totalSec: 4 })),
  extractPosterFrame: vi.fn(async () => Buffer.from("poster-png")),
}));

vi.mock("./musicGen", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./musicGen")>()),
  generateMusicBed: vi.fn(async (_prompt: string, sec: number) => {
    state.music.push(sec);
    return Buffer.from("music");
  }),
}));

vi.mock("../usage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../usage")>()),
  recordUsage: vi.fn(
    async (
      tenantId: number,
      _kind: string,
      meta?: { funding?: string; costPaise?: number },
    ) => {
      state.usage.push({ tenantId, funding: meta?.funding, costPaise: meta?.costPaise });
    },
  ),
}));

vi.mock("../credits", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../credits")>()),
  refundCredits: vi.fn(async (tenantId: number, _kind: string, units: number) => {
    state.refunds.push({ tenantId, units });
  }),
}));

vi.mock("../localization/dub", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../localization/dub")>();
  return {
    ...actual,
    orchestrateLocalizedDub: vi.fn(async () => {
      if (state.dubError) throw state.dubError;
      return Buffer.from("dubbed-mp4");
    }),
  };
});

vi.mock("../objectStorage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../objectStorage")>();
  class FakeObjectStorageService {
    async getObjectEntityUploadURL(tenantId: number): Promise<string> {
      return `https://storage.example.com/objects/${tenantId}/uploads/out-uuid`;
    }
    normalizeObjectEntityPath(uploadURL: string): string {
      return new URL(uploadURL).pathname;
    }
    async getObjectEntityFile(
      _objectPath: string,
      _tenantId: number,
    ): Promise<{
      getMetadata: () => Promise<[{ size: number; contentType: string }]>;
      download: () => Promise<[Buffer]>;
    }> {
      return {
        getMetadata: async () => [{ size: 1024, contentType: "video/mp4" }],
        download: async () => [Buffer.from("fake-video-bytes")],
      };
    }
  }
  return { ...actual, ObjectStorageService: FakeObjectStorageService };
});

import { db, videoGenerationsTable, type VideoStoryboard } from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTenant, deleteTenant, type TestTenant } from "../../test/dbHelpers";
import { VideoGenProviderError } from "./index";
import {
  runVideoGenerationJob,
  resumeVideoGenerationJob,
  STORYBOARD_TTL_MS,
} from "./jobRunner";
import { CueOverrunError } from "../localization/dub";

const createdTenants: TestTenant[] = [];

async function newTenant(): Promise<TestTenant> {
  const tenant = await createTenant();
  createdTenants.push(tenant);
  return tenant;
}

type JobRow = typeof videoGenerationsTable.$inferInsert;

async function seedJob(tenantId: number, overrides: Partial<JobRow> = {}) {
  return (
    await db
      .insert(videoGenerationsTable)
      .values({
        tenantId,
        engine: "text_to_video",
        status: "queued",
        prompt: "A barista pulling an espresso shot",
        options: { aspectRatio: "9:16", reviewStoryboard: true },
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

beforeEach(() => {
  state.planned.length = 0;
  state.rendered.length = 0;
  state.usage.length = 0;
  state.refunds.length = 0;
  state.music.length = 0;
  state.renderError = null;
  state.dubError = null;
  state.disabledFeature = null;
  // uploadToStorage PUTs the finished bytes to a presigned URL; the storage
  // service is faked, so the PUT is too.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 200 })),
  );
});

afterAll(async () => {
  vi.unstubAllGlobals();
  for (const tenant of createdTenants) {
    await db
      .delete(videoGenerationsTable)
      .where(eq(videoGenerationsTable.tenantId, tenant.tenantId));
    await deleteTenant(tenant.tenantId);
  }
});

describe("the clip storyboard pause", () => {
  it("pauses all three clip engines and meters nothing yet", async () => {
    // Every engine that is not topic mode gets a plan, which is the whole point
    // of this patch: before it, only topic mode ever paused.
    const tenant = await newTenant();
    const engines = [
      ["text_to_video", "prompt"],
      ["image_to_video", "photo"],
      ["slideshow", "slide"],
    ] as const;

    for (const [engine, source] of engines) {
      const job = await seedJob(tenant.tenantId, {
        engine,
        sourceImagePaths:
          engine === "text_to_video"
            ? null
            : [`/objects/${tenant.tenantId}/uploads/a.png`, `/objects/${tenant.tenantId}/uploads/b.png`],
      });
      const before = Date.now();
      await runVideoGenerationJob(job.id, "quota");

      const row = await readJob(job.id);
      expect(row.status, engine).toBe("awaiting_review");
      expect(row.storyboard?.visualsSource, engine).toBe(source);
      expect(row.storyboard?.scenes[0]?.visual).toBe("planned shot");
      // Held long enough to come back to tomorrow, and swept after that.
      expect(row.storyboardExpiresAt?.getTime() ?? 0).toBeGreaterThanOrEqual(
        before + STORYBOARD_TTL_MS - 5_000,
      );
      expect(row.videoPath).toBeNull();
      expect(row.error).toBeNull();
    }

    expect(state.planned).toEqual(["prompt", "photo", "slide"]);
    // Nothing was rendered and nothing was billed: the reservation stays
    // reserved against a render the user has not asked for yet.
    expect(state.rendered).toHaveLength(0);
    expect(state.usage).toHaveLength(0);
    expect(state.refunds).toHaveLength(0);
  });

  it("renders the approved plan on resume instead of planning again", async () => {
    const tenant = await newTenant();
    const approved: VideoStoryboard = {
      version: 1,
      visualsSource: "prompt",
      timelineLocked: false,
      durationBounds: { minSec: 3, maxSec: 10 },
      model: null,
      provider: null,
      regenerations: 0,
      narration: null,
      scenes: [
        {
          id: "s1",
          text: "",
          visual: "the shot the user edited",
          durationSec: 7,
          previewPath: null,
          outfitId: null,
        },
      ],
    };
    // The approve route already claimed the row, so resume takes it as it is.
    const job = await seedJob(tenant.tenantId, {
      status: "processing",
      funding: "credit",
      storyboard: approved,
      durationMs: 1_200,
    });

    await resumeVideoGenerationJob(await readJob(job.id));

    // The edited plan is what got filmed — not a fresh one.
    expect(state.planned).toHaveLength(0);
    expect(state.rendered).toEqual([approved]);
    const row = await readJob(job.id);
    expect(row.status).toBe("succeeded");
    expect(row.videoPath).toBe(`/objects/${tenant.tenantId}/uploads/out-uuid`);
    expect(row.thumbnailPath).toBe(`/objects/${tenant.tenantId}/uploads/out-uuid`);
    expect(row.provider).toBe("replicate");
    expect(row.model).toBe("veo-test");
    // Planning time already on the row is kept, so cost meters see the whole job.
    expect(row.durationMs ?? 0).toBeGreaterThanOrEqual(1_200);
    expect(state.usage).toEqual([
      // Uncataloged test model → unknown cost (undefined), never guessed.
      { tenantId: tenant.tenantId, funding: "credit", costPaise: undefined },
    ]);
  });

  it("still splits the shots a declined review was funded for", async () => {
    // Turning review off must not quietly turn a three-shot job into one shot:
    // the user was charged three units at enqueue.
    const tenant = await newTenant();
    const job = await seedJob(tenant.tenantId, {
      options: { aspectRatio: "9:16", reviewStoryboard: false, shotCount: 3 },
    });

    await runVideoGenerationJob(job.id, "quota");

    expect(state.planned).toEqual(["prompt"]);
    expect(state.rendered).toHaveLength(1);
    const row = await readJob(job.id);
    expect(row.status).toBe("succeeded");
    // Planned in memory and rendered in one pass, so nothing was ever awaiting
    // review and no plan was parked on the row.
    expect(row.storyboard).toBeNull();
    // One usage row per funded unit. The render's actual cost lives on the
    // FIRST row only; supplemental unit rows are explicitly 0 so they never
    // read as "unknown cost" in the admin report.
    expect(state.usage).toHaveLength(3);
    expect(state.usage.slice(1).map((u) => u.costPaise)).toEqual([0, 0]);
  });

  it("refunds every funded shot when the render fails", async () => {
    const tenant = await newTenant();
    const job = await seedJob(tenant.tenantId, {
      options: { aspectRatio: "9:16", reviewStoryboard: false, shotCount: 3 },
    });
    state.renderError = new VideoGenProviderError("Replicate is over capacity.", 503);

    await runVideoGenerationJob(job.id, "credit");

    const row = await readJob(job.id);
    expect(row.status).toBe("failed");
    expect(row.error).toBe("Replicate is over capacity.");
    expect(row.storyboardExpiresAt).toBeNull();
    expect(state.usage).toHaveLength(0);
    // Three units in, three units back.
    expect(state.refunds).toEqual([{ tenantId: tenant.tenantId, units: 3 }]);
  });

  it("sizes an AI music bed to the plan the user approved, not the request", async () => {
    // The length the user edited the plan to is the length the bed has to cover.
    const tenant = await newTenant();
    const job = await seedJob(tenant.tenantId, {
      status: "processing",
      options: { aspectRatio: "9:16", musicPrompt: "warm lo-fi", durationSec: 5 },
      storyboard: {
        version: 1,
        visualsSource: "prompt",
        timelineLocked: false,
        durationBounds: { minSec: 3, maxSec: 10 },
        model: null,
        provider: null,
        regenerations: 0,
        narration: null,
        scenes: [1, 2, 3].map((i) => ({
          id: `s${i}`,
          text: "",
          visual: `shot ${i}`,
          durationSec: 6,
          previewPath: null,
          outfitId: null,
        })),
      },
    });

    await resumeVideoGenerationJob(await readJob(job.id));

    expect((await readJob(job.id)).status).toBe("succeeded");
    expect(state.music).toEqual([18]);
  });
});

describe("individual Video Studio controls", () => {
  const modeCases = [
    ["text_to_video", "videoTextToVideo", "Text to Video"],
    ["image_to_video", "videoAnimatePhoto", "Animate Photo"],
    ["slideshow", "videoSlideshow", "Photo Slideshow"],
    ["topic_to_video", "videoTopicToVideo", "Topic to Video"],
  ] as const;

  it("fails and refunds every queued mode that was disabled after enqueue", async () => {
    const tenant = await newTenant();

    for (const [engine, feature, label] of modeCases) {
      state.disabledFeature = feature;
      state.refunds.length = 0;
      const job = await seedJob(tenant.tenantId, {
        engine,
        funding: "credit",
        options: { aspectRatio: "9:16", reviewStoryboard: false },
      });

      await runVideoGenerationJob(job.id, "credit");

      const row = await readJob(job.id);
      expect(row.status, engine).toBe("failed");
      expect(row.error, engine).toContain(`${label} is currently turned off`);
      expect(state.refunds, engine).toEqual([{ tenantId: tenant.tenantId, units: 1 }]);
      expect(state.planned, engine).toHaveLength(0);
      expect(state.rendered, engine).toHaveLength(0);
    }
  });

  it("fails and refunds every approved mode that is disabled before resume executes", async () => {
    const tenant = await newTenant();

    for (const [engine, feature, label] of modeCases) {
      state.disabledFeature = feature;
      state.refunds.length = 0;
      const job = await seedJob(tenant.tenantId, {
        engine,
        status: "processing",
        funding: "credit",
        options: { aspectRatio: "9:16", reviewStoryboard: true },
      });

      await resumeVideoGenerationJob(await readJob(job.id));

      const row = await readJob(job.id);
      expect(row.status, engine).toBe("failed");
      expect(row.error, engine).toContain(`${label} is currently turned off`);
      expect(state.refunds, engine).toEqual([{ tenantId: tenant.tenantId, units: 1 }]);
      expect(state.planned, engine).toHaveLength(0);
      expect(state.rendered, engine).toHaveLength(0);
    }
  });

  it("keeps the Video Studio master switch authoritative for queued and resumed jobs", async () => {
    const tenant = await newTenant();
    state.disabledFeature = "videoGen";

    const queued = await seedJob(tenant.tenantId, {
      engine: "lip_sync",
      funding: "credit",
      options: { aspectRatio: "9:16", reviewStoryboard: false },
    });
    await runVideoGenerationJob(queued.id, "credit");
    expect((await readJob(queued.id)).status).toBe("failed");
    expect((await readJob(queued.id)).error).toBe("Video Studio is currently turned off.");
    expect(state.refunds).toEqual([{ tenantId: tenant.tenantId, units: 1 }]);

    state.refunds.length = 0;
    const paused = await seedJob(tenant.tenantId, {
      engine: "topic_to_video",
      status: "processing",
      funding: "credit",
      options: { aspectRatio: "9:16", reviewStoryboard: true },
    });
    await resumeVideoGenerationJob(await readJob(paused.id));
    expect((await readJob(paused.id)).status).toBe("failed");
    expect((await readJob(paused.id)).error).toBe("Video Studio is currently turned off.");
    expect(state.refunds).toEqual([{ tenantId: tenant.tenantId, units: 1 }]);
    expect(state.planned).toHaveLength(0);
    expect(state.rendered).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * localized_dub refund path
 *
 * These tests prove that a credit-funded localized_dub job goes terminal
 * (status = "failed") AND triggers exactly one credit refund unit when the
 * orchestration throws — either from TTS/provider errors or from ffmpeg/render
 * errors. The orchestrateLocalizedDub function is mocked at its module
 * boundary; everything else (DB writes, kill-switch, funding/refund rail) runs
 * for real against the test database.
 * ------------------------------------------------------------------ */

describe("localized_dub — refund on orchestration failure", () => {
  /** A minimal valid localized_dub job seeded directly into the DB. */
  async function seedDubJob(tenantId: number) {
    return (
      await db
        .insert(videoGenerationsTable)
        .values({
          tenantId,
          engine: "localized_dub",
          status: "queued",
          funding: "credit",
          options: {
            aspectRatio: "16:9" as const,
            sourceVideoPath: `/objects/${tenantId}/uploads/source.mp4`,
            reviewStoryboard: false as const,
            localizedTrack: {
              scriptApproved: true,
              locale: "te" as const,
              voice: "nova" as const,
              cues: [
                { index: 1, startMs: 0, endMs: 2000, text: "నమస్కారం." },
                { index: 2, startMs: 2500, endMs: 5000, text: "మళ్ళీ కలుద్దాం." },
              ],
            },
          },
        })
        .returning()
    )[0]!;
  }

  it("refunds exactly one credit unit and marks the job failed when TTS/provider throws", async () => {
    const tenant = await newTenant();
    const job = await seedDubJob(tenant.tenantId);

    // Simulate a provider-level TTS error (e.g. OpenAI 503).
    state.dubError = new VideoGenProviderError("OpenAI TTS is overloaded.", 503);

    await runVideoGenerationJob(job.id, "credit");

    const row = await readJob(job.id);
    expect(row.status).toBe("failed");
    // Provider errors surface their message directly to the user.
    expect(row.error).toBe("OpenAI TTS is overloaded.");
    // Exactly one credit unit refunded — no more, no less.
    expect(state.refunds).toEqual([{ tenantId: tenant.tenantId, units: 1 }]);
    // No usage recorded (job never succeeded).
    expect(state.usage).toHaveLength(0);
  });

  it("refunds exactly one credit unit and marks the job failed when ffmpeg/render throws", async () => {
    const tenant = await newTenant();
    const job = await seedDubJob(tenant.tenantId);

    // Simulate an ffmpeg-level render error (not a VideoGenProviderError).
    // The job runner intentionally does not leak internal ffmpeg details to the
    // user — the error is logged server-side and the row gets the generic
    // "Video generation failed. Please try again." message.
    state.dubError = new Error("ffmpeg: filter graph failed: lavfi/overlay");

    await runVideoGenerationJob(job.id, "credit");

    const row = await readJob(job.id);
    expect(row.status).toBe("failed");
    expect(row.error).toBe("Video generation failed. Please try again.");
    // Exactly one credit unit refunded — the important assertion.
    expect(state.refunds).toEqual([{ tenantId: tenant.tenantId, units: 1 }]);
    expect(state.usage).toHaveLength(0);
  });

  it("surfaces CueOverrunError as the user-facing job error and refunds one unit", async () => {
    const tenant = await newTenant();
    const job = await seedDubJob(tenant.tenantId);

    // Cue 1 overruns by 400 ms — user-actionable, locked cues cannot be edited.
    state.dubError = new CueOverrunError(1, 400);

    await runVideoGenerationJob(job.id, "credit");

    const row = await readJob(job.id);
    expect(row.status).toBe("failed");
    // The overrun message should tell the user to shorten the SOURCE line,
    // not to edit the target-language field (which is locked after review).
    expect(row.error).toMatch(/cue 1/i);
    expect(row.error).toMatch(/400 ms/);
    expect(row.error).toMatch(/shorten/i);
    // One credit unit back — not zero, not two.
    expect(state.refunds).toEqual([{ tenantId: tenant.tenantId, units: 1 }]);
    expect(state.usage).toHaveLength(0);
  });
});
