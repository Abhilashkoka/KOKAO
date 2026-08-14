/**
 * Regression guard for cancelling a queued video from the mobile Videos
 * screen (app/videos.tsx):
 * - the Cancel button appears ONLY on queued cards (never processing,
 *   succeeded, failed, cancelled, or awaiting_review)
 * - pressing Cancel calls cancelVideoJob(jobId), refetches the list, and
 *   shows the refund success notice
 * - a 409 from the server shows the "Too late to cancel" notice (the job
 *   already started, so it will finish and charge normally)
 * - any other error shows the generic failure notice
 * - every path refetches so the card reflects the job's real state
 */
import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockState: { jobs: Array<Record<string, unknown>> } = { jobs: [] };
const cancelVideoJobMock = vi.fn();
const refetchMock = vi.fn();

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("./apiClientMock");
  return createApiClientMock({
    cancelVideoJob: (...args: unknown[]) => cancelVideoJobMock(...args),
    useListVideoJobs: () => ({
      data: mockState.jobs,
      isLoading: false,
      isError: false,
      isRefetching: false,
      refetch: refetchMock,
    }),
    useListFeatureFlags: () => ({ data: undefined, isLoading: false }),
    useGetAiSpendRates: () => ({ data: undefined, isLoading: false }),
  });
});

vi.mock("expo-clipboard", () => ({
  setStringAsync: vi.fn().mockResolvedValue(true),
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
    status: "queued",
    stage: null,
    error: null,
    units: 1,
    videoPath: null,
    thumbnailPath: null,
    aspectRatio: "9:16",
    createdAt: new Date("2026-08-01T00:00:00Z").toISOString(),
    ...overrides,
  };
}

function renderScreen() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <VideosScreen />
    </QueryClientProvider>,
  );
}

function makeApiError(status: number) {
  const err = new Error(`Request failed with status ${status}`) as Error & {
    status: number;
  };
  err.status = status;
  return err;
}

beforeEach(() => {
  cleanup();
  mockState.jobs = [];
  cancelVideoJobMock.mockReset();
  refetchMock.mockReset();
});

describe("Videos screen — Cancel button visibility", () => {
  it("shows Cancel only on queued cards", () => {
    mockState.jobs = [
      makeJob({ id: 1, status: "queued" }),
      makeJob({ id: 2, status: "processing", stage: "Composing the video" }),
      makeJob({ id: 3, status: "succeeded", videoPath: "/videos/3.mp4" }),
      makeJob({ id: 4, status: "failed", error: "boom" }),
      makeJob({ id: 5, status: "cancelled" }),
      makeJob({ id: 6, status: "awaiting_review" }),
    ];
    renderScreen();
    expect(screen.getByTestId("button-cancel-video-job-1")).toBeTruthy();
    for (const id of [2, 3, 4, 5, 6]) {
      expect(screen.queryByTestId(`button-cancel-video-job-${id}`)).toBeNull();
    }
  });
});

describe("Videos screen — cancelling a queued job", () => {
  it("calls cancelVideoJob, refetches, and shows the refund notice on success", async () => {
    cancelVideoJobMock.mockResolvedValue(undefined);
    mockState.jobs = [makeJob({ id: 7 })];
    renderScreen();

    fireEvent.click(screen.getByTestId("button-cancel-video-job-7"));

    await waitFor(() => {
      expect(screen.getByTestId("banner-video-cancel-notice")).toBeTruthy();
    });
    expect(cancelVideoJobMock).toHaveBeenCalledTimes(1);
    expect(cancelVideoJobMock).toHaveBeenCalledWith(7);
    expect(refetchMock).toHaveBeenCalled();
    expect(
      screen.getByTestId("banner-video-cancel-notice").textContent,
    ).toContain("Video cancelled — nothing was charged");
  });

  it("shows the 'Too late to cancel' notice on 409 and still refetches", async () => {
    cancelVideoJobMock.mockRejectedValue(makeApiError(409));
    mockState.jobs = [makeJob({ id: 8 })];
    renderScreen();

    fireEvent.click(screen.getByTestId("button-cancel-video-job-8"));

    await waitFor(() => {
      expect(screen.getByTestId("banner-video-cancel-notice")).toBeTruthy();
    });
    expect(
      screen.getByTestId("banner-video-cancel-notice").textContent,
    ).toContain("Too late to cancel — generation already started");
    expect(refetchMock).toHaveBeenCalled();
  });

  it("shows the generic failure notice for other errors", async () => {
    cancelVideoJobMock.mockRejectedValue(makeApiError(500));
    mockState.jobs = [makeJob({ id: 9 })];
    renderScreen();

    fireEvent.click(screen.getByTestId("button-cancel-video-job-9"));

    await waitFor(() => {
      expect(screen.getByTestId("banner-video-cancel-notice")).toBeTruthy();
    });
    expect(
      screen.getByTestId("banner-video-cancel-notice").textContent,
    ).toContain("Couldn't cancel the video. It will finish normally.");
    expect(refetchMock).toHaveBeenCalled();
  });

  it("ignores a second press while a cancel is in flight", async () => {
    let resolveCancel: () => void = () => {};
    cancelVideoJobMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveCancel = resolve;
        }),
    );
    mockState.jobs = [makeJob({ id: 10 })];
    renderScreen();

    const button = screen.getByTestId("button-cancel-video-job-10");
    fireEvent.click(button);
    fireEvent.click(button);
    expect(cancelVideoJobMock).toHaveBeenCalledTimes(1);

    resolveCancel();
    await waitFor(() => {
      expect(screen.getByTestId("banner-video-cancel-notice")).toBeTruthy();
    });
  });
});
