import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";

// Radix components need a few APIs jsdom doesn't implement.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
if (typeof globalThis.ResizeObserver === "undefined") {
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

const mockState: {
  lastGenerateVars: any;
  generateError: any;
  jobs: any[];
  activeJob: any;
  characters: any[];
  brandKits: any[];
  styleProfiles: any[];
  storyboardEdits: any[];
  storyboardEditError: unknown;
  deferStoryboardEdit: boolean;
  resolveStoryboardEdit: (() => void) | null;
  approvals: number[];
  guidedPreviewRenders: number[];
  guidedCorrections: any[];
  transcript: string;
  transcribeError: any;
  lastSpokespersonScriptVars: any;
  lastLocalizeVars: any;
  localizedScript: string;
  localizeSpendPaise: number | null;
  localizeError: any;
  localizeBlocked: boolean;
  deferLocalize: boolean;
  resolveLocalize: (() => void) | null;
  localizeCallCount: number;
  lastIntakeVars: any;
  intakeResult: any;
  intakeError: any;
  spokespersonScript: string;
  spokespersonBeats: any;
  spokespersonMeta: any;
  spokespersonScriptError: any;
  aiSpendRates: any;
  wallet: any;
  videoCostModels: any;
  videoModels: any;
  me: any;
  featureFlags: Record<string, boolean> | undefined;
  retriedJobIds: number[];
  freshRestartedJobIds: number[];
  repairedJobs: Array<{ jobId: number; reason: string }>;
  repairError: unknown;
  lastOutfitVars: any;
  createdOutfitCharacter: any;
  finalizedGuidedReferences: any[];
} = {
  lastGenerateVars: null,
  generateError: null,
  jobs: [],
  activeJob: undefined,
  characters: [],
  brandKits: [],
  styleProfiles: [],
  storyboardEdits: [],
  storyboardEditError: null,
  deferStoryboardEdit: false,
  resolveStoryboardEdit: null,
  approvals: [],
  guidedPreviewRenders: [],
  guidedCorrections: [],
  transcript: "",
  transcribeError: null,
  lastSpokespersonScriptVars: null,
  lastLocalizeVars: null,
  localizedScript: "మీ వారపు కంటెంట్‌ను ముందుగానే ప్లాన్ చేయండి.",
  localizeSpendPaise: 245,
  localizeError: null,
  localizeBlocked: false,
  deferLocalize: false,
  resolveLocalize: null,
  localizeCallCount: 0,
  lastIntakeVars: null,
  // Default: the intake pass finds no gaps, so the clarify step is skipped
  // and the flow behaves exactly like the pre-variant one.
  intakeResult: {
    suggestedVariant: "marketing",
    variantConfidence: 0.9,
    desiredTakeaway: "Weekly planning saves time",
    extractedFacts: [],
    detectedLanguage: "en",
    gaps: [],
  },
  intakeError: null,
  spokespersonScript:
    "Planning your content one week ahead creates consistency without the daily scramble.",
  spokespersonBeats: undefined,
  spokespersonMeta: undefined,
  spokespersonScriptError: null,
  aiSpendRates: undefined,
  wallet: undefined,
  videoCostModels: undefined,
  videoModels: undefined,
  me: undefined,
  featureFlags: undefined,
  retriedJobIds: [],
  freshRestartedJobIds: [],
  repairedJobs: [],
  repairError: null,
  lastOutfitVars: null,
  createdOutfitCharacter: null,
  finalizedGuidedReferences: [],
};

// Voice notes: a fake MediaRecorder that yields one non-empty chunk on stop,
// so the VoiceNoteButton flow (record -> stop -> transcribe) runs in jsdom.
class FakeMediaRecorder {
  static isTypeSupported = () => true;
  stream: any;
  state = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((e: any) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(stream: any) {
    this.stream = stream;
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["voice"], { type: "audio/webm" }) });
    this.onstop?.();
  }
}
(globalThis as any).MediaRecorder = FakeMediaRecorder;
Object.defineProperty(navigator, "mediaDevices", {
  configurable: true,
  value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [] }) },
});

const { trackPresetCastEventSpy, trackProtectedOutfitEventSpy } = vi.hoisted(() => ({
  trackPresetCastEventSpy: vi.fn(),
  trackProtectedOutfitEventSpy: vi.fn(),
}));
const toastSpy = vi.fn();
const cancelVideoJobSpy = vi.fn();
vi.mock("@/lib/analytics", () => ({
  trackPresetCastEvent: trackPresetCastEventSpy,
  trackProtectedOutfitEvent: trackProtectedOutfitEventSpy,
}));
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy }),
}));

vi.mock("wouter/use-browser-location", () => ({
  navigate: vi.fn(),
}));

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  return createApiClientMock({
    useGetMe: () => ({ data: mockState.me }),
    useWalletGetOverview: () => ({ data: mockState.wallet, isLoading: false }),
    useGenerateVideo: () => ({
      isPending: false,
      mutate: (vars: unknown, opts: any) => {
        mockState.lastGenerateVars = vars;
        if (mockState.generateError) {
          opts?.onError?.(mockState.generateError);
          return;
        }
        opts?.onSuccess?.({ id: 42, status: "queued", engine: "text_to_video" });
      },
    }),
    useRetryVideoJob: () => ({
      isPending: false,
      mutate: (vars: { jobId: number }, opts: any) => {
        mockState.retriedJobIds.push(vars.jobId);
        opts?.onSuccess?.({
          ...mockState.activeJob,
          id: 99,
          status: "queued",
          retryable: false,
          units: 1,
        });
      },
    }),
    useRestartVideoJobFresh: () => ({
      isPending: false,
      mutate: (vars: { jobId: number }, opts: any) => {
        mockState.freshRestartedJobIds.push(vars.jobId);
        const job = {
          ...mockState.activeJob,
          id: 199,
          status: "queued",
          error: null,
          retryable: false,
          freshRestart: { version: 1, sourceJobId: vars.jobId, childJobId: null },
        };
        mockState.activeJob = job;
        mockState.jobs = [job, ...mockState.jobs];
        opts?.onSuccess?.(job);
      },
    }),
    useRepairVideoJob: () => ({
      isPending: false,
      mutate: (vars: { jobId: number; data: { reason: string } }, opts: any) => {
        mockState.repairedJobs.push({ jobId: vars.jobId, reason: vars.data.reason });
        if (mockState.repairError) {
          opts?.onError?.(mockState.repairError);
          return;
        }
        opts?.onSuccess?.({
          ...mockState.activeJob,
          id: 109,
          status: "queued",
          videoPath: null,
          currentVideoPath: null,
          repairable: false,
          repair: {
            chainId: vars.jobId,
            sourceJobId: vars.jobId,
            reason: vars.data.reason,
          },
        });
      },
    }),
    useRequestUploadUrl: () => ({
      isPending: false,
      mutateAsync: vi.fn().mockResolvedValue({
        uploadURL: "https://uploads.example.test/presenter",
        objectPath: "/objects/1/uploads/presenter.mp4",
      }),
    }),
    useGetVideoJob: () => ({ data: mockState.activeJob }),
    useGenerateHooks: () => ({
      isPending: false,
      mutate: (_vars: unknown, opts: any) =>
        opts?.onSuccess?.({
          hooks: [
            { style: "question", text: "Still doing chai the slow way?" },
            { style: "stat", text: "83% of founders skip this one habit." },
          ],
        }),
    }),
    useAnalyzeScriptIntake: () => ({
      isPending: false,
      mutate: (vars: unknown, opts: any) => {
        mockState.lastIntakeVars = vars;
        if (mockState.intakeError) {
          opts?.onError?.(mockState.intakeError);
          return;
        }
        opts?.onSuccess?.(mockState.intakeResult);
      },
    }),
    useGenerateSpokespersonScript: () => ({
      isPending: false,
      mutate: (vars: unknown, opts: any) => {
        mockState.lastSpokespersonScriptVars = vars;
        if (mockState.spokespersonScriptError) {
          opts?.onError?.(mockState.spokespersonScriptError);
          return;
        }
        opts?.onSuccess?.({
          script: mockState.spokespersonScript,
          beats: mockState.spokespersonBeats,
          meta: mockState.spokespersonMeta,
        });
      },
    }),
    useLocalizeScript: () => ({
      isPending: false,
      mutate: (vars: unknown, opts: any) => {
        mockState.lastLocalizeVars = vars;
        mockState.localizeCallCount += 1;
        if (mockState.localizeError) {
          opts?.onError?.(mockState.localizeError);
          return;
        }
        const result = {
          tracks: [
            {
              locale: "te",
              label: "Telugu",
              blocked: mockState.localizeBlocked,
              trackIssues: [],
              srt: "",
              vtt: "",
              cues: [
                {
                  index: 1,
                  startMs: 0,
                  endMs: 45_000,
                  text: mockState.localizedScript,
                  backTranslation: "Plan your weekly content in advance.",
                  sourceSyllables: 12,
                  syllables: 12,
                  syllableBudget: 16,
                  issues: mockState.localizeBlocked
                    ? [
                        {
                          code: "wrong_script",
                          severity: "error",
                          message: "The line needs review.",
                        },
                      ]
                    : [],
                  cueIssues: [],
                },
              ],
            },
          ],
          spendPaise: mockState.localizeSpendPaise,
        };
        if (mockState.deferLocalize) {
          mockState.resolveLocalize = () => opts?.onSuccess?.(result);
          return;
        }
        opts?.onSuccess?.(result);
      },
    }),
    useListVideoJobs: () => ({ data: mockState.jobs }),
    useListVideoModels: () => ({ data: mockState.videoModels }),
    useGetGoogleDriveStatus: () => ({
      data: { connected: false, configured: true, redirectUri: "x", expired: false },
      isLoading: false,
    }),
    useListContent: () => ({ data: [], isLoading: false }),
    useUpdateVideoStoryboard: () => ({
      isPending: false,
      mutate: (vars: any, opts: any) => {
        mockState.storyboardEdits.push(vars);
        if (mockState.storyboardEditError) {
          opts?.onError?.(mockState.storyboardEditError);
          return;
        }
        if (mockState.deferStoryboardEdit) {
          mockState.resolveStoryboardEdit = () => opts?.onSuccess?.(mockState.activeJob);
          return;
        }
        opts?.onSuccess?.(mockState.activeJob);
      },
    }),
    useRenderMissingGuidedStoryPreviews: () => ({
      isPending: false,
      mutate: (vars: any, opts: any) => {
        mockState.guidedPreviewRenders.push(vars.jobId);
        opts?.onSuccess?.({
          ...mockState.activeJob,
          guidedPreviewRender: {
            version: 1,
            operationId: `guided-preview:${vars.jobId}:test`,
            state: "queued",
            total: mockState.activeJob?.storyboard?.scenes.length ?? 0,
            completed: 0,
            error: null,
            retryable: false,
            requestedAt: new Date().toISOString(),
            startedAt: null,
            finishedAt: null,
          },
        });
      },
    }),
    useCorrectGuidedStoryScene: () => ({
      isPending: false,
      mutate: (vars: any, opts: any) => {
        mockState.guidedCorrections.push(vars);
        opts?.onSuccess?.(mockState.activeJob);
      },
    }),
    useFinalizeGuidedStoryReference: () => ({
      isPending: false,
      mutate: (vars: any, opts: any) => {
        mockState.finalizedGuidedReferences.push(vars);
        opts?.onSuccess?.({
          ...mockState.activeJob,
          guidedReferenceContext: {
            ...mockState.activeJob.guidedReferenceContext,
            revision: mockState.activeJob.guidedReferenceContext.revision + 1,
          },
        });
      },
    }),
    useApproveVideoStoryboard: () => ({
      isPending: false,
      mutate: (vars: any, opts: any) => {
        mockState.approvals.push(vars.jobId);
        opts?.onSuccess?.({ ...mockState.activeJob, status: "processing", storyboard: null });
      },
    }),
    cancelVideoJob: (...args: unknown[]) => cancelVideoJobSpy(...args),
    useTranscribeAudio: () => ({
      isPending: false,
      mutate: (_vars: unknown, opts: any) => {
        if (mockState.transcribeError) {
          opts?.onError?.(mockState.transcribeError);
          return;
        }
        opts?.onSuccess?.({ text: mockState.transcript });
      },
    }),
    useListCharacters: () => ({ data: mockState.characters }),
    useCreateCharacterOutfit: () => ({
      isPending: false,
      mutate: (vars: unknown, opts: any) => {
        mockState.lastOutfitVars = vars;
        opts?.onSuccess?.(mockState.createdOutfitCharacter);
      },
    }),
    useStartGuidedStoryReferenceOperation: () => ({
      isPending: false,
      mutate: (vars: any, opts: any) => opts?.onSuccess?.({
        ...mockState.activeJob,
        guidedReferenceContext: {
          ...mockState.activeJob.guidedReferenceContext,
          operations: {
            [vars.roleId]: {
              revision: mockState.activeJob.guidedReferenceContext?.revision ?? 1,
              operationKey: "durable-reference-operation",
              kind: vars.data.kind,
              state: "queued",
              updatedAt: "2026-01-01T00:00:00Z",
            },
          },
        },
      }),
    }),
    useCompleteGuidedStoryReferenceOperation: () => ({
      isPending: false,
      mutate: (_vars: any, opts: any) => opts?.onSuccess?.(mockState.activeJob),
    }),
    useListBrandKits: () => ({ data: mockState.brandKits }),
    useGetBrandKit: () => ({ data: (mockState as any).brandKitDetail }),
    useListVideoStyles: () => ({ data: mockState.styleProfiles }),
    useGetVideoCapabilities: () => ({
      data: {
        costModels: mockState.videoCostModels,
        characterDialogueLocales: [
          {
            code: "en",
            label: "English",
            endonym: "English",
            bcp47: "en-US",
            direction: "ltr",
            modelId: "eleven_v3",
            script: "Latin",
            fontCandidates: ["Noto Sans"],
          },
          {
            code: "fr",
            label: "French",
            endonym: "Français",
            bcp47: "fr-FR",
            direction: "ltr",
            modelId: "eleven_v3",
            script: "Latin",
            fontCandidates: ["Noto Sans"],
          },
          {
            code: "te",
            label: "Telugu",
            endonym: "తెలుగు",
            bcp47: "te-IN",
            direction: "ltr",
            modelId: "eleven_v3",
            script: "Telugu",
            fontCandidates: ["Noto Sans Telugu"],
          },
        ],
      },
    }),
    useGetAiSpendRates: () => ({ data: mockState.aiSpendRates, isLoading: false }),
    useListFeatureFlags: () => ({ data: mockState.featureFlags, isLoading: false }),
  });
});

import { VideoStudioPage } from "./video-studio";

