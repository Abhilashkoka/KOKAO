/**
 * Regression guard for the mobile Videos screen (app/videos.tsx):
 * - list rendering + status badges for each job state
 * - the polling gate only polls while a job is queued/processing
 * - the "AI amount spent" line (testID "text-video-ai-spent") shows
 *   rate × units only on an expanded succeeded job when the aiSpend flag is
 *   on and the rate is > 0 — never for failed/running jobs or when the flag
 *   or rate is off/zero.
 */
import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockState: {
  jobs: Array<Record<string, unknown>>;
  flags: Record<string, boolean> | undefined;
  rates: { videoPaise: number } | undefined;
} = { jobs: [], flags: undefined, rates: undefined };

// Captured per render so we can assert the polling gate and the
// flag-gated rates fetch without any network.
let capturedJobsOptions: any = null;
let capturedRatesOptions: any = null;

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("./apiClientMock");
  return createApiClientMock({
    useListVideoJobs: (opts?: any) => {
      capturedJobsOptions = opts;
      return {
        data: mockState.jobs,
        isLoading: false,
        isError: false,
        isRefetching: false,
        refetch: vi.fn(),
      };
    },
    useListFeatureFlags: () => ({ data: mockState.flags, isLoading: false }),
    useGetAiSpendRates: (opts?: any) => {
      capturedRatesOptions = opts;
      return { data: mockState.rates, isLoading: false };
    },
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
    status: "succeeded",
    stage: null,
    error: null,
    units: 1,
    videoPath: "/videos/1.mp4",
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

function expandJob(id: number) {
  fireEvent.click(screen.getByTestId(`card-video-job-${id}`));
}

beforeEach(() => {
  cleanup();
  mockState.jobs = [];
  mockState.flags = undefined;
  mockState.rates = undefined;
  capturedJobsOptions = null;
  capturedRatesOptions = null;
});

describe("Videos screen — list rendering and status badges", () => {
  it("shows one card per job with the right status badges", () => {
    mockState.jobs = [
      makeJob({ id: 1, status: "succeeded" }),
      makeJob({ id: 2, status: "failed", error: "Render blew up", videoPath: null }),
      makeJob({ id: 3, status: "processing", stage: "Composing the video", videoPath: null }),
      makeJob({ id: 4, status: "queued", stage: null, videoPath: null }),
    ];
    renderScreen();
    expect(screen.getByTestId("card-video-job-1")).toBeTruthy();
    expect(screen.getByText("Ready")).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByText("Generating")).toBeTruthy();
    expect(screen.getByText("Queued")).toBeTruthy();
    // Failed jobs surface their error; running jobs surface their stage.
    expect(screen.getByText("Render blew up")).toBeTruthy();
    expect(screen.getByText("Composing the video")).toBeTruthy();
    expect(screen.getByText("Waiting to start…")).toBeTruthy();
  });

  it("shows the empty state when there are no jobs", () => {
    renderScreen();
    expect(screen.getByText("No videos yet")).toBeTruthy();
  });
});

describe("Videos screen — polling gate", () => {
  function pollFor(jobs: Array<Record<string, unknown>>) {
    renderScreen();
    const refetchInterval = capturedJobsOptions?.query?.refetchInterval;
    expect(typeof refetchInterval).toBe("function");
    return refetchInterval({ state: { data: jobs } });
  }

  it("polls every 5s while a job is queued or processing", () => {
    mockState.jobs = [makeJob({ id: 1, status: "processing", videoPath: null })];
    expect(pollFor(mockState.jobs)).toBe(5000);
  });

  it("does not poll when every job is terminal", () => {
    mockState.jobs = [makeJob({ id: 1, status: "succeeded" }), makeJob({ id: 2, status: "failed", videoPath: null })];
    expect(pollFor(mockState.jobs)).toBe(false);
  });
});

describe("Videos screen — AI amount spent line", () => {
  it("shows rate × units on an expanded succeeded job when the flag is on", () => {
    mockState.flags = { aiSpend: true };
    mockState.rates = { videoPaise: 2500 };
    mockState.jobs = [makeJob({ id: 1, units: 3 })];
    renderScreen();
    expect(screen.queryByTestId("text-video-ai-spent")).toBeNull(); // collapsed
    expandJob(1);
    const line = screen.getByTestId("text-video-ai-spent");
    // 2500 paise × 3 units = ₹75.00
    expect(line.textContent).toContain("AI amount spent: ₹75.00");
  });

  it("shows the plain rate for a single-unit job", () => {
    mockState.flags = { aiSpend: true };
    mockState.rates = { videoPaise: 2500 };
    mockState.jobs = [makeJob({ id: 1, units: 1 })];
    renderScreen();
    expandJob(1);
    expect(screen.getByTestId("text-video-ai-spent").textContent).toContain("₹25.00");
  });

  it("prefers the job's charge-time rate snapshot over the current rate", () => {
    // Admin has since raised the rate to 9900; the job froze 2500 at charge
    // time, so history keeps showing what was really charged.
    mockState.flags = { aiSpend: true };
    mockState.rates = { videoPaise: 9900 };
    mockState.jobs = [makeJob({ id: 1, units: 4, chargedRatePaise: 2500 })];
    renderScreen();
    expandJob(1);
    expect(screen.getByTestId("text-video-ai-spent").textContent).toContain("₹100.00");
  });

  it("prefers the job's snapshotted total spend over any rate x units estimate", () => {
    // Cost_plus mode: the persisted spendPaise (real cost + margin) rarely
    // equals rate x units — it must win outright over both the charge-time
    // rate snapshot and the current rate.
    mockState.flags = { aiSpend: true };
    mockState.rates = { videoPaise: 9900 };
    mockState.jobs = [makeJob({ id: 1, units: 4, chargedRatePaise: 2500, spendPaise: 1234 })];
    renderScreen();
    expandJob(1);
    const line = screen.getByTestId("text-video-ai-spent");
    expect(line.textContent).toContain("₹12.34");
    expect(line.textContent).not.toContain("₹100.00");
  });

  it("hides the line when the snapshot says the job charged nothing", () => {
    mockState.flags = { aiSpend: true };
    mockState.rates = { videoPaise: 9900 };
    mockState.jobs = [makeJob({ id: 1, units: 4, chargedRatePaise: 2500, spendPaise: 0 })];
    renderScreen();
    expandJob(1);
    expect(screen.queryByTestId("text-video-ai-spent")).toBeNull();
  });

  it("shows a snapshotted job's spend even when the current rate is zero", () => {
    mockState.flags = { aiSpend: true };
    mockState.rates = { videoPaise: 0 };
    mockState.jobs = [makeJob({ id: 1, units: 1, chargedRatePaise: 2500 })];
    renderScreen();
    expandJob(1);
    expect(screen.getByTestId("text-video-ai-spent").textContent).toContain("₹25.00");
  });

  it("hides a snapshotted job's spend when the aiSpend flag is off", () => {
    mockState.flags = { aiSpend: false };
    mockState.rates = { videoPaise: 9900 };
    mockState.jobs = [makeJob({ id: 1, units: 1, chargedRatePaise: 2500 })];
    renderScreen();
    expandJob(1);
    expect(screen.queryByTestId("text-video-ai-spent")).toBeNull();
  });

  it("never shows the line when the aiSpend flag is off, and disables the rates fetch", () => {
    mockState.flags = { aiSpend: false };
    mockState.rates = { videoPaise: 2500 }; // even if data were cached
    mockState.jobs = [makeJob({ id: 1, units: 3 })];
    renderScreen();
    expandJob(1);
    expect(screen.queryByTestId("text-video-ai-spent")).toBeNull();
    expect(capturedRatesOptions?.query?.enabled).toBe(false);
  });

  it("shows nothing when the rate is zero or absent", () => {
    mockState.flags = { aiSpend: true };
    mockState.rates = { videoPaise: 0 };
    mockState.jobs = [makeJob({ id: 1 })];
    renderScreen();
    expandJob(1);
    expect(screen.queryByTestId("text-video-ai-spent")).toBeNull();

    cleanup();
    mockState.rates = undefined;
    renderScreen();
    expandJob(1);
    expect(screen.queryByTestId("text-video-ai-spent")).toBeNull();
  });

  it("never shows the line for failed or running jobs even with flag on and rate set", () => {
    mockState.flags = { aiSpend: true };
    mockState.rates = { videoPaise: 2500 };
    mockState.jobs = [
      makeJob({ id: 1, status: "failed", error: "boom", videoPath: null }),
      makeJob({ id: 2, status: "processing", stage: "Composing the video", videoPath: null }),
      makeJob({ id: 3, status: "queued", videoPath: null }),
    ];
    renderScreen();
    // Tapping non-playable cards must not expand them.
    expandJob(1);
    expandJob(2);
    expandJob(3);
    expect(screen.queryByTestId("text-video-ai-spent")).toBeNull();
  });
});
