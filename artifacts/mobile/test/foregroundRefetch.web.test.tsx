/**
 * Negative case for the AppState → focusManager bridge in _layout.tsx: on
 * web, React Query already gets real window focus events, so the module must
 * NOT register an AppState listener. Lives in its own file because the bridge
 * runs once at module scope and the Platform.OS mock must differ.
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";

const addEventListenerMock = vi.hoisted(() => vi.fn(() => ({ remove: vi.fn() })));
vi.mock("react-native", () => ({
  Platform: { OS: "web" },
  AppState: { addEventListener: addEventListenerMock },
}));

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

import "../app/_layout";

describe("AppState → focusManager bridge on web", () => {
  it("does not register an AppState listener (window focus events already work)", () => {
    expect(addEventListenerMock).not.toHaveBeenCalled();
  });
});
