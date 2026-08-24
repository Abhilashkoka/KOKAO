import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
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
  approvals: number[];
  transcript: string;
  transcribeError: any;
  lastSpokespersonScriptVars: any;
  lastIntakeVars: any;
  intakeResult: any;
  intakeError: any;
  spokespersonScript: string;
  spokespersonBeats: any;
  spokespersonMeta: any;
  spokespersonScriptError: any;
  aiSpendRates: any;
  wallet: any;
  me: any;
  featureFlags: Record<string, boolean> | undefined;
  retriedJobIds: number[];
} = {
  lastGenerateVars: null,
  generateError: null,
  jobs: [],
  activeJob: undefined,
  characters: [],
  brandKits: [],
  styleProfiles: [],
  storyboardEdits: [],
  approvals: [],
  transcript: "",
  transcribeError: null,
  lastSpokespersonScriptVars: null,
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
  me: undefined,
  featureFlags: undefined,
  retriedJobIds: [],
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

const toastSpy = vi.fn();
const cancelVideoJobSpy = vi.fn();
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
    useListVideoJobs: () => ({ data: mockState.jobs }),
    useGetGoogleDriveStatus: () => ({
      data: { connected: false, configured: true, redirectUri: "x", expired: false },
      isLoading: false,
    }),
    useListContent: () => ({ data: [], isLoading: false }),
    useUpdateVideoStoryboard: () => ({
      isPending: false,
      mutate: (vars: any, opts: any) => {
        mockState.storyboardEdits.push(vars);
        opts?.onSuccess?.(mockState.activeJob);
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
    useListBrandKits: () => ({ data: mockState.brandKits }),
    useGetBrandKit: () => ({ data: (mockState as any).brandKitDetail }),
    useListVideoStyles: () => ({ data: mockState.styleProfiles }),
    useGetVideoCapabilities: () => ({
      data: {
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
  mockState.lastGenerateVars = null;
  mockState.generateError = null;
  mockState.jobs = [];
  mockState.activeJob = undefined;
  mockState.characters = [];
  mockState.brandKits = [];
  mockState.styleProfiles = [];
  mockState.storyboardEdits = [];
  mockState.approvals = [];
  mockState.transcript = "";
  mockState.transcribeError = null;
  mockState.lastSpokespersonScriptVars = null;
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
  mockState.me = undefined;
  mockState.featureFlags = undefined;
  mockState.retriedJobIds = [];
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
        }),
      );
      // Ensure no stock voice fallback
      expect(mockState.lastGenerateVars.data.voice).toBeUndefined();
    });

    it("does not require a presenter recording left over from a template", async () => {
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
          styleProfileId: null,
          presenterVideoPath: null,
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
        }),
      );
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
          title: "Retry started",
          description: "KOKAO is resuming the 1 unfinished generation.",
        }),
      );
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
      });
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

  it("disables Cancel once the job is processing", async () => {
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
    expect((screen.getByTestId("button-cancel-video-job") as HTMLButtonElement).disabled).toBe(true);
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

  // Pre-generate wallet cost estimate: wallet-billed workspaces see the total
  // (units x per-unit rate) next to Generate, mirroring the server's
  // videoJobUnits counting, plus a recharge hint when the balance is short.
  describe("wallet cost estimate", () => {
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

    await user.click(screen.getByTestId("button-use-video-template-22"));
    expect(screen.getByText("Template selected")).toBeTruthy();
    fireEvent.change(screen.getByTestId("input-video-prompt"), {
      target: { value: "How independent shops can turn one customer story into a reel" },
    });
    fireEvent.click(screen.getByTestId("button-generate-video"));
    await waitFor(() => expect(mockState.lastGenerateVars).toBeTruthy());
    expect(mockState.lastGenerateVars.data).toMatchObject({
      styleProfileId: 22,
      aspectRatio: "9:16",
      paragraphCount: 2,
      captionStyle: "classic",
      subtitles: true,
    });
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

  it("opens a readable full-script view that includes unsaved edits and can render", async () => {
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
    const script = screen.getByTestId("text-full-script");
    expect(script.textContent).toContain("A fresh opening line");
    expect(script.textContent).toContain("Line 2");
    expect(script.textContent).toContain("wide shot 1");
    expect(script.textContent).toContain("wide shot 2");
    // Rendering straight from the reading view still flushes the edit first.
    fireEvent.click(screen.getByTestId("button-render-from-script"));
    await waitFor(() => expect(mockState.approvals).toEqual([11]));
    expect(mockState.storyboardEdits).toEqual([
      { jobId: 11, data: { scenes: [{ id: "s1", text: "A fresh opening line" }] } },
    ]);
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
});
