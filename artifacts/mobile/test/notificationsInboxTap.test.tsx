/**
 * Inbox row-tap contract: tapping a notification row navigates via
 * mapLinkUrlToRoute(item.linkUrl) (library post / accounts / ads / settings,
 * or stays put for unknown/admin URLs), flips the row to read optimistically,
 * and marks the server row read.
 */
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const routerPush = vi.fn();
const markReadMutate = vi.fn();
const syncBadgeMock = vi.fn(async () => {});

const mockState: { items: Array<Record<string, unknown>> } = { items: [] };

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("./apiClientMock");
  const { useQuery } = await import("@tanstack/react-query");
  const keyFor = (params?: unknown) => ["notifications", params ?? null];
  return createApiClientMock({
    getListNotificationsQueryKey: (params?: unknown) => keyFor(params),
    // Backed by the real query cache so the screen's optimistic
    // setQueryData write re-renders the row, just like production.
    useListNotifications: (params?: unknown) =>
      useQuery({
        queryKey: keyFor(params),
        queryFn: async () => mockState.items,
        initialData: mockState.items,
        // Keep the seed fresh so a mount refetch never clobbers the
        // screen's optimistic setQueryData write mid-test.
        staleTime: Infinity,
      }),
    useMarkNotificationRead: () => ({ mutate: markReadMutate, isPending: false }),
    useMarkAllNotificationsRead: () => ({ mutate: vi.fn(), isPending: false }),
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
  useAuth: () => ({ isLoaded: true, isSignedIn: true }),
}));
vi.mock("@/lib/pushNotifications", () => ({
  syncBadgeCount: (...a: unknown[]) => syncBadgeMock(...(a as [])),
}));

import NotificationsScreen from "../app/notifications";

let nextId = 1;
function makeNotification(overrides: Record<string, unknown> = {}) {
  return {
    id: nextId++,
    title: `Alert ${nextId}`,
    message: "Something happened",
    linkUrl: null,
    readAt: null,
    createdAt: new Date("2026-07-20T10:00:00Z").toISOString(),
    ...overrides,
  };
}

function renderScreen() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <NotificationsScreen />
    </QueryClientProvider>,
  );
}

function pressRow(title: string) {
  fireEvent.click(screen.getByText(title));
}

describe("notifications inbox row taps", () => {
  beforeEach(() => {
    nextId = 1;
    routerPush.mockClear();
    markReadMutate.mockClear();
    syncBadgeMock.mockClear();
    mockState.items = [];
  });

  afterEach(() => {
    cleanup();
  });

  it("opens the exact post's screen for a library linkUrl with an item id", () => {
    mockState.items = [
      makeNotification({ title: "Post published", linkUrl: "/library?item=42" }),
    ];
    renderScreen();
    pressRow("Post published");
    expect(routerPush).toHaveBeenCalledWith({
      pathname: "/content/[id]",
      params: { id: "42" },
    });
  });

  it("opens the library tab for a plain /library linkUrl", () => {
    mockState.items = [
      makeNotification({ title: "Library alert", linkUrl: "/library" }),
    ];
    renderScreen();
    pressRow("Library alert");
    expect(routerPush).toHaveBeenCalledWith("/(tabs)/library");
  });

  it("opens accounts, ads, and settings for their linkUrls", () => {
    mockState.items = [
      makeNotification({ title: "Connection lost", linkUrl: "/accounts" }),
      makeNotification({ title: "Ad change applied", linkUrl: "/ads?platform=meta" }),
      makeNotification({ title: "Plan changed", linkUrl: "/settings?tab=billing" }),
    ];
    renderScreen();
    pressRow("Connection lost");
    expect(routerPush).toHaveBeenLastCalledWith("/(tabs)/accounts");
    pressRow("Ad change applied");
    expect(routerPush).toHaveBeenLastCalledWith("/ads");
    pressRow("Plan changed");
    expect(routerPush).toHaveBeenLastCalledWith("/settings");
  });

  it("does not navigate for admin/unknown or missing linkUrls but still marks read", () => {
    mockState.items = [
      makeNotification({ title: "Admin alert", linkUrl: "/admin" }),
      makeNotification({ title: "No link alert", linkUrl: null }),
    ];
    renderScreen();
    pressRow("Admin alert");
    pressRow("No link alert");
    expect(routerPush).not.toHaveBeenCalled();
    expect(markReadMutate).toHaveBeenCalledTimes(2);
  });

  it("flips the tapped unread row to read optimistically and marks the server row read", async () => {
    const item = makeNotification({ title: "Unread alert", linkUrl: "/accounts" });
    mockState.items = [item];
    renderScreen();

    expect(screen.getByLabelText("Unread notification, tap to mark read")).toBeTruthy();
    expect(screen.getByText("1 unread")).toBeTruthy();

    pressRow("Unread alert");

    // Optimistic cache write re-renders the row as read immediately.
    await waitFor(() => {
      expect(screen.queryByLabelText("Unread notification, tap to mark read")).toBeNull();
      expect(screen.getByLabelText("Notification")).toBeTruthy();
    });
    expect(screen.getByText("All caught up")).toBeTruthy();

    // Server row marked read with the tapped id.
    expect(markReadMutate).toHaveBeenCalledTimes(1);
    expect(markReadMutate.mock.calls[0][0]).toEqual({ id: item.id });
  });

  it("does not re-mark an already-read row but still navigates", () => {
    mockState.items = [
      makeNotification({
        title: "Old alert",
        linkUrl: "/ads",
        readAt: new Date("2026-07-19T00:00:00Z").toISOString(),
      }),
    ];
    renderScreen();
    pressRow("Old alert");
    expect(markReadMutate).not.toHaveBeenCalled();
    expect(routerPush).toHaveBeenCalledWith("/ads");
  });
});
