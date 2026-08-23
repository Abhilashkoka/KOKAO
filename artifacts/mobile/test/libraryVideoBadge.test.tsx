/**
 * Regression guard: the Library tab's numeric video-job badge must clear as
 * soon as the final queued/processing job reaches a terminal state.
 */
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

type JobStatus = "queued" | "processing" | "succeeded" | "failed" | "cancelled";

const mockState = vi.hoisted(() => ({
  videoJobs: [] as Array<{ id: number; status: JobStatus }>,
}));

vi.mock("@clerk/expo", () => ({
  useAuth: () => ({ isSignedIn: true }),
}));

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("./apiClientMock");
  return createApiClientMock({
    useListVideoJobs: () => ({
      data: mockState.videoJobs,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    }),
    getListVideoJobsQueryKey: () => ["listVideoJobs"],
  });
});

vi.mock("expo-glass-effect", () => ({
  isLiquidGlassAvailable: () => false,
}));

vi.mock("expo-blur", () => ({
  BlurView: () => null,
}));

vi.mock("expo-symbols", () => ({
  SymbolView: () => null,
}));

vi.mock("@expo/vector-icons", () => ({
  Feather: () => null,
}));

vi.mock("expo-router/unstable-native-tabs", () => ({
  NativeTabs: Object.assign(() => null, { Trigger: () => null }),
  Icon: () => null,
  Label: () => null,
}));

vi.mock("expo-router", () => {
  const Tabs = ({ children }: { children: React.ReactNode }) => <div>{children}</div>;
  Tabs.Screen = ({
    options,
  }: {
    options: { title?: string; tabBarBadge?: number };
  }) =>
    options.title === "Library" && options.tabBarBadge !== undefined ? (
      <span data-testid="library-tab-badge">{options.tabBarBadge}</span>
    ) : null;

  return {
    Tabs,
    Redirect: () => null,
  };
});

vi.mock("@/hooks/useColors", () => ({
  useColors: () => ({
    primary: "#6d3bec",
    mutedForeground: "#71717a",
    background: "#ffffff",
    border: "#e4e4e7",
  }),
}));

vi.mock("@/constants/fonts", () => ({
  fonts: { medium: "System" },
}));

import TabLayout from "../app/(tabs)/_layout";

describe("Library tab video-job badge", () => {
  beforeEach(() => {
    cleanup();
    mockState.videoJobs = [];
  });

  it("clears the badge as soon as the last active job reaches a terminal state", () => {
    mockState.videoJobs = [{ id: 1, status: "processing" }];
    const { rerender } = render(<TabLayout />);

    expect(screen.getByTestId("library-tab-badge").textContent).toBe("1");

    mockState.videoJobs = [{ id: 1, status: "succeeded" }];
    rerender(<TabLayout />);

    expect(screen.queryByTestId("library-tab-badge")).toBeNull();
  });
});