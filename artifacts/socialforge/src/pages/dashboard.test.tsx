import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardPage } from "./dashboard";

const mockState = vi.hoisted(() => ({
  me: {
    data: {
      tenant: { name: "Test Workspace", plan: "free", aiModel: "default" },
      usage: { captions: 2, images: 1 },
      limits: { captions: 10, images: 10 },
    },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  },
  content: {
    data: [] as any[],
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  },
  schedules: {
    data: [] as any[],
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  },
}));

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  return createApiClientMock({
    useGetMe: () => mockState.me,
    useListContent: () => mockState.content,
    useListSchedules: () => mockState.schedules,
  });
});

vi.mock("@/lib/features", () => ({
  useFeatureFlags: () => ({ flags: { billing: false } }),
}));

vi.mock("@/components/welcome-banner", () => ({
  WelcomeBanner: () => null,
}));

vi.mock("@/components/getting-started-checklist", () => ({
  GettingStartedChecklist: () => null,
}));

describe("DashboardPage", () => {
  beforeEach(() => {
    mockState.me.isLoading = false;
    mockState.me.isError = false;
    mockState.content.isLoading = false;
    mockState.content.isError = false;
    mockState.schedules.isLoading = false;
    mockState.schedules.isError = false;
    mockState.me.refetch.mockClear();
    mockState.content.refetch.mockClear();
    mockState.schedules.refetch.mockClear();
  });

  it("shows the dashboard while secondary lists are still loading", () => {
    mockState.content.isLoading = true;
    mockState.schedules.isLoading = true;

    render(<DashboardPage />);

    expect(screen.getByTestId("dashboard-page")).toBeTruthy();
    expect(screen.getByText("Welcome back, Test Workspace")).toBeTruthy();
    expect(screen.getByTestId("dashboard-content-loading")).toBeTruthy();
    expect(screen.getByTestId("dashboard-schedules-loading")).toBeTruthy();
    expect(screen.queryByTestId("dashboard-loading")).toBeNull();
  });

  it("keeps the dashboard visible and lets failed secondary lists retry", () => {
    mockState.content.isError = true;
    mockState.schedules.isError = true;

    render(<DashboardPage />);

    expect(screen.getByTestId("dashboard-page")).toBeTruthy();
    expect(screen.getByText("Recent content could not be loaded.")).toBeTruthy();
    expect(screen.getByText("Upcoming posts could not be loaded.")).toBeTruthy();
    const retries = screen.getAllByRole("button", { name: "Try again" });
    fireEvent.click(retries[0]!);
    fireEvent.click(retries[1]!);
    expect(mockState.content.refetch).toHaveBeenCalledOnce();
    expect(mockState.schedules.refetch).toHaveBeenCalledOnce();
  });
});