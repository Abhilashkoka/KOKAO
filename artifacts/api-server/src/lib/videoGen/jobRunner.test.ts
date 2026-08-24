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
  sourceDubs: [] as string[],
  clonedSamples: [] as Buffer[],
  clonedSpeech: [] as string[],
  removedVoiceIds: [] as string[],
  dubOrchestrationCalls: [] as {
    cueTexts: string[];
    hasSpeakCue: boolean;
    hasRepairCue: boolean;
    renderVideo: boolean | undefined;
  }[],
  presenterPlans: 0,
  presenterRenders: [] as unknown[],
  presenterAssetLoads: [] as string[],
  presenterRenderError: null as unknown,
  dialogueVisuals: [] as string[],
  dialogueSpeech: [] as string[],
  lipSyncCalls: 0,
  lipSyncError: null as unknown,
  dialoguePlateDurations: [] as number[],
  videoCostDurations: [] as Array<{ model: string; durationSec: number }>,
  walletSettlements: [] as Array<{ costPaise: number | null | undefined; provider?: string }>,
  rawPlateVerifyError: null as unknown,
  dialogueNarrationDurations: [] as number[],
  dialogueStrictTrimDurations: [] as number[],
  dialogueCompositions: [] as Array<{ scenes: Array<{ text: string; narrationDurationSec: number }>; clips: number }>,
  failLipSyncCall: null as number | null,
  dialogueBrandVoice: false,
  dialogueCompositionError: null as unknown,
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
  verifyRenderedVideo: vi.fn(async (
    _buffer: Buffer,
    qa?: { label?: string; expectedDurationSec?: number },
  ) => {
    if (qa?.label === "AI-person provider plate" && state.rawPlateVerifyError) {
      throw state.rawPlateVerifyError;
    }
    return { durationSec: qa?.expectedDurationSec ?? 8 };
  }),
}));

vi.mock("./index", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./index")>();
  return {
    ...actual,
    generateVideo: vi.fn(async ({ prompt }: { prompt: string }) => {
      state.dialogueVisuals.push(prompt);
      return {
        buffer: Buffer.from("generated-ai-person-video"),
        provider: "replicate",
        model: "visual-model",
      };
    }),
  };
});

vi.mock("./topicVideo/narration", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./topicVideo/narration")>();
  return {
    ...actual,
    synthesizeNarration: vi.fn(async (sentences: string[]) => {
      state.dialogueSpeech.push(sentences.join(" "));
      return {
        wav: Buffer.from("dialogue-wav"),
        cues: [],
        totalDurationSec: 4,
      };
    }),
  };
});

vi.mock("./slideshow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./slideshow")>()),
  renderSlideshow: vi.fn(async () => ({ buffer: Buffer.from("slides"), totalSec: 4 })),
  extractPosterFrame: vi.fn(async () => Buffer.from("poster-png")),
}));

vi.mock("./postprocess", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./postprocess")>()),
  normalizeVideo: vi.fn(async (video: Buffer) => video),
  loopVideoPlateToDuration: vi.fn(async (video: Buffer, durationSec: number) => {
    state.dialoguePlateDurations.push(durationSec);
    return video;
  }),
}));

vi.mock("./characterDialogueCompose", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./characterDialogueCompose")>()),
  probeNarrationWavDurationSec: vi.fn(async () => state.dialogueNarrationDurations.shift() ?? 4),
  trimCharacterDialogueClipStrict: vi.fn(async (video: Buffer, durationSec: number) => {
    state.dialogueStrictTrimDurations.push(durationSec);
    return video;
  }),
  composeCharacterDialogue: vi.fn(async (input: {
    clips: Buffer[];
    scenes: Array<{ text: string; narrationDurationSec: number }>;
  }) => {
    if (state.dialogueCompositionError) throw state.dialogueCompositionError;
    state.dialogueCompositions.push({ clips: input.clips.length, scenes: input.scenes });
    return {
      buffer: Buffer.from("composed-character-dialogue"),
      durationSec: input.scenes.reduce((sum, scene) => sum + scene.narrationDurationSec, 0),
    };
  }),
}));

vi.mock("./characterClip", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./characterClip")>()),
  generateCharacterClip: vi.fn(async ({ prompt }: { prompt: string }) => {
    state.dialogueVisuals.push(prompt);
    return { buffer: Buffer.from("saved-character-plate"), provider: "replicate", model: "visual-model" };
  }),
}));

vi.mock("./branding", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./branding")>();
  return {
    ...actual,
    loadVideoBranding: vi.fn(async () =>
      state.dialogueBrandVoice
        ? {
            voiceHint: null, accentColor: null, watermarkPath: null, brandName: "Test",
            clonedVoice: { provider: "elevenlabs", voiceId: "saved-character-voice" },
            presetVoice: null, deliveryStyle: null,
          }
        : null,
    ),
  };
});

