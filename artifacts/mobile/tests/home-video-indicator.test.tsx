/**
 * Guard: Home tab video-generating banner.
 *
 * The banner (testID="banner-video-generating") must appear while any video
 * job is in a queued or processing state and disappear as soon as all jobs
 * reach a terminal state (succeeded / failed / cancelled).
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// ── Mocks for native / third-party modules ────────────────────────────────────

vi.mock("@expo/vector-icons", () => ({ Feather: () => null }));

vi.mock("@clerk/expo", () => ({
  useAuth: () => ({ signOut: vi.fn() }),
}));

vi.mock("expo-router", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ clear: vi.fn(), invalidateQueries: vi.fn() }),
}));

vi.mock("@/constants/colors", () => ({
  default: {
    light: {
      primary: "#6d3bec",
      primaryForeground: "#ffffff",
      background: "#fff",
      foreground: "#000",
      card: "#fafafa",
      cardForeground: "#000",
      muted: "#f4f4f5",
      mutedForeground: "#71717a",
      secondary: "#f4f4f5",
      secondaryForeground: "#18181b",
      accent: "#f1ebfe",
      accentForeground: "#4c1fb8",
      border: "#e4e4e7",
      destructive: "#ef4444",
      destructiveForeground: "#fff",
      text: "#0a0a0a",
      tint: "#6d3bec",
    },
    radius: 12,
  },
}));

vi.mock("@/constants/fonts", () => ({
  fonts: { regular: "System", medium: "System", semiBold: "System", bold: "System" },
}));

vi.mock("@/components/ui", () => ({
  Badge: ({ label }: { label: string }) => <span>{label}</span>,
  Card: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ErrorState: ({ message }: { message?: string }) => <div>{message}</div>,
  Skeleton: () => null,
}));

vi.mock("@/components/ConsentPrompt", () => ({ ConsentPrompt: () => null }));
vi.mock("@/components/OnboardingWizard", () => ({ OnboardingWizard: () => null }));
vi.mock("@/components/GettingStartedChecklist", () => ({
  GettingStartedChecklist: () => null,
}));
vi.mock("@/components/WelcomeCreditsBanner", () => ({
  WelcomeCreditsBanner: () => null,
}));
vi.mock("@/components/TeamMembership", () => ({
  TeamMembershipCard: () => null,
  TeamWelcomeModal: () => null,
}));

vi.mock("@/lib/contentPending", () => ({
  hasPendingPieces: () => false,
  PENDING_TEXT: "#f59e0b",
}));

// ── Shared mock state ──────────────────────────────────────────────────────────

type JobStatus = "queued" | "processing" | "succeeded" | "failed" | "cancelled";

interface MockJob {
  id: number;
  status: JobStatus;
}

const mockState: { videoJobs: MockJob[] } = { videoJobs: [] };

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  return createApiClientMock({
    useGetMe: () => ({
      data: {
        tenant: { name: "Test Workspace", plan: "free" },
        usage: { captions: 0, images: 0 },
        limits: { captions: 10, images: 10 },
        brandOnboardingComplete: true,
      },
      isLoading: false,
      isError: false,
      isRefetching: false,
      refetch: vi.fn(),
    }),
    useListContent: () => ({
      data: [],
      isLoading: false,
      isRefetching: false,
      refetch: vi.fn(),
    }),
    useListNotifications: () => ({
      data: [],
      isLoading: false,
      isRefetching: false,
      refetch: vi.fn(),
    }),
    useListVideoJobs: () => ({
      data: mockState.videoJobs,
      isLoading: false,
      refetch: vi.fn(),
    }),
    getListNotificationsQueryKey: () => ["listNotifications"],
    getListVideoJobsQueryKey: () => ["listVideoJobs"],
    getGetFirstPostProgressQueryKey: () => ["getFirstPostProgress"],
  });
});

// ── Import component under test (after all vi.mock calls) ─────────────────────

import HomeScreen from "../app/(tabs)/index";

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("Home tab video-generating banner", () => {
  beforeEach(() => {
    mockState.videoJobs = [];
  });

  it("shows the banner when there is one queued job", () => {
    mockState.videoJobs = [{ id: 1, status: "queued" }];
    render(<HomeScreen />);
    expect(screen.getByTestId("banner-video-generating")).toBeTruthy();
  });

  it("shows the banner when there is one processing job", () => {
    mockState.videoJobs = [{ id: 1, status: "processing" }];
    render(<HomeScreen />);
    expect(screen.getByTestId("banner-video-generating")).toBeTruthy();
  });

  it("shows the banner when there are multiple active jobs", () => {
    mockState.videoJobs = [
      { id: 1, status: "queued" },
      { id: 2, status: "processing" },
    ];
    render(<HomeScreen />);
    expect(screen.getByTestId("banner-video-generating")).toBeTruthy();
  });

  it("hides the banner when there are no jobs at all", () => {
    mockState.videoJobs = [];
    render(<HomeScreen />);
    expect(screen.queryByTestId("banner-video-generating")).toBeNull();
  });

  it("hides the banner when the only job has succeeded", () => {
    mockState.videoJobs = [{ id: 1, status: "succeeded" }];
    render(<HomeScreen />);
    expect(screen.queryByTestId("banner-video-generating")).toBeNull();
  });

  it("hides the banner when the only job has failed", () => {
    mockState.videoJobs = [{ id: 1, status: "failed" }];
    render(<HomeScreen />);
    expect(screen.queryByTestId("banner-video-generating")).toBeNull();
  });

  it("hides the banner when the only job was cancelled", () => {
    mockState.videoJobs = [{ id: 1, status: "cancelled" }];
    render(<HomeScreen />);
    expect(screen.queryByTestId("banner-video-generating")).toBeNull();
  });

  it("hides the banner when all jobs are in terminal states", () => {
    mockState.videoJobs = [
      { id: 1, status: "succeeded" },
      { id: 2, status: "failed" },
      { id: 3, status: "cancelled" },
    ];
    render(<HomeScreen />);
    expect(screen.queryByTestId("banner-video-generating")).toBeNull();
  });

  it("shows the banner when at least one job is active among terminal jobs", () => {
    mockState.videoJobs = [
      { id: 1, status: "succeeded" },
      { id: 2, status: "processing" },
    ];
    render(<HomeScreen />);
    expect(screen.getByTestId("banner-video-generating")).toBeTruthy();
  });

  it("clears the banner as soon as the last active job transitions to succeeded", () => {
    // Start with one active job — banner visible.
    mockState.videoJobs = [{ id: 1, status: "processing" }];
    const { rerender } = render(<HomeScreen />);
    expect(screen.getByTestId("banner-video-generating")).toBeTruthy();

    // Job reaches terminal state — banner must vanish.
    mockState.videoJobs = [{ id: 1, status: "succeeded" }];
    rerender(<HomeScreen />);
    expect(screen.queryByTestId("banner-video-generating")).toBeNull();
  });

  it("clears the banner as soon as the last active job transitions to failed", () => {
    mockState.videoJobs = [{ id: 1, status: "queued" }];
    const { rerender } = render(<HomeScreen />);
    expect(screen.getByTestId("banner-video-generating")).toBeTruthy();

    mockState.videoJobs = [{ id: 1, status: "failed" }];
    rerender(<HomeScreen />);
    expect(screen.queryByTestId("banner-video-generating")).toBeNull();
  });

  it("keeps the banner visible when one of two active jobs finishes but one remains", () => {
    mockState.videoJobs = [
      { id: 1, status: "queued" },
      { id: 2, status: "processing" },
    ];
    const { rerender } = render(<HomeScreen />);
    expect(screen.getByTestId("banner-video-generating")).toBeTruthy();

    // Only the first job finishes — second is still processing.
    mockState.videoJobs = [
      { id: 1, status: "succeeded" },
      { id: 2, status: "processing" },
    ];
    rerender(<HomeScreen />);
    expect(screen.getByTestId("banner-video-generating")).toBeTruthy();
  });
});
