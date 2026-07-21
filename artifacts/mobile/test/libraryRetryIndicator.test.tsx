/**
 * Regression guard: the mobile library list flags content items whose
 * scheduled post is pending with retryCount > 0 (auto-retrying after a
 * transient platform outage) with a blue "Retrying after a temporary outage"
 * pill, mirroring the web Schedule page indicator.
 */
import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockState: {
  items: Array<Record<string, unknown>>;
  schedules: Array<Record<string, unknown>>;
} = { items: [], schedules: [] };

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("./apiClientMock");
  return createApiClientMock({
    useListContent: () => ({
      data: mockState.items,
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
      isRefetching: false,
    }),
    useListSchedules: () => ({ data: mockState.schedules }),
  });
});

vi.mock("expo-router", () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("@expo/vector-icons", () => ({
  Feather: Object.assign(() => null, { glyphMap: {} }),
}));
vi.mock("@/components/ContentImage", () => ({
  ContentImage: () => null,
}));

import LibraryScreen from "../app/(tabs)/library";

function makeItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    title: "Post",
    caption: "Caption",
    imagePath: null,
    platform: "x",
    status: "scheduled",
    createdAt: new Date("2026-01-01T00:00:00Z").toISOString(),
    ...overrides,
  };
}

function makeSchedule(overrides: Record<string, unknown> = {}) {
  return {
    id: 10,
    contentItemId: 1,
    platform: "x",
    status: "pending",
    scheduledAt: new Date("2026-08-01T10:00:00Z").toISOString(),
    retryCount: 0,
    failureReason: null,
    ...overrides,
  };
}

function renderScreen() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <LibraryScreen />
    </QueryClientProvider>,
  );
}

const INDICATOR = "Retrying after a temporary outage";

beforeEach(() => {
  cleanup();
  mockState.items = [];
  mockState.schedules = [];
});

describe("Mobile library auto-retry indicator", () => {
  it("shows the pill for items whose pending schedule has retryCount > 0", () => {
    mockState.items = [
      makeItem({ id: 1, title: "Retrying" }),
      makeItem({ id: 2, title: "Plain pending" }),
    ];
    mockState.schedules = [
      makeSchedule({ id: 10, contentItemId: 1, retryCount: 2 }),
      makeSchedule({ id: 11, contentItemId: 2, retryCount: 0 }),
    ];
    renderScreen();

    expect(screen.getAllByText(INDICATOR)).toHaveLength(1);
  });

  it("shows no pill when the schedule is no longer pending", () => {
    mockState.items = [makeItem({ id: 1, status: "published" })];
    mockState.schedules = [
      makeSchedule({ contentItemId: 1, status: "published", retryCount: 2 }),
      makeSchedule({
        id: 12,
        contentItemId: 1,
        status: "failed",
        retryCount: 3,
      }),
      makeSchedule({
        id: 13,
        contentItemId: 1,
        status: "cancelled",
        retryCount: 1,
      }),
    ];
    renderScreen();
    expect(screen.queryByText(INDICATOR)).toBeNull();
  });

  it("shows no pill when there are no schedules", () => {
    mockState.items = [makeItem({ id: 1 })];
    renderScreen();
    expect(screen.queryByText(INDICATOR)).toBeNull();
  });
});
