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
} = {
  lastGenerateVars: null,
  generateError: null,
  jobs: [],
  activeJob: undefined,
  characters: [],
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
    useListVideoJobs: () => ({ data: mockState.jobs }),
    useGetGoogleDriveStatus: () => ({
      data: { connected: false, configured: true, redirectUri: "x", expired: false },
      isLoading: false,
    }),
    useListContent: () => ({ data: [], isLoading: false }),
    useListCharacters: () => ({ data: mockState.characters }),
  });
});

import { VideoStudioPage } from "./video-studio";

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
