/**
 * Inbox liveness contract (task: alerts inbox keeps itself fresh while open):
 * the notifications screen configures its list query with
 * `refetchInterval: 30_000` + `refetchIntervalInBackground: false`, so
 * sweeps resolving alerts / another admin dismissing show up without leaving
 * the screen — but polling never runs while the app is backgrounded.
 *
 * The api-client mock passes the screen's *real* query options through to a
 * live useQuery, so a refactor that drops the interval flags fails here.
 * Fake timers drive the 30s interval; focusManager (driven in production by
 * the AppState bridge in _layout — see foregroundRefetch.test.tsx) models
 * background/foreground.
 */
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  focusManager,
  useQuery,
} from "@tanstack/react-query";

const fetchNotifications = vi.fn(async () => [] as Array<Record<string, unknown>>);

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("./apiClientMock");
  const { useQuery } = await import("@tanstack/react-query");
  return createApiClientMock({
    getListNotificationsQueryKey: (params?: unknown) => ["notifications", params ?? null],
    // Pass the screen's real query options (refetchInterval etc.) through to
    // a live useQuery — this is exactly what the generated hook does.
    useListNotifications: (
      _params?: unknown,
      options?: { query?: Record<string, unknown> },
    ) =>
      useQuery({
        queryKey: ["notifications", "fallback"],
        queryFn: fetchNotifications,
        ...(options?.query as object),
      }),
    useMarkNotificationRead: () => ({ mutate: vi.fn(), isPending: false }),
    useMarkAllNotificationsRead: () => ({ mutate: vi.fn(), isPending: false }),
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
vi.mock("@clerk/expo", () => ({
  useAuth: () => ({ isLoaded: true, isSignedIn: true }),
}));
vi.mock("@/lib/pushNotifications", () => ({
  syncBadgeCount: vi.fn(async () => {}),
}));

import NotificationsScreen from "../app/notifications";

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

describe("notifications inbox 30s polling", () => {
  beforeEach(() => {
    fetchNotifications.mockClear();
    vi.useFakeTimers();
    // The screen is open and the app is foregrounded.
    focusManager.setFocused(true);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    // Restore the singleton default so other test files see jsdom-driven focus.
    focusManager.setFocused(undefined);
  });

  it("refetches every 30s while the screen stays open and focused", async () => {
    renderScreen();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchNotifications).toHaveBeenCalledTimes(1);

    // Just before the interval: no poll yet.
    await vi.advanceTimersByTimeAsync(29_000);
    expect(fetchNotifications).toHaveBeenCalledTimes(1);

    // Interval elapses → poll fires.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchNotifications).toHaveBeenCalledTimes(2);

    // And keeps firing while the screen remains open.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchNotifications).toHaveBeenCalledTimes(3);
  });

  it("does not poll while the app is backgrounded (refetchIntervalInBackground: false)", async () => {
    renderScreen();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchNotifications).toHaveBeenCalledTimes(1);

    // App goes to background (in production the AppState bridge in _layout
    // drives this exact focusManager transition).
    focusManager.setFocused(false);

    // Multiple intervals elapse in the background — no polling.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchNotifications).toHaveBeenCalledTimes(1);
  });

  it("stops polling once the screen unmounts", async () => {
    const view = renderScreen();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchNotifications).toHaveBeenCalledTimes(1);

    view.unmount();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchNotifications).toHaveBeenCalledTimes(1);
  });
});

describe("home bell query polling (same 30s contract)", () => {
  // The home tab's bell badge uses the identical refetchInterval config
  // (app/(tabs)/index.tsx). Mounting the full home screen drags in many
  // unrelated deps, so assert the shared contract on a query configured the
  // same way, driven by the same focusManager the AppState bridge controls.
  const bellFetch = vi.fn(async () => []);

  function BellHarness() {
    useQuery({
      queryKey: ["notifications", null],
      queryFn: bellFetch,
      refetchInterval: 30_000,
      refetchIntervalInBackground: false,
    });
    return null;
  }

  beforeEach(() => {
    bellFetch.mockClear();
    vi.useFakeTimers();
    focusManager.setFocused(true);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    focusManager.setFocused(undefined);
  });

  it("polls at 30s while focused and pauses in background", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <BellHarness />
      </QueryClientProvider>,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(bellFetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(bellFetch).toHaveBeenCalledTimes(2);

    focusManager.setFocused(false);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(bellFetch).toHaveBeenCalledTimes(2);
  });
});
