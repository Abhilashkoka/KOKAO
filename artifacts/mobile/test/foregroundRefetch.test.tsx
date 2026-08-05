/**
 * Foreground-refresh contract (task: mobile alerts must refresh when the app
 * returns to the foreground): _layout.tsx registers a module-scope AppState →
 * React Query focusManager bridge on native. These tests import the real
 * _layout module (with its heavy Expo/Clerk deps mocked), capture the
 * AppState listener it registers, and assert that a background → active
 * transition (a) drives the real focusManager and (b) refetches a mounted
 * notification-style query — so a future _layout refactor that drops the
 * bridge fails CI instead of silently killing live foreground refreshes.
 *
 * AppState mocking mirrors lib/pushNotifications.badgeSync.test.tsx.
 * The web-platform negative case lives in foregroundRefetch.web.test.tsx
 * (the bridge runs once at module scope, so it needs its own module graph).
 */
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  focusManager,
  useQuery,
} from "@tanstack/react-query";

// ---- AppState capture (same pattern as pushNotifications.badgeSync.test) ----
const { appStateListeners, addEventListenerMock } = vi.hoisted(() => {
  const listeners: Array<(state: string) => void> = [];
  return {
    appStateListeners: listeners,
    addEventListenerMock: vi.fn((_event: string, cb: (state: string) => void) => {
      listeners.push(cb);
      return { remove: vi.fn() };
    }),
  };
});
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  AppState: {
    addEventListener: (
      ...args: [string, (state: string) => void]
    ) => addEventListenerMock(...args),
  },
}));

// ---- Mocks for _layout's module-scope imports (not under test) ----
vi.mock("@expo-google-fonts/plus-jakarta-sans", () => ({
  useFonts: () => [true, null],
  PlusJakartaSans_400Regular: {},
  PlusJakartaSans_500Medium: {},
  PlusJakartaSans_600SemiBold: {},
  PlusJakartaSans_700Bold: {},
}));
vi.mock("@clerk/expo", () => ({
  ClerkProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ClerkLoaded: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useAuth: () => ({ getToken: async () => null }),
}));
vi.mock("@clerk/expo/token-cache", () => ({ tokenCache: {} }));
vi.mock("expo-router", () => ({ Stack: Object.assign(() => null, { Screen: () => null }) }));
vi.mock("expo-splash-screen", () => ({
  preventAutoHideAsync: vi.fn(),
  hideAsync: vi.fn(),
}));
vi.mock("react-native-gesture-handler", () => ({
  GestureHandlerRootView: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("react-native-keyboard-controller", () => ({
  KeyboardProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("./apiClientMock");
  return createApiClientMock({
    setBaseUrl: vi.fn(),
    setAuthTokenGetter: vi.fn(),
    ApiError: class ApiError extends Error {},
  });
});
vi.mock("@/components/AnalyticsTracker", () => ({ AnalyticsTracker: () => null }));
vi.mock("@/lib/pushNotifications", () => ({ PushRegistrar: () => null }));
vi.mock("@/lib/analytics", () => ({ trackError: vi.fn() }));
vi.mock("@/components/ErrorBoundary", () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Importing the module runs the module-scope AppState → focusManager bridge.
import "../app/_layout";

function fireAppState(state: string) {
  for (const cb of appStateListeners) cb(state);
}

const queryFn = vi.fn(async () => [{ id: 1 }]);

function Harness() {
  // Mirrors the notification list queries: refetchOnWindowFocus is the
  // React Query default, which is exactly what the focusManager bridge drives.
  useQuery({ queryKey: ["notifications"], queryFn });
  return null;
}

function renderHarness() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
}

describe("AppState → focusManager foreground-refresh bridge (_layout)", () => {
  beforeEach(() => {
    queryFn.mockClear();
  });

  afterEach(() => {
    cleanup();
    // Restore the singleton to its default (jsdom-driven) focus behavior so
    // other test files aren't affected by a stuck manual override.
    focusManager.setFocused(undefined);
  });

  it("registers exactly one AppState listener on native", () => {
    expect(addEventListenerMock).toHaveBeenCalledTimes(1);
    expect(addEventListenerMock).toHaveBeenCalledWith("change", expect.any(Function));
  });

  it("drives focusManager from AppState transitions", () => {
    fireAppState("background");
    expect(focusManager.isFocused()).toBe(false);

    fireAppState("active");
    expect(focusManager.isFocused()).toBe(true);

    // Non-active states (including "inactive") count as unfocused.
    fireAppState("inactive");
    expect(focusManager.isFocused()).toBe(false);
  });

  it("refetches a mounted notification query when the app returns to the foreground", async () => {
    renderHarness();
    await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1));

    fireAppState("background");
    // Backgrounding alone must not refetch.
    await new Promise((r) => setTimeout(r, 10));
    expect(queryFn).toHaveBeenCalledTimes(1);

    fireAppState("active");
    await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2));
  });

  it("does not refetch on foreground for queries that opt out of focus refetching", async () => {
    const optOutFn = vi.fn(async () => []);
    function OptOut() {
      useQuery({
        queryKey: ["opt-out"],
        queryFn: optOutFn,
        refetchOnWindowFocus: false,
      });
      return null;
    }
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <OptOut />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(optOutFn).toHaveBeenCalledTimes(1));

    fireAppState("background");
    fireAppState("active");
    await new Promise((r) => setTimeout(r, 10));
    expect(optOutFn).toHaveBeenCalledTimes(1);
  });
});