vi.mock("./presenterBroll", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./presenterBroll")>();
  const snapshot = () => ({
    version: 1 as const,
    durationMs: 8_000,
    lines: [
      { index: 1, startMs: 0, endMs: 4_000, text: "First presenter line." },
      { index: 2, startMs: 4_000, endMs: 8_000, text: "Closing presenter line." },
    ],
    beats: [
      {
        id: "pb1",
        startMs: 0,
        endMs: 4_000,
        query: "weekly planning desk",
        kind: "lifestyle" as const,
        opacity: 0.55,
        lineIndexes: [1],
        assetPath: null as string | null,
        previewPath: null as string | null,
        assetKind: "video" as const,
        provider: "pexels",
      },
    ],
    notes: [],
  });
  return {
    ...actual,
    resolvePresenterBrollAssets: vi.fn(async ({
      snapshot: planned,
      upload,
      onCheckpoint,
    }: {
      snapshot: ReturnType<typeof snapshot>;
      upload: (b: Buffer, t: string) => Promise<string>;
      onCheckpoint: (planned: ReturnType<typeof snapshot>) => Promise<void>;
    }) => {
      if (planned.beats.every((beat) => beat.assetPath && beat.previewPath)) return planned;
      state.presenterPlans += 1;
      const resolved = structuredClone(planned);
      resolved.beats[0]!.assetPath = await upload(Buffer.from("stock-broll"), "video/mp4");
      resolved.beats[0]!.previewPath = await upload(Buffer.from("poster"), "image/png");
      await onCheckpoint(resolved);
      return resolved;
    }),
    presenterStoryboard: vi.fn((planned: ReturnType<typeof snapshot>) => ({
      version: 1 as const,
      presenterBroll: true,
      visualsSource: "prompt" as const,
      timelineLocked: true,
      durationBounds: null,
      model: null,
      provider: planned.beats[0]?.provider ?? null,
      regenerations: 0,
      narration: null,
      scenes: planned.beats.map((beat) => ({
        id: beat.id,
        text: "",
        visual: beat.query,
        durationSec: (beat.endMs - beat.startMs) / 1000,
        previewPath: beat.previewPath,
        outfitId: null,
      })),
    })),
    syncReviewedPresenterBroll: vi.fn(async ({ snapshot: planned }: { snapshot: unknown }) => planned),
    renderPresenterBroll: vi.fn(
      async ({
        snapshot: planned,
        load,
      }: {
        snapshot: ReturnType<typeof snapshot>;
        load: (path: string, kind: "video" | "image") => Promise<Buffer>;
      }) => {
        if (state.presenterRenderError) throw state.presenterRenderError;
        state.presenterRenders.push(planned);
        for (const beat of planned.beats) {
          if (!beat.assetPath) throw new Error("presenter asset was not resolved");
          state.presenterAssetLoads.push(beat.assetPath);
          await load(beat.assetPath, beat.assetKind);
        }
        return Buffer.from("presenter-rendered-mp4");
      },
    ),
  };
});

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
      state.usage.push({
        tenantId,
        funding: meta?.funding,
        costPaise: meta?.costPaise,
      });
    },
  ),
}));

vi.mock("../aiCost", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../aiCost")>();
  return {
    ...actual,
    computeVideoCostPaise: vi.fn(async (args: {
      model: string;
      durationSec?: number | null;
    }) => {
      if (args.model === "visual-model" || args.model === "bytedance/latentsync") {
        if (typeof args.durationSec !== "number") return null;
        state.videoCostDurations.push({ model: args.model, durationSec: args.durationSec });
        return Math.round(args.durationSec * 10);
      }
      return actual.computeVideoCostPaise(args as Parameters<typeof actual.computeVideoCostPaise>[0]);
    }),
  };
});

vi.mock("../credits", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../credits")>()),
  refundCredits: vi.fn(async (tenantId: number, _kind: string, units: number) => {
    state.refunds.push({ tenantId, units });
  }),
}));

vi.mock("../wallet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../wallet")>();
  return {
    ...actual,
    settleWallet: vi.fn(async (_tenantId: number, _reservation: unknown, meta: {
      costPaise?: number | null;
      provider?: string;
    }) => {
      state.walletSettlements.push({ costPaise: meta.costPaise, provider: meta.provider });
      return { chargedPaise: meta.costPaise ?? 0, estimated: meta.costPaise == null };
    }),
  };
});

