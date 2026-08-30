import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { and } from "drizzle-orm";
import {
  allowsGeneratedStoryboardPrivacyRecovery,
  hasDeferredTemplateFunding,
  topicStoryboardEligible,
} from "./jobRunner";

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
  clipCheckpointed: [] as number[],
  topicPlanMode: null as "ai" | "character" | null,
  topicSceneCount: 1,
  topicPlans: 0,
  topicRenders: 0,
  topicRenderError: null as unknown,
  topicCheckpointed: [] as number[],
  privacyRejectScene: false,
  replacementImageCalls: 0,
  walletFailureRefunds: [] as number[],
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
  presenterResolveError: null as unknown,
  qaError: null as unknown,
  normalizeError: null as unknown,
  dialogueVisuals: [] as string[],
  videoRequests: [] as Array<{ resolvedVideoModel?: unknown; mode: string }>,
  dialogueWardrobeSnapshots: [] as unknown[],
  dialogueVisualModels: [] as Array<{ provider: string; model: string }>,
  dialogueSpeech: [] as string[],
  lipSyncCalls: 0,
  lipSyncModels: [] as string[],
  lipSyncError: null as unknown,
  dialoguePlateDurations: [] as number[],
  videoCostDurations: [] as Array<{ model: string; durationSec: number }>,
  walletSettlements: [] as Array<{ costPaise: number | null | undefined; provider?: string }>,
  rawPlateVerifyError: null as unknown,
  dialogueNarrationDurations: [] as number[],
  dialogueLipSyncDurations: [] as number[],
  dialogueStrictTrimDurations: [] as number[],
  dialogueCompositions: [] as Array<{ scenes: Array<{ text: string; narrationDurationSec: number }>; clips: number }>,
  failLipSyncCall: null as number | null,
  dialogueBrandVoice: false,
  dialogueCompositionError: null as unknown,
  unpricedVideoModels: new Set<string>(),
  guidedPreviewProviderCalls: 0,
  guidedPreviewGenerationEnabled: false,
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
    renderClipStoryboard: vi.fn(async ({
      storyboard,
      onCheckpoint,
    }: {
      storyboard: { scenes: Array<{ providerCheckpoint?: unknown }> };
      onCheckpoint?: (args: {
        sceneIndex: number;
        buffer: Buffer;
        provider: string;
        model: string;
        durationSec: number;
      }) => Promise<void>;
    }) => {
      if (state.renderError) throw state.renderError;
      state.rendered.push(storyboard);
      for (const [sceneIndex, scene] of storyboard.scenes.entries()) {
        if (scene.providerCheckpoint) continue;
        state.clipCheckpointed.push(sceneIndex);
        await onCheckpoint?.({
          sceneIndex,
          buffer: Buffer.from(`scene-${sceneIndex}`),
          provider: "replicate",
          model: "veo-test",
          durationSec: 4,
        });
      }
      return {
        buffer: Buffer.from("rendered-mp4"),
        provider: "replicate",
        model: "veo-test",
        totalSec: 4,
      };
    }),
  };
});

vi.mock("./topicVideo", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./topicVideo")>();
  return {
    ...actual,
    regenerateStoryboardPreview: vi.fn(async (params: any) => {
      if (!state.guidedPreviewGenerationEnabled) {
        return actual.regenerateStoryboardPreview(params);
      }
      await params.onProviderStart?.({ attemptIndex: 0 });
      state.guidedPreviewProviderCalls += 1;
      const result = {
        buffer: Buffer.from(`guided-preview-${state.guidedPreviewProviderCalls}`),
        provider: "openai",
        model: "gpt-image-1",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
      await params.onProviderSuccess?.({ attemptIndex: 0, result });
      return params.uploadGenerated
        ? params.uploadGenerated(result)
        : params.upload(result.buffer, "image/png");
    }),
    planTopicStoryboard: vi.fn(async (params: { tenantId: number; visualsSource: string }) => {
      if (!state.topicPlanMode) return actual.planTopicStoryboard(params as never);
      state.topicPlans += 1;
      const character = state.topicPlanMode === "character";
      return {
        version: 1 as const,
        mode: character ? "character_story" as const : "standard" as const,
        visualsSource: character ? "character" : params.visualsSource,
        timelineLocked: true,
        model: "planner-test",
        provider: "test",
        regenerations: 0,
        narration: {
          audioPath: `/objects/${params.tenantId}/uploads/narration.wav`,
          totalDurationSec: 4,
          cues: [{ text: "Saved line", startSec: 0, endSec: 4 }],
        },
        scenes: Array.from({ length: state.topicSceneCount }, (_, index) => ({
          id: `topic-s${index + 1}`,
          text: "Saved line",
          visual: character ? "saved character keyframe" : "saved AI still",
          durationSec: 4,
          previewPath: `/objects/${params.tenantId}/uploads/${character ? "keyframe" : "still"}.png`,
          outfitId: character ? 2 : null,
        })),
      };
    }),
    renderTopicStoryboard: vi.fn(async (params: {
      storyboard: { scenes: Array<{ providerCheckpoint?: unknown }> };
      onPrivacyImageRejected?: (args: {
        sceneIndex: number;
        error: import("./providers/openrouter").OpenRouterInputImagePrivacyError;
      }) => Promise<Buffer>;
      onCheckpoint?: (checkpoint: {
        sceneIndex: number;
        buffer: Buffer;
        provider: string;
        model: string;
        durationSec: number;
      }) => Promise<void>;
    }) => {
      if (!state.topicPlanMode) return actual.renderTopicStoryboard(params as never);
      state.topicRenders += 1;
      if (state.topicRenderError) throw state.topicRenderError;
      if (state.privacyRejectScene) {
        if (!params.onPrivacyImageRejected) {
          throw new Error("privacy rejection recovery hook was not installed");
        }
        await params.onPrivacyImageRejected({
          sceneIndex: 0,
          error: new OpenRouterInputImagePrivacyError(1),
        });
        throw new VideoGenProviderError("Animation failed after recovered keyframe.", 503);
      }
      for (const [sceneIndex, scene] of params.storyboard.scenes.entries()) {
        if (scene.providerCheckpoint) continue;
        state.topicCheckpointed.push(sceneIndex);
        await params.onCheckpoint?.({
          sceneIndex,
          buffer: Buffer.from(`topic-scene-${sceneIndex}`),
          provider: "replicate",
          model: "topic-model",
          durationSec: 4,
        });
      }
      return {
        buffer: Buffer.from("topic-video"),
        provider: "replicate",
        model: "topic-model",
        durationSec: 4,
      };
    }),
  };
});

vi.mock("./topicVideo/aiBroll", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./topicVideo/aiBroll")>()),
  generateBrollStills: vi.fn(async () => {
    state.replacementImageCalls += 1;
    return {
      results: [{
        buffer: Buffer.from("privacy-safe-replacement"),
        provider: "openai",
        model: "gpt-image-1",
        usage: { inputTokens: 12, outputTokens: 8 },
      }],
    };
  }),
}));

vi.mock("./qaGate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./qaGate")>()),
  verifyRenderedVideo: vi.fn(async (
    _buffer: Buffer,
    qa?: { label?: string; expectedDurationSec?: number },
  ) => {
    if (state.qaError) throw state.qaError;
    if (qa?.label === "AI-person provider plate" && state.rawPlateVerifyError) {
      throw state.rawPlateVerifyError;
    }
    if (qa?.label?.includes("lip-sync provider output")) {
      return { durationSec: state.dialogueLipSyncDurations.shift() ?? 8 };
    }
    return { durationSec: qa?.expectedDurationSec ?? 8 };
  }),
  verifyRepairedVideo: vi.fn(async (
    _buffer: Buffer,
    qa: { expectedDurationSec: number },
  ) => {
    if (state.qaError) throw state.qaError;
    return { durationSec: qa.expectedDurationSec };
  }),
}));

