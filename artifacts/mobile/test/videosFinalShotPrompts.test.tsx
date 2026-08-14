/**
 * Mobile Videos screen — polished shot prompts (app/videos.tsx):
 * - a succeeded text_to_video job with storyboard scenes carrying
 *   `renderVisual` shows the "Final shot prompts" section when expanded
 * - Copy puts the polished prompt on the clipboard (expo-clipboard) and
 *   confirms via the notice banner
 * - "Use as new brief" prefills the text-to-video brief input
 * - jobs without stored polish (or non-text_to_video engines) render nothing
 */
import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockState: {
  jobs: Array<Record<string, unknown>>;
  flags: Record<string, boolean> | undefined;
} = { jobs: [], flags: undefined };

const generateMutate = vi.fn();

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("./apiClientMock");
  return createApiClientMock({
    useListVideoJobs: () => ({
      data: mockState.jobs,
      isLoading: false,
      isError: false,
      isRefetching: false,
      refetch: vi.fn(),
    }),
    useListFeatureFlags: () => ({ data: mockState.flags, isLoading: false }),
    useGetAiSpendRates: () => ({ data: undefined, isLoading: false }),
    useGenerateVideo: () => ({ mutate: generateMutate, isPending: false }),
  });
});

const setStringAsync = vi.fn().mockResolvedValue(true);
vi.mock("expo-clipboard", () => ({
  setStringAsync: (text: string) => setStringAsync(text),
}));

vi.mock("@clerk/expo", () => ({
  useAuth: () => ({ getToken: vi.fn().mockResolvedValue("test-token") }),
}));
vi.mock("expo-video", () => ({
  useVideoPlayer: () => ({}),
  VideoView: () => null,
}));
vi.mock("@expo/vector-icons", () => ({
  Feather: Object.assign(() => null, { glyphMap: {} }),
}));
vi.mock("expo-haptics", () => ({
  impactAsync: vi.fn(),
  ImpactFeedbackStyle: { Light: "light" },
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("@/components/ContentImage", () => ({
  ContentImage: () => null,
}));

import VideosScreen from "../app/videos";

function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    engine: "text_to_video",
    prompt: "A launch teaser",
    status: "succeeded",
    stage: null,
    error: null,
    units: 1,
    videoPath: "/videos/1.mp4",
    thumbnailPath: null,
    aspectRatio: "9:16",
    createdAt: new Date("2026-08-01T00:00:00Z").toISOString(),
    storyboard: {
      version: 1,
      visualsSource: "prompt",
      timelineLocked: false,
      regenerations: 0,
      narration: null,
      scenes: [
        {
          id: "s1",
          text: "",
          visual: "A rocket on a launch pad",
          durationSec: 5,
          previewPath: null,
          outfitId: null,
          renderVisual: "Cinematic wide shot of a gleaming rocket at dawn, mist rolling",
        },
        {
          id: "s2",
          text: "",
          visual: "Liftoff",
          durationSec: 5,
          previewPath: null,
          outfitId: null,
          renderVisual: null, // no polish stored for this shot
        },
      ],
    },
    ...overrides,
  };
}

function renderScreen() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <VideosScreen />
    </QueryClientProvider>,
  );
}

function expandFirstJob() {
  fireEvent.click(screen.getByTestId("card-video-job-1"));
}

describe("Videos screen — final shot prompts", () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    mockState.jobs = [makeJob()];
    mockState.flags = undefined;
  });

  it("shows polished prompts only for shots that stored one", () => {
    renderScreen();
    expandFirstJob();
    expect(screen.getByTestId("final-shot-prompts")).toBeTruthy();
    expect(screen.getByTestId("final-prompt-scene-s1")).toBeTruthy();
    expect(screen.queryByTestId("final-prompt-scene-s2")).toBeNull();
    // Polished text is revealed on demand.
    expect(screen.queryByTestId("text-final-prompt-s1")).toBeNull();
    fireEvent.click(screen.getByTestId("button-toggle-final-prompt-s1"));
    expect(screen.getByTestId("text-final-prompt-s1")).toBeTruthy();
  });

  it("renders nothing without a storyboard, without polish, or for other engines", () => {
    mockState.jobs = [makeJob({ storyboard: null })];
    renderScreen();
    expandFirstJob();
    expect(screen.queryByTestId("final-shot-prompts")).toBeNull();
    cleanup();

    const noPolish = makeJob() as any;
    noPolish.storyboard.scenes = noPolish.storyboard.scenes.map(
      (s: Record<string, unknown>) => ({ ...s, renderVisual: "   " }),
    );
    mockState.jobs = [noPolish];
    renderScreen();
    expandFirstJob();
    expect(screen.queryByTestId("final-shot-prompts")).toBeNull();
    cleanup();

    mockState.jobs = [makeJob({ engine: "topic_to_video" })];
    renderScreen();
    expandFirstJob();
    expect(screen.queryByTestId("final-shot-prompts")).toBeNull();
  });

  it("copies the polished prompt and confirms via the notice banner", async () => {
    renderScreen();
    expandFirstJob();
    fireEvent.click(screen.getByTestId("button-toggle-final-prompt-s1"));
    fireEvent.click(screen.getByTestId("button-copy-final-prompt-s1"));
    await waitFor(
      () =>
        expect(setStringAsync).toHaveBeenCalledWith(
          "Cinematic wide shot of a gleaming rocket at dawn, mist rolling",
        ),
      { timeout: 10000 },
    );
    await waitFor(
      () =>
        expect(screen.getByTestId("banner-video-cancel-notice").textContent).toContain(
          "Prompt copied",
        ),
      { timeout: 10000 },
    );
  });

  it("'Use as new brief' prefills the text-to-video brief input", () => {
    renderScreen();
    expandFirstJob();
    fireEvent.click(screen.getByTestId("button-toggle-final-prompt-s1"));
    fireEvent.click(screen.getByTestId("button-use-final-prompt-s1"));
    const input = screen.getByTestId("input-video-brief") as HTMLTextAreaElement | HTMLInputElement;
    expect((input as { value?: string }).value ?? input.getAttribute("value")).toContain(
      "Cinematic wide shot",
    );
    expect(screen.getByTestId("banner-video-cancel-notice").textContent).toContain(
      "Brief prefilled",
    );
  });

  it("generates a text_to_video job from the brief and hides the composer when videoGen is off", () => {
    renderScreen();
    const input = screen.getByTestId("input-video-brief");
    fireEvent.change(input, { target: { value: "A cozy cafe montage" } });
    fireEvent.click(screen.getByTestId("button-generate-video"));
    expect(generateMutate).toHaveBeenCalledWith(
      { data: { engine: "text_to_video", prompt: "A cozy cafe montage" } },
      expect.anything(),
    );
    cleanup();

    mockState.flags = { videoGen: false };
    renderScreen();
    expect(screen.queryByTestId("input-video-brief")).toBeNull();
  });
});