vi.mock("../localization/dub", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../localization/dub")>();
  return {
    ...actual,
    orchestrateLocalizedDub: vi.fn(async () => {
      if (state.dubError) throw state.dubError;
      return Buffer.from("dubbed-mp4");
    }),
    extractVoiceSampleWav: vi.fn(async (media: Buffer) =>
      Buffer.concat([Buffer.from("sample-wav:"), media]),
    ),
    burnSubtitles: vi.fn(async () => Buffer.from("localized-video")),
    orchestrateLocalizedDubFull: vi.fn(async (
      _video: Buffer,
      track: { cues: { index: number; startMs: number; endMs: number; text: string }[] },
      deps: {
        speakCue?: (text: string, speaker: string, selection: unknown) => Promise<Buffer>;
        repairCue?: (...args: unknown[]) => Promise<string>;
        renderVideo?: boolean;
      },
    ) => {
      if (state.dubError) throw state.dubError;
      state.dubOrchestrationCalls.push({
        cueTexts: track.cues.map((cue) => cue.text),
        hasSpeakCue: Boolean(deps.speakCue),
        hasRepairCue: Boolean(deps.repairCue),
        renderVideo: deps.renderVideo,
      });
      if (deps.speakCue && track.cues[0]) {
        await deps.speakCue(track.cues[0].text, "nova", {});
      }
      return {
        video: Buffer.from("dubbed-mp4"),
        dubTrackWav: Buffer.from("dub-track-wav"),
        finalCues: track.cues,
        repairedCueIndices: [track.cues[0]!.index],
      };
    }),
  };
});

vi.mock("../voiceClone", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../voiceClone")>();
  return {
    ...actual,
    elevenLabsDubSourceVoice: vi.fn(async (args: { targetLang: string }) => {
      state.sourceDubs.push(args.targetLang);
      return Buffer.from("elevenlabs-dubbed-media");
    }),
    speakWithClonedVoiceReceipt: vi.fn(async (
      _voice: unknown,
      text: string,
      _onReceipt?: unknown,
      _modelId?: string,
    ) => {
      state.clonedSpeech.push(text);
      return {
        audio: Buffer.from("spoken-wav"),
        receipt: { providerCredits: null, requestId: null, traceId: null },
      };
    }),
    resolveVoiceCloneApiKey: vi.fn(async () => "test-elevenlabs-key"),
    getVoiceCloneProviderDef: vi.fn((id: string) => {
      if (id !== "elevenlabs") return undefined;
      return {
        ...actual.VOICE_CLONE_PROVIDERS[0]!,
        clone: vi.fn(async ({ audio }: { audio: Buffer }) => {
          state.clonedSamples.push(audio);
          return "temporary-source-voice";
        }),
        speak: vi.fn(async ({ text }: { text: string }) => {
          state.clonedSpeech.push(text);
          return Buffer.from("spoken-wav");
        }),
        remove: vi.fn(async ({ voiceId }: { voiceId: string }) => {
          state.removedVoiceIds.push(voiceId);
        }),
      };
    }),
  };
});

vi.mock("./providers/replicate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./providers/replicate")>()),
  generateLipSyncWithReplicate: vi.fn(async () => {
    state.lipSyncCalls += 1;
    if (state.lipSyncError || state.failLipSyncCall === state.lipSyncCalls) {
      throw state.lipSyncError ?? new VideoGenProviderError("LatentSync unavailable.", 503);
    }
    return {
      buffer: Buffer.from("lip-synced-video"),
      mimeType: "video/mp4",
      provider: "replicate",
      model: "bytedance/latentsync",
    };
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

import {
  db,
  videoGenerationsTable,
  type VideoJobOptions,
  type VideoStoryboard,
} from "@workspace/db";
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
  state.sourceDubs.length = 0;
  state.clonedSamples.length = 0;
  state.clonedSpeech.length = 0;
  state.removedVoiceIds.length = 0;
  state.dubOrchestrationCalls.length = 0;
  state.presenterPlans = 0;
  state.presenterRenders.length = 0;
  state.presenterAssetLoads.length = 0;
  state.presenterRenderError = null;
  state.dialogueVisuals.length = 0;
  state.dialogueSpeech.length = 0;
  state.lipSyncCalls = 0;
  state.lipSyncError = null;
  state.dialoguePlateDurations.length = 0;
  state.videoCostDurations.length = 0;
  state.walletSettlements.length = 0;
  state.rawPlateVerifyError = null;
  state.dialogueNarrationDurations.length = 0;
  state.dialogueCompositions.length = 0;
  state.failLipSyncCall = null;
  state.dialogueBrandVoice = false;
  state.dialogueStrictTrimDurations.length = 0;
  state.dialogueCompositionError = null;
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

    const completed = await readJob(job.id);
    expect(completed.status, completed.error ?? undefined).toBe("succeeded");
    expect(state.music).toEqual([18]);
  });
});

