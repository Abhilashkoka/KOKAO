/**
 * Regression guard: the mobile content library list flags published items
 * that still have missing chain pieces (LinkedIn follow-up comments, Threads
 * or X thread posts) with an amber "Some pieces missing" indicator, so users
 * discover the in-app Resend fix without opening every item.
 *
 * Mirrors the web library cards' pending-posts warnings
 * (artifacts/socialforge/src/components/pending-posts-warning.tsx).
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
      <LibraryScreen />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  cleanup();
  routerPush.mockReset();
  mockState.items = [];
});

describe("Mobile library pending-pieces indicator", () => {
  it("shows the indicator on rows with any pending chain pieces", () => {
    mockState.items = [
      makeItem({ id: 1, title: "LinkedIn gap", linkedinCommentsPending: 2 }),
      makeItem({ id: 2, title: "Threads gap", threadsPostsPending: 1 }),
      makeItem({ id: 3, title: "X gap", twitterPostsPending: 3 }),
      makeItem({ id: 4, title: "Complete" }),
    ];
    renderScreen();

    expect(screen.getAllByText("Some pieces missing")).toHaveLength(3);
  });

  it("shows no indicator when nothing is pending", () => {
    mockState.items = [makeItem({ id: 1 })];
    renderScreen();
    expect(screen.queryByText("Some pieces missing")).toBeNull();
  });

  it("shows no indicator when pending fields are absent", () => {
    mockState.items = [
      makeItem({
        id: 1,
        linkedinCommentsPending: undefined,
        threadsPostsPending: undefined,
        twitterPostsPending: undefined,
      }),
    ];
    renderScreen();
    expect(screen.queryByText("Some pieces missing")).toBeNull();
  });

  it("tapping a flagged row opens the content detail screen", () => {
    mockState.items = [
      makeItem({ id: 7, title: "Flagged", twitterPostsPending: 1 }),
    ];
    renderScreen();

    fireEvent.click(screen.getByText("Flagged"));
    expect(routerPush).toHaveBeenCalledWith({
      pathname: "/content/[id]",
      params: { id: "7" },
    });
  });
});