/** A saved style profile as the API returns it. */
function styleProfile(over: {
  id: number;
  name: string;
  captionStyle: "classic" | "dynamic" | "none";
}) {
  return {
    id: over.id,
    name: over.name,
    sourceVideoPath: `/objects/1/uploads/ref-${over.id}.mp4`,
    payload: {
      version: 1,
      hookShape: "question straight to camera",
      pacing: { sceneCount: 5, avgSceneSec: 6, wordsPerMinute: 160 },
      captionStyle: over.captionStyle,
      energy: "punchy",
      visualNotes: ["handheld framing"],
      scriptGuidance: "Short sentences. End on a question.",
      sourceDurationSec: 30,
      transcriptExcerpt: "",
    },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function curatedTemplate(over: {
  id: number;
  name: string;
  summary: string;
  captionStyle: "classic" | "dynamic" | "none";
  jobDefaults?: Record<string, unknown>;
  slots?: any[];
}) {
  return {
    ...styleProfile({ id: over.id, name: over.name, captionStyle: over.captionStyle }),
    scope: "platform",
    sourceKind: "curated",
    summary: over.summary,
    slots: over.slots ?? [
      {
        kind: "script",
        required: true,
        label: "Your script or topic",
        hint: "Bring an original angle for your audience.",
      },
    ],
    jobDefaults: over.jobDefaults ?? {},
    estimatedUnits: 2,
    sourceVideoPath: null,
  };
}

/** A plan from an engine that voices nothing, so its lengths are editable. */
function clipBoard(visualsSource: "prompt" | "slide" | "photo") {
  return {
    version: 1,
    visualsSource,
    timelineLocked: false,
    durationBounds: visualsSource === "slide" ? { minSec: 1, maxSec: 10 } : { minSec: 3, maxSec: 10 },
    model: null,
    provider: null,
    regenerations: 0,
    narration: null,
    scenes: [1, 2].map((i) => ({
      id: `s${i}`,
      text: "",
      visual: visualsSource === "slide" ? `caption ${i}` : `shot ${i}`,
      durationSec: 4,
      previewPath: visualsSource === "prompt" ? null : `/objects/1/uploads/p${i}.png`,
      outfitId: null,
    })),
  };
}

/** A topic plan: cut against a recording, so the timeline is not the user's. */
function narratedBoard() {
  return {
    version: 1,
    visualsSource: "character",
    timelineLocked: true,
    durationBounds: null,
    model: "kwaivgi/kling-v1.6-standard",
    provider: "replicate",
    regenerations: 0,
    narration: {
      audioPath: "/objects/1/uploads/narration.wav",
      totalDurationSec: 12,
      cues: [
        { text: "Line 1", startSec: 0, endSec: 6 },
        { text: "Line 2", startSec: 6, endSec: 12 },
      ],
    },
    scenes: [1, 2].map((i) => ({
      id: `s${i}`,
      text: `Line ${i}`,
      visual: `wide shot ${i}`,
      durationSec: 6,
      previewPath: `/objects/1/uploads/shot-${i}.png`,
      outfitId: null,
    })),
  };
}

function hybridBoard() {
  const base = narratedBoard();
  return {
    ...base,
    mode: "hybrid_character_story",
    visualsSource: "ai_video",
    scenes: base.scenes.map((scene, index) => ({
      ...scene,
      id: `h${index + 1}`,
      beatType: index === 0 ? "character_speaking" : "story_animation",
      hybridRole: index === 0 ? "character_opening" : "story_animation",
      patternIndex: index,
    })),
  };
}

function presenterBrollBoard() {
  return {
    version: 1,
    presenterBroll: true,
    visualsSource: "prompt",
    timelineLocked: true,
    durationBounds: null,
    model: null,
    provider: "pexels",
    regenerations: 0,
    narration: null,
    scenes: [
      {
        id: "pb1",
        text: "",
        visual: "founder planning at a desk",
        durationSec: 5,
        previewPath: "/objects/1/uploads/presenter-poster.png",
        outfitId: null,
      },
    ],
  };
}

function pausedJob(storyboard: unknown) {
  return {
    id: 11,
    engine: "text_to_video",
    status: "awaiting_review",
    prompt: "A barista pulling an espresso shot",
    sourceImagePaths: [],
    aspectRatio: "9:16",
    storyboard,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <VideoStudioPage />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  trackPresetCastEventSpy.mockClear();
  trackProtectedOutfitEventSpy.mockClear();
  mockState.lastGenerateVars = null;
  mockState.generateError = null;
  mockState.jobs = [];
  mockState.activeJob = undefined;
  mockState.characters = [];
  mockState.brandKits = [];
  mockState.styleProfiles = [];
  mockState.storyboardEdits = [];
  mockState.storyboardEditError = null;
  mockState.deferStoryboardEdit = false;
  mockState.resolveStoryboardEdit = null;
  mockState.approvals = [];
  mockState.guidedPreviewRenders = [];
  mockState.guidedCorrections = [];
  mockState.transcript = "";
  mockState.transcribeError = null;
  mockState.lastSpokespersonScriptVars = null;
  mockState.lastLocalizeVars = null;
  mockState.localizedScript = "మీ వారపు కంటెంట్‌ను ముందుగానే ప్లాన్ చేయండి.";
  mockState.localizeSpendPaise = 245;
  mockState.localizeError = null;
  mockState.localizeBlocked = false;
  mockState.deferLocalize = false;
  mockState.resolveLocalize = null;
  mockState.localizeCallCount = 0;
  mockState.spokespersonScript =
    "Planning your content one week ahead creates consistency without the daily scramble.";
  mockState.spokespersonBeats = undefined;
  mockState.spokespersonMeta = undefined;
  mockState.spokespersonScriptError = null;
  mockState.lastIntakeVars = null;
  mockState.intakeError = null;
  mockState.intakeResult = {
    suggestedVariant: "marketing",
    variantConfidence: 0.9,
    desiredTakeaway: "Weekly planning saves time",
    extractedFacts: [],
    detectedLanguage: "en",
    gaps: [],
  };
  (mockState as any).brandKitDetail = undefined;
  mockState.aiSpendRates = undefined;
  mockState.wallet = undefined;
  mockState.videoCostModels = undefined;
  mockState.videoModels = undefined;
  mockState.me = undefined;
  mockState.featureFlags = undefined;
  mockState.retriedJobIds = [];
  mockState.freshRestartedJobIds = [];
  mockState.repairedJobs = [];
  mockState.repairError = null;
  mockState.lastOutfitVars = null;
  mockState.createdOutfitCharacter = null;
  mockState.finalizedGuidedReferences = [];
  toastSpy.mockClear();
  cancelVideoJobSpy.mockReset().mockResolvedValue({ id: 42, status: "cancelled" });
  localStorage.clear();
  cleanup();
});

describe("Video Studio", () => {
  it("hides only the mode whose individual control is off", async () => {
    const modeCases = [
      ["videoTextToVideo", "tab-text-to-video"],
      ["videoAnimatePhoto", "tab-image-to-video"],
      ["videoSlideshow", "tab-slideshow"],
      ["videoTopicToVideo", "tab-topic-to-video"],
    ] as const;

    for (const [feature, testId] of modeCases) {
      cleanup();
      mockState.featureFlags = {
        videoGen: true,
        videoTextToVideo: true,
        videoAnimatePhoto: true,
        videoSlideshow: true,
        videoTopicToVideo: true,
        lipSync: true,
        aiSpend: false,
        referenceStyles: false,
      };
      mockState.featureFlags[feature] = false;
      renderPage();

      expect(screen.queryByTestId(testId), feature).toBeNull();
      for (const [, otherTestId] of modeCases) {
        if (otherTestId !== testId) {
          expect(screen.getByTestId(otherTestId), `${feature} keeps ${otherTestId}`).toBeTruthy();
        }
      }
      expect(screen.getByTestId("tab-lip-sync"), feature).toBeTruthy();
      expect(screen.getByTestId("tab-dialogue-lip-sync"), feature).toBeTruthy();
    }
  });

  it("moves off a mode that is disabled while the page is open", async () => {
    mockState.featureFlags = {
      videoGen: true,
      videoTextToVideo: false,
      videoAnimatePhoto: true,
      videoSlideshow: true,
      videoTopicToVideo: true,
      lipSync: true,
      aiSpend: false,
      referenceStyles: false,
    };

    renderPage();

    await waitFor(() =>
      expect(screen.getByText("Bring one photo to life with subtle AI motion.")).toBeTruthy(),
    );
    expect(screen.queryByTestId("tab-text-to-video")).toBeNull();
  });

  describe("spokesperson script approval", () => {
    /** Step 0: pick the video type, which is what reveals the topic box. */
    async function openSpokespersonTopic(user: ReturnType<typeof userEvent.setup>) {
      await user.click(screen.getByTestId("tab-lip-sync"));
      await user.click(screen.getByTestId("button-variant-marketing"));
    }

    it("starts with a typed or transcribed topic before showing video setup", async () => {
      mockState.transcript = "Explain why weekly content planning saves time";
      renderPage();
      const user = userEvent.setup();
      await openSpokespersonTopic(user);

      expect(screen.getByTestId("input-spokesperson-topic")).toBeTruthy();
      expect(screen.queryByTestId("button-upload-base-video")).toBeNull();
      expect(screen.queryByTestId("button-generate-video")).toBeNull();

      await user.click(screen.getByTestId("button-voice-spokesperson-topic"));
      await user.click(screen.getByTestId("button-voice-spokesperson-topic"));
      await waitFor(() =>
        expect(
          (screen.getByTestId("input-spokesperson-topic") as HTMLTextAreaElement).value,
        ).toBe("Explain why weekly content planning saves time"),
      );
    });

    it("generates an editable script and requires explicit approval", async () => {
      renderPage();
      const user = userEvent.setup();
      await openSpokespersonTopic(user);
      await user.type(
        screen.getByTestId("input-spokesperson-topic"),
        "How a weekly plan makes social media easier",
      );
      await user.click(screen.getByTestId("button-generate-spokesperson-script"));

      expect(mockState.lastSpokespersonScriptVars.data).toEqual(
        expect.objectContaining({
          topic: "How a weekly plan makes social media easier",
          variant: "marketing",
          durationSeconds: 45,
        }),
      );
      const script = screen.getByTestId("input-spokesperson-script") as HTMLTextAreaElement;
      expect(script.value).toBe(mockState.spokespersonScript);
      expect(screen.queryByTestId("button-upload-base-video")).toBeNull();

      await user.clear(script);
      await user.type(script, "This is the exact edited script the user approved.");
      await user.click(screen.getByTestId("button-approve-spokesperson-script"));

      expect(screen.getByTestId("approved-spokesperson-script").textContent).toContain(
        "This is the exact edited script the user approved.",
      );
      expect(screen.getByTestId("button-upload-base-video")).toBeTruthy();

      await user.click(screen.getByTestId("button-edit-spokesperson-script"));
      expect(screen.queryByTestId("button-upload-base-video")).toBeNull();
      expect(screen.getByTestId("input-spokesperson-script")).toBeTruthy();
    });

    it("submits the exact approved script through the existing lip-sync job", async () => {
      mockState.brandKits = [{ id: 9, name: "Launch kit" }];
      (mockState as any).brandKitDetail = {
        activeVersion: {
          payload: {
            base_videos: [
              {
                id: "saved-1",
                label: "Founder intro",
                video_path: "/objects/1/uploads/founder.mp4",
                voice_mode: "preset",
                preset_voice: "nova",
              },
            ],
          },
        },
      };
      renderPage();
      const user = userEvent.setup();
      await openSpokespersonTopic(user);
      await user.type(
        screen.getByTestId("input-spokesperson-topic"),
        "Share our launch planning advice",
      );
      await user.click(screen.getByTestId("button-generate-spokesperson-script"));
      const script = screen.getByTestId("input-spokesperson-script") as HTMLTextAreaElement;
      await user.clear(script);
      await user.type(script, "Use this reviewed script exactly as written.");
      await user.click(screen.getByTestId("button-approve-spokesperson-script"));

      await user.click(screen.getByTestId("select-lipsync-brand-kit"));
      await user.click(screen.getByText("Launch kit"));
      await user.click(screen.getByTestId("select-saved-base-video"));
      await user.click(screen.getByText("Founder intro"));
      await user.click(screen.getByTestId("checkbox-lipsync-consent"));
      await user.click(screen.getByTestId("button-generate-video"));

      await waitFor(() => expect(mockState.lastGenerateVars).toBeTruthy());
      expect(mockState.lastGenerateVars.data).toMatchObject({
        engine: "lip_sync",
        prompt: "Use this reviewed script exactly as written.",
        sourceVideoPath: "/objects/1/uploads/founder.mp4",
        lipSyncConsent: true,
        lipSyncQuality: "standard",
        brandKitId: 9,
      });
    });

    it("asks about gaps the intake pass found, and skips the step when there are none", async () => {
      mockState.intakeResult = {
        suggestedVariant: "marketing",
        variantConfidence: 0.7,
        desiredTakeaway: "",
        extractedFacts: ["Settles in under four hours"],
        detectedLanguage: "en",
        gaps: ["cta", "desiredTakeaway"],
      };
      renderPage();
      const user = userEvent.setup();
      await openSpokespersonTopic(user);
      await user.type(
        screen.getByTestId("input-spokesperson-topic"),
        "Same-day vendor payouts for ecommerce ops teams",
      );
      await user.click(screen.getByTestId("button-generate-spokesperson-script"));

      // Gaps present → the clarify step, not the script.
      expect(screen.getByTestId("spokesperson-clarify")).toBeTruthy();
      expect(screen.getByTestId("input-clarify-cta")).toBeTruthy();
      expect(screen.getByTestId("input-clarify-desiredTakeaway")).toBeTruthy();
      // A gap that was not reported is never asked about.
      expect(screen.queryByTestId("input-clarify-audience")).toBeNull();
      expect(screen.getByTestId("chip-fact-0").textContent).toContain(
        "Settles in under four hours",
      );

      await user.click(screen.getByTestId("chip-cta-book-a-demo"));
      await user.click(screen.getByTestId("button-clarify-continue"));

      expect(mockState.lastSpokespersonScriptVars.data).toEqual(
        expect.objectContaining({
          cta: "Book a demo",
          sourceFacts: ["Settles in under four hours"],
        }),
      );
      expect(screen.getByTestId("input-spokesperson-script")).toBeTruthy();
    });

    it("lets a wrong extracted fact be removed before it becomes an approved claim", async () => {
      mockState.intakeResult = {
        suggestedVariant: "marketing",
        variantConfidence: 0.7,
        desiredTakeaway: "x",
        extractedFacts: ["Wrong fact", "Right fact"],
        detectedLanguage: "en",
        gaps: ["cta"],
      };
      renderPage();
      const user = userEvent.setup();
      await openSpokespersonTopic(user);
      await user.type(screen.getByTestId("input-spokesperson-topic"), "A topic to write about");
      await user.click(screen.getByTestId("button-generate-spokesperson-script"));

      await user.click(screen.getByLabelText("Remove fact: Wrong fact"));
      await user.click(screen.getByTestId("button-clarify-continue"));

      expect(mockState.lastSpokespersonScriptVars.data.sourceFacts).toEqual(["Right fact"]);
    });

    it("still writes a script when the intake pass fails", async () => {
      mockState.intakeError = { data: { error: "intake down" } };
      renderPage();
      const user = userEvent.setup();
      await openSpokespersonTopic(user);
      await user.type(screen.getByTestId("input-spokesperson-topic"), "A topic to write about");
      await user.click(screen.getByTestId("button-generate-spokesperson-script"));

      // Advisory enrichment must never block the thing the user asked for.
      expect(screen.getByTestId("input-spokesperson-script")).toBeTruthy();
      expect(screen.queryByTestId("spokesperson-clarify")).toBeNull();
    });

    it("surfaces open items and production beats on review", async () => {
      mockState.spokespersonBeats = [
        {
          id: "b1",
          label: "Hook",
          spoken: "Your vendors waited [emphasis]nine days[/].",
          onScreen: "Nine days.",
          bRoll: "presenter hold",
          framing: "medium-close",
          durationSec: 5,
          note: null,
        },
      ];
      mockState.spokespersonMeta = {
        wordCount: 96,
        estimatedDurationSec: 41,
        takeaway: "Same-day payouts",
        cta: "Start a trial",
        openItems: ["nine days is illustrative"],
        pronunciations: [{ term: "PayLane", saidAs: "pay-lane" }],
      };
      renderPage();
      const user = userEvent.setup();
      await openSpokespersonTopic(user);
      await user.type(screen.getByTestId("input-spokesperson-topic"), "A topic to write about");
      await user.click(screen.getByTestId("button-generate-spokesperson-script"));

      expect(screen.getByTestId("script-open-items").textContent).toContain(
        "nine days is illustrative",
      );
      expect(screen.getByTestId("script-meta").textContent).toContain("96 words");
      const beats = screen.getByTestId("script-beats");
      expect(beats.textContent).toContain("Hook");
      // Cues stay visible in the beat, never in the spoken script.
      expect(beats.textContent).toContain("[emphasis]");
      expect(
        (screen.getByTestId("input-spokesperson-script") as HTMLTextAreaElement).value,
      ).not.toContain("[emphasis]");
      expect(screen.getByTestId("script-pronunciations").textContent).toContain("pay-lane");
    });

    it("sends the chosen variant along with the video job", async () => {
      renderPage();
      const user = userEvent.setup();
      await user.click(screen.getByTestId("tab-lip-sync"));
      await user.click(screen.getByTestId("button-variant-training"));
      // Training defaults to a longer runtime than marketing.
      await user.type(screen.getByTestId("input-spokesperson-topic"), "How to reset a password");
      await user.click(screen.getByTestId("button-generate-spokesperson-script"));

      expect(mockState.lastSpokespersonScriptVars.data).toEqual(
        expect.objectContaining({ variant: "training", durationSeconds: 90 }),
      );
    });

    it("keeps the topic after a recoverable script-generation error", async () => {
      mockState.spokespersonScriptError = {
        data: { error: "The script provider is temporarily unavailable." },
      };
      renderPage();
      const user = userEvent.setup();
      await openSpokespersonTopic(user);
      const topic = screen.getByTestId("input-spokesperson-topic") as HTMLTextAreaElement;
      await user.type(topic, "Explain a simple customer research habit");
      await user.click(screen.getByTestId("button-generate-spokesperson-script"));

      expect(topic.value).toBe("Explain a simple customer research habit");
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Couldn't write the script",
          description: "The script provider is temporarily unavailable.",
          variant: "destructive",
        }),
      );
    });
  });

  describe("Character Dialogue", () => {
    async function selectCharacterDialogue(user: ReturnType<typeof userEvent.setup>) {
      await user.click(screen.getByTestId("tab-topic-to-video"));
      await user.click(screen.getByTestId("toggle-visuals-character"));
      await user.click(screen.getByTestId("toggle-character-mode-dialogue"));
    }

    it("shows empty states and guidance when requirements are not met", async () => {
      // Mock missing character/brand kit
      mockState.characters = [];
      mockState.brandKits = [];
      renderPage();
      const user = userEvent.setup();
      await selectCharacterDialogue(user);
      expect(screen.queryByTestId("select-video-length")).toBeNull();

      const guidance = screen.getByTestId("dialogue-setup-guidance");
      expect(guidance.textContent).toContain("Missing requirements");
      expect(screen.queryByTestId("select-character-dialogue-locale")).toBeNull();
    });

    it("loads locales, drafts script with targetLocale, estimates long scenes, and submits payload", async () => {
      mockState.characters = [{ id: 1, name: "Alice", isPublic: false, outfits: [] }];
      mockState.brandKits = [
        {
          id: 5,
          name: "My Cloned Kit",
          activeVersion: {
            payload: {
              brand_voice: {
                mode: "cloned",
                provider: "elevenlabs",
                provider_voice_id: "xyz",
                cloned_label: "Founder voice",
                cloned_gender: "female",
              },
            },
          },
        },
      ];
      renderPage();
      const user = userEvent.setup();
      await selectCharacterDialogue(user);

      // 1. Locale selection
      const localeSelect = screen.getByTestId("select-character-dialogue-locale");
      expect(localeSelect).toBeTruthy();

      // Select a character first
      await user.click(screen.getByTestId("select-character"));
      await user.click(screen.getByText("Alice"));

      // 2. Brand Voice selection
      await user.click(screen.getByTestId("select-character-dialogue-brand-kit"));
      const voiceOption = screen.getByRole("option", {
        name: /My Cloned Kit.*Founder voice.*Female/,
      });
      await user.click(voiceOption);

      // 3. Draft script with targetLocale
      await user.type(screen.getByTestId("input-spokesperson-topic"), "Hello World in French");
      await user.click(screen.getByTestId("select-character-dialogue-duration"));
      await user.click(screen.getByRole("option", { name: "90 seconds" }));
      await user.click(screen.getByTestId("button-generate-spokesperson-script"));

      expect(mockState.lastSpokespersonScriptVars.data).toEqual(
        expect.objectContaining({
          topic: "Hello World in French",
          targetLocale: "en", // default from mock videoCapabilities? wait, let's see what the mock provides.
        }),
      );

      // 4. Approval and consent gating
      expect(screen.getByTestId("input-spokesperson-script")).toBeTruthy();
      expect((screen.getByTestId("button-generate-video") as HTMLButtonElement).disabled).toBe(true);
      await user.click(screen.getByTestId("button-approve-spokesperson-script"));

      expect((screen.getByTestId("button-generate-video") as HTMLButtonElement).disabled).toBe(true);
      await user.click(screen.getByTestId("checkbox-lipsync-consent"));

      expect((screen.getByTestId("button-generate-video") as HTMLButtonElement).disabled).toBe(false);

      // 5. Submit final payload
      await user.click(screen.getByTestId("button-generate-video"));

      expect(mockState.lastGenerateVars.data).toEqual(
        expect.objectContaining({
          engine: "dialogue_lip_sync",
          prompt: "Hello World in French",
          characterId: 1,
          brandKitId: 5,
          dialogue: mockState.spokespersonScript,
          characterDialogue: { scriptApproved: true, locale: "en" },
          subtitles: true,
          lipSyncConsent: true,
          aiPersonConsent: true,
          durationSec: 90,
        }),
      );
      // Ensure no stock voice fallback
      expect(mockState.lastGenerateVars.data.voice).toBeUndefined();
    });

    it("explains when the selected video length is too short and accepts the correction", async () => {
      mockState.characters = [{ id: 1, name: "Alice", isPublic: false, outfits: [] }];
      mockState.brandKits = [
        {
          id: 5,
          name: "My Cloned Kit",
          activeVersion: {
            payload: {
              brand_voice: {
                mode: "cloned",
                provider: "elevenlabs",
                provider_voice_id: "xyz",
              },
            },
          },
        },
      ];
      mockState.spokespersonScript = Array.from(
        { length: 100 },
        (_, index) => `word${index}`,
      ).join(" ");
      renderPage();
      const user = userEvent.setup();
      await selectCharacterDialogue(user);
      await user.type(screen.getByTestId("input-spokesperson-topic"), "A detailed training script");
      await user.click(screen.getByTestId("button-generate-spokesperson-script"));

      expect(screen.getByTestId("text-character-dialogue-duration-error").textContent).toMatch(
        /needs at least \d+ seconds/i,
      );
      const approve = screen.getByTestId(
        "button-approve-spokesperson-script",
      ) as HTMLButtonElement;
      expect(approve.disabled).toBe(true);

      await user.click(screen.getByTestId("select-character-dialogue-duration"));
      await user.click(screen.getByRole("option", { name: "90 seconds" }));
      expect(screen.queryByTestId("text-character-dialogue-duration-error")).toBeNull();
      expect(approve.disabled).toBe(false);
    });

    it("translates an edited English draft to Telugu and submits only the approved Telugu text", async () => {
      mockState.characters = [{ id: 1, name: "Alice", isPublic: false, outfits: [] }];
      mockState.brandKits = [
        {
          id: 5,
          name: "My Cloned Kit",
          activeVersion: {
            payload: {
              brand_voice: {
                mode: "cloned",
                provider: "elevenlabs",
                provider_voice_id: "xyz",
                cloned_label: "Founder voice",
              },
            },
          },
        },
      ];
      renderPage();
      const user = userEvent.setup();
      await selectCharacterDialogue(user);
      await user.click(screen.getByTestId("select-character"));
      await user.click(screen.getByText("Alice"));
      await user.click(screen.getByTestId("select-character-dialogue-locale"));
      await user.click(screen.getByRole("option", { name: /Telugu/ }));
      await user.click(screen.getByTestId("select-character-dialogue-brand-kit"));
      await user.click(screen.getByRole("option", { name: /My Cloned Kit/ }));
      await user.type(
        screen.getByTestId("input-spokesperson-topic"),
        "Explain why planning content early saves time",
      );
      await user.click(screen.getByTestId("button-generate-spokesperson-script"));

      expect(mockState.lastSpokespersonScriptVars.data).not.toHaveProperty("targetLocale");
      const source = screen.getByTestId(
        "input-spokesperson-source-script",
      ) as HTMLTextAreaElement;
      expect(source.value).toBe(mockState.spokespersonScript);
      expect(screen.queryByTestId("input-spokesperson-script")).toBeNull();

      await user.clear(source);
      await user.type(source, "This edited English source is the only translation input.");
      await user.click(screen.getByTestId("button-translate-spokesperson-script"));

      expect(mockState.localizeCallCount).toBe(1);
      expect(mockState.lastLocalizeVars.data.locales).toEqual(["te"]);
      expect(mockState.lastLocalizeVars.data.cues).toEqual([
        expect.objectContaining({
          index: 1,
          text: "This edited English source is the only translation input.",
        }),
      ]);
      const translated = screen.getByTestId(
        "input-spokesperson-script",
      ) as HTMLTextAreaElement;
      expect(translated.value).toBe(mockState.localizedScript);
      expect(screen.getByTestId("text-translation-spend").textContent).toContain("₹2.45");

      await user.clear(translated);
      await user.type(translated, "ఇది వినియోగదారు ఆమోదించిన తెలుగు వచనం.");
      await user.click(screen.getByTestId("button-approve-spokesperson-script"));
      await user.click(screen.getByTestId("checkbox-lipsync-consent"));
      await user.click(screen.getByTestId("button-generate-video"));

      expect(mockState.lastGenerateVars.data).toEqual(
        expect.objectContaining({
          dialogue: "ఇది వినియోగదారు ఆమోదించిన తెలుగు వచనం.",
          characterDialogue: { scriptApproved: true, locale: "te" },
        }),
      );
      expect(mockState.lastGenerateVars.data.dialogue).not.toContain("English source");
    });

    it("keeps the English source after translation failure and allows a retry", async () => {
      mockState.characters = [{ id: 1, name: "Alice", isPublic: false, outfits: [] }];
      mockState.brandKits = [
        {
          id: 5,
          name: "My Cloned Kit",
          activeVersion: {
            payload: {
              brand_voice: {
                mode: "cloned",
                provider: "elevenlabs",
                provider_voice_id: "xyz",
              },
            },
          },
        },
      ];
      mockState.localizeError = { data: { error: "Translation is temporarily unavailable." } };
      renderPage();
      const user = userEvent.setup();
      await selectCharacterDialogue(user);
      await user.click(screen.getByTestId("select-character-dialogue-locale"));
      await user.click(screen.getByRole("option", { name: /Telugu/ }));
      await user.type(screen.getByTestId("input-spokesperson-topic"), "A retryable Telugu topic");
      await user.click(screen.getByTestId("button-generate-spokesperson-script"));
      const source = screen.getByTestId(
        "input-spokesperson-source-script",
      ) as HTMLTextAreaElement;
      const originalSource = source.value;

      await user.click(screen.getByTestId("button-translate-spokesperson-script"));
      expect(source.value).toBe(originalSource);
      expect(screen.queryByTestId("input-spokesperson-script")).toBeNull();
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Could not translate this script",
          description: "Translation is temporarily unavailable.",
          variant: "destructive",
        }),
      );

      mockState.localizeError = null;
      await user.click(screen.getByTestId("button-translate-spokesperson-script"));
      expect(
        (screen.getByTestId("input-spokesperson-script") as HTMLTextAreaElement).value,
      ).toBe(mockState.localizedScript);
    });

    it("ignores a late Telugu response after the English source changes", async () => {
      mockState.characters = [{ id: 1, name: "Alice", isPublic: false, outfits: [] }];
      mockState.brandKits = [
        {
          id: 5,
          name: "My Cloned Kit",
          activeVersion: {
            payload: {
              brand_voice: {
                mode: "cloned",
                provider: "elevenlabs",
                provider_voice_id: "xyz",
              },
            },
          },
        },
      ];
      mockState.deferLocalize = true;
      renderPage();
      const user = userEvent.setup();
      await selectCharacterDialogue(user);
      await user.click(screen.getByTestId("select-character-dialogue-locale"));
      await user.click(screen.getByRole("option", { name: /Telugu/ }));
      await user.type(screen.getByTestId("input-spokesperson-topic"), "A source race test");
      await user.click(screen.getByTestId("button-generate-spokesperson-script"));
      await user.click(screen.getByTestId("button-translate-spokesperson-script"));

      const source = screen.getByTestId(
        "input-spokesperson-source-script",
      ) as HTMLTextAreaElement;
      fireEvent.change(source, { target: { value: "The English source changed during translation." } });
      await act(async () => {
        mockState.resolveLocalize?.();
      });

      expect(source.value).toBe("The English source changed during translation.");
      expect(screen.queryByTestId("input-spokesperson-script")).toBeNull();
      expect(
        toastSpy.mock.calls.some(([toast]) => toast?.title === "Telugu draft ready"),
      ).toBe(false);
    });

    it("requires an edit before a blocked Telugu result can be approved", async () => {
      mockState.characters = [{ id: 1, name: "Alice", isPublic: false, outfits: [] }];
      mockState.brandKits = [
        {
          id: 5,
          name: "My Cloned Kit",
          activeVersion: {
            payload: {
              brand_voice: {
                mode: "cloned",
                provider: "elevenlabs",
                provider_voice_id: "xyz",
              },
            },
          },
        },
      ];
      mockState.localizeBlocked = true;
      renderPage();
      const user = userEvent.setup();
      await selectCharacterDialogue(user);
      await user.click(screen.getByTestId("select-character-dialogue-locale"));
      await user.click(screen.getByRole("option", { name: /Telugu/ }));
      await user.type(screen.getByTestId("input-spokesperson-topic"), "A blocked translation test");
      await user.click(screen.getByTestId("button-generate-spokesperson-script"));
      await user.click(screen.getByTestId("button-translate-spokesperson-script"));

      expect(screen.getByTestId("text-translation-needs-edit").textContent).toContain(
        "Edit the Telugu text before approval",
      );
      const approve = screen.getByTestId(
        "button-approve-spokesperson-script",
      ) as HTMLButtonElement;
      expect(approve.disabled).toBe(true);

      const translated = screen.getByTestId(
        "input-spokesperson-script",
      ) as HTMLTextAreaElement;
      fireEvent.change(translated, {
        target: { value: "సమీక్షించిన మరియు సవరించిన తెలుగు వచనం." },
      });
      expect(screen.queryByTestId("text-translation-needs-edit")).toBeNull();
      expect(approve.disabled).toBe(false);
      await user.click(approve);
      expect(screen.getByTestId("approved-spokesperson-script")).toBeTruthy();
    });

    it("invalidates a Telugu draft and its approval when the English source changes", async () => {
      mockState.me = { tenant: { id: 77 } };
      mockState.characters = [{ id: 1, name: "Alice", isPublic: false, outfits: [] }];
      mockState.brandKits = [
        {
          id: 5,
          name: "My Cloned Kit",
          activeVersion: {
            payload: {
              brand_voice: {
                mode: "cloned",
                provider: "elevenlabs",
                provider_voice_id: "xyz",
              },
            },
          },
        },
      ];
      localStorage.setItem(
        "kokao-character-dialogue-draft-v1:77",
        JSON.stringify({
          v: 1,
          active: true,
          characterId: 1,
          outfitId: null,
          brandKitId: 5,
          locale: "te",
          topic: "Explain our launch",
          sourceScript: "This is the saved English source.",
          script: "ఇది సేవ్ చేసిన తెలుగు అనువాదం.",
          approvedScript: "ఇది సేవ్ చేసిన తెలుగు అనువాదం.",
          translationSpendPaise: 245,
          step: "setup",
          scriptVariant: "marketing",
          scriptDuration: 45,
          durationSec: 45,
          aspect: "9:16",
          reviewStoryboard: true,
        }),
      );
      renderPage();

      const source = await screen.findByTestId("input-spokesperson-source-script");
      expect((source as HTMLTextAreaElement).value).toBe("This is the saved English source.");
      expect((screen.getByTestId("input-spokesperson-script") as HTMLTextAreaElement).value).toBe(
        "ఇది సేవ్ చేసిన తెలుగు అనువాదం.",
      );
      expect(screen.getByTestId("approved-spokesperson-script")).toBeTruthy();

      fireEvent.change(source, { target: { value: "The English source has changed." } });
      expect(screen.queryByTestId("input-spokesperson-script")).toBeNull();
      expect(screen.queryByTestId("approved-spokesperson-script")).toBeNull();
      await waitFor(() => {
        const saved = JSON.parse(
          localStorage.getItem("kokao-character-dialogue-draft-v1:77") ?? "{}",
        );
        expect(saved).toEqual(
          expect.objectContaining({
            sourceScript: "The English source has changed.",
            script: "",
            approvedScript: null,
            translationSpendPaise: null,
          }),
        );
      });
    });

    it("keeps a presenter template and lets the saved character fill its presenter slot", async () => {
      mockState.characters = [{ id: 1, name: "Alice", isPublic: false, outfits: [] }];
      mockState.brandKits = [
        {
          id: 5,
          name: "My Cloned Kit",
          activeVersion: {
            payload: {
              brand_voice: {
                mode: "cloned",
                provider: "elevenlabs",
                provider_voice_id: "xyz",
              },
            },
          },
        },
      ];
      mockState.styleProfiles = [
        curatedTemplate({
          id: 23,
          name: "Presenter with B-roll",
          summary: "Presenter footage cut with stock supporting visuals.",
          captionStyle: "dynamic",
          jobDefaults: { visualsSource: "stock" },
          slots: [
            {
              kind: "script",
              required: true,
              label: "Your script or topic",
              hint: "Bring an original angle for your audience.",
            },
            {
              kind: "presenter_video",
              required: true,
              label: "A take of you talking to camera",
              hint: "Upload the direct-to-camera take.",
            },
          ],
        }),
      ];
      renderPage();
      const user = userEvent.setup();

      await user.click(screen.getByTestId("tab-topic-to-video"));
      await user.click(screen.getByTestId("button-use-video-template-23"));
      await user.click(screen.getByTestId("toggle-visuals-character"));
      await user.click(screen.getByTestId("toggle-character-mode-dialogue"));
      expect(screen.getByTestId("video-templates-section")).toBeTruthy();
      expect(screen.getByTestId("character-dialogue-format-note")).toBeTruthy();
      expect(screen.queryByTestId("presenter-video-upload")).toBeNull();
      await user.click(screen.getByTestId("select-character"));
      await user.click(screen.getByText("Alice"));
      await user.click(screen.getByTestId("select-character-dialogue-brand-kit"));
      await user.click(screen.getByText("My Cloned Kit"));
      await user.type(screen.getByTestId("input-spokesperson-topic"), "Explain our launch");
      await user.click(screen.getByTestId("button-generate-spokesperson-script"));
      await user.click(screen.getByTestId("button-approve-spokesperson-script"));
      await user.click(screen.getByTestId("checkbox-lipsync-consent"));
      await user.click(screen.getByTestId("button-generate-video"));

      expect(mockState.lastGenerateVars.data).toEqual(
        expect.objectContaining({
          engine: "dialogue_lip_sync",
          styleProfileId: 23,
          presenterVideoPath: null,
          reviewStoryboard: true,
        }),
      );
      expect(toastSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({ title: "Add the template’s required inputs" }),
      );
    });

    it("restores the workspace's Character Dialogue selections after remounting", async () => {
      mockState.me = { tenant: { id: 77 } };
      mockState.characters = [
        {
          id: 1,
          name: "Alice",
          isPublic: false,
          outfits: [{ id: 9, name: "Launch outfit", imagePath: "/objects/77/outfit.png" }],
        },
      ];
      mockState.brandKits = [
        {
          id: 5,
          name: "My Cloned Kit",
          activeVersion: {
            payload: {
              brand_voice: {
                mode: "cloned",
                provider: "elevenlabs",
                provider_voice_id: "xyz",
              },
            },
          },
        },
      ];
      mockState.videoCostModels = {
        textToVideo: null,
        imageToVideo: null,
        lipSync: {
          provider: "replicate",
          model: "bytedance/latentsync",
          paisePerSecond: 20,
          paisePerVideo: null,
        },
        lipSyncHigh: {
          provider: "replicate",
          model: "sync/lipsync-2",
          paisePerSecond: 420,
          paisePerVideo: null,
        },
      };
      localStorage.setItem(
        "kokao-character-dialogue-draft-v1:77",
        JSON.stringify({
          v: 1,
          active: true,
          characterId: 1,
          outfitId: 9,
          brandKitId: 5,
          locale: "te",
          topic: "Explain our launch",
          script: "This approved script should still be here.",
          approvedScript: "This approved script should still be here.",
          step: "setup",
          scriptVariant: "training",
          scriptDuration: 90,
          durationSec: 90,
          aspect: "9:16",
          reviewStoryboard: true,
          lipSyncQuality: "high",
        }),
      );

      renderPage();

      await waitFor(() =>
        expect((screen.getByTestId("input-spokesperson-topic") as HTMLTextAreaElement).value).toBe(
          "Explain our launch",
        ),
      );
      expect(screen.getByTestId("select-character").textContent).toContain("Alice");
      expect(screen.getByTestId("select-character-dialogue-brand-kit").textContent).toContain(
        "My Cloned Kit",
      );
      expect((screen.getByTestId("input-spokesperson-script") as HTMLTextAreaElement).value).toBe(
        "This approved script should still be here.",
      );
      expect(
        screen.getByTestId("toggle-lipsync-quality-high").getAttribute("data-state"),
      ).toBe("on");
      expect((screen.getByTestId("button-generate-video") as HTMLButtonElement).disabled).toBe(true);

      const user = userEvent.setup();
      await user.click(screen.getByTestId("checkbox-lipsync-consent"));
      await user.click(screen.getByTestId("button-generate-video"));
      expect(mockState.lastGenerateVars.data).toEqual(
        expect.objectContaining({
          durationSec: 90,
          characterId: 1,
          outfitId: 9,
          brandKitId: 5,
          characterDialogue: { scriptApproved: true, locale: "te" },
          lipSyncQuality: "high",
        }),
      );
      expect(screen.getByTestId("input-spokesperson-script")).toBeTruthy();
      expect(
        (screen.getByTestId("input-spokesperson-topic") as HTMLTextAreaElement).value,
      ).toBe("Explain our launch");
      expect(screen.getByTestId("approved-spokesperson-script")).toBeTruthy();
    });

    it("separates a multi-scene Character Dialogue model estimate from its wallet reservation", async () => {
      const longScript = Array.from({ length: 96 }, (_, index) => `word${index}.`).join(" ");
      mockState.me = { tenant: { id: 77 } };
      mockState.characters = [
        {
          id: 1,
          name: "Alice",
          isPublic: false,
          outfits: [{ id: 9, name: "Launch outfit", imagePath: "/objects/77/outfit.png" }],
        },
      ];
      mockState.brandKits = [
        {
          id: 5,
          name: "My Cloned Kit",
          activeVersion: {
            payload: {
              brand_voice: {
                mode: "cloned",
                provider: "elevenlabs",
                provider_voice_id: "xyz",
              },
            },
          },
        },
      ];
      mockState.wallet = {
        walletBilling: true,
        balancePaise: 100_000,
        rates: { captionPaise: 240, imagePaise: 1200, videoPaise: 1200 },
      };
      mockState.videoCostModels = {
        textToVideo: null,
        imageToVideo: {
          provider: "replicate",
          model: "wan-video/wan-2.2-i2v-fast",
          paisePerSecond: null,
          paisePerVideo: 100,
        },
        lipSync: {
          provider: "replicate",
          model: "bytedance/latentsync",
          paisePerSecond: 20,
          paisePerVideo: null,
        },
      };
      localStorage.setItem(
        "kokao-character-dialogue-draft-v1:77",
        JSON.stringify({
          v: 1,
          active: true,
          characterId: 1,
          outfitId: 9,
          brandKitId: 5,
          locale: "en",
          topic: "Explain our launch",
          script: longScript,
          approvedScript: longScript,
          step: "setup",
          scriptVariant: "training",
          scriptDuration: 90,
          durationSec: 90,
          aspect: "9:16",
          reviewStoryboard: true,
        }),
      );

      renderPage();

      await waitFor(() => {
        expect(screen.getByTestId("text-video-model-estimate").textContent).toContain("₹21.00");
      });
      expect(screen.getByTestId("text-video-model-estimate").textContent).toContain(
        "6 provider generations",
      );
      expect(screen.getByTestId("text-video-model-estimate").textContent).toContain(
        "wan-video/wan-2.2-i2v-fast + bytedance/latentsync",
      );
      expect(screen.getByTestId("text-wallet-estimate").textContent).toContain("₹72.00");
      expect(screen.getByTestId("text-wallet-estimate").textContent).toContain("6 generations");
      expect(screen.getByTestId("text-wallet-estimate").textContent).toContain("₹12.00 each");
    });

    it("shows long-video scene estimate for scripts > 30s", async () => {
      mockState.characters = [{ id: 1, name: "Alice", isPublic: false, outfits: [] }];
      mockState.brandKits = [
        {
          id: 5,
          name: "My Cloned Kit",
          activeVersion: {
            payload: {
              brand_voice: { mode: "cloned", provider: "elevenlabs" },
            },
          },
        },
      ];
      // Generate a script that bounds > 30s. A 100-word script will have bounds ~55 seconds.
      mockState.spokespersonScript = new Array(100).fill("word").join(" ");
      renderPage();
      const user = userEvent.setup();
      await selectCharacterDialogue(user);

      await user.click(screen.getByTestId("select-character-dialogue-brand-kit"));
      await user.click(screen.getByText("My Cloned Kit"));
      await user.type(screen.getByTestId("input-spokesperson-topic"), "A long script");
      await user.click(screen.getByTestId("button-generate-spokesperson-script"));

      expect(screen.getByTestId("text-character-dialogue-runtime").textContent).toContain(
        "4 scenes · 8 video units",
      );
      expect(screen.getByTestId("text-character-dialogue-scene-count").textContent).toContain(
        "reliable lip-sync",
      );
    });

    it("resumes only retryable failed Character Dialogue jobs", async () => {
      mockState.activeJob = {
        id: 44,
        engine: "dialogue_lip_sync",
        status: "failed",
        error: "Scene 2 lip-sync failed.",
        retryable: true,
        recovery: {
          mode: "resume",
          chainId: 44,
          sourceJobId: 44,
          reusable: ["scene 1"],
          regenerated: ["1 missing provider operation"],
        },
        units: 4,
        sourceImagePaths: [],
        aspectRatio: "9:16",
        createdAt: "2026-08-24T00:00:00Z",
        updatedAt: "2026-08-24T00:00:00Z",
      };
      renderPage();
      const user = userEvent.setup();

      await user.click(screen.getByTestId("button-retry-video"));

      expect(mockState.retriedJobIds).toEqual([44]);
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Resume started",
          description: "KOKAO reserved only 1 missing provider operation.",
        }),
      );
    });

    it("labels an ordinary failed engine as retrying from immutable saved inputs", () => {
      mockState.activeJob = {
        id: 45,
        engine: "text_to_video",
        status: "failed",
        prompt: "Original saved brief",
        error: "Provider was temporarily unavailable.",
        retryable: true,
        recovery: {
          mode: "saved_inputs",
          chainId: 45,
          sourceJobId: 45,
          reusable: [],
          regenerated: ["1 missing provider operation"],
        },
        units: 1,
        sourceImagePaths: [],
        aspectRatio: "9:16",
        createdAt: "2026-08-24T00:00:00Z",
        updatedAt: "2026-08-24T00:00:00Z",
      };

      renderPage();

      expect(screen.getByTestId("button-retry-video").textContent).toContain(
        "Retry from saved inputs",
      );
      expect(screen.getByText(/regenerate provider work/i)).toBeTruthy();
      expect(screen.getByTestId("button-start-over-video")).toBeTruthy();
    });

    it("shows durable scene and job errors, then fresh-restarts into the new job", async () => {
      mockState.activeJob = {
        id: 1082,
        engine: "topic_to_video",
        status: "failed",
        error: "Provider stopped.",
        retryable: true,
        recovery: { mode: "resume", chainId: 1082, sourceJobId: 1082, reusable: [], regenerated: [] },
        units: 4,
        sourceImagePaths: [],
        aspectRatio: "9:16",
        errorHistory: [
          {
            jobId: 1082, jobNumber: 1082, scope: "job", sceneNumber: null, displayNumber: null,
            operation: "compose", occurredAt: "2026-08-24T12:00:00.000Z", sceneId: null,
            provider: "replicate", model: "video-model", providerRequestId: "req-job-1082",
            code: "provider_timeout", message: "Composition timed out.", attempt: 1,
            recoveryAttempt: 0, outcome: "stopped", fingerprint: "job-failure",
          },
          {
            jobId: 1082, jobNumber: 1082, scope: "scene", sceneNumber: 3, displayNumber: 3,
            operation: "storyboard_preview", occurredAt: "2026-08-24T12:01:00.000Z", sceneId: "s3",
            provider: "replicate", model: "image-model", providerRequestId: "req-scene-3",
            code: "provider_error", message: "Scene three failed.", attempt: 2,
            recoveryAttempt: 1, outcome: "stopped", fingerprint: "scene-3-failure",
          },
          {
            jobId: 1082, jobNumber: 1082, scope: "scene", sceneNumber: 4, displayNumber: 4,
            operation: "storyboard_preview", occurredAt: "2026-08-24T12:01:00.000Z", sceneId: "s4",
            provider: null, model: null, providerRequestId: null, code: null,
            message: "Scene four was skipped.", attempt: 1, recoveryAttempt: 1,
            outcome: "not_attempted", fingerprint: "scene-4-not-attempted",
          },
        ],
        storyboard: {
          version: 1, visualsSource: "ai", timelineLocked: true, regenerations: 0,
          scenes: [1, 2, 3, 4].map((number) => ({
            id: `s${number}`, text: `Scene ${number}`, visual: `Visual ${number}`,
            durationSec: 2, previewPath: null, outfitId: null,
          })),
        },
        createdAt: "2026-08-24T00:00:00Z", updatedAt: "2026-08-24T00:00:00Z",
      };
      renderPage();
      const user = userEvent.setup();

      expect(screen.getByText("Job-wide error history · Job #1082")).toBeTruthy();
      expect(screen.getByText(/req-job-1082/)).toBeTruthy();
      expect(screen.getByTestId("durable-error-scene-3-failure").textContent).toContain(
        "Stopped after this error.",
      );
      expect(screen.getByTestId("durable-error-scene-4-not-attempted").textContent).toContain(
        "Not attempted after this error.",
      );

      await user.click(screen.getByTestId("button-fresh-restart-video"));
      expect(mockState.freshRestartedJobIds).toEqual([1082]);
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Fresh restart started",
          description: "Job #199 is a full current-price fresh job with no reused assets.",
        }),
      );
      expect(screen.getByTestId("active-video-job-number").textContent).toContain("Job #199");
    });

    it("does not offer a fresh restart to workspace members", () => {
      mockState.me = { tenant: { id: 1 }, team: { role: "member" } };
      mockState.activeJob = {
        id: 1082,
        engine: "topic_to_video",
        status: "failed",
        error: "Provider stopped.",
        retryable: false,
        units: 1,
        sourceImagePaths: [],
        aspectRatio: "9:16",
        createdAt: "2026-08-24T00:00:00Z",
        updatedAt: "2026-08-24T00:00:00Z",
      };
      renderPage();
      expect(screen.queryByTestId("button-fresh-restart-video")).toBeNull();
    });

    it("offers focused copy for an eligible historical privacy scene", async () => {
      mockState.activeJob = {
        id: 451,
        engine: "topic_to_video",
        status: "failed",
        prompt: "A fictional story",
        error: "The provider rejected one generated keyframe.",
        retryable: true,
        privacyRecoveryCapability: {
          eligible: true,
          code: "InputImageSensitiveContentDetected.PrivacyInformation",
          sceneId: "story-2",
          reason: null,
        },
        recovery: {
          mode: "resume",
          chainId: 451,
          sourceJobId: 451,
          reusable: ["narration", "scene story-1"],
          regenerated: ["privacy-safe keyframe for scene story-2"],
        },
        units: 2,
        sourceImagePaths: [],
        aspectRatio: "9:16",
        createdAt: "2026-08-24T00:00:00Z",
        updatedAt: "2026-08-24T00:00:00Z",
      };
      renderPage();
      const user = userEvent.setup();

      expect(screen.getByText(/regenerate scene story-2 safely and resume/i)).toBeTruthy();
      expect(screen.getByText(/one anonymous, fictional keyframe/i)).toBeTruthy();
      const action = screen.getByTestId("button-retry-video");
      expect(action.textContent).toContain("Regenerate affected scene & resume");
      await user.click(action);
      expect(mockState.retriedJobIds).toEqual([451]);
    });

    it("opens saved scenes read-only and edits missing scenes before resume", async () => {
      mockState.activeJob = {
        id: 46,
        engine: "topic_to_video",
        status: "failed",
        error:
          "AI provider failure: the image provider is temporarily overloaded. 1 of 2 storyboard images were saved and will be reused when you retry.",
        retryable: true,
        recovery: {
          mode: "resume",
          chainId: 46,
          sourceJobId: 46,
          reusable: ["approved storyboard", "saved scene assets"],
          regenerated: ["missing provider operations"],
        },
        units: 5,
        sourceImagePaths: [],
        aspectRatio: "9:16",
        storyboard: {
          version: 1,
          visualsSource: "ai",
          timelineLocked: true,
          regenerations: 0,
          scenes: [
            {
              id: "s1",
              text: "Saved scene",
              visual: "Saved visual",
              durationSec: 2,
              previewPath: "/objects/1/uploads/s1.png",
              outfitId: null,
              previewCheckpoint: {
                status: "complete",
                targetPath: "/objects/1/uploads/s1.png",
                selectedEventId: "event-1",
                events: [{
                  eventId: "event-1",
                  provider: "replicate",
                  model: "google/nano-banana-pro",
                  label: "storyboard_preview:s1:attempt:1",
                  durationSec: null,
                  requestBytes: 10,
                  costPaise: 10,
                }],
              },
            },
            {
              id: "s2",
              text: "Missing scene",
              visual: "Missing visual",
              durationSec: 2,
              previewPath: null,
              outfitId: null,
              previewCheckpoint: {
                status: "prepared",
                targetPath: "/objects/1/uploads/s2.png",
                events: [],
              },
            },
          ],
        },
        createdAt: "2026-08-24T00:00:00Z",
        updatedAt: "2026-08-24T00:00:00Z",
      };

      renderPage();
      const user = userEvent.setup();

      expect(screen.getByTestId("saved-storyboard-progress")).toBeTruthy();
      expect(screen.getByText(/saving 1 of 2 storyboard images/i)).toBeTruthy();
      expect(screen.getByAltText("Saved storyboard scene 1")).toBeTruthy();
      expect(screen.getByText("replicate")).toBeTruthy();
      expect(screen.getByText("Waiting for AI provider")).toBeTruthy();
      expect(screen.getByText("Missing")).toBeTruthy();

      const savedCard = screen.getByTestId("saved-storyboard-scene-s1");
      expect(savedCard.getAttribute("aria-label")).toMatch(/saved and view only/i);
      await user.click(savedCard);
      expect(screen.getByTestId("dialog-recovery-scene")).toBeTruthy();
      expect(screen.getByText(/completed provider work is protected/i)).toBeTruthy();
      expect((screen.getByTestId("input-recovery-scene-visual") as HTMLTextAreaElement).disabled).toBe(true);
      expect(screen.queryByTestId("button-save-recovery-scene")).toBeNull();
      await user.click(screen.getAllByRole("button", { name: "Close" })[0]!);

      const missingCard = screen.getByTestId("saved-storyboard-scene-s2");
      expect(missingCard.getAttribute("aria-label")).toMatch(/missing and editable/i);
      await user.click(missingCard);
      const visual = screen.getByTestId("input-recovery-scene-visual");
      await user.clear(visual);
      await user.type(visual, "Corrected missing visual");
      await user.click(screen.getByTestId("button-save-recovery-scene"));

      expect(mockState.storyboardEdits).toContainEqual({
        jobId: 46,
        data: { scenes: [{ id: "s2", visual: "Corrected missing visual" }] },
      });
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Missing scene updated" }),
      );
    });

    it("keeps the recovery scene dialog open and reports an invalid edit", async () => {
      mockState.storyboardEditError = { data: { error: "Storyboard direction is invalid." } };
      mockState.activeJob = {
        id: 47,
        engine: "topic_to_video",
        status: "failed",
        error: "Provider stopped",
        retryable: true,
        recovery: {
          mode: "resume",
          chainId: 47,
          sourceJobId: 47,
          reusable: ["saved scene assets"],
          regenerated: ["missing provider operations"],
        },
        units: 1,
        sourceImagePaths: [],
        aspectRatio: "9:16",
        storyboard: {
          version: 1,
          visualsSource: "ai",
          timelineLocked: true,
          regenerations: 0,
          scenes: [
            {
              id: "saved",
              text: "Saved",
              visual: "Saved direction",
              durationSec: 2,
              previewPath: "/objects/1/uploads/saved.png",
              outfitId: null,
            },
            {
              id: "missing",
              text: "Narration",
              visual: "Original direction",
              durationSec: 2,
              previewPath: null,
              outfitId: null,
            },
          ],
        },
        createdAt: "2026-08-24T00:00:00Z",
        updatedAt: "2026-08-24T00:00:00Z",
      };
      renderPage();
      const user = userEvent.setup();
      await user.click(screen.getByTestId("saved-storyboard-scene-missing"));
      const visual = screen.getByTestId("input-recovery-scene-visual");
      await user.clear(visual);
      await user.type(visual, "Rejected direction");
      await user.click(screen.getByTestId("button-save-recovery-scene"));

      expect(screen.getByTestId("dialog-recovery-scene")).toBeTruthy();
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Could not save that scene",
          variant: "destructive",
        }),
      );
    });

    it("shows editable scene cards when the provider failed before saving any preview", async () => {
      mockState.activeJob = {
        id: 48,
        engine: "topic_to_video",
        status: "failed",
        error: "Provider stopped immediately",
        retryable: true,
        recovery: {
          mode: "resume",
          chainId: 48,
          sourceJobId: 48,
          reusable: ["approved storyboard"],
          regenerated: ["all storyboard previews"],
        },
        units: 2,
        sourceImagePaths: [],
        aspectRatio: "9:16",
        storyboard: {
          version: 1,
          visualsSource: "ai",
          timelineLocked: true,
          regenerations: 0,
          scenes: [{
            id: "all-missing",
            text: "Narration",
            visual: "Original direction",
            durationSec: 2,
            previewPath: null,
            outfitId: null,
          }],
        },
        createdAt: "2026-08-24T00:00:00Z",
        updatedAt: "2026-08-24T00:00:00Z",
      };
      renderPage();
      const user = userEvent.setup();

      expect(screen.getByText(/saving 0 of 1 storyboard images/i)).toBeTruthy();
      await user.click(screen.getByTestId("saved-storyboard-scene-all-missing"));
      expect((screen.getByTestId("input-recovery-scene-visual") as HTMLTextAreaElement).disabled).toBe(false);
      expect(screen.getByTestId("button-save-recovery-scene")).toBeTruthy();
    });
  });

  describe("AI Dialogue", () => {
    async function approveDialogueScript(user: ReturnType<typeof userEvent.setup>) {
      await user.click(screen.getByTestId("tab-dialogue-lip-sync"));
      await user.click(screen.getByTestId("button-variant-marketing"));
      await user.type(screen.getByTestId("input-spokesperson-topic"), "Explain our planning method");
      await user.click(screen.getByTestId("button-generate-spokesperson-script"));
      await user.click(screen.getByTestId("button-approve-spokesperson-script"));
    }

    it("shows a clearly labelled AI Dialogue tab under the lip-sync feature flag", () => {
      renderPage();
      expect(screen.getByTestId("tab-dialogue-lip-sync").textContent).toContain("AI Dialogue");
    });

    it("keeps AI Dialogue generation disabled until its visual prompt, voice, and authorization are ready", async () => {
      renderPage();
      const user = userEvent.setup();
      await approveDialogueScript(user);

      const button = screen.getByTestId("button-generate-video") as HTMLButtonElement;
      expect(screen.getByTestId("input-ai-person-prompt")).toBeTruthy();
      expect(screen.queryByTestId("button-upload-base-video")).toBeNull();
      expect(button.disabled).toBe(true);

      await user.type(
        screen.getByTestId("input-ai-person-prompt"),
        "An original presenter in a sunlit studio",
      );
      expect(button.disabled).toBe(true);
      await user.click(screen.getByTestId("select-dialogue-lip-sync-voice"));
      await user.click(screen.getByText("Nova · bright"));
      expect(button.disabled).toBe(true);
      // The 30-second script setting is the default, but this short approved
      // dialogue needs a shorter plate to stay within the provider's range.
      expect(
        (screen.getByTestId("select-dialogue-video-duration") as HTMLElement).textContent,
      ).toContain("30");
      await user.click(screen.getByTestId("select-dialogue-video-duration"));
      await user.click(screen.getByText("10 seconds"));
      expect(button.disabled).toBe(true);
      await user.click(screen.getByTestId("checkbox-ai-person-consent"));
      expect(button.disabled).toBe(false);
    });

    it("submits the approved dialogue with an explicit stock voice", async () => {
      renderPage();
      const user = userEvent.setup();
      await approveDialogueScript(user);
      await user.type(
        screen.getByTestId("input-ai-person-prompt"),
        "An original presenter in a sunlit studio",
      );
      await user.click(screen.getByTestId("select-dialogue-lip-sync-voice"));
      await user.click(screen.getByText("Nova · bright"));
      await user.click(screen.getByTestId("select-dialogue-video-duration"));
      await user.click(screen.getByText("10 seconds"));
      await user.click(screen.getByTestId("checkbox-ai-person-consent"));
      await user.click(screen.getByTestId("button-generate-video"));

      await waitFor(() => expect(mockState.lastGenerateVars).toBeTruthy());
      expect(mockState.lastGenerateVars.data).toMatchObject({
        engine: "dialogue_lip_sync",
        prompt: "An original presenter in a sunlit studio",
        dialogue: mockState.spokespersonScript,
        aiPersonConsent: true,
        brandKitId: null,
        voice: "nova",
        sourceVideoPath: null,
        durationSec: 10,
        lipSyncQuality: "standard",
      });
    });

    it("submits High Quality dialogue only when priced, before generation starts", async () => {
      mockState.videoCostModels = {
        textToVideo: null,
        imageToVideo: null,
        lipSync: {
          provider: "replicate",
          model: "bytedance/latentsync",
          paisePerSecond: 20,
          paisePerVideo: null,
        },
        lipSyncHigh: {
          provider: "replicate",
          model: "sync/lipsync-2",
          paisePerSecond: 420,
          paisePerVideo: null,
        },
      };
      renderPage();
      const user = userEvent.setup();
      await approveDialogueScript(user);
      expect(
        screen.getByTestId("toggle-lipsync-quality-standard").getAttribute("aria-describedby"),
      ).toBe("lipsync-quality-standard-description");
      expect(screen.getByTestId("lipsync-quality-standard-description").textContent).toMatch(
        /lower provider cost/i,
      );
      expect(screen.getByTestId("lipsync-quality-high-description").textContent).toMatch(
        /higher-quality lip-sync/i,
      );
      expect(screen.getByTestId("text-lipsync-source-guidance").textContent).toMatch(
        /already talking naturally/i,
      );
      await user.click(screen.getByTestId("toggle-lipsync-quality-high"));
      expect(screen.getByTestId("text-lipsync-quality-price").textContent).toContain(
        "₹4.20/output second",
      );
      expect(screen.getByTestId("text-lipsync-quality-price").textContent).toContain(
        "sync/lipsync-2 · $0.05/output second",
      );
      await user.type(
        screen.getByTestId("input-ai-person-prompt"),
        "An original presenter in a sunlit studio",
      );
      await user.click(screen.getByTestId("select-dialogue-lip-sync-voice"));
      await user.click(screen.getByText("Nova · bright"));
      await user.click(screen.getByTestId("select-dialogue-video-duration"));
      await user.click(screen.getByText("10 seconds"));
      await user.click(screen.getByTestId("checkbox-ai-person-consent"));
      await user.click(screen.getByTestId("button-generate-video"));

      await waitFor(() => expect(mockState.lastGenerateVars).toBeTruthy());
      expect(mockState.lastGenerateVars.data.lipSyncQuality).toBe("high");
      expect(screen.queryByTestId("input-spokesperson-script")).toBeNull();
    });

    it("keeps High Quality disabled when its price is unavailable", async () => {
      renderPage();
      const user = userEvent.setup();
      await approveDialogueScript(user);
      expect(
        (screen.getByTestId("toggle-lipsync-quality-standard") as HTMLElement).getAttribute(
          "data-state",
        ),
      ).toBe("on");
      expect(
        (screen.getByTestId("toggle-lipsync-quality-high") as HTMLButtonElement).disabled,
      ).toBe(true);
    });

    it("uses the two-unit AI Dialogue wallet estimate", async () => {
      mockState.wallet = {
        walletBilling: true,
        balancePaise: 100_000,
        rates: { captionPaise: 240, imagePaise: 1200, videoPaise: 41760 },
      };
      renderPage();
      const user = userEvent.setup();
      await approveDialogueScript(user);

      const estimate = screen.getByTestId("text-wallet-estimate");
      expect(estimate.textContent).toContain("2 generations");
      expect(estimate.textContent).toContain("₹835.20");
    });
  });

  it("keeps Generate disabled until the text prompt is long enough", () => {
    renderPage();
    const button = screen.getByTestId("button-generate-video") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("input-video-prompt"), {
      target: { value: "A calm ocean at dusk" },
    });
    expect(button.disabled).toBe(false);
  });

  it("submits a text-to-video job with the chosen aspect ratio and length", async () => {
    renderPage();
    fireEvent.change(screen.getByTestId("input-video-prompt"), {
      target: { value: "A calm ocean at dusk" },
    });
    fireEvent.click(screen.getByTestId("button-generate-video"));
    await waitFor(() => expect(mockState.lastGenerateVars).toBeTruthy());
    expect(mockState.lastGenerateVars.data).toMatchObject({
      engine: "text_to_video",
      prompt: "A calm ocean at dusk",
      aspectRatio: "9:16",
      sourceImagePaths: [],
    });
  });

  it("shows queued status with elapsed time and cancels a still-queued job", async () => {
    mockState.activeJob = {
      id: 42,
      engine: "text_to_video",
      status: "queued",
      prompt: "A calm ocean at dusk",
      sourceImagePaths: [],
      aspectRatio: "9:16",
      createdAt: new Date(Date.now() - 5000).toISOString(),
      updatedAt: new Date().toISOString(),
    };
    renderPage();
    fireEvent.change(screen.getByTestId("input-video-prompt"), {
      target: { value: "A calm ocean at dusk" },
    });
    fireEvent.click(screen.getByTestId("button-generate-video"));

    await waitFor(() => expect(screen.getByTestId("text-job-stage").textContent).toContain("Queued"));
    expect(screen.getByTestId("text-video-job-elapsed").textContent).toMatch(/\ds elapsed/);

    const cancelBtn = screen.getByTestId("button-cancel-video-job") as HTMLButtonElement;
    expect(cancelBtn.disabled).toBe(false);
    fireEvent.click(cancelBtn);
    await waitFor(() => expect(cancelVideoJobSpy).toHaveBeenCalledWith(42));
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Video cancelled" }),
      ),
    );
  });

  it("explains when a processing job is too late to cancel", async () => {
    cancelVideoJobSpy.mockRejectedValueOnce({ status: 409 });
    mockState.activeJob = {
      id: 42,
      engine: "text_to_video",
      status: "processing",
      stage: "Writing the script",
      prompt: "A calm ocean at dusk",
      sourceImagePaths: [],
      aspectRatio: "9:16",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    renderPage();
    fireEvent.change(screen.getByTestId("input-video-prompt"), {
      target: { value: "A calm ocean at dusk" },
    });
    fireEvent.click(screen.getByTestId("button-generate-video"));

    await waitFor(() => expect(screen.getByTestId("button-cancel-video-job")).toBeTruthy());
    const cancelBtn = screen.getByTestId("button-cancel-video-job") as HTMLButtonElement;
    expect(cancelBtn.disabled).toBe(false);
    fireEvent.click(cancelBtn);
    await waitFor(() => expect(cancelVideoJobSpy).toHaveBeenCalledWith(42));
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Too late to cancel",
          description:
            "Generation already started, so it cannot be stopped safely and will finish normally.",
        }),
      ),
    );
  });

  it("requires photos before a slideshow can start, and offers all three photo sources", async () => {
    renderPage();
    // Radix tabs activate on focus/pointer, not synthetic click events.
    await userEvent.setup().click(screen.getByTestId("tab-slideshow"));
    expect(screen.getByTestId("button-upload-photos")).toBeTruthy();
    expect(screen.getByTestId("button-pick-library")).toBeTruthy();
    expect(screen.getByTestId("button-pick-drive")).toBeTruthy();
    expect(screen.queryByText("Seconds per photo")).toBeNull();
    expect(
      (screen.getByTestId("button-generate-video") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("surfaces a quota toast on a 402 instead of a generic error", async () => {
    mockState.generateError = { status: 402, message: "Monthly video quota reached" };
    renderPage();
    fireEvent.change(screen.getByTestId("input-video-prompt"), {
      target: { value: "A calm ocean at dusk" },
    });
    fireEvent.click(screen.getByTestId("button-generate-video"));
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Video quota reached" }),
      ),
    );
  });

  // Wallet-billed workspaces have no plan upgrades or credit packs — the 402
  // toast must point at recharging the prepaid wallet instead. These guard
  // the video-studio.tsx wiring that passes walletBilling into the helpers.
  it("shows wallet-recharge copy on a 402 for a wallet-billed owner", async () => {
    mockState.generateError = {
      status: 402,
      message: "Monthly video quota reached. Upgrade or buy a credit pack.",
    };
    mockState.wallet = { walletBilling: true };
    renderPage();
    fireEvent.change(screen.getByTestId("input-video-prompt"), {
      target: { value: "A calm ocean at dusk" },
    });
    fireEvent.click(screen.getByTestId("button-generate-video"));
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Wallet balance too low" }),
      ),
    );
    const toastArg = toastSpy.mock.calls.find(
      (c) => c[0]?.title === "Wallet balance too low",
    )![0];
    expect(toastArg.description).toMatch(/recharge your prepaid wallet/i);
    // The server's credit-pack advice is wrong for wallet billing.
    expect(toastArg.description).not.toMatch(/credit pack|upgrade/i);
  });

  it("tells a wallet-billed member to ask the owner to recharge on a 402", async () => {
    mockState.generateError = { status: 402, message: "Monthly video quota reached" };
    mockState.wallet = { walletBilling: true };
    mockState.me = { tenant: { id: 1 }, team: { role: "member" } };
    renderPage();
    fireEvent.change(screen.getByTestId("input-video-prompt"), {
      target: { value: "A calm ocean at dusk" },
    });
    fireEvent.click(screen.getByTestId("button-generate-video"));
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Wallet balance too low" }),
      ),
    );
    const toastArg = toastSpy.mock.calls.find(
      (c) => c[0]?.title === "Wallet balance too low",
    )![0];
    expect(toastArg.description).toMatch(
      /ask your workspace owner to recharge the prepaid wallet/i,
    );
    expect(toastArg.description).not.toMatch(/upgrade your plan/i);
  });

  // The active model/duration estimate is distinct from the larger up-front
  // reservation used to guard concurrent wallet spending.
  describe("video cost estimate and wallet reservation", () => {
    const walletBase = {
      walletBilling: true,
      balancePaise: 100_000,
      rates: { captionPaise: 240, imagePaise: 1200, videoPaise: 41760 },
    };

    it("shows the single-unit estimate for a default text-to-video job", () => {
      mockState.wallet = { ...walletBase };
      renderPage();
      const line = screen.getByTestId("text-wallet-estimate");
      expect(line.textContent).toContain("₹417.60");
      // One unit — no "x each" breakdown.
      expect(line.textContent).not.toContain("each");
      expect(screen.queryByTestId("text-wallet-estimate-shortfall")).toBeNull();
    });

    it("multiplies by the shot count with a per-unit breakdown", async () => {
      mockState.wallet = { ...walletBase };
      renderPage();
      const user = userEvent.setup();
      await user.click(screen.getByTestId("select-shot-count"));
      await user.click(screen.getByTestId("option-shots-3"));
      const line = screen.getByTestId("text-wallet-estimate");
      expect(line.textContent).toContain("₹1,252.80");
      expect(line.textContent).toContain("3 generations");
      expect(line.textContent).toContain("₹417.60 each");
    });

    it("uses the active model's per-second rate and selected duration", async () => {
      mockState.wallet = { ...walletBase };
      mockState.videoCostModels = {
        textToVideo: {
          provider: "replicate",
          model: "wan-video/wan-2.2-t2v-fast",
          paisePerSecond: 60,
          paisePerVideo: null,
        },
        imageToVideo: null,
        lipSync: null,
      };
      renderPage();

      expect(screen.getByTestId("text-video-model-estimate").textContent).toContain("₹3.00");
      expect(screen.getByTestId("text-video-model-estimate").textContent).toContain(
        "wan-video/wan-2.2-t2v-fast",
      );
      expect(screen.getByTestId("text-wallet-estimate").textContent).toContain("₹417.60");

      const user = userEvent.setup();
      await user.click(screen.getByTestId("select-shot-count"));
      await user.click(screen.getByTestId("option-shots-3"));
      expect(screen.getByTestId("text-video-model-estimate").textContent).toContain("₹9.00");
      expect(screen.getByTestId("text-video-model-estimate").textContent).toContain(
        "3 provider generations",
      );
      expect(screen.getByTestId("text-wallet-estimate").textContent).toContain("₹1,252.80");
    });

    it("does not invent a model estimate when the active model has no price", () => {
      mockState.wallet = { ...walletBase };
      mockState.videoCostModels = {
        textToVideo: {
          provider: "replicate",
          model: "unpriced/model",
          paisePerSecond: null,
          paisePerVideo: null,
        },
        imageToVideo: null,
        lipSync: null,
      };
      renderPage();
      expect(screen.getByTestId("text-video-model-estimate-unavailable").textContent).toMatch(
        /unavailable/i,
      );
      expect(screen.getByTestId("text-wallet-estimate").textContent).toContain("₹417.60");
    });

    it("counts topic-video AI b-roll scenes and the AI music bed like the server", async () => {
      mockState.wallet = { ...walletBase, balancePaise: 1_000_000 };
      renderPage();
      const user = userEvent.setup();
      await user.click(screen.getByTestId("tab-topic-to-video"));
      // AI b-roll = 2 units per paragraph (1 paragraph default).
      await user.click(screen.getByTestId("toggle-visuals-ai"));
      const line = screen.getByTestId("text-wallet-estimate");
      expect(line.textContent).toContain("2 generations");
      expect(line.textContent).toContain("₹835.20");
      // Animated AI b-roll = 3 units per paragraph.
      await user.click(screen.getByTestId("toggle-visuals-ai-video"));
      expect(screen.getByTestId("text-wallet-estimate").textContent).toContain("3 generations");
      expect(screen.getByTestId("text-wallet-estimate").textContent).toContain("₹1,252.80");
      // Character visuals = 4 units per paragraph.
      await user.click(screen.getByTestId("toggle-visuals-character"));
      expect(screen.getByTestId("text-wallet-estimate").textContent).toContain("4 generations");
    });

    it("reserves only planning before a long-form template's exact scene plan", async () => {
      mockState.wallet = {
        ...walletBase,
        balancePaise: 774_341,
        rates: { ...walletBase.rates, videoPaise: 42_000 },
      };
      mockState.styleProfiles = [
        curatedTemplate({
          id: 4606,
          name: "test 1",
          summary: "A bounded long-form story template.",
          captionStyle: "dynamic",
          jobDefaults: {
            durationMode: "script_derived",
            maxDurationSeconds: 68,
            minSceneCount: 10,
            maxSceneCount: 31,
            visualStrategy: "ai",
            visualsSource: "ai",
          },
        }),
      ];
      renderPage();
      const user = userEvent.setup();
      await user.click(screen.getByTestId("tab-topic-to-video"));
      await user.click(screen.getByTestId("button-use-video-template-4606"));
      await user.click(screen.getByTestId("toggle-visuals-character"));

      const estimate = screen.getByTestId("text-wallet-estimate");
      expect(estimate.textContent).toContain("Planning reservation");
      expect(estimate.textContent).toContain("₹420.00");
      expect(estimate.textContent).not.toContain("₹13,020.00");
      expect(screen.getByTestId("text-template-planning-ceiling").textContent).toContain(
        "up to 31 video units",
      );
      expect(screen.queryByTestId("text-wallet-estimate-shortfall")).toBeNull();
    });

    it("shows a paused template's exact requirement separately from its held planning unit", async () => {
      const job = {
        ...pausedJob(narratedBoard()),
        engine: "topic_to_video",
        units: 1,
        requiredUnits: 6,
        error: "Funding for the remaining 5 visual units is unavailable.",
      };
      mockState.jobs = [job];
      mockState.activeJob = job;
      renderPage();
      await waitFor(() =>
        expect(screen.getByText(/Exact storyboard requirement: 6 video units; 1 currently funded/i)).toBeTruthy(),
      );
    });

    it("warns and suggests recharging when the estimate exceeds the balance", async () => {
      // Balance covers one unit but not three.
      mockState.wallet = { ...walletBase, balancePaise: 50_000 };
      renderPage();
      const user = userEvent.setup();
      expect(screen.queryByTestId("text-wallet-estimate-shortfall")).toBeNull();
      await user.click(screen.getByTestId("select-shot-count"));
      await user.click(screen.getByTestId("option-shots-3"));
      const hint = screen.getByTestId("text-wallet-estimate-shortfall");
      expect(hint.textContent).toMatch(/recharge/i);
      expect(hint.textContent).toContain("₹500.00");
    });

    it("stays hidden for quota-billed workspaces and when no rate is set", () => {
      mockState.wallet = { ...walletBase, walletBilling: false };
      renderPage();
      expect(screen.queryByTestId("text-wallet-estimate")).toBeNull();
      cleanup();
      mockState.wallet = { ...walletBase, rates: { ...walletBase.rates, videoPaise: 0 } };
      renderPage();
      expect(screen.queryByTestId("text-wallet-estimate")).toBeNull();
    });
  });

  it("keeps Generate disabled until the topic is long enough", async () => {
    renderPage();
    await userEvent.setup().click(screen.getByTestId("tab-topic-to-video"));
    const button = screen.getByTestId("button-generate-video") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("input-video-prompt"), {
      target: { value: "5 morning habits that transform your day" },
    });
    expect(button.disabled).toBe(false);
  });

  it("submits a topic-to-video job with narration defaults", async () => {
    renderPage();
    await userEvent.setup().click(screen.getByTestId("tab-topic-to-video"));
    // The topic engine trades the seconds picker for length + voice controls.
    expect(screen.getByTestId("select-video-length")).toBeTruthy();
    expect(screen.getByTestId("select-video-voice")).toBeTruthy();
    expect(screen.getByTestId("switch-subtitles")).toBeTruthy();
    // Caption style is offered while subtitles are on (dynamic is the default).
    expect(screen.getByTestId("select-caption-style")).toBeTruthy();
    fireEvent.change(screen.getByTestId("input-video-prompt"), {
      target: { value: "5 morning habits that transform your day" },
    });
    fireEvent.click(screen.getByTestId("button-generate-video"));
    await waitFor(() => expect(mockState.lastGenerateVars).toBeTruthy());
    expect(mockState.lastGenerateVars.data).toMatchObject({
      engine: "topic_to_video",
      prompt: "5 morning habits that transform your day",
      sourceImagePaths: [],
      aspectRatio: "9:16",
      // Default is the brand kit voice: no explicit voice is sent so the
      // server resolves the kit's cloned/preset voice.
      voice: undefined,
      stockSource: "auto",
      subtitles: true,
      captionStyle: "dynamic",
      paragraphCount: 1,
    });
  });

  it("sends an AI music prompt with the job (+1 unit chip shown)", async () => {
    renderPage();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("tab-topic-to-video"));
    fireEvent.change(screen.getByTestId("input-video-prompt"), {
      target: { value: "5 morning habits that transform your day" },
    });
    await user.click(screen.getByTestId("button-ai-music"));
    fireEvent.change(screen.getByTestId("input-ai-music"), {
      target: { value: "warm lofi chill beat" },
    });
    await user.click(screen.getByTestId("button-set-ai-music"));
    expect(screen.getByTestId("chip-ai-music").textContent).toContain("warm lofi chill beat");
    fireEvent.click(screen.getByTestId("button-generate-video"));
    await waitFor(() => expect(mockState.lastGenerateVars).toBeTruthy());
    expect(mockState.lastGenerateVars.data).toMatchObject({
      engine: "topic_to_video",
      musicPath: null,
      musicPrompt: "warm lofi chill beat",
    });
  });

  it("offers a music toggle on Text to Video that gates the music payload", async () => {
    renderPage();
    const user = userEvent.setup();
    // Music picker is hidden until the toggle is switched on.
    expect(screen.queryByTestId("button-ai-music")).toBeNull();
    await user.click(screen.getByTestId("switch-clip-music"));
    await user.click(screen.getByTestId("button-ai-music"));
    fireEvent.change(screen.getByTestId("input-ai-music"), {
      target: { value: "soft ambient pads" },
    });
    await user.click(screen.getByTestId("button-set-ai-music"));
    fireEvent.change(screen.getByTestId("input-video-prompt"), {
      target: { value: "A calm ocean at dusk" },
    });
    fireEvent.click(screen.getByTestId("button-generate-video"));
    await waitFor(() => expect(mockState.lastGenerateVars).toBeTruthy());
    expect(mockState.lastGenerateVars.data).toMatchObject({
      engine: "text_to_video",
      musicPath: null,
      musicPrompt: "soft ambient pads",
    });
  });

  it("drops the music payload when the clip music toggle is turned back off", async () => {
    renderPage();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("switch-clip-music"));
    await user.click(screen.getByTestId("button-ai-music"));
    fireEvent.change(screen.getByTestId("input-ai-music"), {
      target: { value: "soft ambient pads" },
    });
    await user.click(screen.getByTestId("button-set-ai-music"));
    await user.click(screen.getByTestId("switch-clip-music"));
    expect(screen.queryByTestId("chip-ai-music")).toBeNull();
    fireEvent.change(screen.getByTestId("input-video-prompt"), {
      target: { value: "A calm ocean at dusk" },
    });
    fireEvent.click(screen.getByTestId("button-generate-video"));
    await waitFor(() => expect(mockState.lastGenerateVars).toBeTruthy());
    expect(mockState.lastGenerateVars.data).toMatchObject({
      engine: "text_to_video",
      musicPath: null,
      musicPrompt: null,
    });
  });

  it("offers hook ideas and applies the picked hook to the topic", async () => {
    renderPage();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("tab-topic-to-video"));
    expect(screen.getByTestId("select-topic-template")).toBeTruthy();
    fireEvent.change(screen.getByTestId("input-video-prompt"), {
      target: { value: "morning habits for founders" },
    });
    await user.click(screen.getByTestId("button-hook-ideas"));
    await user.click(screen.getByTestId("button-use-hook-0"));
    const promptBox = screen.getByTestId("input-video-prompt") as HTMLTextAreaElement;
    expect(promptBox.value).toBe(
      'morning habits for founders — open with this hook: "Still doing chai the slow way?"',
    );
  });

  it("sends the picked brand kit with a topic video, and nothing by default", async () => {
    mockState.brandKits = [
      { id: 9, name: "Chai Point", tenantId: 1 },
      { id: 12, name: "Side Project", tenantId: 1 },
    ];
    renderPage();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("tab-topic-to-video"));
    fireEvent.change(screen.getByTestId("input-video-prompt"), {
      target: { value: "5 morning habits that transform your day" },
    });

    // Branding is opt-in: nothing is sent until a kit is chosen.
    fireEvent.click(screen.getByTestId("button-generate-video"));
    await waitFor(() => expect(mockState.lastGenerateVars).toBeTruthy());
    expect(mockState.lastGenerateVars.data.brandKitId).toBeNull();

    mockState.lastGenerateVars = null;
    await user.click(screen.getByTestId("select-brand-kit"));
    await user.click(screen.getByRole("option", { name: "Chai Point" }));
    fireEvent.click(screen.getByTestId("button-generate-video"));
    await waitFor(() => expect(mockState.lastGenerateVars).toBeTruthy());
    expect(mockState.lastGenerateVars.data.brandKitId).toBe(9);
  });

  it("keeps the brand kit picker off engines that cannot use it", async () => {
    mockState.brandKits = [{ id: 9, name: "Chai Point", tenantId: 1 }];
    renderPage();
    const user = userEvent.setup();
    expect(screen.queryByTestId("select-brand-kit")).toBeNull();
    await user.click(screen.getByTestId("tab-topic-to-video"));
    expect(screen.getByTestId("select-brand-kit")).toBeTruthy();
    await user.click(screen.getByTestId("tab-slideshow"));
    expect(screen.queryByTestId("select-brand-kit")).toBeNull();
  });

  it("sends the picked reference style and adopts its caption treatment", async () => {
    mockState.styleProfiles = [
      styleProfile({ id: 5, name: "Fast-cut explainer", captionStyle: "classic" }),
      styleProfile({ id: 6, name: "Silent b-roll", captionStyle: "none" }),
    ];
    renderPage();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("tab-topic-to-video"));
    fireEvent.change(screen.getByTestId("input-video-prompt"), {
      target: { value: "5 morning habits that transform your day" },
    });

    // Reference styling is opt-in.
    fireEvent.click(screen.getByTestId("button-generate-video"));
    await waitFor(() => expect(mockState.lastGenerateVars).toBeTruthy());
    expect(mockState.lastGenerateVars.data.styleProfileId).toBeNull();
    expect(mockState.lastGenerateVars.data.captionStyle).toBe("dynamic");

    mockState.lastGenerateVars = null;
    await user.click(screen.getByTestId("select-style-profile"));
    await user.click(screen.getByRole("option", { name: "Fast-cut explainer" }));
    fireEvent.click(screen.getByTestId("button-generate-video"));
    await waitFor(() => expect(mockState.lastGenerateVars).toBeTruthy());
    expect(mockState.lastGenerateVars.data.styleProfileId).toBe(5);
    // The reference's caption treatment becomes the starting point.
    expect(mockState.lastGenerateVars.data.captionStyle).toBe("classic");

    // A reference with no burned-in captions turns subtitles off entirely.
    mockState.lastGenerateVars = null;
    await user.click(screen.getByTestId("select-style-profile"));
    await user.click(screen.getByRole("option", { name: "Silent b-roll" }));
    expect(screen.queryByTestId("select-caption-style")).toBeNull();
    fireEvent.click(screen.getByTestId("button-generate-video"));
    await waitFor(() => expect(mockState.lastGenerateVars).toBeTruthy());
    expect(mockState.lastGenerateVars.data.styleProfileId).toBe(6);
    expect(mockState.lastGenerateVars.data.subtitles).toBe(false);
  });

  it("shows curated video templates separately and applies the selected format", async () => {
    mockState.styleProfiles = [
      curatedTemplate({
        id: 22,
        name: "Expert B-roll explainer",
        summary: "A direct-to-camera take with illustrative cutaways.",
        captionStyle: "classic",
        jobDefaults: {
          aspectRatio: "9:16",
          durationMode: "script_derived",
          maxDurationSeconds: 600,
          speakingRateWpm: 160,
          scriptDetailLevel: "detailed",
          minSceneDurationSeconds: 3,
          maxSceneDurationSeconds: 30,
          minSceneCount: 2,
          maxSceneCount: 20,
          visualStrategy: "stock",
          paragraphCount: 2,
          subtitles: true,
          captionStyle: "classic",
          visualsSource: "stock",
        },
      }),
      styleProfile({ id: 5, name: "My fast-cut reference", captionStyle: "dynamic" }),
    ];
    renderPage();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("tab-topic-to-video"));

    expect(screen.getByTestId("video-templates-section")).toBeTruthy();
    expect(screen.getByText("Expert B-roll explainer")).toBeTruthy();
    expect(screen.getByText("Your script or topic")).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Expert B-roll explainer" })).toBeNull();

    const templateButton = screen.getByTestId("button-use-video-template-22");
    expect(templateButton.tagName).toBe("BUTTON");
    expect(templateButton.getAttribute("aria-pressed")).toBe("false");
    expect(templateButton.getAttribute("aria-expanded")).toBe("false");
    expect(templateButton.textContent).toContain("A direct-to-camera take with illustrative cutaways.");

    await user.click(templateButton);
    expect(templateButton.getAttribute("aria-pressed")).toBe("true");
    expect(templateButton.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Template selected")).toBeTruthy();

    await user.click(templateButton);
    expect(templateButton.getAttribute("aria-pressed")).toBe("false");
    expect(templateButton.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Template selected")).toBeNull();

    await user.click(templateButton);
    fireEvent.change(screen.getByTestId("input-video-prompt"), {
      target: { value: "How independent shops can turn one customer story into a reel" },
    });
    fireEvent.click(screen.getByTestId("button-generate-video"));
    await waitFor(() => expect(mockState.lastGenerateVars).toBeTruthy());
    expect(mockState.lastGenerateVars.data).toMatchObject({
      styleProfileId: 22,
      aspectRatio: "9:16",
      paragraphCount: 2,
      durationSec: 600,
      captionStyle: "classic",
      subtitles: true,
    });
  });

  it("accepts the selected Brand Character as a hybrid template saved-character input", async () => {
    mockState.characters = [
      {
        id: 41,
        name: "Brand Character",
        isPublic: false,
        outfits: [
          {
            id: 42,
            name: "Default outfit",
            imagePath: "/objects/1/brand-character.png",
            isDefault: true,
          },
        ],
      },
    ];
    mockState.styleProfiles = [
      curatedTemplate({
        id: 24,
        name: "Hybrid Character Story",
        summary: "A saved character introduces and closes an animated story.",
        captionStyle: "classic",
        jobDefaults: {
          format: "hybrid_character_story",
          visualsSource: "ai_video",
          hybridBeatPattern: [
            { kind: "character_opening", maxDurationSeconds: 12 },
            { kind: "story_animation", maxDurationSeconds: 20 },
            { kind: "character_closing", maxDurationSeconds: 12 },
          ],
        },
        slots: [
          {
            kind: "saved_character",
            required: true,
            label: "Your saved character",
            hint: "Used for the opening and closing.",
          },
          {
            kind: "script",
            required: true,
            label: "Your script or topic",
            hint: "What the character should tell.",
          },
        ],
      }),
    ];
    renderPage();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("tab-topic-to-video"));
    await user.click(screen.getByTestId("button-use-video-template-24"));
    await waitFor(() => {
      expect((screen.getByTestId("select-character") as HTMLElement).textContent).toContain(
        "Brand Character",
      );
    });
    fireEvent.change(screen.getByTestId("input-video-prompt"), {
      target: { value: "Tell our founder story with a clear closing statement" },
    });
    await user.click(screen.getByTestId("checkbox-hybrid-lipsync-consent"));
    await user.click(screen.getByTestId("button-generate-video"));

    await waitFor(() => expect(mockState.lastGenerateVars).toBeTruthy());
    expect(mockState.lastGenerateVars.data).toMatchObject({
      styleProfileId: 24,
      characterId: 41,
      outfitId: 42,
      lipSyncConsent: true,
    });
    expect(toastSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: "Add the template’s required inputs" }),
    );
  });

  it("requires a presenter upload for presenter templates and sends its object path", async () => {
    mockState.styleProfiles = [
      curatedTemplate({
        id: 23,
        name: "Presenter with B-roll",
        summary: "Presenter footage cut with stock supporting visuals.",
        captionStyle: "dynamic",
        jobDefaults: { visualsSource: "stock" },
        slots: [
          {
            kind: "script",
            required: true,
            label: "Your script or topic",
            hint: "Bring an original angle for your audience.",
          },
          {
            kind: "presenter_video",
            required: true,
            label: "Presenter video",
            hint: "Upload the direct-to-camera take.",
          },
        ],
      }),
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    renderPage();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("tab-topic-to-video"));
    await user.click(screen.getByTestId("button-use-video-template-23"));
    fireEvent.change(screen.getByTestId("input-video-prompt"), {
      target: { value: "How to make a weekly planning habit stick" },
    });

    expect(screen.getByTestId("presenter-video-upload")).toBeTruthy();
    expect(screen.getByTestId("switch-review-storyboard")).toBeTruthy();
    expect((screen.getByTestId("button-generate-video") as HTMLButtonElement).disabled).toBe(true);

    const file = new File(["presenter footage"], "founder.mp4", { type: "video/mp4" });
    fireEvent.change(screen.getByTestId("input-presenter-video"), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByTestId("text-presenter-video-name").textContent).toBe("founder.mp4"));
    expect((screen.getByTestId("button-generate-video") as HTMLButtonElement).disabled).toBe(false);

    await user.click(screen.getByTestId("button-generate-video"));
    await waitFor(() => expect(mockState.lastGenerateVars).toBeTruthy());
    expect(mockState.lastGenerateVars.data).toMatchObject({
      engine: "topic_to_video",
      styleProfileId: 23,
      presenterVideoPath: "/objects/1/uploads/presenter.mp4",
    });
  });

  it("keeps the reference style picker on the topic engine only", async () => {
    renderPage();
    const user = userEvent.setup();
    expect(screen.queryByTestId("select-style-profile")).toBeNull();
    await user.click(screen.getByTestId("tab-topic-to-video"));
    expect(screen.getByTestId("select-style-profile")).toBeTruthy();
    await user.click(screen.getByTestId("tab-slideshow"));
    expect(screen.queryByTestId("select-style-profile")).toBeNull();
  });

  it("opens the reference style manager and blocks analysis until a video is uploaded", async () => {
    renderPage();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("tab-topic-to-video"));
    await user.click(screen.getByTestId("button-manage-styles"));
    expect(screen.getByTestId("button-upload-reference")).toBeTruthy();
    // A name alone is not enough — the reference itself is what gets analyzed.
    fireEvent.change(screen.getByTestId("input-style-name"), {
      target: { value: "Fast-cut explainer" },
    });
    expect((screen.getByTestId("button-analyze-style") as HTMLButtonElement).disabled).toBe(true);
  });

  it("hides the caption style picker when subtitles are off", async () => {
    renderPage();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("tab-topic-to-video"));
    await user.click(screen.getByTestId("switch-subtitles"));
    expect(screen.queryByTestId("select-caption-style")).toBeNull();
  });

  it("blocks character-mode topic videos until a character is picked", async () => {
    renderPage();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("tab-topic-to-video"));
    fireEvent.change(screen.getByTestId("input-video-prompt"), {
      target: { value: "a day in the life of a founder" },
    });
    expect((screen.getByTestId("button-generate-video") as HTMLButtonElement).disabled).toBe(false);
    await user.click(screen.getByTestId("toggle-visuals-character"));
    // No characters exist: generation is blocked and creation is offered.
    expect((screen.getByTestId("button-generate-video") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("button-manage-characters")).toBeTruthy();
    // The character manager opens from the empty state.
    await user.click(screen.getByTestId("button-manage-characters"));
    expect(screen.getByTestId("button-create-character")).toBeTruthy();
  });

  it("opens an enlarged outfit image when the character preview is clicked", async () => {
    mockState.characters = [
      {
        id: 3,
        name: "Maya",
        description: "cheerful founder",
        referenceImagePath: "/objects/1/uploads/maya.png",
        outfits: [
          {
            id: 10,
            name: "Default",
            description: "casual",
            referenceImagePath: "/objects/1/uploads/maya.png",
            isDefault: true,
          },
        ],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ];
    renderPage();
    const user = userEvent.setup();

    await user.click(screen.getByTestId("button-manage-characters"));
    await user.click(screen.getByRole("button", { name: "Preview Maya wearing Default" }));
    await user.click(screen.getByTestId("button-enlarge-outfit-preview-10"));

    const viewer = screen.getByTestId("dialog-enlarged-outfit-preview");
    const enlargedImage = viewer.querySelector("img");
    expect(enlargedImage?.getAttribute("src")).toBe("/api/storage/objects/1/uploads/maya.png");
    expect(enlargedImage?.getAttribute("alt")).toBe("Maya wearing Default");
  });

  it("offers the character picker on Text to Video when characters exist", async () => {
    mockState.characters = [
      {
        id: 3,
        name: "Maya",
        description: "cheerful founder",
        referenceImagePath: "/objects/1/uploads/maya.png",
        outfits: [
          { id: 10, name: "Default", description: "casual", referenceImagePath: "/objects/1/uploads/maya.png", isDefault: true },
        ],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ];
    renderPage();
    expect(screen.getByTestId("select-character")).toBeTruthy();
    // Without a character picked, the submitted body carries no character lock.
    fireEvent.change(screen.getByTestId("input-video-prompt"), {
      target: { value: "A calm ocean at dusk" },
    });
    fireEvent.click(screen.getByTestId("button-generate-video"));
    await waitFor(() => expect(mockState.lastGenerateVars).toBeTruthy());
    expect(mockState.lastGenerateVars.data).toMatchObject({
      engine: "text_to_video",
      characterId: null,
      outfitId: null,
    });
  });

  it("shows the finished video with save and download actions", () => {
    mockState.activeJob = {
      id: 7,
      engine: "text_to_video",
      status: "succeeded",
      prompt: "sunset",
      sourceImagePaths: [],
      aspectRatio: "9:16",
      videoPath: "/objects/1/uploads/v.mp4",
      thumbnailPath: "/objects/1/uploads/p.png",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    mockState.jobs = [mockState.activeJob];
    renderPage();
    // Select the job from the recent grid so it becomes active.
    fireEvent.click(screen.getByTestId("job-card-7"));
    const video = screen.getByTestId("video-preview") as HTMLVideoElement;
    expect(video.getAttribute("src")).toBe("/api/storage/objects/1/uploads/v.mp4");
    expect(screen.getByTestId("button-save-video")).toBeTruthy();
  });

  it("starts a no-charge repair for an eligible completed video", async () => {
    mockState.activeJob = {
      id: 7,
      engine: "topic_to_video",
      status: "succeeded",
      prompt: "sunset",
      sourceImagePaths: [],
      aspectRatio: "9:16",
      videoPath: "/objects/1/uploads/original.mp4",
      currentVideoPath: "/objects/1/uploads/original.mp4",
      thumbnailPath: null,
      repairable: true,
      repair: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    mockState.jobs = [mockState.activeJob];
    renderPage();
    fireEvent.click(screen.getByTestId("job-card-7"));
    await userEvent.setup().click(screen.getByTestId("button-repair-video"));
    expect(screen.getByText(/will not regenerate paid assets/i)).toBeTruthy();
    await userEvent.setup().click(screen.getByTestId("button-confirm-repair-video"));
    expect(mockState.repairedJobs).toEqual([{ jobId: 7, reason: "audio_visual" }]);
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Repair started" }),
    );
  });

  it("keeps a failed repair linked to the preserved original without a paid retry action", () => {
    mockState.activeJob = {
      id: 109,
      engine: "topic_to_video",
      status: "failed",
      prompt: "sunset",
      sourceImagePaths: [],
      aspectRatio: "9:16",
      videoPath: null,
      currentVideoPath: null,
      thumbnailPath: null,
      repairable: false,
      repair: { chainId: 7, sourceJobId: 7, reason: "captions" },
      error: "A saved scene asset is missing. The original video is still available.",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    mockState.jobs = [mockState.activeJob];
    renderPage();
    fireEvent.click(screen.getByTestId("job-card-109"));
    expect(screen.getByText("Repair could not be completed")).toBeTruthy();
    expect(screen.getByTestId("button-open-original-video")).toBeTruthy();
    expect(screen.queryByTestId("button-retry-video")).toBeNull();
  });

  it("shows a cancelled repair as safe to restart from the original", () => {
    mockState.activeJob = {
      id: 109,
      engine: "topic_to_video",
      status: "cancelled",
      prompt: "sunset",
      sourceImagePaths: [],
      aspectRatio: "9:16",
      videoPath: null,
      currentVideoPath: null,
      thumbnailPath: null,
      repairable: false,
      repair: { chainId: 7, sourceJobId: 7, reason: "captions" },
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    mockState.jobs = [mockState.activeJob];
    renderPage();
    fireEvent.click(screen.getByTestId("job-card-109"));
    expect(screen.getByText("Repair cancelled")).toBeTruthy();
    expect(screen.getByTestId("button-open-original-video")).toBeTruthy();
  });

  it("keeps an actionable missing-asset failure visible inside the repair dialog", async () => {
    mockState.activeJob = {
      id: 7,
      engine: "topic_to_video",
      status: "succeeded",
      prompt: "sunset",
      sourceImagePaths: [],
      aspectRatio: "9:16",
      videoPath: "/objects/1/uploads/original.mp4",
      currentVideoPath: "/objects/1/uploads/original.mp4",
      thumbnailPath: null,
      repairable: true,
      repair: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    mockState.jobs = [mockState.activeJob];
    mockState.repairError = {
      data: {
        error:
          "A saved repair asset is missing (scene.png). The original video is unchanged.",
      },
    };
    renderPage();
    fireEvent.click(screen.getByTestId("job-card-7"));
    const user = userEvent.setup();
    await user.click(screen.getByTestId("button-repair-video"));
    await user.click(screen.getByTestId("button-confirm-repair-video"));
    expect(screen.getByTestId("repair-start-error").textContent).toMatch(
      /saved repair asset is missing.*original video is unchanged/i,
    );
    expect(screen.getByTestId("repair-start-error").textContent).toMatch(
      /no AI quota or wallet balance/i,
    );
  });

  it("reveals the polished final prompt per shot on a finished text-to-video job", () => {
    mockState.activeJob = {
      id: 7,
      engine: "text_to_video",
      status: "succeeded",
      prompt: "sunset",
      sourceImagePaths: [],
      aspectRatio: "9:16",
      videoPath: "/objects/1/uploads/v.mp4",
      thumbnailPath: null,
      storyboard: {
        version: 1,
        visualsSource: "prompt",
        timelineLocked: false,
        regenerations: 0,
        narration: null,
        model: "m",
        provider: "p",
        scenes: [
          {
            id: "s1",
            text: "",
            visual: "A calm ocean",
            durationSec: 5,
            previewPath: null,
            outfitId: null,
            renderVisual: "Cinematic wide shot of a calm ocean at dusk, soft light",
          },
          // No polish stored (e.g. older job) — must not offer a reveal.
          {
            id: "s2",
            text: "",
            visual: "Waves crashing",
            durationSec: 5,
            previewPath: null,
            outfitId: null,
            renderVisual: null,
          },
        ],
      },
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    mockState.jobs = [mockState.activeJob];
    renderPage();
    fireEvent.click(screen.getByTestId("job-card-7"));
    const section = screen.getByTestId("final-shot-prompts");
    expect(section.textContent).toContain("Final shot prompts");
    // The approved text is visible up front; the polished prompt is behind a toggle.
    expect(screen.getByTestId("final-prompt-scene-s1").textContent).toContain("A calm ocean");
    expect(screen.queryByTestId("text-final-prompt-s1")).toBeNull();
    fireEvent.click(screen.getByTestId("button-toggle-final-prompt-s1"));
    const revealed = screen.getByTestId("text-final-prompt-s1");
    expect(revealed.textContent).toContain("Final rendered prompt (AI-polished)");
    expect(revealed.textContent).toContain("Cinematic wide shot of a calm ocean at dusk");
    // The unpolished scene has no card at all.
    expect(screen.queryByTestId("final-prompt-scene-s2")).toBeNull();

    // Copy puts the polished prompt on the clipboard.
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    fireEvent.click(screen.getByTestId("button-copy-final-prompt-s1"));
    expect(writeText).toHaveBeenCalledWith(
      "Cinematic wide shot of a calm ocean at dusk, soft light",
    );

    // "Use as new brief" prefills the text-to-video prompt field.
    fireEvent.click(screen.getByTestId("button-use-final-prompt-s1"));
    const promptField = screen.getByTestId("input-video-prompt") as HTMLTextAreaElement;
    expect(promptField.value).toBe("Cinematic wide shot of a calm ocean at dusk, soft light");
  });

  it("shows no final-prompt section when the storyboard stored no polish", () => {
    mockState.activeJob = {
      id: 7,
      engine: "text_to_video",
      status: "succeeded",
      prompt: "sunset",
      sourceImagePaths: [],
      aspectRatio: "9:16",
      videoPath: "/objects/1/uploads/v.mp4",
      thumbnailPath: null,
      storyboard: {
        version: 1,
        visualsSource: "prompt",
        timelineLocked: false,
        regenerations: 0,
        narration: null,
        model: "m",
        provider: "p",
        scenes: [
          {
            id: "s1",
            text: "",
            visual: "A calm ocean",
            durationSec: 5,
            previewPath: null,
            outfitId: null,
          },
        ],
      },
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    mockState.jobs = [mockState.activeJob];
    renderPage();
    fireEvent.click(screen.getByTestId("job-card-7"));
    expect(screen.getByTestId("video-preview")).toBeTruthy();
    expect(screen.queryByTestId("final-shot-prompts")).toBeNull();
  });

  it("shows the AI amount spent line on a finished video when a rate is set", () => {
    mockState.aiSpendRates = { captionPaise: 550, imagePaise: 1100, videoPaise: 2500 };
    mockState.activeJob = {
      id: 7,
      engine: "text_to_video",
      status: "succeeded",
      prompt: "sunset",
      sourceImagePaths: [],
      aspectRatio: "9:16",
      videoPath: "/objects/1/uploads/v.mp4",
      thumbnailPath: "/objects/1/uploads/p.png",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    mockState.jobs = [mockState.activeJob];
    renderPage();
    fireEvent.click(screen.getByTestId("job-card-7"));
    const line = screen.getByTestId("text-video-ai-spent");
    expect(line.textContent).toContain("AI amount spent");
    expect(line.textContent).toContain("25.00");
  });

  it("shows a legible job number on the active generation and recent video card", () => {
    mockState.activeJob = {
      id: 37190,
      engine: "text_to_video",
      status: "succeeded",
      prompt: "Tracked generation",
      sourceImagePaths: [],
      aspectRatio: "9:16",
      videoPath: "/objects/1/uploads/tracked.mp4",
      thumbnailPath: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    mockState.jobs = [mockState.activeJob];

    renderPage();

    expect(screen.getByTestId("active-video-job-number").textContent).toContain("Job #37190");
    expect(screen.getByTestId("job-number-37190").textContent).toContain("Job #37190");
  });

  it("removes saved jobs from the unsaved timeline and prevents duplicate saving", () => {
    mockState.activeJob = {
      id: 37190,
      engine: "text_to_video",
      status: "succeeded",
      prompt: "Saved generation",
      sourceImagePaths: [],
      aspectRatio: "9:16",
      videoPath: "/objects/1/uploads/saved.mp4",
      thumbnailPath: null,
      savedContentItemId: 44,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    mockState.jobs = [mockState.activeJob];

    renderPage();

    expect(screen.queryByTestId("job-card-37190")).toBeNull();
    expect(screen.queryByTestId("button-save-video")).toBeNull();
    expect(screen.getByTestId("video-saved-to-library").textContent).toContain("Saved to library");
    expect(screen.getByTestId("active-video-job-number").textContent).toContain(
      "Saved generation history",
    );
    expect(screen.getByTestId("saved-video-explanation").textContent).toContain(
      "managed separately in the Content Library",
    );
  });

  it("multiplies the AI amount spent by the job's charged unit count", () => {
    mockState.aiSpendRates = { captionPaise: 550, imagePaise: 1100, videoPaise: 2500 };
    mockState.activeJob = {
      id: 7,
      engine: "text_to_video",
      status: "succeeded",
      prompt: "sunset",
      sourceImagePaths: [],
      aspectRatio: "9:16",
      videoPath: "/objects/1/uploads/v.mp4",
      thumbnailPath: null,
      units: 4,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    mockState.jobs = [mockState.activeJob];
    renderPage();
    fireEvent.click(screen.getByTestId("job-card-7"));
    const line = screen.getByTestId("text-video-ai-spent");
    expect(line.textContent).toContain("100.00");
  });

  it("prefers the job's charge-time rate snapshot over the current admin rate", () => {
    // Admin has since raised the rate to 9900; the job froze 2500 at charge
    // time, so history must keep showing what was really charged.
    mockState.aiSpendRates = { captionPaise: 550, imagePaise: 1100, videoPaise: 9900 };
    mockState.activeJob = {
      id: 7,
      engine: "text_to_video",
      status: "succeeded",
      prompt: "sunset",
      sourceImagePaths: [],
      aspectRatio: "9:16",
      videoPath: "/objects/1/uploads/v.mp4",
      thumbnailPath: null,
      units: 4,
      chargedRatePaise: 2500,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    mockState.jobs = [mockState.activeJob];
    renderPage();
    fireEvent.click(screen.getByTestId("job-card-7"));
    const line = screen.getByTestId("text-video-ai-spent");
    expect(line.textContent).toContain("100.00");
    expect(line.textContent).not.toContain("396.00");
  });

  it("shows a snapshotted job's spend even when the current rate is zero", () => {
    mockState.aiSpendRates = { captionPaise: 550, imagePaise: 1100, videoPaise: 0 };
    mockState.activeJob = {
      id: 7,
      engine: "text_to_video",
      status: "succeeded",
      prompt: "sunset",
      sourceImagePaths: [],
      aspectRatio: "9:16",
      videoPath: "/objects/1/uploads/v.mp4",
      thumbnailPath: null,
      chargedRatePaise: 2500,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    mockState.jobs = [mockState.activeJob];
    renderPage();
    fireEvent.click(screen.getByTestId("job-card-7"));
    expect(screen.getByTestId("text-video-ai-spent").textContent).toContain("25.00");
  });

  it("prefers the job's snapshotted total spend over any rate x units estimate", () => {
    // Cost_plus mode: the real spend (cost + margin) rarely equals
    // rate x units — the snapshot must win outright, ignoring units and the
    // charge-time rate.
    mockState.aiSpendRates = { captionPaise: 550, imagePaise: 1100, videoPaise: 9900 };
    mockState.activeJob = {
      id: 7,
      engine: "text_to_video",
      status: "succeeded",
      prompt: "sunset",
      sourceImagePaths: [],
      aspectRatio: "9:16",
      videoPath: "/objects/1/uploads/v.mp4",
      thumbnailPath: null,
      units: 4,
      chargedRatePaise: 2500,
      spendPaise: 1234,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    mockState.jobs = [mockState.activeJob];
    renderPage();
    fireEvent.click(screen.getByTestId("job-card-7"));
    const line = screen.getByTestId("text-video-ai-spent");
    expect(line.textContent).toContain("12.34");
    expect(line.textContent).not.toContain("100.00"); // chargedRate x units
    expect(line.textContent).not.toContain("396.00"); // current rate x units
  });

  it("hides the line when the snapshot says the job charged nothing", () => {
    // A persisted 0 means the job really charged nothing — never replace it
    // with a nonzero flat/charged estimate.
    mockState.aiSpendRates = { captionPaise: 550, imagePaise: 1100, videoPaise: 9900 };
    mockState.activeJob = {
      id: 7,
      engine: "text_to_video",
      status: "succeeded",
      prompt: "sunset",
      sourceImagePaths: [],
      aspectRatio: "9:16",
      videoPath: "/objects/1/uploads/v.mp4",
      thumbnailPath: null,
      units: 4,
      chargedRatePaise: 2500,
      spendPaise: 0,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    mockState.jobs = [mockState.activeJob];
    renderPage();
    fireEvent.click(screen.getByTestId("job-card-7"));
    expect(screen.getByTestId("video-preview")).toBeTruthy();
    expect(screen.queryByTestId("text-video-ai-spent")).toBeNull();
  });

  it("hides the AI amount spent line when the video rate is zero", () => {
    mockState.aiSpendRates = { captionPaise: 550, imagePaise: 1100, videoPaise: 0 };
    mockState.activeJob = {
      id: 7,
      engine: "text_to_video",
      status: "succeeded",
      prompt: "sunset",
      sourceImagePaths: [],
      aspectRatio: "9:16",
      videoPath: "/objects/1/uploads/v.mp4",
      thumbnailPath: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    mockState.jobs = [mockState.activeJob];
    renderPage();
    fireEvent.click(screen.getByTestId("job-card-7"));
    expect(screen.getByTestId("video-preview")).toBeTruthy();
    expect(screen.queryByTestId("text-video-ai-spent")).toBeNull();
  });

  it("shows the server-reported pipeline stage while a job is processing", () => {
    mockState.activeJob = {
      id: 8,
      engine: "topic_to_video",
      status: "processing",
      prompt: "coffee culture",
      sourceImagePaths: [],
      aspectRatio: "9:16",
      stage: "Voicing the narration",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    mockState.jobs = [mockState.activeJob];
    renderPage();
    fireEvent.click(screen.getByTestId("job-card-8"));
    expect(screen.getByTestId("text-job-stage").textContent).toBe("Voicing the narration…");
  });

  it("offers a storyboard on every engine except searched stock footage", async () => {
    renderPage();
    const user = userEvent.setup();
    // Text to Video.
    expect(screen.getByTestId("switch-review-storyboard")).toBeTruthy();
    await user.click(screen.getByTestId("tab-image-to-video"));
    expect(screen.getByTestId("switch-review-storyboard")).toBeTruthy();
    await user.click(screen.getByTestId("tab-slideshow"));
    expect(screen.getByTestId("text-storyboard-blurb").textContent).toContain(
      "every photo with its own caption and length",
    );
    // Topic mode defaults to stock footage, which is searched rather than
    // prompted — there is nothing to edit, so the toggle is gone.
    await user.click(screen.getByTestId("tab-topic-to-video"));
    expect(screen.queryByTestId("switch-review-storyboard")).toBeNull();
    await user.click(screen.getByTestId("toggle-visuals-ai"));
    expect(screen.getByTestId("switch-review-storyboard")).toBeTruthy();
  });

  it("prices the shot count and sends it with a text-to-video job", async () => {
    renderPage();
    const user = userEvent.setup();
    expect(screen.getByTestId("text-shot-cost").textContent).toContain("One clip, one video unit");
    await user.click(screen.getByTestId("select-shot-count"));
    await user.click(screen.getByTestId("option-shots-3"));
    expect(screen.getByTestId("text-shot-cost").textContent).toContain("3 video units");
    fireEvent.change(screen.getByTestId("input-video-prompt"), {
      target: { value: "A calm ocean at dusk" },
    });
    fireEvent.click(screen.getByTestId("button-generate-video"));
    await waitFor(() => expect(mockState.lastGenerateVars).toBeTruthy());
    expect(mockState.lastGenerateVars.data).toMatchObject({
      engine: "text_to_video",
      shotCount: 3,
      reviewStoryboard: true,
    });
  });

  it("keeps the shots picker off engines that cannot split shots", async () => {
    renderPage();
    const user = userEvent.setup();
    expect(screen.getByTestId("select-shot-count")).toBeTruthy();
    await user.click(screen.getByTestId("tab-slideshow"));
    expect(screen.queryByTestId("select-shot-count")).toBeNull();
  });

  it("opens a paused plan in a dialog the user can reopen", async () => {
    mockState.activeJob = pausedJob(clipBoard("prompt"));
    mockState.jobs = [mockState.activeJob];
    renderPage();
    fireEvent.click(screen.getByTestId("job-card-11"));
    // The plan announces itself: the dialog is open without being asked for.
    await waitFor(() => expect(screen.getByTestId("storyboard-review")).toBeTruthy());
    expect(screen.getByTestId("text-storyboard-summary").textContent).toContain("2 shots");
    // And it can be got back after a dismissal.
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("storyboard-review")).toBeNull());
    fireEvent.click(screen.getByTestId("button-open-storyboard"));
    await waitFor(() => expect(screen.getByTestId("storyboard-review")).toBeTruthy());
  });

  it("lets a shot's length be edited, and hides redraw on the user's own photos", async () => {
    // A clip plan voices nothing, which is what frees the timeline.
    mockState.activeJob = pausedJob(clipBoard("slide"));
    mockState.jobs = [mockState.activeJob];
    renderPage();
    fireEvent.click(screen.getByTestId("job-card-11"));
    await waitFor(() => expect(screen.getByTestId("storyboard-review")).toBeTruthy());
    expect(screen.getByTestId("select-length-s1")).toBeTruthy();
    // The preview is the upload itself, so there is nothing to redraw.
    expect(screen.queryByTestId("button-redraw-s1")).toBeNull();
    expect(screen.queryByTestId("text-rolls-left")).toBeNull();
  });

  it("pins lengths to the recording on a narrated plan", async () => {
    mockState.activeJob = pausedJob(narratedBoard());
    mockState.jobs = [mockState.activeJob];
    renderPage();
    fireEvent.click(screen.getByTestId("job-card-11"));
    await waitFor(() => expect(screen.getByTestId("storyboard-review")).toBeTruthy());
    expect(screen.queryByTestId("select-length-s1")).toBeNull();
    expect(screen.getByTestId("text-storyboard-summary").textContent).toContain(
      "the voiceover re-records to match",
    );
    // Stills on a character plan were drawn, so those can be re-rolled.
    expect(screen.getByTestId("button-redraw-s1")).toBeTruthy();
  });

  it("shows persisted previews for presenter B-roll without enabling AI redraws", async () => {
    mockState.activeJob = pausedJob(presenterBrollBoard());
    mockState.jobs = [mockState.activeJob];
    renderPage();
    fireEvent.click(screen.getByTestId("job-card-11"));
    await waitFor(() => expect(screen.getByTestId("storyboard-review")).toBeTruthy());
    const preview = screen.getByAltText("Shot 1 preview") as HTMLImageElement;
    expect(preview.src).toContain("presenter-poster.png");
    expect(screen.getByTestId("text-storyboard-summary").textContent).toContain("B-roll beat");
    expect(screen.queryByTestId("button-redraw-pb1")).toBeNull();
    expect(screen.queryByTestId("select-length-pb1")).toBeNull();
  });

  it("edits the full script in shared draft state, saves every changed scene together, and can render", async () => {
    mockState.activeJob = pausedJob(narratedBoard());
    mockState.jobs = [mockState.activeJob];
    renderPage();
    fireEvent.click(screen.getByTestId("job-card-11"));
    await waitFor(() => expect(screen.getByTestId("storyboard-review")).toBeTruthy());
    // An edit typed but not yet saved must appear in the reading view.
    fireEvent.change(screen.getByTestId("input-narration-s1"), {
      target: { value: "A fresh opening line" },
    });
    fireEvent.click(screen.getByTestId("button-read-script"));
    await waitFor(() => expect(screen.getByTestId("text-full-script")).toBeTruthy());
    expect((screen.getByTestId("input-script-narration-s1") as HTMLTextAreaElement).value).toBe(
      "A fresh opening line",
    );
    fireEvent.change(screen.getByTestId("input-script-narration-s2"), {
      target: { value: "A revised closing line" },
    });
    fireEvent.change(screen.getByTestId("input-script-visual-s1"), {
      target: { value: "a bright opening frame" },
    });
    // The card and dialog are two views over one draft, not copied state.
    expect((screen.getByTestId("input-narration-s2") as HTMLTextAreaElement).value).toBe(
      "A revised closing line",
    );
    expect((screen.getByTestId("input-shot-s1") as HTMLTextAreaElement).value).toBe(
      "a bright opening frame",
    );
    fireEvent.click(screen.getByTestId("button-save-full-script"));
    await waitFor(() =>
      expect(screen.getByTestId("status-full-script-save").textContent).toContain("All changes saved"),
    );
    expect(mockState.storyboardEdits).toEqual([
      {
        jobId: 11,
        data: {
          scenes: [
            { id: "s1", text: "A fresh opening line", visual: "a bright opening frame" },
            { id: "s2", text: "A revised closing line" },
          ],
        },
      },
    ]);
    // Rendering straight from the reading view still flushes the edit first.
    fireEvent.click(screen.getByTestId("button-render-from-script"));
    await waitFor(() => expect(mockState.approvals).toEqual([11]));
  });

  it("keeps the full-script dialog open with clear error feedback when batch save fails", async () => {
    mockState.activeJob = pausedJob(narratedBoard());
    mockState.jobs = [mockState.activeJob];
    mockState.storyboardEditError = { data: { error: "A scene is too long." } };
    renderPage();
    fireEvent.click(screen.getByTestId("job-card-11"));
    fireEvent.click(await screen.findByTestId("button-read-script"));
    fireEvent.change(screen.getByTestId("input-script-narration-s1"), {
      target: { value: "An invalid replacement" },
    });
    fireEvent.click(screen.getByTestId("button-save-full-script"));
    await waitFor(() =>
      expect(screen.getByTestId("status-full-script-save").textContent).toContain(
        "Changes not saved",
      ),
    );
    expect(screen.getByTestId("text-full-script")).toBeTruthy();
    expect((screen.getByTestId("input-script-narration-s1") as HTMLTextAreaElement).value).toBe(
      "An invalid replacement",
    );
  });

  it("does not discard newer typing when an earlier full-script save finishes", async () => {
    mockState.activeJob = pausedJob(narratedBoard());
    mockState.jobs = [mockState.activeJob];
    mockState.deferStoryboardEdit = true;
    renderPage();
    fireEvent.click(screen.getByTestId("job-card-11"));
    fireEvent.click(await screen.findByTestId("button-read-script"));
    fireEvent.change(screen.getByTestId("input-script-narration-s1"), {
      target: { value: "First submitted version" },
    });
    fireEvent.click(screen.getByTestId("button-save-full-script"));
    fireEvent.change(screen.getByTestId("input-script-narration-s1"), {
      target: { value: "Newer unsaved version" },
    });
    act(() => mockState.resolveStoryboardEdit?.());
    await waitFor(() =>
      expect(screen.getByTestId("status-full-script-save").textContent).toContain(
        "Edits sync with the storyboard cards",
      ),
    );
    expect((screen.getByTestId("input-script-narration-s1") as HTMLTextAreaElement).value).toBe(
      "Newer unsaved version",
    );

    mockState.deferStoryboardEdit = false;
    fireEvent.click(screen.getByTestId("button-save-full-script"));
    expect(mockState.storyboardEdits.at(-1)).toEqual({
      jobId: 11,
      data: { scenes: [{ id: "s1", text: "Newer unsaved version" }] },
    });
  });

  it("allows fixed Hybrid narration wording edits but keeps Character Dialogue read-only", async () => {
    mockState.activeJob = pausedJob(hybridBoard());
    mockState.jobs = [mockState.activeJob];
    const view = renderPage();
    fireEvent.click(screen.getByTestId("job-card-11"));
    fireEvent.click(await screen.findByTestId("button-read-script"));
    fireEvent.change(screen.getByTestId("input-script-narration-h1"), {
      target: { value: "A new hybrid opening." },
    });
    expect((screen.getByTestId("input-narration-h1") as HTMLTextAreaElement).value).toBe(
      "A new hybrid opening.",
    );

    view.unmount();
    mockState.activeJob = pausedJob({
      ...hybridBoard(),
      mode: "character_dialogue",
      scenes: hybridBoard().scenes.map((scene) => ({ ...scene, beatType: null, hybridRole: null })),
    });
    mockState.jobs = [mockState.activeJob];
    renderPage();
    fireEvent.click(screen.getByTestId("job-card-11"));
    fireEvent.click(await screen.findByTestId("button-read-script"));
    expect(screen.queryByTestId("input-script-narration-h1")).toBeNull();
    expect(screen.getAllByText(/approved dialogue · read only/i).length).toBeGreaterThan(0);
    expect(screen.getByTestId("input-script-visual-h1")).toBeTruthy();
  });

  it("saves an unsaved edit before it starts the render", async () => {
    // Typing a prompt and then watching it get filmed without is the one
    // outcome the review step exists to prevent.
    mockState.activeJob = pausedJob(clipBoard("prompt"));
    mockState.jobs = [mockState.activeJob];
    renderPage();
    fireEvent.click(screen.getByTestId("job-card-11"));
    await waitFor(() => expect(screen.getByTestId("storyboard-review")).toBeTruthy());
    fireEvent.change(screen.getByTestId("input-shot-s1"), {
      target: { value: "a slow push in on the cup" },
    });
    fireEvent.click(screen.getByTestId("button-approve-storyboard"));
    await waitFor(() => expect(mockState.approvals).toEqual([11]));
    expect(mockState.storyboardEdits).toEqual([
      { jobId: 11, data: { scenes: [{ id: "s1", visual: "a slow push in on the cup" }] } },
    ]);
  });

  it("shows guided cast metadata and blocks approval for missing or inconsistent previews", async () => {
    const board = clipBoard("slide");
    board.scenes = board.scenes.map((scene, index) => ({
      ...scene,
      previewPath: index === 0 ? scene.previewPath : null,
      guidedStory: {
        scriptSceneId: `script-${index + 1}`,
        startMs: index * 4_000,
        endMs: (index + 1) * 4_000,
        roleIds: ["hero"],
        lineOwnership: [
          {
            lineId: `line-${index + 1}`,
            ownerRoleId: "hero",
            kind: "dialogue",
            startMs: index * 4_000,
            endMs: (index + 1) * 4_000,
          },
        ],
        cast: [
          {
            roleId: "hero",
            characterName: "Ari",
            source: "saved",
            characterId: 12,
            outfitId: 34,
            referenceImagePath: "/objects/1/ari.png",
            outfitReferenceImagePath: "/objects/1/jacket.png",
            voiceProvider: "elevenlabs",
            providerVoiceId: "private-provider-id",
          },
        ],
        inconsistencyFlags: index === 0 ? ["outfit_changed"] : [],
        inputFingerprint: `fp-${index}`,
        visuals: {
          logoPath: index === 0 ? "/objects/1/logo.png" : null,
          locationMode: index === 0 ? "text" : "none",
          locationImagePath: null,
          locationDescription: index === 0 ? "A warm library" : null,
        },
      },
      previewCheckpoint: {
        status: index === 0 ? "prepared" : "complete",
        targetPath: index === 0 ? scene.previewPath! : "/objects/1/missing.png",
      },
    }));
    mockState.activeJob = pausedJob(board);
    mockState.jobs = [mockState.activeJob];
    renderPage();
    fireEvent.click(screen.getByTestId("job-card-11"));

    expect((await screen.findByTestId("guided-story-cast-s1-hero")).textContent).toContain(
      "Ari · Appearance: saved character · Outfit: saved outfit #34 · Voice: elevenlabs",
    );
    expect(screen.getByTestId("guided-story-lines-s1").textContent).toContain(
      "Dialogue · hero",
    );
    expect(screen.getByTestId("guided-story-cast-s1-hero").textContent).toContain("Cast reference: anchored");
    fireEvent.click(screen.getByTestId("button-enlarge-guided-outfit-s1-hero"));
    expect(
      (await screen.findByTestId("image-enlarged-guided-reference")).getAttribute("alt"),
    ).toBe("Ari locked outfit reference");
    expect(screen.getByText("Ari outfit reference")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(screen.getByTestId("guided-story-logo-s1").textContent).toContain("on");
    expect(screen.getByTestId("guided-story-location-s1").textContent).toContain("text — A warm library");
    expect(screen.getByTestId("guided-story-checkpoint-s1").textContent).toContain("prepared");
    expect(screen.queryByTestId("input-shot-s1")).toBeNull();
    expect(screen.queryByTestId("button-redraw-s1")).toBeNull();
    expect(screen.queryByTestId("button-add-after-s1")).toBeNull();
    expect(screen.getByTestId("guided-story-consistency-s1-outfit_changed")).toBeTruthy();
    expect(screen.getByTestId("guided-story-preview-missing-s2")).toBeTruthy();
    expect((screen.getByTestId("button-approve-storyboard") as HTMLButtonElement).disabled).toBe(
      true,
    );
    const renderMissing = screen.getByTestId("button-render-missing-guided-previews");
    expect(renderMissing.textContent).toContain("Render all missing previews (2)");
    fireEvent.click(renderMissing);
    expect(mockState.guidedPreviewRenders).toEqual([11]);
    expect(screen.getByTestId("status-guided-storyboard-blocked")).toBeTruthy();
    expect(screen.queryByText("private-provider-id")).toBeNull();
  });

  it("requires explicit identity replacement and finalizes references for the whole Guided job", async () => {
    const board = clipBoard("slide");
    board.scenes = [board.scenes[0]!];
    (board.scenes as any[])[0] = {
      ...board.scenes[0]!,
      previewCheckpoint: {
        status: "complete" as const,
        targetPath: board.scenes[0]!.previewPath!,
      },
      guidedStory: {
        scriptSceneId: "script-1",
        startMs: 0,
        endMs: 4_000,
        roleIds: ["hero"],
        lineOwnership: [],
        cast: [{
          roleId: "hero",
          characterName: "Uploaded Ari",
          source: "saved" as const,
          characterId: 12,
          outfitId: 34,
          referenceImagePath: "/objects/1/uploads/ari.png",
          outfitReferenceImagePath: "/objects/1/uploads/ari-default.png",
          voiceProvider: "stock",
          providerVoiceId: null,
        }],
        inconsistencyFlags: [],
        inputFingerprint: "before-reference-change",
        visuals: {
          logoPath: null,
          locationMode: "none" as const,
          locationImagePath: null,
          locationDescription: null,
        },
      },
    };
    mockState.characters = [{
      id: 13,
      name: "Mina",
      description: "A fictional explorer",
      referenceImagePath: "/objects/1/uploads/mina.png",
      protectedRegion: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      outfits: [{
        id: 35,
        name: "Default",
        description: "Blue field jacket",
        referenceImagePath: "/objects/1/uploads/mina-default.png",
        isDefault: true,
        status: "approved",
        identityVerified: true,
        canonicalReferenceImagePath: "/objects/1/uploads/mina.png",
        protectedRegion: null,
      }],
    }];
    mockState.activeJob = {
      ...pausedJob(board),
      guidedReferenceContext: { draftId: 5, revision: 8 },
    };
    mockState.jobs = [mockState.activeJob];
    renderPage();
    fireEvent.click(screen.getByTestId("job-card-11"));
    fireEvent.click(
      await screen.findByTestId("button-redefine-guided-character-s1-hero"),
    );
    fireEvent.click(screen.getByTestId("select-guided-character-s1-hero"));
    fireEvent.click(await screen.findByText("Mina"));

    const finalize = screen.getByTestId("button-finalize-guided-reference-s1-hero");
    expect((finalize as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(
      screen.getByTestId("checkbox-confirm-guided-character-replacement-s1-hero"),
    );
    expect((finalize as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(finalize);

    expect(mockState.finalizedGuidedReferences).toEqual([{
      jobId: 11,
      roleId: "hero",
      data: {
        revision: 8,
        characterId: 13,
        outfitId: 35,
        replaceCharacterConfirmed: true,
      },
    }]);
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "References finalized across the story",
      }),
    );
  });

  it("confirms a single Guided scene correction with locked references and shows its cost history", async () => {
    const board = clipBoard("slide");
    board.scenes = board.scenes.map((scene, index) => ({
      ...scene,
      previewCheckpoint: {
        status: "complete" as const,
        targetPath: scene.previewPath!,
      },
      guidedStory: {
        scriptSceneId: `script-${index + 1}`,
        startMs: index * 4_000,
        endMs: (index + 1) * 4_000,
        roleIds: ["hero"],
        lineOwnership: [],
        cast: [{
          roleId: "hero",
          characterName: "Ari",
          source: "saved" as const,
          characterId: 12,
          outfitId: 34,
          referenceImagePath: "/objects/1/ari.png",
          outfitReferenceImagePath: "/objects/1/jacket.png",
          voiceProvider: "stock",
          providerVoiceId: null,
        }],
        inconsistencyFlags: [],
        inputFingerprint: `fp-${index}`,
        visuals: {
          logoPath: index === 0 ? "/objects/1/logo.png" : null,
          locationMode: index === 0 ? "image" as const : "none" as const,
          locationImagePath: index === 0 ? "/objects/1/library.png" : null,
          locationDescription: null,
        },
        corrections: index === 0 ? {
          version: 1 as const,
          attempts: [{
            id: "previous",
            version: 1,
            category: "costume" as const,
            note: "Match the red jacket.",
            state: "succeeded" as const,
            inputFingerprint: `fp-${index}`,
            originalPreviewPath: "/objects/1/original.png",
            replacementPath: scene.previewPath,
            funding: "wallet" as const,
            walletReservation: null,
            walletOperationId: 5,
            provider: "openai",
            model: "gpt-image-1",
            knownCostPaise: 45,
            actualCostPaise: 40,
            error: null,
            requestedAt: new Date().toISOString(),
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
          }],
        } : undefined,
      },
    }));
    mockState.activeJob = pausedJob(board);
    mockState.jobs = [mockState.activeJob];
    renderPage();
    fireEvent.click(screen.getByTestId("job-card-11"));

    expect(
      (await screen.findByTestId("guided-correction-history-s1")).textContent,
    ).toContain("actual ₹0.40");
    fireEvent.click(screen.getByTestId("button-correct-scene-s1"));
    expect(screen.getAllByAltText("Ari locked cast reference").length).toBeGreaterThan(0);
    expect(screen.getAllByAltText("Ari locked outfit reference").length).toBeGreaterThan(0);
    expect(screen.getAllByAltText("Locked location reference").length).toBeGreaterThan(0);
    expect(screen.getAllByAltText("Locked logo reference").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByTestId("checkbox-guided-correction-costume"));
    fireEvent.click(screen.getByTestId("checkbox-guided-correction-location"));
    fireEvent.change(screen.getByTestId("input-guided-correction-note"), {
      target: { value: "Keep Ari in the approved jacket." },
    });
    fireEvent.click(screen.getByTestId("checkbox-confirm-guided-correction"));
    fireEvent.click(screen.getByTestId("button-confirm-guided-correction"));

    expect(mockState.guidedCorrections).toEqual([{
      jobId: 11,
      sceneId: "s1",
      data: {
        category: "other",
        note:
          "Issues to correct: Character, Costume, Location. Keep Ari in the approved jacket.",
        confirmed: true,
      },
    }]);
  });

  it("shows Guided preview progress and offers a retry after interruption", async () => {
    const board = clipBoard("slide");
    board.scenes = board.scenes.map((scene, index) => ({
      ...scene,
      previewPath: index === 0 ? scene.previewPath : null,
      previewCheckpoint:
        index === 0
          ? { status: "complete" as const, targetPath: scene.previewPath! }
          : { status: "prepared" as const, targetPath: `/objects/1/pending-${index}.png` },
      guidedStory: {
        scriptSceneId: `script-${index + 1}`,
        startMs: index * 4_000,
        endMs: (index + 1) * 4_000,
        roleIds: [],
        lineOwnership: [],
        cast: [],
        inconsistencyFlags: [],
        inputFingerprint: `fp-${index}`,
        visuals: {
          logoPath: null,
          locationMode: "none" as const,
          locationImagePath: null,
          locationDescription: null,
        },
      },
    }));
    mockState.activeJob = {
      ...pausedJob(board),
      guidedPreviewRender: {
        version: 1,
        operationId: "guided-preview:11:failed",
        state: "failed",
        total: 3,
        completed: 1,
        error: "The preview worker restarted.",
        retryable: true,
        requestedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      },
    };
    mockState.jobs = [mockState.activeJob];
    renderPage();
    fireEvent.click(screen.getByTestId("job-card-11"));

    expect((await screen.findByTestId("status-guided-preview-render")).textContent).toContain(
      "Preview rendering was interrupted · 1 of 3 complete",
    );
    expect(screen.getByTestId("status-guided-preview-render").textContent).toContain(
      "The preview worker restarted.",
    );
    expect(screen.getByTestId("button-render-missing-guided-previews").textContent).toContain(
      "Retry missing previews (1)",
    );
  });

  it("does not render stale text when a newer edit arrives during the render save", async () => {
    mockState.activeJob = pausedJob(narratedBoard());
    mockState.jobs = [mockState.activeJob];
    mockState.deferStoryboardEdit = true;
    renderPage();
    fireEvent.click(screen.getByTestId("job-card-11"));
    fireEvent.change(await screen.findByTestId("input-narration-s1"), {
      target: { value: "First version queued for render" },
    });
    fireEvent.click(screen.getByTestId("button-approve-storyboard"));
    fireEvent.change(screen.getByTestId("input-narration-s1"), {
      target: { value: "Newer version that must not be lost" },
    });
    act(() => mockState.resolveStoryboardEdit?.());

    await waitFor(() => expect(mockState.approvals).toEqual([]));
    expect((screen.getByTestId("input-narration-s1") as HTMLTextAreaElement).value).toBe(
      "Newer version that must not be lost",
    );
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Newer edits still need saving" }),
    );
  });

  it("falls back to a generic label when no stage is reported yet", () => {
    mockState.activeJob = {
      id: 9,
      engine: "text_to_video",
      status: "processing",
      prompt: "sunset",
      sourceImagePaths: [],
      aspectRatio: "9:16",
      stage: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    mockState.jobs = [mockState.activeJob];
    renderPage();
    fireEvent.click(screen.getByTestId("job-card-9"));
    expect(screen.getByTestId("text-job-stage").textContent).toBe("Rendering your video…");
  });
});

/** Record then stop on the same voice button, driving the fake recorder. */
async function dictate(user: ReturnType<typeof userEvent.setup>, testId: string) {
  await user.click(screen.getByTestId(testId));
  await waitFor(() =>
    expect(screen.getByTestId(testId).textContent).toContain("Stop recording"),
  );
  await user.click(screen.getByTestId(testId));
}

describe("Video Studio voice notes", () => {
  it("fills the brief from a voice note on every engine", async () => {
    mockState.transcript = "a sunrise over the mountains";
    const user = userEvent.setup();
    for (const tab of ["tab-text-to-video", "tab-topic-to-video", "tab-image-to-video"]) {
      cleanup();
      renderPage();
      await user.click(screen.getByTestId(tab));
      await dictate(user, "button-voice-video-prompt");
      await waitFor(() =>
        expect((screen.getByTestId("input-video-prompt") as HTMLTextAreaElement).value).toBe(
          "a sunrise over the mountains",
        ),
      );
    }
  });

  it("appends the transcript after existing typed text instead of overwriting it", async () => {
    mockState.transcript = "with soft morning light";
    renderPage();
    const user = userEvent.setup();
    fireEvent.change(screen.getByTestId("input-video-prompt"), {
      target: { value: "A calm ocean at dusk" },
    });
    await dictate(user, "button-voice-video-prompt");
    await waitFor(() =>
      expect((screen.getByTestId("input-video-prompt") as HTMLTextAreaElement).value).toBe(
        "A calm ocean at dusk with soft morning light",
      ),
    );
  });

  it("shows the failure toast and leaves the field untouched when transcription errors", async () => {
    mockState.transcribeError = new Error("Speech-to-text is not configured");
    renderPage();
    const user = userEvent.setup();
    fireEvent.change(screen.getByTestId("input-video-prompt"), {
      target: { value: "A calm ocean at dusk" },
    });
    await dictate(user, "button-voice-video-prompt");
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Transcription failed",
          description: "Speech-to-text is not configured",
          variant: "destructive",
        }),
      ),
    );
    expect((screen.getByTestId("input-video-prompt") as HTMLTextAreaElement).value).toBe(
      "A calm ocean at dusk",
    );
  });

  it("dictates the slideshow overlay caption", async () => {
    mockState.transcript = "Summer collection twenty six";
    renderPage();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("tab-slideshow"));
    await dictate(user, "button-voice-overlay-text");
    await waitFor(() =>
      expect((screen.getByTestId("input-overlay-text") as HTMLInputElement).value).toBe(
        "Summer collection twenty six",
      ),
    );
  });

  it("dictates wardrobe notes in topic character mode", async () => {
    mockState.transcript = "switch to gym wear halfway";
    renderPage();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("tab-topic-to-video"));
    await user.click(screen.getByTestId("toggle-visuals-character"));
    await dictate(user, "button-voice-wardrobe-notes");
    await waitFor(() =>
      expect((screen.getByTestId("input-wardrobe-notes") as HTMLInputElement).value).toBe(
        "switch to gym wear halfway",
      ),
    );
  });

  it("dictates a scene's narration and visual in the storyboard review, appending to each", async () => {
    mockState.activeJob = pausedJob(narratedBoard());
    mockState.jobs = [mockState.activeJob];
    mockState.transcript = "spoken addition";
    renderPage();
    const user = userEvent.setup();
    fireEvent.click(screen.getByTestId("job-card-11"));
    await waitFor(() => expect(screen.getByTestId("storyboard-review")).toBeTruthy());
    await dictate(user, "button-voice-narration-s1");
    await waitFor(() =>
      expect((screen.getByTestId("input-narration-s1") as HTMLTextAreaElement).value).toBe(
        "Line 1 spoken addition",
      ),
    );
    await dictate(user, "button-voice-shot-s1");
    await waitFor(() =>
      expect((screen.getByTestId("input-shot-s1") as HTMLTextAreaElement).value).toBe(
        "wide shot 1 spoken addition",
      ),
    );
  });

  it("dictates both fields of the add-scene dialog", async () => {
    mockState.activeJob = pausedJob(narratedBoard());
    mockState.jobs = [mockState.activeJob];
    mockState.transcript = "a brand new line";
    renderPage();
    const user = userEvent.setup();
    fireEvent.click(screen.getByTestId("job-card-11"));
    await waitFor(() => expect(screen.getByTestId("storyboard-review")).toBeTruthy());
    await user.click(screen.getByTestId("button-add-scene-end"));
    await dictate(user, "button-voice-add-scene-text");
    await waitFor(() =>
      expect((screen.getByTestId("input-add-scene-text") as HTMLTextAreaElement).value).toBe(
        "a brand new line",
      ),
    );
    await dictate(user, "button-voice-add-scene-visual");
    await waitFor(() =>
      expect((screen.getByTestId("input-add-scene-visual") as HTMLTextAreaElement).value).toBe(
        "a brand new line",
      ),
    );
  });

  it("dictates the character appearance description", async () => {
    mockState.transcript = "a cheerful woman in her late twenties";
    renderPage();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("tab-topic-to-video"));
    await user.click(screen.getByTestId("toggle-visuals-character"));
    await user.click(screen.getByTestId("button-manage-characters"));
    await dictate(user, "button-voice-character-description");
    await waitFor(() =>
      expect(
        (screen.getByTestId("input-character-description") as HTMLTextAreaElement).value,
      ).toBe("a cheerful woman in her late twenties"),
    );
  });

  it("dictates the save-to-library caption", async () => {
    mockState.activeJob = {
      id: 7,
      engine: "text_to_video",
      status: "succeeded",
      prompt: "sunset",
      sourceImagePaths: [],
      aspectRatio: "9:16",
      videoPath: "/objects/1/uploads/v.mp4",
      thumbnailPath: "/objects/1/uploads/p.png",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    mockState.jobs = [mockState.activeJob];
    mockState.transcript = "golden hour vibes";
    renderPage();
    const user = userEvent.setup();
    fireEvent.click(screen.getByTestId("job-card-7"));
    await user.click(screen.getByTestId("button-save-video"));
    await dictate(user, "button-voice-save-caption");
    await waitFor(() =>
      expect((document.getElementById("save-caption") as HTMLTextAreaElement).value).toBe(
        "golden hour vibes",
      ),
    );
  });

  it("labels included preset characters and exposes their casting metadata", async () => {
    mockState.characters = [
      {
        id: 10,
        name: "Asha",
        description: "Warm, confident product guide",
        referenceImagePath: "/objects/platform/asha.png",
        outfits: [
          {
            id: 101,
            name: "Everyday",
            description: "Blue shirt",
            referenceImagePath: "/objects/platform/asha-everyday.png",
            isDefault: true,
          },
        ],
        scope: "platform",
        archetype: "Product guide",
        ageRange: "30–40",
        languages: ["en", "hi"],
        voice: { name: "Warm alto", languages: ["en", "hi"] },
        metadata: { presentationStyle: "Conversational" },
      },
      {
        id: 20,
        name: "My founder",
        description: "Workspace character",
        referenceImagePath: "/objects/1/founder.png",
        outfits: [],
        scope: "tenant",
      },
    ];
    renderPage();
    const user = userEvent.setup();

    await user.click(screen.getByTestId("select-character"));
    expect(screen.getByText("Included cast · free to use")).toBeTruthy();
    expect(screen.getByText("Asha · Preset")).toBeTruthy();
    expect(screen.getByText("Your characters")).toBeTruthy();
    await user.click(screen.getByText("Asha · Preset"));

    const metadata = screen.getByTestId("character-metadata-10");
    expect(metadata.textContent).toContain("Included preset · free");
    expect(metadata.textContent).toContain("Warm alto");
    expect(metadata.textContent).toContain("en, hi");
    expect(metadata.textContent).toContain("Conversational");
  });

  it("hides preview, rejected, and unverified outfits from video selection", async () => {
    mockState.characters = [
      {
        id: 20,
        name: "My founder",
        description: "Workspace character",
        referenceImagePath: "/objects/1/founder.png",
        protectedRegion: null,
        outfits: [
          {
            id: 201,
            name: "Default",
            description: "Original",
            referenceImagePath: "/objects/1/founder.png",
            isDefault: true,
            status: "approved",
            identityVerified: true,
          },
          {
            id: 202,
            name: "Verified launch look",
            description: "Green blazer",
            referenceImagePath: "/objects/1/launch.png",
            isDefault: false,
            status: "approved",
            identityVerified: true,
          },
          {
            id: 203,
            name: "Still previewing",
            description: "Blue jacket",
            referenceImagePath: "/objects/1/preview.png",
            isDefault: false,
            status: "preview",
            identityVerified: true,
          },
          {
            id: 204,
            name: "Unverified look",
            description: "Red jacket",
            referenceImagePath: "/objects/1/unverified.png",
            isDefault: false,
            status: "approved",
            identityVerified: false,
          },
        ],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ];
    renderPage();
    const user = userEvent.setup();

    await user.click(screen.getByTestId("select-character"));
    await user.click(screen.getByText("My founder"));
    await user.click(screen.getByTestId("select-outfit"));

    expect(screen.getByText("Verified launch look")).toBeTruthy();
    expect(screen.queryByText("Still previewing")).toBeNull();
    expect(screen.queryByText("Unverified look")).toBeNull();
  });

  it("previews and approves a tenant-owned outfit derived from a preset", async () => {
    mockState.characters = [
      {
        id: "asha",
        name: "Asha",
        description: "Included guide",
        referenceImagePath: "/storage/public-objects/preset-characters/asha/identity.png",
        source: "preset",
        stableId: "asha",
        supportedLanguages: ["en", "hi"],
        voices: [{ id: "asha-warm", label: "Asha warm", languages: ["en", "hi"] }],
        outfits: [
          {
            id: 0,
            name: "Everyday",
            description: "Blue shirt",
            referenceImagePath: "/storage/public-objects/preset-characters/asha/signature.png",
            isDefault: true,
            status: "approved",
          },
        ],
      },
    ];
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: 311,
          name: "Launch look",
          description: "Green blazer and white sneakers",
          referenceImagePath: "/objects/1/asha-launch.png",
          status: "preview",
          isDefault: false,
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 311, name: "Launch look", status: "approved" }),
      } as Response);
    renderPage();
    const user = userEvent.setup();

    await user.click(screen.getByTestId("button-manage-characters"));
    expect(screen.getByTestId("badge-preset-character-asha").textContent).toContain("free");
    expect(screen.queryByTestId("button-delete-character-asha")).toBeNull();
    await user.click(screen.getByTestId("button-add-outfit-asha"));
    expect(trackProtectedOutfitEventSpy).toHaveBeenCalledWith(
      "protected_outfit_editor_opened",
      "preset",
      "video_studio_character_manager",
    );
    await user.type(screen.getByTestId("input-outfit-name"), "Launch look");
    await user.type(
      screen.getByTestId("input-outfit-description"),
      "Green blazer and white sneakers",
    );
    await user.click(screen.getByTestId("button-save-outfit"));

    await waitFor(() =>
      expect(
        fetchSpy.mock.calls.some(
          ([url]) => url === "/api/preset-characters/asha/outfit-derivatives",
        ),
      ).toBe(true),
    );
    const generationCall = fetchSpy.mock.calls.find(
      ([url]) => url === "/api/preset-characters/asha/outfit-derivatives",
    );
    expect(generationCall).toBeTruthy();
    expect((generationCall?.[1] as RequestInit).method).toBe("POST");
    expect(
      JSON.parse(String((generationCall?.[1] as RequestInit).body)),
    ).toMatchObject({
      protectedRegion: { x: 0.2, y: 0.04, width: 0.6, height: 0.38 },
    });
    expect(screen.getByTestId("outfit-preview-311")).toBeTruthy();
    expect(trackProtectedOutfitEventSpy).toHaveBeenCalledWith(
      "protected_outfit_preview_generated",
      "preset",
      "video_studio_character_manager",
    );
    await user.clear(screen.getByTestId("input-outfit-preview-name"));
    await user.type(screen.getByTestId("input-outfit-preview-name"), "Launch day look");
    await user.click(screen.getByTestId("button-approve-reuse-outfit"));
    await waitFor(() =>
      expect(
        fetchSpy.mock.calls.some(
          ([url]) => url === "/api/preset-characters/asha/outfit-derivatives/311",
        ),
      ).toBe(true),
    );
    const approvalCall = fetchSpy.mock.calls.find(
      ([url]) => url === "/api/preset-characters/asha/outfit-derivatives/311",
    );
    expect((approvalCall?.[1] as RequestInit).body).toBe(
      JSON.stringify({ name: "Launch day look", status: "approved" }),
    );
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Outfit approved" }),
    );
    expect(trackPresetCastEventSpy).toHaveBeenCalledWith("preset_outfit_approved", "asha");
    expect(trackProtectedOutfitEventSpy).toHaveBeenCalledWith(
      "protected_outfit_preview_approved",
      "preset",
      "video_studio_character_manager",
    );
    await user.type(screen.getByTestId("input-video-prompt"), "A launch announcement");
    await user.click(screen.getByTestId("button-generate-video"));
    await waitFor(() => expect(mockState.lastGenerateVars).toBeTruthy());
    expect(mockState.lastGenerateVars.data).toMatchObject({
      characterId: null,
      outfitId: null,
      presetCharacterId: "asha",
      presetOutfitDerivativeId: 311,
      presetVoiceId: "asha-warm",
      presetLanguage: "en",
    });
    fetchSpy.mockRestore();
  });

  it("enables Topic-to-Video character stories for a selected preset and sends preset casting fields", async () => {
    mockState.characters = [{
      id: "amara-sen", source: "preset", stableId: "amara-sen", name: "Amara",
      description: "A guide", referenceImagePath: "/storage/public-objects/preset-characters/amara-sen/identity.png",
      supportedLanguages: ["en"], voices: [{ id: "amara-en", label: "Amara English", languages: ["en"] }],
      outfits: [{ id: 0, name: "Signature", description: "Signature", referenceImagePath: "/storage/public-objects/preset-characters/amara-sen/signature.png", isDefault: true, status: "approved" }],
    }];
    renderPage();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("tab-topic-to-video"));
    await user.click(screen.getByTestId("toggle-visuals-character"));
    await user.click(screen.getByTestId("select-character"));
    await user.click(screen.getByText("Amara · Preset"));
    expect(trackPresetCastEventSpy).toHaveBeenCalledWith(
      "preset_character_selected",
      "amara-sen",
    );
    await user.type(screen.getByTestId("input-video-prompt"), "Explain the launch");
    expect((screen.getByTestId("button-generate-video") as HTMLButtonElement).disabled).toBe(false);
    await user.click(screen.getByTestId("button-generate-video"));
    expect(mockState.lastGenerateVars.data).toMatchObject({
      presetCharacterId: "amara-sen", presetVoiceId: "amara-en", presetLanguage: "en",
      characterId: null, outfitId: null,
    });
    expect(trackPresetCastEventSpy).toHaveBeenCalledWith(
      "preset_video_enqueued",
      "amara-sen",
    );
  });

  it("does not count a preset enqueue after switching back to stock visuals", async () => {
    mockState.characters = [{
      id: "amara-sen", source: "preset", stableId: "amara-sen", name: "Amara",
      description: "A guide", referenceImagePath: "/storage/public-objects/preset-characters/amara-sen/identity.png",
      supportedLanguages: ["en"], voices: [{ id: "amara-en", label: "Amara English", languages: ["en"] }],
      outfits: [],
    }];
    renderPage();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("tab-topic-to-video"));
    await user.click(screen.getByTestId("toggle-visuals-character"));
    await user.click(screen.getByTestId("select-character"));
    await user.click(screen.getByText("Amara · Preset"));
    await user.click(screen.getByTestId("toggle-visuals-stock"));
    await user.type(screen.getByTestId("input-video-prompt"), "Explain the launch");
    await user.click(screen.getByTestId("button-generate-video"));
    expect(mockState.lastGenerateVars.data.presetCharacterId).toBeNull();
    expect(trackPresetCastEventSpy).not.toHaveBeenCalledWith(
      "preset_video_enqueued",
      expect.anything(),
    );
  });

  it("enables Character Dialogue with a compatible preset licensed voice", async () => {
    mockState.characters = [{
      id: "amara-sen", source: "preset", stableId: "amara-sen", name: "Amara",
      description: "A guide", referenceImagePath: "/storage/public-objects/preset-characters/amara-sen/identity.png",
      supportedLanguages: ["en"], voices: [{ id: "amara-en", label: "Amara English", languages: ["en"] }],
      outfits: [{ id: 0, name: "Signature", description: "Signature", referenceImagePath: "/storage/public-objects/preset-characters/amara-sen/signature.png", isDefault: true, status: "approved" }],
    }];
    renderPage();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("tab-topic-to-video"));
    await user.click(screen.getByTestId("toggle-visuals-character"));
    await user.click(screen.getByTestId("toggle-character-mode-dialogue"));
    await user.click(screen.getByTestId("select-character"));
    await user.click(screen.getByText("Amara · Preset"));
    await user.type(screen.getByTestId("input-spokesperson-topic"), "Explain our launch");
    await user.click(screen.getByTestId("button-generate-spokesperson-script"));
    await user.click(screen.getByTestId("button-approve-spokesperson-script"));
    await user.click(screen.getByTestId("checkbox-lipsync-consent"));
    expect((screen.getByTestId("button-generate-video") as HTMLButtonElement).disabled).toBe(false);
    await user.click(screen.getByTestId("button-generate-video"));
    expect(mockState.lastGenerateVars.data).toMatchObject({
      engine: "dialogue_lip_sync", presetCharacterId: "amara-sen",
      presetVoiceId: "amara-en", presetLanguage: "en", characterId: null,
    });
  });

  it("switches Text-to-Video to image-capable models when a preset is selected", async () => {
    mockState.characters = [{
      id: "amara-sen", source: "preset", stableId: "amara-sen", name: "Amara",
      description: "A guide", referenceImagePath: "/storage/public-objects/preset-characters/amara-sen/identity.png",
      supportedLanguages: ["en"], voices: [{ id: "amara-en", label: "Amara English", languages: ["en"] }],
      outfits: [],
    }];
    mockState.videoModels = { models: [
      { id: "text-only", label: "Text only", modes: ["text"], durations: [5], resolutions: ["720p"], hasQuality: false, canGenerateAudio: false, unitMultiplier: 1 },
      { id: "image-model", label: "Image model", modes: ["image"], durations: [5], resolutions: ["720p"], hasQuality: false, canGenerateAudio: false, unitMultiplier: 1 },
    ] };
    renderPage();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("select-video-model"));
    expect(screen.getByText(/Text only/)).toBeTruthy();
    await user.keyboard("{Escape}");
    await user.click(screen.getByTestId("select-character"));
    await user.click(screen.getByText("Amara · Preset"));
    expect(trackPresetCastEventSpy).toHaveBeenCalledWith(
      "preset_character_selected",
      "amara-sen",
    );
    await user.click(screen.getByTestId("select-video-model"));
    expect(screen.queryByText(/Text only/)).toBeNull();
    expect(screen.getByText(/Image model/)).toBeTruthy();
  });
});