describe("presenter-and-B-roll topic templates", () => {
  function presenterOptions(tenantId: number, reviewStoryboard: boolean): VideoJobOptions {
    return {
      aspectRatio: "9:16",
      presenterVideoPath: `/objects/${tenantId}/uploads/presenter.mp4`,
      videoTemplateId: 42,
      presenterBroll: {
        version: 1,
        durationMs: 8_000,
        lines: [
          { index: 1, startMs: 0, endMs: 4_000, text: "First presenter line." },
          { index: 2, startMs: 4_000, endMs: 8_000, text: "Closing presenter line." },
        ],
        beats: [
          {
            id: "pb1",
            startMs: 0,
            endMs: 4_000,
            query: "weekly planning desk",
            kind: "lifestyle",
            opacity: 0.55,
            lineIndexes: [1],
            assetPath: null,
            previewPath: null,
            assetKind: "video",
            provider: null,
          },
        ],
        notes: [],
      },
      visualsSource: "stock",
      stockSource: "auto",
      subtitles: true,
      captionStyle: "dynamic",
      reviewStoryboard,
    };
  }

  it("persists resolved assets before review and renders that snapshot after approval", async () => {
    const tenant = await newTenant();
    const job = await seedJob(tenant.tenantId, {
      engine: "topic_to_video",
      prompt: "First presenter line. Closing presenter line.",
      options: presenterOptions(tenant.tenantId, true),
    });

    await runVideoGenerationJob(job.id, "quota");
    const paused = await readJob(job.id);
    expect(paused.status).toBe("awaiting_review");
    expect(paused.options?.presenterBroll).toMatchObject({
      version: 1,
      durationMs: 8_000,
      beats: [{ assetPath: `/objects/${tenant.tenantId}/uploads/out-uuid` }],
    });
    expect(paused.storyboard).toMatchObject({
      timelineLocked: true,
      scenes: [{ id: "pb1", visual: "weekly planning desk" }],
    });
    expect(state.presenterPlans).toBe(1);
    expect(state.presenterRenders).toHaveLength(0);
    expect(state.usage).toHaveLength(0);

    const approved = (
      await db
        .update(videoGenerationsTable)
        .set({ status: "processing" })
        .where(eq(videoGenerationsTable.id, job.id))
        .returning()
    )[0]!;
    await resumeVideoGenerationJob(approved);

    const complete = await readJob(job.id);
    expect(complete.status).toBe("succeeded");
    expect(state.presenterPlans).toBe(1);
    expect(state.presenterRenders).toHaveLength(1);
    expect(state.presenterAssetLoads).toEqual([
      `/objects/${tenant.tenantId}/uploads/out-uuid`,
    ]);
    expect(state.usage).toHaveLength(1);
  });

  it("refunds a terminal compositor failure while retaining the resolved snapshot", async () => {
    const tenant = await newTenant();
    const job = await seedJob(tenant.tenantId, {
      engine: "topic_to_video",
      funding: "credit",
      prompt: "First presenter line. Closing presenter line.",
      options: presenterOptions(tenant.tenantId, false),
    });
    state.presenterRenderError = new VideoGenProviderError("Presenter compositor unavailable.");

    await runVideoGenerationJob(job.id, "credit");

    const failed = await readJob(job.id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("Presenter compositor unavailable.");
    expect(failed.options?.presenterBroll?.beats).toHaveLength(1);
    expect(state.presenterPlans).toBe(1);
    expect(state.refunds).toEqual([{ tenantId: tenant.tenantId, units: 1 }]);
    expect(state.usage).toHaveLength(0);
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

describe("dialogue_lip_sync runner", () => {
  function dialogueOptions(): VideoJobOptions {
    return {
      aspectRatio: "9:16",
      durationSec: 5,
      dialogue: "Welcome to the launch. Let us show you what is new.",
      voice: "nova",
      aiPersonConsent: true,
      brandKitId: null,
      reviewStoryboard: false,
    };
  }

  function savedCharacterDialogueOptions(sceneCount = 2): VideoJobOptions {
    return {
      ...dialogueOptions(),
      dialogue: "First approved Telugu scene. Second approved Telugu scene.",
      characterDialogue: {
        version: 1,
        scriptApproved: true,
        locale: "te",
        modelId: "eleven_v3",
        direction: "ltr",
        script: "Telugu",
        scriptName: "Telugu",
        fontCandidates: ["Noto Sans Telugu"],
        characterId: 41,
        outfitId: 42,
        brandKitId: 43,
        scenes: Array.from({ length: sceneCount }, (_, index) => ({
          id: `scene-${index + 1}`,
          text: `Approved Telugu scene ${index + 1}.`,
          visualPrompt: `Saved character scene ${index + 1}`,
          estimatedDurationSec: 4,
        })),
      },
    };
  }

  it("creates an AI person, voices one speaker, and runs LatentSync", async () => {
    const tenant = await newTenant();
    const job = await seedJob(tenant.tenantId, {
      engine: "dialogue_lip_sync",
      prompt: "A fictional presenter in a bright studio, speaking to camera",
      options: dialogueOptions(),
    });

    await runVideoGenerationJob(job.id, "quota");

    const row = await readJob(job.id);
    expect(row.status).toBe("succeeded");
    expect(row.stage).toBeNull();
    expect(row.error).toBeNull();
    expect(row.provider).toBe("replicate");
    expect(row.model).toBe("bytedance/latentsync");
    expect(state.dialogueVisuals).toEqual([
      "A fictional presenter in a bright studio, speaking to camera",
    ]);
    expect(state.dialogueSpeech).toEqual([
      "Welcome to the launch. Let us show you what is new.",
    ]);
    expect(state.lipSyncCalls).toBe(1);
    expect(state.dialoguePlateDurations).toEqual([5]);
    // The generated AI-person plate and LatentSync are both funded work.
    expect(state.usage).toHaveLength(2);
    expect(state.usage.map((event) => event.funding)).toEqual(["quota", "quota"]);
  });

  it("extends a short default-provider plate to a 15-second dialogue duration", async () => {
    const tenant = await newTenant();
    const job = await seedJob(tenant.tenantId, {
      engine: "dialogue_lip_sync",
      prompt: "A fictional presenter",
      options: { ...dialogueOptions(), durationSec: 15 },
    });
    await runVideoGenerationJob(job.id, "quota");
    expect((await readJob(job.id)).status).toBe("succeeded");
    // generateVideo's mocked provider clip is intentionally short; the
    // compositor, not the WAN prompt, provides the approved duration.
    expect(state.dialoguePlateDurations).toEqual([15]);
    expect(state.videoCostDurations.find((event) => event.model === "visual-model")?.durationSec)
      .toBe(8);
  });

  it("renders every frozen saved-character scene at measured narration duration and composes them", async () => {
    const tenant = await newTenant();
    state.dialogueBrandVoice = true;
    state.dialogueNarrationDurations.push(4.2, 5.7);
    const job = await seedJob(tenant.tenantId, {
      engine: "dialogue_lip_sync",
      prompt: "A saved presenter at a desk",
      options: savedCharacterDialogueOptions(),
    });

    await runVideoGenerationJob(job.id, "quota");

    const completed = await readJob(job.id);
    expect(completed.status, completed.error ?? undefined).toBe("succeeded");
    expect(state.clonedSpeech).toEqual(["Approved Telugu scene 1.", "Approved Telugu scene 2."]);
    expect(state.dialoguePlateDurations).toEqual([4.55, 6.05]);
    expect(state.dialogueStrictTrimDurations).toEqual([4.2, 5.7]);
    expect(state.lipSyncCalls).toBe(2);
    expect(state.dialogueCompositions).toEqual([{
      clips: 2,
      scenes: [
        { text: "Approved Telugu scene 1.", narrationDurationSec: 4.2 },
        { text: "Approved Telugu scene 2.", narrationDurationSec: 5.7 },
      ],
    }]);
    // Provider video is charged from the inspected raw plate, never the looped
    // plate nor the requested narration duration; lip-sync uses measured speech.
    expect(state.videoCostDurations).toEqual([
      { model: "visual-model", durationSec: 8 },
      { model: "bytedance/latentsync", durationSec: 4.2 },
      { model: "visual-model", durationSec: 8 },
      { model: "bytedance/latentsync", durationSec: 5.7 },
    ]);
  });

  it("retains partial scene events and resumes from narration and plate checkpoints", async () => {
    const tenant = await newTenant();
    state.dialogueBrandVoice = true;
    state.dialogueNarrationDurations.push(4, 5);
    state.failLipSyncCall = 2;
    const job = await seedJob(tenant.tenantId, {
      engine: "dialogue_lip_sync",
      funding: "credit",
      prompt: "A saved presenter at a desk",
      options: savedCharacterDialogueOptions(),
    });

    await runVideoGenerationJob(job.id, "credit");
    const interrupted = await readJob(job.id);
    expect(interrupted.status, interrupted.error ?? undefined).toBe("failed");
    expect(state.usage).toHaveLength(3); // scene 1 visual/lipsync + scene 2 visual
    expect(state.refunds).toEqual([{ tenantId: tenant.tenantId, units: 1 }]);
    expect(interrupted.options?.characterDialogue?.scenes[0]?.checkpoint?.lipSyncPath).toBeTruthy();
    expect(interrupted.options?.characterDialogue?.scenes[1]?.checkpoint?.narrationPath).toBeTruthy();
    expect(interrupted.options?.characterDialogue?.scenes[1]?.checkpoint?.platePath).toBeTruthy();

    expect(interrupted.options?.characterDialogue?.scenes[0]?.checkpoint?.visualEvent?.accounted).toBe(true);
    expect(interrupted.options?.characterDialogue?.scenes[0]?.checkpoint?.lipSyncEvent?.accounted).toBe(true);
    expect(interrupted.options?.characterDialogue?.scenes[1]?.checkpoint?.visualEvent?.accounted).toBe(true);

    state.failLipSyncCall = null;
    const retryOptions = structuredClone(interrupted.options!);
    retryOptions.characterDialogue!.retry = { sourceJobId: job.id, fundedUnits: 1, state: "queued" };
    const retry = await seedJob(tenant.tenantId, {
      engine: "dialogue_lip_sync", funding: "credit",
      prompt: interrupted.prompt, options: retryOptions,
    });
    await runVideoGenerationJob(retry.id, "credit");

    expect((await readJob(retry.id)).status).toBe("succeeded");
    // No scene is re-spoken or re-filmed: only the unfinished scene's lip-sync reruns.
    expect(state.clonedSpeech).toEqual(["Approved Telugu scene 1.", "Approved Telugu scene 2."]);
    expect(state.dialogueVisuals).toEqual(["Saved character scene 1", "Saved character scene 2"]);
    expect(state.lipSyncCalls).toBe(3);
    expect(state.dialogueCompositions[0]?.clips).toBe(2);
    // Three events were settled on the failed source; the child records only
    // its newly funded missing lip-sync operation.
    expect(state.usage).toHaveLength(4);
  });

  it("checkpoints MusicGen once and a zero-unit compositor retry records no prior events", async () => {
    const tenant = await newTenant();
    state.dialogueBrandVoice = true;
    state.dialogueNarrationDurations.push(4, 4);
    state.dialogueCompositionError = new VideoGenProviderError("Local subtitle composition failed.");
    const options = savedCharacterDialogueOptions();
    options.musicPrompt = "warm instrumental";
    const source = await seedJob(tenant.tenantId, {
      engine: "dialogue_lip_sync", funding: "credit",
      prompt: "A saved presenter at a desk", options,
    });

    await runVideoGenerationJob(source.id, "credit");
    const failed = await readJob(source.id);
    expect(failed.status).toBe("failed");
    expect(failed.options?.characterDialogue?.musicCheckpoint).toMatchObject({
      provider: "replicate", model: "meta/musicgen",
      event: { label: "character_dialogue_music", accounted: true },
    });
    expect(state.music).toEqual([8]);
    expect(state.usage).toHaveLength(5);

    state.dialogueCompositionError = null;
    const retryOptions = structuredClone(failed.options!);
    retryOptions.characterDialogue!.retry = { sourceJobId: source.id, fundedUnits: 0, state: "queued" };
    const retry = await seedJob(tenant.tenantId, {
      engine: "dialogue_lip_sync", funding: "quota",
      prompt: failed.prompt, options: retryOptions,
    });
    await runVideoGenerationJob(retry.id, "quota");

    expect((await readJob(retry.id)).status).toBe("succeeded");
    expect(state.music).toEqual([8]);
    expect(state.usage).toHaveLength(5);
    expect(state.clonedSpeech).toHaveLength(2);
    expect(state.dialogueVisuals).toHaveLength(2);
    expect(state.lipSyncCalls).toBe(2);
  });

  it("supports a second retry without re-accounting or regenerating checkpointed stages", async () => {
    const tenant = await newTenant();
    state.dialogueBrandVoice = true;
    state.dialogueNarrationDurations.push(4);
    state.failLipSyncCall = 1;
    const source = await seedJob(tenant.tenantId, {
      engine: "dialogue_lip_sync", funding: "credit",
      prompt: "A saved presenter", options: savedCharacterDialogueOptions(1),
    });
    await runVideoGenerationJob(source.id, "credit");
    const firstFailed = await readJob(source.id);
    expect(state.usage).toHaveLength(1);

    const firstRetryOptions = structuredClone(firstFailed.options!);
    firstRetryOptions.characterDialogue!.retry = { sourceJobId: source.id, fundedUnits: 1, state: "queued" };
    const firstRetry = await seedJob(tenant.tenantId, {
      engine: "dialogue_lip_sync", funding: "credit", prompt: source.prompt, options: firstRetryOptions,
    });
    state.failLipSyncCall = 2;
    await runVideoGenerationJob(firstRetry.id, "credit");
    const secondFailed = await readJob(firstRetry.id);
    expect(secondFailed.status).toBe("failed");
    expect(state.usage).toHaveLength(1);

    const secondRetryOptions = structuredClone(secondFailed.options!);
    secondRetryOptions.characterDialogue!.retry = { sourceJobId: firstRetry.id, fundedUnits: 1, state: "queued" };
    const secondRetry = await seedJob(tenant.tenantId, {
      engine: "dialogue_lip_sync", funding: "credit", prompt: source.prompt, options: secondRetryOptions,
    });
    state.failLipSyncCall = null;
    await runVideoGenerationJob(secondRetry.id, "credit");
    expect((await readJob(secondRetry.id)).status).toBe("succeeded");
    expect(state.clonedSpeech).toHaveLength(1);
    expect(state.dialogueVisuals).toHaveLength(1);
    expect(state.lipSyncCalls).toBe(3);
    expect(state.usage).toHaveLength(2);
  });

  it("keeps the visual usage and refunds only the unused credit when LatentSync fails", async () => {
    const tenant = await newTenant();
    const job = await seedJob(tenant.tenantId, {
      engine: "dialogue_lip_sync",
      funding: "credit",
      prompt: "A fictional presenter",
      options: dialogueOptions(),
    });
    state.lipSyncError = new VideoGenProviderError("LatentSync unavailable.", 503);

    await runVideoGenerationJob(job.id, "credit");

    expect((await readJob(job.id)).status).toBe("failed");
    expect(state.usage).toHaveLength(1);
    expect(state.refunds).toEqual([{ tenantId: tenant.tenantId, units: 1 }]);
  });

  it("settles a wallet success to the combined visual and LatentSync actual cost", async () => {
    const tenant = await newTenant();
    const job = await seedJob(tenant.tenantId, {
      engine: "dialogue_lip_sync",
      funding: "wallet",
      prompt: "A fictional presenter",
      options: dialogueOptions(),
      walletReservationId: 9001,
      walletReservedPaise: 10_000,
      walletReservedUnits: 2,
    });

    await runVideoGenerationJob(job.id, "wallet");

    expect((await readJob(job.id)).status).toBe("succeeded");
    expect(state.walletSettlements).toEqual([
      { costPaise: 120, provider: "replicate" },
    ]);
  });

  it("settles only raw visual cost when LatentSync fails for a wallet job", async () => {
    const tenant = await newTenant();
    const job = await seedJob(tenant.tenantId, {
      engine: "dialogue_lip_sync",
      funding: "wallet",
      prompt: "A fictional presenter",
      options: dialogueOptions(),
      walletReservationId: 9002,
      walletReservedPaise: 10_000,
      walletReservedUnits: 2,
    });
    state.lipSyncError = new VideoGenProviderError("LatentSync unavailable.", 503);

    await runVideoGenerationJob(job.id, "wallet");

    expect((await readJob(job.id)).status).toBe("failed");
    expect(state.walletSettlements).toEqual([
      { costPaise: 80, provider: "replicate" },
    ]);
    expect(state.usage).toHaveLength(1);
  });

  it("treats a raw-plate probe failure as partial wallet work with estimated settlement", async () => {
    const tenant = await newTenant();
    const job = await seedJob(tenant.tenantId, {
      engine: "dialogue_lip_sync",
      funding: "wallet",
      prompt: "A fictional presenter",
      options: dialogueOptions(),
      walletReservationId: 9003,
      walletReservedPaise: 10_000,
      walletReservedUnits: 2,
    });
    state.rawPlateVerifyError = new VideoGenProviderError("Could not inspect provider plate.");

    await runVideoGenerationJob(job.id, "wallet");

    expect((await readJob(job.id)).status).toBe("failed");
    expect(state.dialogueVisuals).toHaveLength(1);
    expect(state.lipSyncCalls).toBe(0);
    expect(state.usage).toHaveLength(1);
    expect(state.walletSettlements).toEqual([
      { costPaise: null, provider: "replicate" },
    ]);
  });

  it("refunds only the unused credit when raw-plate probing fails after visual success", async () => {
    const tenant = await newTenant();
    const job = await seedJob(tenant.tenantId, {
      engine: "dialogue_lip_sync",
      funding: "credit",
      prompt: "A fictional presenter",
      options: dialogueOptions(),
    });
    state.rawPlateVerifyError = new VideoGenProviderError("Could not inspect provider plate.");

    await runVideoGenerationJob(job.id, "credit");

    expect((await readJob(job.id)).status).toBe("failed");
    expect(state.usage).toHaveLength(1);
    expect(state.refunds).toEqual([{ tenantId: tenant.tenantId, units: 1 }]);
  });

  it("refuses an unconsented recovered row and refunds its video unit", async () => {
    const tenant = await newTenant();
    const job = await seedJob(tenant.tenantId, {
      engine: "dialogue_lip_sync",
      funding: "credit",
      prompt: "A generated presenter",
      options: { ...dialogueOptions(), aiPersonConsent: false },
    });

    await runVideoGenerationJob(job.id, "credit");

    const row = await readJob(job.id);
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/likeness consent/i);
    expect(row.stage).toBeNull();
    expect(state.dialogueVisuals).toHaveLength(0);
    expect(state.dialogueSpeech).toHaveLength(0);
    expect(state.lipSyncCalls).toBe(0);
    expect(state.refunds).toEqual([{ tenantId: tenant.tenantId, units: 2 }]);
  });

  it("re-checks lip-sync and Brand Voice gates before provider execution", async () => {
    const tenant = await newTenant();
    for (const feature of ["lipSync", "brandVoiceClone"]) {
      state.disabledFeature = feature;
      state.refunds.length = 0;
      const job = await seedJob(tenant.tenantId, {
        engine: "dialogue_lip_sync",
        funding: "credit",
        prompt: "A generated presenter",
        options: dialogueOptions(),
      });

      await runVideoGenerationJob(job.id, "credit");

      expect((await readJob(job.id)).status, feature).toBe("failed");
      expect(state.dialogueVisuals, feature).toHaveLength(0);
      expect(state.lipSyncCalls, feature).toBe(0);
      expect(state.refunds, feature).toEqual([{ tenantId: tenant.tenantId, units: 2 }]);
    }
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
              lipSyncConsent: true,
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
    // The automatic pass has already failed, so this asks for focused review.
    expect(row.error).toMatch(/cue 1/i);
    expect(row.error).toMatch(/400 ms/);
    expect(row.error).toMatch(/shorten/i);
    // One credit unit back — not zero, not two.
    expect(state.refunds).toEqual([{ tenantId: tenant.tenantId, units: 1 }]);
    expect(state.usage).toHaveLength(0);
  });

  it("uses ElevenLabs dubbing only to seed a temporary voice that speaks the approved cues", async () => {
    const tenant = await newTenant();
    const job = await seedDubJob(tenant.tenantId);
    const sourceVoiceOptions: VideoJobOptions = {
      ...job.options!,
      aspectRatio: job.options?.aspectRatio ?? "16:9",
      localizedTrack: {
        ...job.options!.localizedTrack!,
        voiceMode: "source_voice",
      },
    };
    await db
      .update(videoGenerationsTable)
      .set({ options: sourceVoiceOptions })
      .where(eq(videoGenerationsTable.id, job.id));

    await runVideoGenerationJob(job.id, "credit");

    const row = await readJob(job.id);
    expect(row.status).toBe("succeeded");
    expect(state.sourceDubs).toEqual(["te"]);
    expect(state.clonedSamples[0]?.toString()).toContain("elevenlabs-dubbed-media");
    expect(state.dubOrchestrationCalls).toEqual([
      {
        cueTexts: ["నమస్కారం.", "మళ్ళీ కలుద్దాం."],
        hasSpeakCue: true,
        hasRepairCue: true,
        renderVideo: false,
      },
    ]);
    expect(state.clonedSpeech).toEqual(["నమస్కారం."]);
    expect(state.removedVoiceIds).toEqual(["temporary-source-voice"]);
    expect(row.localizedResult).toMatchObject({
      locale: "te",
      voiceMode: "source_voice",
      provider: "elevenlabs",
      model: "dubbing+instant-voice",
      repairedCueIndices: [1],
      finalCues: [
        { index: 1, text: "నమస్కారం." },
        { index: 2, text: "మళ్ళీ కలుద్దాం." },
      ],
    });
    expect(state.refunds).toHaveLength(0);
    expect(state.usage).toHaveLength(1);
  });

  it("removes the temporary source voice and refunds when approved-cue synthesis fails", async () => {
    const tenant = await newTenant();
    const job = await seedDubJob(tenant.tenantId);
    const sourceVoiceOptions: VideoJobOptions = {
      ...job.options!,
      aspectRatio: job.options?.aspectRatio ?? "16:9",
      localizedTrack: {
        ...job.options!.localizedTrack!,
        voiceMode: "source_voice",
      },
    };
    await db
      .update(videoGenerationsTable)
      .set({ options: sourceVoiceOptions })
      .where(eq(videoGenerationsTable.id, job.id));
    state.dubError = new CueOverrunError(1, 250);

    await runVideoGenerationJob(job.id, "credit");

    const row = await readJob(job.id);
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/cue 1/i);
    expect(state.removedVoiceIds).toEqual(["temporary-source-voice"]);
    expect(state.refunds).toEqual([{ tenantId: tenant.tenantId, units: 1 }]);
    expect(state.usage).toHaveLength(0);
  });

  it("does not call ElevenLabs when source-voice cloning is switched off", async () => {
    const tenant = await newTenant();
    const job = await seedDubJob(tenant.tenantId);
    const sourceVoiceOptions: VideoJobOptions = {
      ...job.options!,
      aspectRatio: job.options?.aspectRatio ?? "16:9",
      localizedTrack: {
        ...job.options!.localizedTrack!,
        voiceMode: "source_voice",
      },
    };
    await db
      .update(videoGenerationsTable)
      .set({ options: sourceVoiceOptions })
      .where(eq(videoGenerationsTable.id, job.id));
    state.disabledFeature = "brandVoiceClone";

    await runVideoGenerationJob(job.id, "credit");

    const row = await readJob(job.id);
    expect(row.status).toBe("failed");
    expect(row.error).toBe("Brand voice cloning is currently turned off.");
    expect(state.sourceDubs).toHaveLength(0);
    expect(state.clonedSamples).toHaveLength(0);
    expect(state.removedVoiceIds).toHaveLength(0);
    expect(state.refunds).toEqual([{ tenantId: tenant.tenantId, units: 1 }]);
    expect(state.usage).toHaveLength(0);
  });
});
