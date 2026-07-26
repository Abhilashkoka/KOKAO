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
};

const toastSpy = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy }),
}));

vi.mock("wouter/use-browser-location", () => ({
  navigate: vi.fn(),
}));

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  return createApiClientMock({
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
    useListCharacters: () => ({ data: mockState.characters }),
    useListBrandKits: () => ({ data: mockState.brandKits }),
    useListVideoStyles: () => ({ data: mockState.styleProfiles }),
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
  toastSpy.mockClear();
  cleanup();
});

describe("Video Studio", () => {
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

  it("requires photos before a slideshow can start, and offers all three photo sources", async () => {
    renderPage();
    // Radix tabs activate on focus/pointer, not synthetic click events.
    await userEvent.setup().click(screen.getByTestId("tab-slideshow"));
    expect(screen.getByTestId("button-upload-photos")).toBeTruthy();
    expect(screen.getByTestId("button-pick-library")).toBeTruthy();
    expect(screen.getByTestId("button-pick-drive")).toBeTruthy();
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
      voice: "alloy",
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
      "lengths follow the narration",
    );
    // Stills on a character plan were drawn, so those can be re-rolled.
    expect(screen.getByTestId("button-redraw-s1")).toBeTruthy();
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
