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
  usage: [] as { tenantId: number; funding: string | undefined }[],
  refunds: [] as { tenantId: number; units: number }[],
  music: [] as number[],
}));

vi.mock("./clipStoryboard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./clipStoryboard")>();
  return {
    ...actual,
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
  verifyRenderedVideo: vi.fn(async () => {}),
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
    async (tenantId: number, _kind: string, meta?: { funding?: string }) => {
      state.usage.push({ tenantId, funding: meta?.funding });
    },
  ),
}));

vi.mock("../credits", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../credits")>()),
  refundCredits: vi.fn(async (tenantId: number, _kind: string, units: number) => {
    state.refunds.push({ tenantId, units });
  }),
}));

vi.mock("../objectStorage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../objectStorage")>();
  class FakeObjectStorageService {
    async getObjectEntityUploadURL(tenantId: number): Promise<string> {
      return `https://storage.example.com/objects/${tenantId}/uploads/out-uuid`;
    }
    normalizeObjectEntityPath(uploadURL: string): string {
      return new URL(uploadURL).pathname;
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
    expect(state.usage).toEqual([{ tenantId: tenant.tenantId, funding: "credit" }]);
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
    // One usage row per funded unit.
    expect(state.usage).toHaveLength(3);
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
