/**
 * Regression guard: the mobile home screen's "Recent content" list shows the
 * same amber "Some pieces missing" indicator as the library for items with
 * pending LinkedIn/Threads/X chain pieces, and tapping the row opens the
 * content detail screen (where the Resend buttons live).
 */
import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const routerPush = vi.fn();

const mockState: { items: Array<Record<string, unknown>> } = { items: [] };

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("./apiClientMock");
  return createApiClientMock({
    useGetMe: () => ({
      data: {
        tenant: { id: 1, name: "Test Workspace", plan: "free" },
        usage: { captionsUsed: 0, imagesUsed: 0 },
        limits: { captions: 10, images: 10 },
      },
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
      isRefetching: false,
    }),
    useListContent: () => ({
      data: mockState.items,
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
      isRefetching: false,
    }),
  });
});

vi.mock("expo-router", () => ({
  useRouter: () => ({ push: routerPush, back: vi.fn(), replace: vi.fn() }),
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("@expo/vector-icons", () => ({
  Feather: Object.assign(() => null, { glyphMap: {} }),
}));
vi.mock("@clerk/expo", () => ({
  useAuth: () => ({ signOut: vi.fn() }),
}));
vi.mock("@/components/ConsentPrompt", () => ({
  ConsentPrompt: () => null,
}));
vi.mock("@/components/TeamMembership", () => ({
  TeamMembershipCard: () => null,
  TeamWelcomeModal: () => null,
}));

import HomeScreen from "../app/(tabs)/index";

function makeItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    title: "Post",
    caption: "Caption",
    imagePath: null,
    platform: "x",
    status: "published",
    createdAt: new Date("2026-01-01T00:00:00Z").toISOString(),
    linkedinCommentsPending: 0,
    threadsPostsPending: 0,
    twitterPostsPending: 0,
    ...overrides,
  };
}

function renderScreen() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <HomeScreen />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  cleanup();
  routerPush.mockReset();
  mockState.items = [];
});

describe("Mobile home screen pending-pieces indicator", () => {
  it("shows the indicator on recent items with pending chain pieces", () => {
    mockState.items = [
      makeItem({ id: 1, title: "LinkedIn gap", linkedinCommentsPending: 2 }),
      makeItem({ id: 2, title: "Complete" }),
      makeItem({ id: 3, title: "X gap", twitterPostsPending: 1 }),
    ];
    renderScreen();

    expect(screen.getAllByText("Some pieces missing")).toHaveLength(2);
  });

  it("shows no indicator when nothing is pending", () => {
    mockState.items = [makeItem({ id: 1 })];
    renderScreen();
    expect(screen.queryByText("Some pieces missing")).toBeNull();
  });

  it("tapping a flagged recent row opens the content detail screen", () => {
    mockState.items = [
      makeItem({ id: 9, title: "Flagged", threadsPostsPending: 2 }),
    ];
    renderScreen();

    fireEvent.click(screen.getByText("Flagged"));
    expect(routerPush).toHaveBeenCalledWith({
      pathname: "/content/[id]",
      params: { id: "9" },
    });
  });
});