vi.mock("./index", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./index")>();
  return {
    ...actual,
    generateVideo: vi.fn(async ({
      prompt,
      mode,
      resolvedVideoModel,
    }: {
      prompt: string;
      mode: string;
      resolvedVideoModel?: unknown;
    }) => {
      state.dialogueVisuals.push(prompt);
      state.videoRequests.push({ mode, resolvedVideoModel });
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
  normalizeVideo: vi.fn(async (video: Buffer) => {
    if (state.normalizeError) throw state.normalizeError;
    return video;
  }),
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
  generateCharacterClip: vi.fn(async ({
    prompt,
    wardrobeSnapshot,
  }: {
    prompt: string;
    wardrobeSnapshot?: unknown;
  }) => {
    state.dialogueVisuals.push(prompt);
    state.dialogueWardrobeSnapshots.push(wardrobeSnapshot);
    const selected = state.dialogueVisualModels.shift() ?? {
      provider: "replicate",
      model: "visual-model",
    };
    return { buffer: Buffer.from("saved-character-plate"), ...selected };
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
  const snapshot = (): NonNullable<
    import("@workspace/db").VideoJobOptions["presenterBroll"]
  > => ({
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
    providerEvents: [],
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
      if (state.presenterResolveError) {
        resolved.providerEvents = [
          {
            provider: "openai",
            model: "gpt-image-1",
            durationSec: null,
            requestBytes: 24,
            label: "presenter_broll_pb1_1",
            costPaise: 30,
          },
        ];
        await onCheckpoint(resolved);
        throw state.presenterResolveError;
      }
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
      provider?: string;
      model: string;
      durationSec?: number | null;
    }) => {
      if (state.unpricedVideoModels.has(args.model)) return null;
      if (
        args.model === "visual-model" ||
        args.model === "fallback-visual-model" ||
        args.model === "bytedance/latentsync" ||
        args.model === "sync/lipsync-2"
      ) {
        if (typeof args.durationSec !== "number") return null;
        state.videoCostDurations.push({ model: args.model, durationSec: args.durationSec });
        return Math.round(args.durationSec * (args.model === "fallback-visual-model" ? 20 : 10));
      }
      return actual.computeVideoCostPaise(args as Parameters<typeof actual.computeVideoCostPaise>[0]);
    }),
    isVideoModelPriced: vi.fn(async (args: { model: string }) =>
      !state.unpricedVideoModels.has(args.model)),
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
  const settle = async (
    _tenantId: number,
    _reservation: unknown,
    meta: {
      costPaise?: number | null;
      provider?: string;
    },
  ) => {
    state.walletSettlements.push({ costPaise: meta.costPaise, provider: meta.provider });
    return { chargedPaise: meta.costPaise ?? 0, estimated: meta.costPaise == null };
  };
  return {
    ...actual,
    settleWallet: vi.fn(settle),
    settleWalletDurably: vi.fn(settle),
    refundFailedVideoJobWallet: vi.fn(async (jobId: number, note: string) => {
      state.walletFailureRefunds.push(jobId);
      return actual.refundFailedVideoJobWallet(jobId, note);
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
  generateLipSyncWithReplicate: vi.fn(async (args: {
    model?: string;
    def?: { model: string };
  }) => {
    state.lipSyncCalls += 1;
    const model = args.model ?? args.def?.model ?? "bytedance/latentsync";
    state.lipSyncModels.push(model);
    if (state.lipSyncError || state.failLipSyncCall === state.lipSyncCalls) {
      throw state.lipSyncError ?? new VideoGenProviderError("LatentSync unavailable.", 503);
    }
    return {
      buffer: Buffer.from("lip-synced-video"),
      mimeType: "video/mp4",
      provider: "replicate",
      model,
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
  walletBalancesTable,
  walletLedgerTable,
  type VideoJobOptions,
  type VideoStoryboard,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTenant, deleteTenant, type TestTenant } from "../../test/dbHelpers";
import { grantCredits } from "../credits";
import { VideoGenProviderError } from "./index";
import { ImageGenProviderError } from "../imageGen";
import { OpenRouterInputImagePrivacyError } from "./providers/openrouter";
import { reserveVideoJobWalletTopUp } from "../wallet";
import {
  runVideoGenerationJob,
  isKnownFreeStockTopicRender,
  runVideoRepairJob,
  resumeVideoGenerationJob,
  fundPlannedTemplateVisualWork,
  plannedTemplateUnits,
  imageProviderFailureMessage,
  uploadToPreparedOrFreshStorage,
  runGuidedPreviewRenderJob,
  resumeInterruptedGuidedPreviewRenders,
  runGuidedSceneCorrectionJob,
  resumeInterruptedGuidedSceneCorrections,
  STORYBOARD_TTL_MS,
} from "./jobRunner";
import { guidedStoryStoryboard } from "./guidedStory";
import { waitForPendingJobs } from "../backgroundJobs";
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
  state.clipCheckpointed.length = 0;
  state.topicPlanMode = null;
  state.topicSceneCount = 1;
  state.topicPlans = 0;
  state.topicRenders = 0;
  state.topicRenderError = null;
  state.topicCheckpointed.length = 0;
  state.privacyRejectScene = false;
  state.replacementImageCalls = 0;
  state.walletFailureRefunds.length = 0;
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
  state.presenterResolveError = null;
  state.qaError = null;
  state.normalizeError = null;
  state.dialogueVisuals.length = 0;
  state.videoRequests.length = 0;
  state.dialogueWardrobeSnapshots.length = 0;
  state.dialogueVisualModels.length = 0;
  state.dialogueSpeech.length = 0;
  state.lipSyncCalls = 0;
  state.lipSyncModels.length = 0;
  state.lipSyncError = null;
  state.dialoguePlateDurations.length = 0;
  state.videoCostDurations.length = 0;
  state.walletSettlements.length = 0;
  state.rawPlateVerifyError = null;
  state.dialogueNarrationDurations.length = 0;
  state.dialogueLipSyncDurations.length = 0;
  state.dialogueCompositions.length = 0;
  state.failLipSyncCall = null;
  state.dialogueBrandVoice = false;
  state.dialogueStrictTrimDurations.length = 0;
  state.dialogueCompositionError = null;
  state.unpricedVideoModels.clear();
  state.guidedPreviewProviderCalls = 0;
  state.guidedPreviewGenerationEnabled = false;
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

describe("guided-story storyboard routing", () => {
  it("never routes an immutable guided snapshot to stock/generic b-roll", () => {
    const job = {
      engine: "topic_to_video",
      options: { visualsSource: "stock", guidedStory: { version: 1 } },
    } as any;
    expect(topicStoryboardEligible(job)).toBe("character");
    expect(hasDeferredTemplateFunding(job)).toBe(true);
  });

  it("keeps approved guided cast frames unchanged on privacy rejection", () => {
    expect(
      allowsGeneratedStoryboardPrivacyRecovery({
        mode: "guided_story",
        visualsSource: "ai_video",
      }),
    ).toBe(false);
    expect(
      allowsGeneratedStoryboardPrivacyRecovery({
        mode: "standard",
        visualsSource: "ai_video",
      }),
    ).toBe(true);
  });
});

describe("the clip storyboard pause", () => {
  it("propagates the frozen provider/model snapshot to a direct clip render", async () => {
    const tenant = await newTenant();
    const snapshot = {
      version: 1 as const,
      source: "explicit" as const,
      mode: "text" as const,
      provider: "replicate",
      model: "wan-video/wan-2.5-t2v",
      catalogModelId: "wan-2.5",
      durationSec: 5,
      resolution: "720p",
      quality: null,
      generateAudio: null,
      supportsEndFrame: true,
    };
    const job = await seedJob(tenant.tenantId, {
      options: {
        aspectRatio: "9:16",
        reviewStoryboard: false,
        modelId: "wan-2.5",
        resolvedVideoModel: snapshot,
      },
    });
    await runVideoGenerationJob(job.id, "credit");
    expect(state.videoRequests).toEqual([{ mode: "text", resolvedVideoModel: snapshot }]);
  });

  it("passes the immutable wardrobe snapshot to a direct character clip", async () => {
    const tenant = await newTenant();
    const characterSnapshot = {
      character: {
        id: 7,
        name: "Mira",
        description: "founder",
        referenceImagePath: `/objects/${tenant.tenantId}/uploads/mira.png`,
      },
      outfits: [{
        id: 3,
        name: "Red suit",
        description: "red tailored suit",
        referenceImagePath: `/objects/${tenant.tenantId}/uploads/mira-red.png`,
        isDefault: true,
      }],
    };
    const job = await seedJob(tenant.tenantId, {
      options: {
        aspectRatio: "9:16",
        reviewStoryboard: false,
        characterId: 7,
        outfitId: 3,
        characterSnapshot,
      },
    });

    await runVideoGenerationJob(job.id, "credit");

    expect(state.dialogueWardrobeSnapshots).toEqual([characterSnapshot]);
    const completed = await readJob(job.id);
    expect(completed.status, completed.error ?? "no job error").toBe("succeeded");
  });

  it("explains that partial storyboard images survive an AI provider failure", () => {
    const storyboard = {
      scenes: [
        { id: "s1", previewPath: "/objects/1/uploads/s1.png" },
        { id: "s2", previewPath: null },
      ],
    } as VideoStoryboard;

    expect(
      imageProviderFailureMessage(
        new ImageGenProviderError("OpenRouter image generation failed", 402),
        storyboard,
      ),
    ).toBe(
      "AI provider failure: the backup image provider could not fund the remaining image requests. 1 of 2 storyboard images were saved and will be reused when you retry.",
    );
  });

  it("renews an expired prepared upload target without regenerating provider bytes", async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 400 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const bytes = Buffer.from("selected-provider-frame");

    const path = await uploadToPreparedOrFreshStorage(
      77,
      "https://storage.example.com/objects/77/uploads/expired-target",
      bytes,
      "image/png",
    );

    expect(path).toBe("/objects/77/uploads/out-uuid");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({ method: "PUT" });
    expect(fetchSpy.mock.calls[1]?.[1]).toMatchObject({ method: "PUT" });
  });

  it("resumes a copied multi-scene board and meters only its missing scene", async () => {
    const tenant = await newTenant();
    const job = await seedJob(tenant.tenantId, {
      engine: "text_to_video",
      prompt: "Two shots",
      options: {
        aspectRatio: "9:16",
        shotCount: 2,
        reviewStoryboard: true,
        recovery: {
          version: 1,
          chainId: 90,
          sourceJobId: 90,
          fundedUnits: 1,
          mode: "resume",
          state: "queued",
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
            visual: "done",
            durationSec: 4,
            previewPath: null,
            outfitId: null,
            providerCheckpoint: {
              path: `/objects/${tenant.tenantId}/uploads/s1.mp4`,
              provider: "replicate",
              model: "veo-test",
              durationSec: 4,
              event: {
                eventId: "video-chain:90:storyboard_scene:s1:job:90",
                provider: "replicate",
                model: "veo-test",
                durationSec: 4,
                requestBytes: 4,
                label: "storyboard_scene:s1",
                costPaise: 5,
                accounted: true,
              },
            },
          },
          { id: "s2", text: "", visual: "missing", durationSec: 4, previewPath: null, outfitId: null },
        ],
      },
    });

    await runVideoGenerationJob(job.id, "credit");

    expect(state.clipCheckpointed).toEqual([1]);
    expect(state.usage).toHaveLength(1);
    expect((await readJob(job.id)).status).toBe("succeeded");
  });

  it("retains a charged receipt when raw provider storage fails", async () => {
    const tenant = await newTenant();
    const job = await seedJob(tenant.tenantId, {
      engine: "text_to_video",
      prompt: "Provider bytes cannot upload",
      options: { aspectRatio: "9:16", reviewStoryboard: false },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));

    await runVideoGenerationJob(job.id, "credit");

    const failed = await readJob(job.id);
    expect(failed.status).toBe("failed");
    expect(failed.options?.renderCheckpoint?.path).toBe("");
    expect(failed.options?.renderCheckpoint?.providerEvents).toHaveLength(1);
    expect(state.refunds).toEqual([]);
  });

  it("persists MusicGen receipt before a failed checkpoint upload", async () => {
    const tenant = await newTenant();
    const job = await seedJob(tenant.tenantId, {
      engine: "text_to_video",
      prompt: "Video with music",
      options: {
        aspectRatio: "9:16",
        reviewStoryboard: false,
        musicPrompt: "soft piano",
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 503 })));

    await runVideoGenerationJob(job.id, "credit");

    const failed = await readJob(job.id);
    expect(failed.options?.musicCheckpoint?.path).toBe("");
    expect(failed.options?.musicCheckpoint?.event.eventId).toContain(`job:${job.id}`);
    // Only the not-yet-called video operation is refunded.
    expect(state.refunds).toEqual([{ tenantId: tenant.tenantId, units: 1 }]);
  });

  it("keeps a priced raw text render checkpoint when normalization fails", async () => {
    const tenant = await newTenant();
    const job = await seedJob(tenant.tenantId, {
      engine: "text_to_video",
      prompt: "A saved provider clip",
      options: { aspectRatio: "9:16", reviewStoryboard: false },
    });
    state.normalizeError = new Error("ffmpeg unavailable");

    await runVideoGenerationJob(job.id, "credit");

    const failed = await readJob(job.id);
    expect(failed.status).toBe("failed");
    expect(failed.options?.renderCheckpoint).toMatchObject({
      stage: "provider_raw",
      provider: "replicate",
      model: "visual-model",
    });
    expect(failed.options?.renderCheckpoint?.path).toContain(`/objects/${tenant.tenantId}/`);
    expect(state.refunds).toEqual([]);
  });

  it("uses a complete generic render checkpoint without regenerating provider video", async () => {
    const tenant = await newTenant();
    const job = await seedJob(tenant.tenantId, {
      options: {
        aspectRatio: "9:16",
        reviewStoryboard: false,
        recovery: {
          version: 1,
          chainId: 700,
          sourceJobId: 700,
          fundedUnits: 0,
          mode: "resume",
          state: "queued",
          reusable: ["completed video render"],
          regenerated: ["final thumbnail and job finalization"],
          rendered: {
            path: `/objects/${tenant.tenantId}/uploads/complete.mp4`,
            provider: "replicate",
            model: "visual-model",
            durationSec: 4,
            providerEvents: [],
          },
        },
      },
    });

    await runVideoGenerationJob(job.id, "quota");

    expect(state.dialogueVisuals).toHaveLength(0);
    expect((await readJob(job.id)).status).toBe("succeeded");
  });

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
    expect(state.rendered).toHaveLength(1);
    expect(state.rendered[0]).toMatchObject(approved);
    const renderedPlan = state.rendered[0] as typeof approved;
    expect(renderedPlan.scenes[0]?.providerCheckpoint).toMatchObject({
      path: `/objects/${tenant.tenantId}/uploads/out-uuid`,
      provider: "replicate",
      model: "veo-test",
    });
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
    // Even without a review pause, the completed scene checkpoint is durable
    // so a later local-stage failure can resume without regenerating it.
    expect(row.storyboard).toMatchObject({
      scenes: [{
        visual: "planned shot",
        providerCheckpoint: {
          path: `/objects/${tenant.tenantId}/uploads/out-uuid`,
          provider: "replicate",
          model: "veo-test",
        },
      }],
    });
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
    expect(row.error).toBe(
      "The video provider could not complete this generation. Please try again.",
    );
    expect(row.storyboard).toMatchObject({
      scenes: [{
        visual: "planned shot",
        previewPath: `/objects/${tenant.tenantId}/uploads/planned.png`,
      }],
    });
    expect(row.storyboardExpiresAt).toBeNull();
    expect(state.usage).toHaveLength(0);
    // Three units in, three units back.
    expect(state.refunds).toEqual([{ tenantId: tenant.tenantId, units: 3 }]);

    // A recovery child receives the durable board. It renders from those saved
    // assets without invoking the planner a second time.
    state.renderError = null;
    const retry = await seedJob(tenant.tenantId, {
      options: row.options!,
      storyboard: structuredClone(row.storyboard),
    });
    await runVideoGenerationJob(retry.id, "quota");
    expect((await readJob(retry.id)).status).toBe("succeeded");
    expect(state.planned).toEqual(["prompt"]);
    expect(state.clipCheckpointed).toEqual([0]);
    expect(state.usage).toHaveLength(3);
  });

  it.each([
    ["no-review AI B-roll", "ai"],
    ["no-review Character Story", "character"],
  ] as const)(
    "persists the complete %s plan before the first scene render and reuses it",
    async (_label, mode) => {
      const tenant = await newTenant();
      state.topicPlanMode = mode;
      state.topicRenderError = new VideoGenProviderError("Failed before first topic scene.");
      const job = await seedJob(tenant.tenantId, {
        engine: "topic_to_video",
        prompt: "A saved no-review topic",
        options: {
          aspectRatio: "9:16",
          visualsSource: mode,
          reviewStoryboard: false,
          paragraphCount: 1,
          ...(mode === "character" ? { characterId: 1, outfitId: 2 } : {}),
        },
      });

      await runVideoGenerationJob(job.id, "credit");

      const failed = await readJob(job.id);
      expect(failed.status).toBe("failed");
      expect(failed.storyboard).toMatchObject({
        mode: mode === "character" ? "character_story" : "standard",
        narration: {
          audioPath: `/objects/${tenant.tenantId}/uploads/narration.wav`,
        },
        scenes: [{
          previewPath: `/objects/${tenant.tenantId}/uploads/${mode === "character" ? "keyframe" : "still"}.png`,
        }],
      });
      expect(state.topicCheckpointed).toHaveLength(0);

      state.topicRenderError = null;
      const retry = await seedJob(tenant.tenantId, {
        engine: "topic_to_video",
        prompt: job.prompt,
        options: failed.options!,
        storyboard: structuredClone(failed.storyboard),
      });
      await runVideoGenerationJob(retry.id, "quota");

      expect((await readJob(retry.id)).status).toBe("succeeded");
      expect(state.topicPlans).toBe(1);
      expect(state.topicCheckpointed).toEqual([0]);
      // Only the recovery render is metered; the failed pre-scene attempt
      // contributes no usage. Supplemental rows mirror the engine's funded
      // scene count (AI B-roll 2, Character Story 4).
      expect(state.usage).toHaveLength(mode === "character" ? 4 : 2);
    },
  );

  it("persists a future native template shortfall and tops it up without replanning", async () => {
    const tenant = await newTenant();
    state.topicPlanMode = "character";
    state.topicSceneCount = 2;
    // No template id is involved: native runtime settings are the capability,
    // so future templates follow the same plan-first path.
    const job = await seedJob(tenant.tenantId, {
      engine: "topic_to_video",
      prompt: "A future template topic",
      funding: "credit",
      options: {
        aspectRatio: "9:16",
        visualsSource: "character",
        reviewStoryboard: true,
        paragraphCount: 1,
        characterId: 1,
        outfitId: 2,
        templateRuntime: {
          durationMode: "script_derived",
          maxDurationSeconds: 60,
          speakingRateWpm: 140,
          scriptDetailLevel: "standard",
          minSceneDurationSeconds: 2,
          maxSceneDurationSeconds: 8,
          minSceneCount: 1,
          maxSceneCount: 8,
          visualStrategy: "character",
        },
        storyboardFunding: {
          version: 1,
          sceneCount: null,
          requiredUnits: null,
          fundedUnits: 1,
          planningUnits: 1,
        },
      },
    });

    await runVideoGenerationJob(job.id, "credit");
    const paused = await readJob(job.id);
    expect(paused.status).toBe("awaiting_review");
    expect(paused.storyboard?.scenes).toHaveLength(2);
    expect(paused.options?.storyboardFunding).toMatchObject({
      sceneCount: 2, requiredUnits: 2, fundedUnits: 1,
    });
    expect(state.topicPlans).toBe(1);

    await grantCredits({
      tenantId: tenant.tenantId,
      captionCredits: 0,
      imageCredits: 0,
      videoCredits: 1,
      kind: "admin_grant",
      note: "test template top-up",
    });
    const topUp = await fundPlannedTemplateVisualWork(paused, paused.storyboard!);
    expect(topUp.funded).toBe(true);
    expect(topUp.job.options?.storyboardFunding).toMatchObject({
      sceneCount: 2, requiredUnits: 2, fundedUnits: 2,
    });
    // The approve route owns the atomic awaiting_review -> processing claim.
    // Mirror that contract here before calling the resume-only runner.
    const claimed = (
      await db.update(videoGenerationsTable)
        .set({ status: "processing" })
        .where(and(
          eq(videoGenerationsTable.id, topUp.job.id),
          eq(videoGenerationsTable.status, "awaiting_review"),
        ))
        .returning()
    )[0]!;
    await resumeVideoGenerationJob(claimed);
    expect(state.topicPlans).toBe(1);
    expect(state.topicRenders).toBe(1);
  });

  it("reserves one additional unit for a durable privacy-recovery keyframe", async () => {
    const tenant = await newTenant();
    const storyboard: VideoStoryboard = {
      version: 1,
      visualsSource: "ai_video",
      timelineLocked: true,
      durationBounds: { minSec: 1, maxSec: 8 },
      model: null,
      provider: null,
      regenerations: 0,
      narration: null,
      scenes: [{
        id: "s1",
        text: "A fictional founder",
        visual: "A founder in a studio",
        durationSec: 4,
        previewPath: "/objects/preview.png",
        outfitId: null,
        privacyRecovery: {
          code: "InputImageSensitiveContentDetected.PrivacyInformation",
          status: "attempting",
          inputIndex: 1,
          originalPreviewPath: "/objects/preview.png",
        },
      }],
    };
    const job = await seedJob(tenant.tenantId, {
      engine: "topic_to_video",
      status: "processing",
      funding: "credit",
      options: {
        aspectRatio: "9:16",
        visualsSource: "ai_video",
        storyboardFunding: {
          version: 1,
          sceneCount: 1,
          requiredUnits: 2,
          fundedUnits: 2,
          planningUnits: 1,
        },
      },
      storyboard,
    });
    expect(plannedTemplateUnits(job, storyboard)).toBe(3);

    await grantCredits({
      tenantId: tenant.tenantId,
      captionCredits: 0,
      imageCredits: 0,
      videoCredits: 1,
      kind: "admin_grant",
      note: "privacy recovery test",
    });
    const funded = await fundPlannedTemplateVisualWork(job, storyboard);
    expect(funded.funded).toBe(true);
    expect(funded.job.options?.storyboardFunding).toMatchObject({
      requiredUnits: 3,
      fundedUnits: 3,
    });
  });

  it.each(["quota", "credit", "wallet"] as const)(
    "accounts a recovered generated keyframe and refunds unused %s funding exactly once",
    async (funding) => {
      const tenant = await newTenant();
      state.topicPlanMode = "ai";
      state.privacyRejectScene = true;
      const originalPath = `/objects/${tenant.tenantId}/uploads/original-keyframe.png`;
      const originalEvent = {
        eventId: "original-preview-receipt",
        provider: "openai",
        model: "gpt-image-1",
        durationSec: null,
        requestBytes: 27,
        label: "storyboard_preview:s1:attempt:1",
        costPaise: 30,
        unitWeight: 1,
      };
      const storyboard: VideoStoryboard = {
        version: 1,
        visualsSource: "ai_video",
        timelineLocked: true,
        durationBounds: { minSec: 1, maxSec: 8 },
        model: null,
        provider: null,
        regenerations: 0,
        narration: null,
        scenes: [{
          id: "s1",
          text: "A fictional founder",
          visual: "An anonymous illustrated founder in a stylized studio",
          durationSec: 4,
          previewPath: originalPath,
          previewCheckpoint: {
            targetPath: originalPath,
            status: "complete",
            selectedEventId: originalEvent.eventId,
            events: [originalEvent],
          },
          outfitId: null,
        }],
      };
      let job = await seedJob(tenant.tenantId, {
        engine: "topic_to_video",
        status: "processing",
        funding,
        options: {
          aspectRatio: "9:16",
          visualsSource: "ai_video",
          storyboardFunding: {
            version: 1,
            sceneCount: 1,
            requiredUnits: 2,
            fundedUnits: 2,
            planningUnits: 1,
          },
        },
        storyboard,
      });

      if (funding === "credit") {
        await grantCredits({
          tenantId: tenant.tenantId,
          captionCredits: 0,
          imageCredits: 0,
          videoCredits: 1,
          kind: "admin_grant",
          note: "privacy recovery orchestration test",
        });
      } else if (funding === "wallet") {
        await db.insert(walletBalancesTable)
          .values({ tenantId: tenant.tenantId, balancePaise: 1_000_000 })
          .onConflictDoUpdate({
            target: walletBalancesTable.tenantId,
            set: { balancePaise: 1_000_000 },
          });
        expect((await reserveVideoJobWalletTopUp(job.id, 2)).heldUnits).toBe(2);
        const [primaryReserve] = await db.select()
          .from(walletLedgerTable)
          .where(and(
            eq(walletLedgerTable.tenantId, tenant.tenantId),
            eq(walletLedgerTable.refKind, "videoJob"),
            eq(walletLedgerTable.refId, String(job.id)),
          ));
        const reserved = await readJob(job.id);
        job = (
          await db.update(videoGenerationsTable).set({
            walletReservationId: primaryReserve!.id,
            walletReservedPaise: reserved.walletReservedPaise,
            walletReservedUnits: 2,
          }).where(eq(videoGenerationsTable.id, job.id)).returning()
        )[0]!;
      }

      await resumeVideoGenerationJob(job);

      const failed = await readJob(job.id);
      const scene = failed.storyboard!.scenes[0]!;
      expect(failed.status).toBe("failed");
      expect(failed.error).toBe(
        "The video provider could not complete this generation. Please try again.",
      );
      expect(failed.options?.storyboardFunding).toMatchObject({
        requiredUnits: 3,
        fundedUnits: 3,
      });
      expect(scene.privacyRecovery).toMatchObject({
        code: "InputImageSensitiveContentDetected.PrivacyInformation",
        status: "complete",
        inputIndex: 1,
        originalPreviewPath: originalPath,
      });
      expect(scene.previewPath).not.toBe(originalPath);
      expect(scene.previewCheckpoint).toMatchObject({
        status: "complete",
        targetPath: scene.previewPath,
      });
      expect(scene.previewCheckpoint?.events).toHaveLength(2);
      expect(scene.previewCheckpoint?.events?.[0]).toMatchObject({
        eventId: originalEvent.eventId,
        label: originalEvent.label,
        accounted: true,
      });
      expect(scene.previewCheckpoint?.events?.[1]).toMatchObject({
        provider: "openai",
        model: "gpt-image-1",
        label: "privacy_keyframe:s1",
        unitWeight: 1,
        accounted: true,
      });
      expect(state.replacementImageCalls).toBe(1);
      expect(state.usage).toHaveLength(2);

      if (funding === "credit") {
        expect(state.refunds).toEqual([{ tenantId: tenant.tenantId, units: 1 }]);
      } else {
        expect(state.refunds).toEqual([]);
      }
      if (funding === "wallet") {
        expect(failed.walletReservedUnits).toBe(3);
        expect(state.walletFailureRefunds).toEqual([job.id]);
        const ledger = await db.select()
          .from(walletLedgerTable)
          .where(and(
            eq(walletLedgerTable.tenantId, tenant.tenantId),
            eq(walletLedgerTable.refKind, "videoJob"),
            eq(walletLedgerTable.refId, String(job.id)),
          ));
        expect(ledger.filter((entry) => entry.kind === "reserve")).toHaveLength(2);
        expect(ledger.filter((entry) => entry.kind === "refund")).toHaveLength(2);
      } else {
        expect(state.walletFailureRefunds).toEqual([]);
      }
    },
  );

  it.each(["attempting", "provider_succeeded"] as const)(
    "fails closed from a restarted privacy recovery at %s without another image call",
    async (status) => {
      const tenant = await newTenant();
      state.topicPlanMode = "ai";
      state.privacyRejectScene = true;
      const originalPath = `/objects/${tenant.tenantId}/uploads/original-keyframe.png`;
      const replacementPath = `/objects/${tenant.tenantId}/uploads/replacement-keyframe.png`;
      const originalEvent = {
        eventId: "restart-original-preview",
        provider: "openai",
        model: "gpt-image-1",
        durationSec: null,
        requestBytes: 20,
        label: "storyboard_preview:s1:attempt:1",
        costPaise: 30,
        unitWeight: 1,
      };
      const replacementEvent = {
        eventId: "restart-replacement-preview",
        provider: "openai",
        model: "gpt-image-1",
        durationSec: null,
        requestBytes: 24,
        label: "privacy_keyframe:s1",
        costPaise: 30,
        unitWeight: 1,
      };
      const providerSucceeded = status === "provider_succeeded";
      const job = await seedJob(tenant.tenantId, {
        engine: "topic_to_video",
        status: "processing",
        funding: "quota",
        options: {
          aspectRatio: "9:16",
          visualsSource: "ai_video",
          storyboardFunding: {
            version: 1,
            sceneCount: 1,
            requiredUnits: 3,
            fundedUnits: 3,
            planningUnits: 1,
          },
        },
        storyboard: {
          version: 1,
          visualsSource: "ai_video",
          timelineLocked: true,
          durationBounds: { minSec: 1, maxSec: 8 },
          model: null,
          provider: null,
          regenerations: 0,
          narration: null,
          scenes: [{
            id: "s1",
            text: "A fictional founder",
            visual: "An anonymous illustrated founder",
            durationSec: 4,
            previewPath: providerSucceeded ? replacementPath : originalPath,
            previewCheckpoint: {
              targetPath: providerSucceeded ? replacementPath : originalPath,
              status: providerSucceeded ? "provider_succeeded" : "complete",
              selectedEventId: providerSucceeded ? replacementEvent.eventId : originalEvent.eventId,
              events: providerSucceeded ? [originalEvent, replacementEvent] : [originalEvent],
            },
            privacyRecovery: {
              code: "InputImageSensitiveContentDetected.PrivacyInformation",
              status,
              inputIndex: 1,
              originalPreviewPath: originalPath,
            },
            outfitId: null,
          }],
        },
      });

      await resumeVideoGenerationJob(job);

      const failed = await readJob(job.id);
      expect(failed.status).toBe("failed");
      expect(state.replacementImageCalls).toBe(0);
      expect(state.topicRenders).toBe(1);
      // A crash/restart must fail closed: it must neither reissue the image
      // request nor rewrite the saved recovery checkpoint into a new attempt.
      expect(failed.storyboard?.scenes[0]).toMatchObject({
        previewPath: providerSucceeded ? replacementPath : originalPath,
        privacyRecovery: {
          status,
          originalPreviewPath: originalPath,
        },
      });
    },
  );

  it("regenerates a pending historical privacy keyframe before resuming the saved board", async () => {
    const tenant = await newTenant();
    state.topicPlanMode = "ai";
    const originalPath = `/objects/${tenant.tenantId}/uploads/legacy-keyframe.png`;
    const job = await seedJob(tenant.tenantId, {
      engine: "topic_to_video",
      status: "processing",
      funding: "quota",
      options: {
        aspectRatio: "9:16",
        visualsSource: "ai_video",
        storyboardFunding: {
          version: 1,
          sceneCount: 1,
          requiredUnits: 3,
          fundedUnits: 3,
          planningUnits: 0,
        },
        recovery: {
          version: 1,
          chainId: 900,
          sourceJobId: 900,
          fundedUnits: 2,
          mode: "resume",
          state: "queued",
          reusable: ["narration"],
          regenerated: ["privacy-safe keyframe for scene s1", "scene animation"],
          privacyRecovery: {
            code: "InputImageSensitiveContentDetected.PrivacyInformation",
            sceneId: "s1",
          },
        },
      },
      storyboard: {
        version: 1,
        visualsSource: "ai_video",
        timelineLocked: true,
        model: null,
        provider: null,
        regenerations: 0,
        narration: null,
        scenes: [{
          id: "s1",
          text: "A fictional founder",
          visual: "An anonymous illustrated founder",
          durationSec: 4,
          previewPath: originalPath,
          privacyRecovery: {
            code: "InputImageSensitiveContentDetected.PrivacyInformation",
            status: "pending",
            inputIndex: 1,
            originalPreviewPath: originalPath,
          },
          outfitId: null,
        }],
      },
    });

    await resumeVideoGenerationJob(job);

    const completed = await readJob(job.id);
    expect(completed.status).toBe("succeeded");
    expect(state.replacementImageCalls).toBe(1);
    expect(state.topicPlans).toBe(0);
    expect(state.topicCheckpointed).toEqual([0]);
    expect(completed.storyboard?.scenes[0]?.privacyRecovery?.status).toBe("complete");
    expect(completed.storyboard?.scenes[0]?.previewPath).not.toBe(originalPath);
  });

  it("reports the exact wallet shortfall without suggesting unusable credits", async () => {
    const tenant = await newTenant();
    await db.insert(walletBalancesTable)
      .values({ tenantId: tenant.tenantId, balancePaise: 0 })
      .onConflictDoUpdate({
        target: walletBalancesTable.tenantId,
        set: { balancePaise: 0 },
      });
    const storyboard: VideoStoryboard = {
      version: 1,
      visualsSource: "ai",
      timelineLocked: false,
      durationBounds: { minSec: 1, maxSec: 8 },
      model: null,
      provider: null,
      regenerations: 0,
      narration: null,
      scenes: [
        { id: "s1", text: "One", visual: "First", durationSec: 3, previewPath: null, outfitId: null },
        { id: "s2", text: "Two", visual: "Second", durationSec: 3, previewPath: null, outfitId: null },
      ],
    };
    const job = await seedJob(tenant.tenantId, {
      engine: "topic_to_video",
      status: "processing",
      funding: "wallet",
      walletReservedUnits: 1,
      walletReservedPaise: 42_000,
      options: {
        aspectRatio: "9:16",
        visualsSource: "ai",
        storyboardFunding: {
          version: 1,
          sceneCount: 2,
          requiredUnits: 2,
          fundedUnits: 1,
          planningUnits: 1,
        },
      },
      storyboard,
    });

    const result = await fundPlannedTemplateVisualWork(job, storyboard);

    expect(result.funded).toBe(false);
    expect(result.error).toMatch(
      /^Your storyboard needs 2 total video units and 1 remain unfunded\. Your wallet has ₹0\.00 available, but ₹[\d,]+\.\d{2} is needed\. Recharge at least ₹[\d,]+\.\d{2}, then approve again\.$/,
    );
    expect(result.error).not.toContain("add credits");
    expect(result.error).not.toContain("visual units");
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

  it("keeps review provider-free, then persists and renders assets after approval", async () => {
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
      beats: [{ assetPath: null, previewPath: null }],
    });
    expect(paused.storyboard).toMatchObject({
      timelineLocked: true,
      scenes: [{ id: "pb1", visual: "weekly planning desk" }],
    });
    expect(state.presenterPlans).toBe(0);
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
    expect(failed.error).toBe(
      "The video provider could not complete this generation. Please try again.",
    );
    expect(failed.options?.presenterBroll?.beats).toHaveLength(1);
    expect(state.presenterPlans).toBe(1);
    expect(state.refunds).toEqual([{ tenantId: tenant.tenantId, units: 1 }]);
    expect(state.usage).toHaveLength(0);
  });

  it("settles a generated B-roll event when an ordinary presenter job fails after it", async () => {
    const tenant = await newTenant();
    const options = presenterOptions(tenant.tenantId, false);
    options.visualsSource = "ai";
    state.presenterResolveError = new VideoGenProviderError("B-roll upload failed.");
    const job = await seedJob(tenant.tenantId, {
      engine: "topic_to_video",
      funding: "credit",
      prompt: "First presenter line. Closing presenter line.",
      options,
    });

    await runVideoGenerationJob(job.id, "credit");

    const failed = await readJob(job.id);
    expect(failed.status).toBe("failed");
    expect(failed.options?.presenterBroll?.providerEvents).toMatchObject([
      { label: "presenter_broll_pb1_1", costPaise: 30, accounted: true },
    ]);
    expect(state.usage).toHaveLength(1);
    expect(state.refunds).toHaveLength(0);
  });

  it("settles and reuses presenter MusicGen work after a downstream failure", async () => {
    const tenant = await newTenant();
    const options = presenterOptions(tenant.tenantId, false);
    options.musicPrompt = "warm expert explainer bed";
    state.qaError = new VideoGenProviderError("Final quality check failed.");
    const job = await seedJob(tenant.tenantId, {
      engine: "topic_to_video",
      funding: "credit",
      prompt: "First presenter line. Closing presenter line.",
      options,
    });

    await runVideoGenerationJob(job.id, "credit");

    const failed = await readJob(job.id);
    expect(failed.status).toBe("failed");
    expect(failed.options?.presenterMusicCheckpoint).toMatchObject({
      path: `/objects/${tenant.tenantId}/uploads/out-uuid`,
      event: { label: "presenter_music", accounted: true },
    });
    expect(state.music).toEqual([8]);
    expect(state.usage).toHaveLength(1);
    // The local presenter/B-roll unit is unused and returned; the MusicGen
    // unit is retained and metered.
    expect(state.refunds).toEqual([{ tenantId: tenant.tenantId, units: 1 }]);

    state.qaError = null;
    const retry = await seedJob(tenant.tenantId, {
      engine: "topic_to_video",
      prompt: "First presenter line. Closing presenter line.",
      options: failed.options!,
    });
    await runVideoGenerationJob(retry.id, "quota");
    expect((await readJob(retry.id)).status).toBe("succeeded");
    expect(state.music).toEqual([8]);
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
          visualPrompt:
            index === 0
              ? "Saved character scene 1; silent source plate, lips relaxed and closed, no speech or mouth movement; exactly one unobstructed front-facing face remains large in frame throughout"
              : `Saved character scene ${index + 1}`,
          estimatedDurationSec: 4,
        })),
      },
    };
  }

  it("pauses a saved-character dialogue before any provider work", async () => {
    const tenant = await newTenant();
    state.dialogueBrandVoice = true;
    const options = savedCharacterDialogueOptions();
    options.reviewStoryboard = true;
    options.presenterBroll = {
      version: 1,
      durationMs: 8_000,
      lines: [
        { index: 1, startMs: 0, endMs: 4_000, text: "Approved Telugu scene 1." },
        { index: 2, startMs: 4_000, endMs: 8_000, text: "Approved Telugu scene 2." },
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
    };
    const job = await seedJob(tenant.tenantId, {
      engine: "dialogue_lip_sync",
      prompt: "A saved presenter at a desk",
      options,
    });

    await runVideoGenerationJob(job.id, "quota");

    const paused = await readJob(job.id);
    expect(paused.status, paused.error ?? undefined).toBe("awaiting_review");
    expect(paused.storyboard).toMatchObject({
      mode: "character_dialogue",
      timelineLocked: true,
      narration: null,
    });
    expect(paused.storyboard?.scenes).toHaveLength(2);
    expect(paused.storyboard?.scenes[0]).toMatchObject({
      id: "scene-1",
      text: "Approved Telugu scene 1.",
      brollVisual: "weekly planning desk",
      previewPath: null,
    });
    expect(state.dialogueVisuals).toHaveLength(0);
    expect(state.clonedSpeech).toHaveLength(0);
    expect(state.lipSyncCalls).toBe(0);
    expect(state.presenterPlans).toBe(0);
    expect(state.usage).toHaveLength(0);
  });

  it("resumes the specialized dialogue renderer with reviewed visual and B-roll directions", async () => {
    const tenant = await newTenant();
    state.dialogueBrandVoice = true;
    const options = savedCharacterDialogueOptions(1);
    options.reviewStoryboard = true;
    options.presenterBroll = {
      version: 1,
      durationMs: 4_000,
      lines: [{ index: 1, startMs: 0, endMs: 4_000, text: "Approved Telugu scene 1." }],
      beats: [
        {
          id: "pb1",
          startMs: 0,
          endMs: 4_000,
          query: "old supporting visual",
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
    };
    const job = await seedJob(tenant.tenantId, {
      engine: "dialogue_lip_sync",
      prompt: "A saved presenter at a desk",
      options,
    });
    await runVideoGenerationJob(job.id, "quota");
    const paused = await readJob(job.id);
    const reviewed = structuredClone(paused.storyboard!);
    reviewed.scenes[0]!.visual = "reviewed tight frontal presenter";
    reviewed.scenes[0]!.brollVisual = "reviewed launch dashboard";
    const approved = (
      await db
        .update(videoGenerationsTable)
        .set({ status: "processing", storyboard: reviewed })
        .where(eq(videoGenerationsTable.id, job.id))
        .returning()
    )[0]!;

    await resumeVideoGenerationJob(approved);

    const completed = await readJob(job.id);
    expect(completed.status, completed.error ?? undefined).toBe("succeeded");
    expect(state.dialogueVisuals[0]).toContain("reviewed tight frontal presenter");
    expect(completed.options?.presenterBroll?.beats[0]?.query).toBe(
      "reviewed launch dashboard",
    );
    expect(state.lipSyncCalls).toBe(1);
    expect(state.dialogueCompositions).toHaveLength(1);
    expect(state.presenterPlans).toBe(1);
    expect(state.presenterRenders).toHaveLength(1);
    expect(state.rendered).toHaveLength(0);
  });

  it("retains and settles generated dialogue B-roll spend when resolution fails", async () => {
    const tenant = await newTenant();
    state.dialogueBrandVoice = true;
    state.presenterResolveError = new VideoGenProviderError("B-roll upload failed.");
    const options = savedCharacterDialogueOptions(1);
    options.reviewStoryboard = true;
    options.visualsSource = "ai";
    options.presenterBroll = {
      version: 1,
      durationMs: 4_000,
      lines: [{ index: 1, startMs: 0, endMs: 4_000, text: "Approved Telugu scene 1." }],
      beats: [
        {
          id: "pb1",
          startMs: 0,
          endMs: 4_000,
          query: "generated launch dashboard",
          kind: "data",
          opacity: 0.55,
          lineIndexes: [1],
          assetPath: null,
          previewPath: null,
          assetKind: "image",
          provider: null,
        },
      ],
      providerEvents: [],
      notes: [],
    };
    const job = await seedJob(tenant.tenantId, {
      engine: "dialogue_lip_sync",
      funding: "credit",
      prompt: "A saved presenter at a desk",
      options,
    });
    await runVideoGenerationJob(job.id, "credit");
    const paused = await readJob(job.id);
    const approved = (
      await db
        .update(videoGenerationsTable)
        .set({ status: "processing" })
        .where(eq(videoGenerationsTable.id, paused.id))
        .returning()
    )[0]!;

    await resumeVideoGenerationJob(approved);

    const failed = await readJob(job.id);
    expect(failed.status).toBe("failed");
    expect(failed.options?.presenterBroll?.providerEvents).toMatchObject([
      { label: "presenter_broll_pb1_1", costPaise: 30, accounted: true },
    ]);
    // Visual + lip-sync + generated B-roll were all completed, so no funded
    // unit is refunded and each provider event is metered exactly once.
    expect(state.usage).toHaveLength(3);
    expect(state.refunds).toHaveLength(0);
  });

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
    expect(state.dialogueVisuals).toHaveLength(1);
    expect(state.dialogueVisuals[0]).toContain(
      "A fictional presenter in a bright studio, speaking to camera",
    );
    expect(state.dialogueSpeech).toEqual([
      "Welcome to the launch. Let us show you what is new.",
    ]);
    expect(state.lipSyncCalls).toBe(1);
    expect(state.dialoguePlateDurations).toEqual([5]);
    expect(state.dialogueVisuals[0]).toContain("visibly talking naturally");
    expect(state.dialogueVisuals[0]).toContain("open-and-close lip motion");
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
    expect(state.dialogueVisuals[0]).toContain("visibly talking naturally from the first second");
    expect(state.dialogueVisuals[0]).not.toContain("lips relaxed and closed");
    expect(completed.options?.characterDialogue?.scenes[0]?.visualPrompt).toBe(state.dialogueVisuals[0]);
    expect(state.lipSyncCalls).toBe(2);
    expect(state.dialogueCompositions).toEqual([{
      clips: 2,
      scenes: [
        { text: "Approved Telugu scene 1.", narrationDurationSec: 4.2 },
        { text: "Approved Telugu scene 2.", narrationDurationSec: 5.7 },
      ],
    }]);
    // Every provider video is charged from its inspected raw output. The
    // lip-sync mock reports 8s even though narration is 4.2/5.7s, proving cost
    // attribution no longer substitutes requested or narration duration.
    expect(state.videoCostDurations).toEqual([
      { model: "visual-model", durationSec: 8 },
      { model: "bytedance/latentsync", durationSec: 8 },
      { model: "visual-model", durationSec: 8 },
      { model: "bytedance/latentsync", durationSec: 8 },
    ]);
  });

  it("keeps High Quality on Sync Labs across scenes and prices measured output duration", async () => {
    const tenant = await newTenant();
    state.dialogueBrandVoice = true;
    state.dialogueNarrationDurations.push(3.25, 4.75);
    state.dialogueLipSyncDurations.push(3.6, 5.1);
    const options = savedCharacterDialogueOptions();
    options.characterDialogue!.lipSyncModel = "sync/lipsync-2";
    const job = await seedJob(tenant.tenantId, {
      engine: "dialogue_lip_sync",
      prompt: "A saved presenter at a desk",
      options,
    });

    await runVideoGenerationJob(job.id, "quota");

    expect((await readJob(job.id)).model).toBe("sync/lipsync-2");
    expect(state.lipSyncModels).toEqual(["sync/lipsync-2", "sync/lipsync-2"]);
    expect(state.videoCostDurations.filter(({ model }) => model === "sync/lipsync-2")).toEqual([
      { model: "sync/lipsync-2", durationSec: 3.6 },
      { model: "sync/lipsync-2", durationSec: 5.1 },
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
    expect(state.dialogueVisuals).toHaveLength(2);
    expect(state.dialogueVisuals.every((prompt) => prompt.includes("visibly talking naturally from the first second"))).toBe(true);
    expect(state.dialogueVisuals.every((prompt) => !prompt.includes("lips relaxed and closed"))).toBe(true);
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
      { costPaise: 160, provider: "replicate" },
    ]);
  });

  it("classifies only known stock topic renders as free local composition", () => {
    expect(isKnownFreeStockTopicRender("topic_to_video", "stock", "pexels")).toBe(true);
    expect(isKnownFreeStockTopicRender("topic_to_video", "stock", "pixabay")).toBe(true);
    expect(isKnownFreeStockTopicRender("topic_to_video", "stock", "wikimedia")).toBe(true);
    expect(isKnownFreeStockTopicRender("topic_to_video", "ai_video", "pexels")).toBe(false);
    expect(isKnownFreeStockTopicRender("text_to_video", "stock", "pexels")).toBe(false);
    expect(isKnownFreeStockTopicRender("topic_to_video", "stock", "replicate")).toBe(false);
  });

  it("settles mixed per-scene provider models from each event's exact cost", async () => {
    const tenant = await newTenant();
    state.dialogueBrandVoice = true;
    state.dialogueNarrationDurations.push(4, 4);
    state.dialogueVisualModels.push(
      { provider: "replicate", model: "visual-model" },
      { provider: "openrouter", model: "fallback-visual-model" },
    );
    const job = await seedJob(tenant.tenantId, {
      engine: "dialogue_lip_sync",
      funding: "wallet",
      prompt: "A saved presenter at a desk",
      options: savedCharacterDialogueOptions(),
      walletReservationId: 9_011,
      walletReservedPaise: 10_000,
      walletReservedUnits: 4,
    });

    await runVideoGenerationJob(job.id, "wallet");

    expect((await readJob(job.id)).status).toBe("succeeded");
    expect(state.walletSettlements).toEqual([
      // 8s visual (80) + 8s fallback visual (160) + two 8s lip-syncs (160).
      { costPaise: 400, provider: "replicate" },
    ]);
    expect(state.videoCostDurations).toContainEqual({
      model: "fallback-visual-model",
      durationSec: 8,
    });
  });

  it("charges zero when an unpriced lip-sync model fails after the visual checkpoint", async () => {
    const tenant = await newTenant();
    state.unpricedVideoModels.add("sync/lipsync-2");
    const options = dialogueOptions();
    options.lipSyncQuality = "high";
    const job = await seedJob(tenant.tenantId, {
      engine: "dialogue_lip_sync",
      funding: "wallet",
      prompt: "A fictional presenter",
      options,
      walletReservationId: 9_012,
      walletReservedPaise: 10_000,
      walletReservedUnits: 2,
    });

    await runVideoGenerationJob(job.id, "wallet");

    expect((await readJob(job.id)).status).toBe("failed");
    expect(state.lipSyncCalls).toBe(0);
    expect(state.walletSettlements).toEqual([]);
    expect((await readJob(job.id)).spendPaise).toBe(0);
  });

  it("charges zero when LatentSync fails after wallet-funded visual work", async () => {
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
    expect(state.walletSettlements).toEqual([]);
    expect((await readJob(job.id)).spendPaise).toBe(0);
    expect(state.usage).toHaveLength(1);
  });

  it("charges zero when raw-plate probing fails after wallet-funded provider work", async () => {
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
    expect(state.walletSettlements).toEqual([]);
    expect((await readJob(job.id)).spendPaise).toBe(0);
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

  it("records deterministic diagnostics with message request ids and keeps later distinct failures", async () => {
    const tenant = await newTenant();
    state.topicPlanMode = "ai";
    const storyboard = {
      version: 1 as const,
      visualsSource: "ai_video" as const,
      timelineLocked: true,
      model: null,
      provider: null,
      regenerations: 0,
      narration: null,
      scenes: ["s1", "s2"].map((id) => ({
        id, text: `Scene ${id}`, visual: `Visual ${id}`, durationSec: 4,
        previewPath: `/objects/${tenant.tenantId}/uploads/${id}.png`, outfitId: null,
      })),
    };
    const job = await seedJob(tenant.tenantId, {
      engine: "topic_to_video",
      status: "processing",
      funding: "quota",
      options: { aspectRatio: "9:16", visualsSource: "ai_video", reviewStoryboard: true },
      storyboard,
    });
    state.topicRenderError = new VideoGenProviderError(
      "OpenRouter failed; x-request-id: request-first-1234", 503,
    );

    await resumeVideoGenerationJob(job);
    const first = await readJob(job.id);
    expect(first.providerRequestId).toBe("request-first-1234");
    expect(first.errorHistory).toEqual(expect.arrayContaining([
      expect.objectContaining({
        scope: "scene", sceneId: "s1", outcome: "stopped",
        providerRequestId: "request-first-1234",
      }),
      expect.objectContaining({ scope: "scene", sceneId: "s2", outcome: "not_attempted" }),
    ]));
    expect(first.errorHistory).toHaveLength(3);

    // A persistence/restart replay of the same failure fingerprint must not
    // multiply customer-visible diagnostics.
    await db.update(videoGenerationsTable).set({ status: "processing" })
      .where(eq(videoGenerationsTable.id, job.id));
    await resumeVideoGenerationJob(await readJob(job.id));
    expect((await readJob(job.id)).errorHistory).toHaveLength(3);

    // A separate provider attempt has a distinct correlation id and is retained.
    state.topicRenderError = new VideoGenProviderError(
      "OpenRouter failed; trace_id=request-second-5678", 503,
    );
    await db.update(videoGenerationsTable).set({ status: "processing" })
      .where(eq(videoGenerationsTable.id, job.id));
    await resumeVideoGenerationJob(await readJob(job.id));
    const second = await readJob(job.id);
    expect(second.providerRequestId).toBe("request-second-5678");
    expect(second.errorHistory).toHaveLength(6);
    expect(second.errorHistory?.filter((entry) => entry.providerRequestId === "request-second-5678"))
      .toHaveLength(2);

    // Without a provider request id, separately executed attempts still need
    // durable identities. Raw provider payloads must never become history.
    state.topicRenderError = new VideoGenProviderError(
      "provider echoed password=hunter2 token=secret signed_payload=abc input=private",
      503,
    );
    await db.update(videoGenerationsTable).set({ status: "processing" })
      .where(eq(videoGenerationsTable.id, job.id));
    await resumeVideoGenerationJob(await readJob(job.id));
    const third = await readJob(job.id);
    await db.update(videoGenerationsTable).set({ status: "processing" })
      .where(eq(videoGenerationsTable.id, job.id));
    await resumeVideoGenerationJob(await readJob(job.id));
    const fourth = await readJob(job.id);
    expect(fourth.errorHistory).toHaveLength(third.errorHistory!.length + 3);
    const noRequestFailures = fourth.errorHistory!.filter((entry) =>
      entry.scope === "scene" && entry.sceneId === "s1" &&
      entry.outcome === "stopped" && entry.providerRequestId === null
    );
    expect(new Set(noRequestFailures.map((entry) => entry.attempt)).size).toBe(2);
    expect(noRequestFailures.every((entry) =>
      entry.message === "Video generation failed. Please try again."
    )).toBe(true);
    expect(JSON.stringify(fourth.errorHistory)).not.toMatch(/hunter2|secret|signed_payload|private/);
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
    // Provider payloads are never persisted as customer-visible copy.
    expect(row.error).toBe(
      "The video provider could not complete this generation. Please try again.",
    );
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

describe("local video repair runner", () => {
  async function seedRepairJob(tenantId: number) {
    const source = (
      await db
        .insert(videoGenerationsTable)
        .values({
          tenantId,
          engine: "topic_to_video",
          status: "succeeded",
          prompt: "Saved source",
          videoPath: `/objects/${tenantId}/uploads/original.mp4`,
          spendPaise: 888,
          sourceImagePaths: [],
          options: { aspectRatio: "9:16", subtitles: true },
          storyboard: {
            version: 1,
            visualsSource: "ai_video",
            timelineLocked: true,
            regenerations: 0,
            model: "topic-model",
            provider: "replicate",
            narration: {
              audioPath: `/objects/${tenantId}/uploads/narration.wav`,
              totalDurationSec: 4,
              cues: [{ startSec: 0, endSec: 4, text: "Complete line." }],
            },
            scenes: [
              {
                id: "s1",
                text: "Complete line.",
                visual: "Saved visual",
                durationSec: 4,
                previewPath: `/objects/${tenantId}/uploads/scene.png`,
                providerCheckpoint: {
                  path: `/objects/${tenantId}/uploads/scene.mp4`,
                  provider: "replicate",
                  model: "topic-model",
                  durationSec: 4,
                  event: {
                    provider: "replicate",
                    model: "topic-model",
                    durationSec: 4,
                    requestBytes: 0,
                    label: "scene 1",
                    costPaise: 10,
                  },
                },
                outfitId: null,
              },
            ],
          },
        })
        .returning()
    )[0]!;
    return (
      await db
        .insert(videoGenerationsTable)
        .values({
          tenantId,
          engine: "topic_to_video",
          status: "queued",
          prompt: source.prompt,
          sourceImagePaths: [],
          spendPaise: 0,
          chargedRatePaise: 0,
          funding: null,
          storyboard: structuredClone(source.storyboard),
          options: {
            ...structuredClone(source.options!),
            repair: {
              version: 1,
              chainId: source.id,
              sourceJobId: source.id,
              reason: "audio_visual",
              state: "queued",
            },
          },
        })
        .returning()
    )[0]!;
  }

  it("recomposes from saved checkpoints without usage, refunds, or wallet settlement", async () => {
    const tenant = await newTenant();
    const repair = await seedRepairJob(tenant.tenantId);
    state.topicPlanMode = "ai";
    await runVideoRepairJob(repair.id);
    const row = await readJob(repair.id);
    expect(row).toMatchObject({
      status: "succeeded",
      provider: "ffmpeg",
      model: "local-recomposition",
      spendPaise: 0,
    });
    expect(row.videoPath).toMatch(new RegExp(`/objects/${tenant.tenantId}/uploads/`));
    expect(row.options?.repair?.state).toBe("succeeded");
    expect(state.topicRenders).toBe(1);
    expect(state.topicCheckpointed).toEqual([]);
    expect(state.usage).toEqual([]);
    expect(state.refunds).toEqual([]);
    expect(state.walletSettlements).toEqual([]);
  });

  it("keeps repair output unpublished when strict validation fails", async () => {
    const tenant = await newTenant();
    const repair = await seedRepairJob(tenant.tenantId);
    state.topicPlanMode = "ai";
    state.qaError = new VideoGenProviderError(
      "The repaired video's audio and picture do not start together. The original video is still available.",
    );
    await runVideoRepairJob(repair.id);
    const row = await readJob(repair.id);
    expect(row.status).toBe("failed");
    expect(row.videoPath).toBeNull();
    expect(row.options?.repair?.state).toBe("failed");
    expect(row.error).toMatch(/original video is still available/i);
    expect(state.usage).toEqual([]);
    expect(state.walletSettlements).toEqual([]);
  });
});

describe("Guided Story preview-only runner", () => {
  function guidedSnapshot(tenantId: number, sceneCount = 2) {
    const scenes = Array.from({ length: sceneCount }, (_, index) => ({
      id: `scene-${index + 1}`,
      startMs: index * 10_000,
      endMs: (index + 1) * 10_000,
      visualDirection: `The hero completes rescue step ${index + 1}.`,
      roleIds: ["hero"],
      lines: [{
        id: `line-${index + 1}`,
        ownerRoleId: "hero",
        kind: "dialogue" as const,
        text: `We will complete rescue step ${index + 1} safely together.`,
        startMs: index * 10_000,
        endMs: (index + 1) * 10_000,
      }],
    }));
    return {
      version: 1 as const,
      draftId: 1,
      draftRevision: 1,
      scriptApprovedAt: "2025-01-01T00:00:00.000Z",
      platform: {
        id: "tiktok",
        aspectRatio: "9:16" as const,
        width: 1080,
        height: 1920,
        safeArea: "center",
        durationSeconds: sceneCount * 10,
      },
      script: {
        version: 1 as const,
        title: "Rescue",
        logline: "A hero helps.",
        runtimeSeconds: sceneCount * 10,
        warnings: [],
        roles: [{ id: "hero", name: "Hero", description: "A fictional hero" }],
        scenes,
      },
      cast: [{
        roleId: "hero",
        source: "saved" as const,
        characterId: 1,
        outfitId: 2,
        brandKitId: 3,
        voiceId: "voice",
        character: {
          name: "Hero",
          description: "A fictional hero",
          referenceImagePath: `/objects/${tenantId}/hero.png`,
        },
        outfit: {
          name: "Coat",
          description: "A red coat",
          referenceImagePath: `/objects/${tenantId}/coat.png`,
        },
        voice: {
          id: "voice",
          label: "Voice",
          provider: "elevenlabs",
          providerVoiceId: "provider-voice",
        },
        isUserRole: true,
        consentGranted: true,
      }],
      castApprovals: {
        version: 1 as const,
        draftRevision: 1,
        roles: {
          hero: {
            roleId: "hero",
            approvedAt: "2025-01-01T00:00:00.000Z",
            character: {
              referenceImagePath: `/objects/${tenantId}/hero.png`,
              sha256: "a".repeat(64),
            },
            outfit: {
              referenceImagePath: `/objects/${tenantId}/coat.png`,
              sha256: "b".repeat(64),
            },
          },
        },
      },
    };
  }

  async function seedGuidedPreviewJob(params: {
    tenantId: number;
    sceneCount?: number;
    funding?: "quota" | "credit" | "wallet" | null;
    operationState?: "queued" | "running";
  }) {
    const snapshot = guidedSnapshot(params.tenantId, params.sceneCount);
    const storyboard = guidedStoryStoryboard(snapshot);
    const requestedAt = new Date().toISOString();
    const job = await seedJob(params.tenantId, {
      engine: "topic_to_video",
      status: "awaiting_review",
      funding: params.funding === undefined ? "quota" : params.funding,
      storyboard,
      options: {
        aspectRatio: "9:16",
        guidedStory: snapshot,
        guidedPreviewRender: {
          version: 1,
          operationId: `guided-preview-test-${Date.now()}-${Math.random()}`,
          state: params.operationState ?? "queued",
          total: storyboard.scenes.length,
          completed: 0,
          error: null,
          requestedAt,
          startedAt: params.operationState === "running" ? requestedAt : null,
          finishedAt: null,
        },
      },
    });
    return { job, snapshot, storyboard };
  }

  it("fails legacy preview operations closed before a provider call", async () => {
    const tenant = await newTenant();
    const seeded = await seedGuidedPreviewJob({ tenantId: tenant.tenantId });
    const legacyOptions = structuredClone(seeded.job.options!);
    delete legacyOptions.guidedStory!.castApprovals;
    await db.update(videoGenerationsTable).set({ options: legacyOptions })
      .where(eq(videoGenerationsTable.id, seeded.job.id));

    await runGuidedPreviewRenderJob(seeded.job.id);

    const saved = await readJob(seeded.job.id);
    expect(saved.options!.guidedPreviewRender).toMatchObject({
      state: "failed",
      error: expect.stringMatching(/review and approve every character and outfit/i),
    });
    expect(state.guidedPreviewProviderCalls).toBe(0);
  });

  it("reuses completed checkpoints without starting a final render", async () => {
    const tenant = await newTenant();
    const snapshot = {
      version: 1 as const,
      draftId: 1,
      draftRevision: 1,
      scriptApprovedAt: "2025-01-01T00:00:00.000Z",
      platform: {
        id: "tiktok",
        aspectRatio: "9:16" as const,
        width: 1080,
        height: 1920,
        safeArea: "center",
        durationSeconds: 10,
      },
      script: {
        version: 1 as const,
        title: "Rescue",
        logline: "A hero helps.",
        runtimeSeconds: 10,
        warnings: [],
        roles: [{ id: "hero", name: "Hero", description: "A fictional hero" }],
        scenes: [{
          id: "scene-one",
          startMs: 0,
          endMs: 10_000,
          visualDirection: "The hero carries supplies through the town.",
          roleIds: ["hero"],
          lines: [{
            id: "line-one",
            ownerRoleId: "hero",
            kind: "dialogue" as const,
            text: "We will bring these supplies to everyone who needs them.",
            startMs: 0,
            endMs: 10_000,
          }],
        }],
      },
      cast: [{
        roleId: "hero",
        source: "saved" as const,
        characterId: 1,
        outfitId: 2,
        brandKitId: 3,
        voiceId: "voice",
        character: {
          name: "Hero",
          description: "A fictional hero",
          referenceImagePath: `/objects/${tenant.tenantId}/hero.png`,
        },
        outfit: {
          name: "Coat",
          description: "A red coat",
          referenceImagePath: `/objects/${tenant.tenantId}/coat.png`,
        },
        voice: {
          id: "voice",
          label: "Voice",
          provider: "elevenlabs",
          providerVoiceId: "provider-voice",
        },
        isUserRole: true,
        consentGranted: true,
      }],
      castApprovals: {
        version: 1 as const,
        draftRevision: 1,
        roles: {
          hero: {
            roleId: "hero",
            approvedAt: "2025-01-01T00:00:00.000Z",
            character: {
              referenceImagePath: `/objects/${tenant.tenantId}/hero.png`,
              sha256: "a".repeat(64),
            },
            outfit: {
              referenceImagePath: `/objects/${tenant.tenantId}/coat.png`,
              sha256: "b".repeat(64),
            },
          },
        },
      },
    };
    const storyboard = guidedStoryStoryboard(snapshot);
    storyboard.scenes[0]!.previewPath = `/objects/${tenant.tenantId}/complete.png`;
    storyboard.scenes[0]!.previewCheckpoint = {
      targetPath: storyboard.scenes[0]!.previewPath!,
      status: "complete",
    };
    const requestedAt = new Date().toISOString();
    const job = await seedJob(tenant.tenantId, {
      engine: "topic_to_video",
      status: "awaiting_review",
      funding: "quota",
      storyboard,
      options: {
        aspectRatio: "9:16",
        guidedStory: snapshot,
        guidedPreviewRender: {
          version: 1,
          operationId: "guided-preview-test",
          state: "queued",
          total: 1,
          completed: 1,
          error: null,
          requestedAt,
          startedAt: null,
          finishedAt: null,
        },
      },
    });

    await runGuidedPreviewRenderJob(job.id);
    const saved = await readJob(job.id);
    expect(saved.status).toBe("awaiting_review");
    expect(saved.storyboard!.scenes[0]!.previewPath).toBe(
      `/objects/${tenant.tenantId}/complete.png`,
    );
    expect(saved.options!.guidedPreviewRender).toMatchObject({
      state: "succeeded",
      total: 1,
      completed: 1,
      error: null,
    });
    expect(state.topicRenders).toBe(0);
    expect(state.usage).toEqual([]);
    expect(state.walletSettlements).toEqual([]);
  });

  it("promotes a legacy saved preview without changing or regenerating it", async () => {
    const tenant = await newTenant();
    const seeded = await seedGuidedPreviewJob({ tenantId: tenant.tenantId });
    const legacyPath = `/objects/${tenant.tenantId}/legacy-guided-preview.png`;
    seeded.storyboard.scenes[0]!.previewPath = legacyPath;
    seeded.storyboard.scenes[0]!.previewCheckpoint = null;
    seeded.storyboard.scenes[1]!.previewPath = `/objects/${tenant.tenantId}/complete.png`;
    seeded.storyboard.scenes[1]!.previewCheckpoint = {
      targetPath: seeded.storyboard.scenes[1]!.previewPath!,
      status: "complete",
    };
    await db.update(videoGenerationsTable).set({
      storyboard: seeded.storyboard,
      options: {
        ...seeded.job.options!,
        guidedPreviewRender: {
          ...seeded.job.options!.guidedPreviewRender!,
          completed: 2,
        },
      },
    }).where(eq(videoGenerationsTable.id, seeded.job.id));

    await runGuidedPreviewRenderJob(seeded.job.id);

    const saved = await readJob(seeded.job.id);
    expect(saved.storyboard!.scenes[0]).toMatchObject({
      previewPath: legacyPath,
      previewCheckpoint: { targetPath: legacyPath, status: "complete" },
    });
    expect(state.guidedPreviewProviderCalls).toBe(0);
    expect(saved.options!.guidedPreviewRender?.state).toBe("succeeded");
    expect(state.usage).toEqual([]);
    expect(state.walletSettlements).toEqual([]);
  });

  it.each([
    { label: "all missing", completedBefore: 0, expectedCalls: 2 },
    { label: "partially complete", completedBefore: 1, expectedCalls: 1 },
  ])("renders only missing frames when $label and preserves immutable cast fingerprints", async ({
    completedBefore,
    expectedCalls,
  }) => {
    const tenant = await newTenant();
    const seeded = await seedGuidedPreviewJob({ tenantId: tenant.tenantId });
    const originalSnapshot = structuredClone(seeded.snapshot);
    const originalFingerprints = seeded.storyboard.scenes.map(
      (scene) => scene.guidedStory!.inputFingerprint,
    );
    if (completedBefore) {
      seeded.storyboard.scenes[0]!.previewPath =
        `/objects/${tenant.tenantId}/kept.png`;
      seeded.storyboard.scenes[0]!.previewCheckpoint = {
        targetPath: seeded.storyboard.scenes[0]!.previewPath!,
        status: "complete",
      };
      await db.update(videoGenerationsTable).set({
        storyboard: seeded.storyboard,
        options: {
          ...seeded.job.options!,
          guidedPreviewRender: {
            ...seeded.job.options!.guidedPreviewRender!,
            completed: completedBefore,
          },
        },
      }).where(eq(videoGenerationsTable.id, seeded.job.id));
    }
    state.guidedPreviewGenerationEnabled = true;

    await runGuidedPreviewRenderJob(seeded.job.id);

    const saved = await readJob(seeded.job.id);
    expect(saved.status).toBe("awaiting_review");
    expect(saved.storyboard!.scenes.every((scene) =>
      scene.previewCheckpoint?.status === "complete" &&
      scene.previewPath === scene.previewCheckpoint.targetPath,
    )).toBe(true);
    if (completedBefore) {
      expect(saved.storyboard!.scenes[0]!.previewPath).toBe(
        `/objects/${tenant.tenantId}/kept.png`,
      );
    } else {
      expect(saved.storyboard!.scenes[0]!.previewPath).toEqual(expect.any(String));
    }
    expect(state.guidedPreviewProviderCalls).toBe(expectedCalls);
    expect(saved.options!.guidedStory).toEqual(originalSnapshot);
    expect(saved.storyboard!.scenes.map(
      (scene) => scene.guidedStory!.inputFingerprint,
    )).toEqual(originalFingerprints);
    expect(saved.options!.guidedPreviewRender).toMatchObject({
      state: "succeeded",
      completed: 2,
      total: 2,
    });
    expect(state.topicRenders).toBe(0);
    expect(state.usage).toEqual([]);
    expect(state.walletSettlements).toEqual([]);
  });

  it("fails closed at provider_started without another provider call", async () => {
    const tenant = await newTenant();
    const seeded = await seedGuidedPreviewJob({
      tenantId: tenant.tenantId,
      sceneCount: 1,
    });
    seeded.storyboard.scenes[0]!.previewCheckpoint = {
      targetPath: `/objects/${tenant.tenantId}/uncertain.png`,
      status: "provider_started",
    };
    await db.update(videoGenerationsTable).set({ storyboard: seeded.storyboard })
      .where(eq(videoGenerationsTable.id, seeded.job.id));
    state.guidedPreviewGenerationEnabled = true;

    await runGuidedPreviewRenderJob(seeded.job.id);

    const saved = await readJob(seeded.job.id);
    expect(saved.options!.guidedPreviewRender).toMatchObject({
      state: "failed",
      completed: 0,
    });
    expect(saved.error).toMatch(/uncertain provider outcome/i);
    expect(saved.storyboard!.scenes[0]!.previewCheckpoint?.status)
      .toBe("provider_started");
    expect(state.guidedPreviewProviderCalls).toBe(0);
    expect(state.usage).toEqual([]);
    expect(state.walletSettlements).toEqual([]);
  });

  it("uses an existing valid wallet hold without wallet settlement or usage", async () => {
    const tenant = await newTenant();
    const seeded = await seedGuidedPreviewJob({
      tenantId: tenant.tenantId,
      sceneCount: 1,
      funding: "wallet",
    });
    await db.update(videoGenerationsTable).set({
      walletReservationId: 987_654,
      walletReservedUnits: 10,
      walletReservedPaise: 10_000,
    }).where(eq(videoGenerationsTable.id, seeded.job.id));
    state.guidedPreviewGenerationEnabled = true;

    await runGuidedPreviewRenderJob(seeded.job.id);

    const saved = await readJob(seeded.job.id);
    expect(saved.options!.guidedPreviewRender?.state).toBe("succeeded");
    expect(state.guidedPreviewProviderCalls).toBe(1);
    expect(state.usage).toEqual([]);
    expect(state.walletSettlements).toEqual([]);
    expect(state.refunds).toEqual([]);
  });

  it("reconciles provider_succeeded storage without another provider call", async () => {
    const tenant = await newTenant();
    const seeded = await seedGuidedPreviewJob({
      tenantId: tenant.tenantId,
      sceneCount: 1,
    });
    const targetPath = `/objects/${tenant.tenantId}/provider-result.png`;
    seeded.storyboard.scenes[0]!.previewCheckpoint = {
      targetPath,
      status: "provider_succeeded",
      events: [{
        eventId: "receipt-1",
        provider: "openai",
        model: "gpt-image-1",
        durationSec: null,
        requestBytes: 20,
        label: "storyboard_preview:scene-1:attempt:1",
        costPaise: 10,
        unitWeight: 1,
      }],
    };
    await db.update(videoGenerationsTable).set({ storyboard: seeded.storyboard })
      .where(eq(videoGenerationsTable.id, seeded.job.id));
    state.guidedPreviewGenerationEnabled = true;

    await runGuidedPreviewRenderJob(seeded.job.id);

    const saved = await readJob(seeded.job.id);
    expect(saved.options!.guidedPreviewRender?.state).toBe("succeeded");
    expect(saved.storyboard!.scenes[0]).toMatchObject({
      previewPath: targetPath,
      previewCheckpoint: { targetPath, status: "complete" },
    });
    expect(state.guidedPreviewProviderCalls).toBe(0);
    expect(state.usage).toEqual([]);
    expect(state.walletSettlements).toEqual([]);
  });

  it("treats a complete checkpoint with a mismatched target as missing", async () => {
    const tenant = await newTenant();
    const seeded = await seedGuidedPreviewJob({
      tenantId: tenant.tenantId,
      sceneCount: 1,
    });
    seeded.storyboard.scenes[0]!.previewPath =
      `/objects/${tenant.tenantId}/wrong.png`;
    seeded.storyboard.scenes[0]!.previewCheckpoint = {
      targetPath: `/objects/${tenant.tenantId}/expected.png`,
      status: "complete",
    };
    await db.update(videoGenerationsTable).set({ storyboard: seeded.storyboard })
      .where(eq(videoGenerationsTable.id, seeded.job.id));
    state.guidedPreviewGenerationEnabled = true;

    await runGuidedPreviewRenderJob(seeded.job.id);

    const saved = await readJob(seeded.job.id);
    expect(saved.options!.guidedPreviewRender?.state).toBe("succeeded");
    expect(saved.storyboard!.scenes[0]!.previewPath).toBe(
      saved.storyboard!.scenes[0]!.previewCheckpoint!.targetPath,
    );
    expect(saved.storyboard!.scenes[0]!.previewPath).not.toBe(
      `/objects/${tenant.tenantId}/wrong.png`,
    );
    expect(state.guidedPreviewProviderCalls).toBe(1);
    expect(state.usage).toEqual([]);
    expect(state.walletSettlements).toEqual([]);
  });

  it.each([
    {
      label: "missing funding identity",
      mutate: (job: Awaited<ReturnType<typeof seedJob>>) => ({
        funding: null,
        options: job.options!,
      }),
    },
    {
      label: "insufficient persisted storyboard funding",
      mutate: (job: Awaited<ReturnType<typeof seedJob>>) => ({
        funding: "quota" as const,
        options: {
          ...job.options!,
          storyboardFunding: {
            version: 1 as const,
            sceneCount: 1,
            requiredUnits: 4,
            fundedUnits: 1,
            planningUnits: 1,
          },
        },
      }),
    },
    {
      label: "invalid wallet reservation",
      mutate: (job: Awaited<ReturnType<typeof seedJob>>) => ({
        funding: "wallet" as const,
        walletReservationId: null,
        walletReservedUnits: 0,
        options: job.options!,
      }),
    },
  ])("fails before provider work for $label", async ({ mutate }) => {
    const tenant = await newTenant();
    const seeded = await seedGuidedPreviewJob({
      tenantId: tenant.tenantId,
      sceneCount: 1,
    });
    await db.update(videoGenerationsTable).set(mutate(seeded.job))
      .where(eq(videoGenerationsTable.id, seeded.job.id));
    state.guidedPreviewGenerationEnabled = true;

    await runGuidedPreviewRenderJob(seeded.job.id);

    const saved = await readJob(seeded.job.id);
    expect(saved.options!.guidedPreviewRender?.state).toBe("failed");
    expect(saved.error).toMatch(/reservation is invalid or insufficient/i);
    expect(saved.storyboard!.scenes[0]!.previewCheckpoint).toBeFalsy();
    expect(state.guidedPreviewProviderCalls).toBe(0);
    expect(state.usage).toEqual([]);
    expect(state.walletSettlements).toEqual([]);
  });

  it("marks interrupted running operations failed and recovers queued work once", async () => {
    const tenant = await newTenant();
    const running = await seedGuidedPreviewJob({
      tenantId: tenant.tenantId,
      sceneCount: 1,
      operationState: "running",
    });
    const queued = await seedGuidedPreviewJob({
      tenantId: tenant.tenantId,
      sceneCount: 1,
      operationState: "queued",
    });
    state.guidedPreviewGenerationEnabled = true;

    await Promise.all([
      resumeInterruptedGuidedPreviewRenders(),
      resumeInterruptedGuidedPreviewRenders(),
    ]);
    await waitForPendingJobs();

    const runningSaved = await readJob(running.job.id);
    const queuedSaved = await readJob(queued.job.id);
    expect(runningSaved.options!.guidedPreviewRender).toMatchObject({
      state: "failed",
    });
    expect(runningSaved.error).toMatch(/interrupted by a server restart/i);
    expect(queuedSaved.options!.guidedPreviewRender).toMatchObject({
      state: "succeeded",
      completed: 1,
    });
    expect(state.guidedPreviewProviderCalls).toBe(1);
    expect(state.usage).toEqual([]);
    expect(state.walletSettlements).toEqual([]);
  });

  it("replaces only the selected Guided preview and does not call the provider twice", async () => {
    const tenant = await newTenant();
    const seeded = await seedGuidedPreviewJob({
      tenantId: tenant.tenantId,
      sceneCount: 2,
    });
    const originalSnapshot = structuredClone(seeded.snapshot);
    for (const [index, scene] of seeded.storyboard.scenes.entries()) {
      scene.previewPath = `/objects/${tenant.tenantId}/original-${index + 1}.png`;
      scene.previewCheckpoint = {
        targetPath: scene.previewPath,
        status: "complete",
      };
    }
    const selected = seeded.storyboard.scenes[0]!;
    const untouchedPath = seeded.storyboard.scenes[1]!.previewPath;
    const originalFingerprint = selected.guidedStory!.inputFingerprint;
    selected.guidedStory!.inconsistencyFlags = ["user_reported:costume"];
    selected.guidedStory!.corrections = {
      version: 1,
      attempts: [{
        id: "guided-correction-test",
        version: 1,
        category: "costume",
        note: "Keep the approved red coat.",
        state: "queued",
        inputFingerprint: originalFingerprint,
        originalPreviewPath: selected.previewPath!,
        replacementPath: null,
        funding: "quota",
        walletReservation: null,
        walletOperationId: null,
        provider: null,
        model: null,
        knownCostPaise: null,
        actualCostPaise: null,
        error: null,
        requestedAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
      }],
    };
    await db.update(videoGenerationsTable).set({
      storyboard: seeded.storyboard,
      options: { ...seeded.job.options!, guidedPreviewRender: null },
    }).where(eq(videoGenerationsTable.id, seeded.job.id));
    state.guidedPreviewGenerationEnabled = true;

    await runGuidedSceneCorrectionJob(
      seeded.job.id,
      selected.id,
      "guided-correction-test",
    );
    await runGuidedSceneCorrectionJob(
      seeded.job.id,
      selected.id,
      "guided-correction-test",
    );

    const saved = await readJob(seeded.job.id);
    const corrected = saved.storyboard!.scenes[0]!;
    expect(state.guidedPreviewProviderCalls).toBe(1);
    expect(corrected.previewPath).not.toBe(selected.previewPath);
    expect(corrected.previewCheckpoint).toMatchObject({
      targetPath: corrected.previewPath,
      status: "complete",
    });
    expect(saved.storyboard!.scenes[1]!.previewPath).toBe(untouchedPath);
    expect(corrected.guidedStory!.inputFingerprint).toBe(originalFingerprint);
    expect(saved.options!.guidedStory).toEqual(originalSnapshot);
    expect(corrected.guidedStory!.inconsistencyFlags).toEqual([]);
    expect(corrected.guidedStory!.corrections!.attempts[0]).toMatchObject({
      state: "succeeded",
      replacementPath: corrected.previewPath,
      provider: "openai",
      model: "gpt-image-1",
    });
    expect(state.usage).toHaveLength(1);
  });

  it("resumes a durably uploaded correction without another provider call", async () => {
    const tenant = await newTenant();
    const seeded = await seedGuidedPreviewJob({
      tenantId: tenant.tenantId,
      sceneCount: 1,
    });
    const scene = seeded.storyboard.scenes[0]!;
    scene.previewPath = `/objects/${tenant.tenantId}/original.png`;
    scene.previewCheckpoint = { targetPath: scene.previewPath, status: "complete" };
    const replacementPath = `/objects/${tenant.tenantId}/replacement.png`;
    scene.guidedStory!.inconsistencyFlags = ["user_reported:character"];
    scene.guidedStory!.corrections = {
      version: 1,
      attempts: [{
        id: "guided-correction-resume",
        version: 1,
        category: "character",
        note: "Match the approved face.",
        state: "provider_succeeded",
        inputFingerprint: scene.guidedStory!.inputFingerprint,
        originalPreviewPath: scene.previewPath,
        replacementPath,
        funding: "quota",
        walletReservation: null,
        walletOperationId: null,
        provider: "openai",
        model: "gpt-image-1",
        knownCostPaise: null,
        actualCostPaise: 25,
        error: null,
        requestedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        finishedAt: null,
      }],
    };
    await db.update(videoGenerationsTable).set({
      storyboard: seeded.storyboard,
      options: { ...seeded.job.options!, guidedPreviewRender: null },
    }).where(eq(videoGenerationsTable.id, seeded.job.id));
    state.guidedPreviewGenerationEnabled = true;

    expect(await resumeInterruptedGuidedSceneCorrections()).toBe(1);
    await waitForPendingJobs();

    const saved = await readJob(seeded.job.id);
    expect(state.guidedPreviewProviderCalls).toBe(0);
    expect(saved.storyboard!.scenes[0]!.previewPath).toBe(replacementPath);
    expect(
      saved.storyboard!.scenes[0]!.guidedStory!.corrections!.attempts[0]!.state,
    ).toBe("succeeded");
  });
});
