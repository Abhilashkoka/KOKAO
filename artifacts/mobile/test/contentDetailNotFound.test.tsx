/**
 * Regression guard: tapping an inbox/push alert whose post was deleted opens
 * /content/[id] with an id that no longer exists. The screen must show a
 * friendly "post no longer exists" state with a way back to the Library —
 * never a raw error with a useless Retry button or an endless skeleton.
 *
 * Verifies:
 * - a 404 from useGetContent renders the not-found state + "Back to Library"
 * - the button navigates back to the library tab
 * - a non-404 error still renders the generic retryable error state
 */
import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockQuery = {
  error: null as { status?: number; message?: string } | null,
};
const routerReplace = vi.fn();

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("./apiClientMock");
  return createApiClientMock({
    useGetContent: () => ({
      data: undefined,
      isLoading: false,
      isError: true,
      error: mockQuery.error,
      refetch: vi.fn(),
    }),
  });
});

// Expo / native modules the screen imports but the test never exercises.
vi.mock("expo-router", () => ({
  useLocalSearchParams: () => ({ id: "42" }),
  useRouter: () => ({ back: vi.fn(), push: vi.fn(), replace: routerReplace }),
}));
vi.mock("expo-haptics", () => ({
  impactAsync: vi.fn(),
  ImpactFeedbackStyle: { Light: "light" },
}));
vi.mock("expo-linking", () => ({ openURL: vi.fn() }));
vi.mock("expo-web-browser", () => ({ openBrowserAsync: vi.fn() }));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("react-native-keyboard-controller", () => ({
  KeyboardAwareScrollView: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/KeyboardAwareScrollViewCompat", () => ({
  KeyboardAwareScrollViewCompat: ({ children }: { children?: React.ReactNode }) => (
    <>{children}</>
  ),
}));
vi.mock("@expo/vector-icons", () => ({
  Feather: Object.assign(() => null, { glyphMap: {} }),
}));
vi.mock("@/components/ContentImage", () => ({
  ContentImage: () => null,
}));
vi.mock("@/components/SchedulePicker", () => ({
  SchedulePicker: () => null,
}));

// Imported after the mocks so the mocked modules are picked up.
import ContentDetailScreen from "../app/content/[id]";

function renderScreen() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ContentDetailScreen />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  mockQuery.error = null;
});

describe("content detail: deleted / nonexistent post", () => {
  it("shows a friendly not-found state on a 404 instead of a raw error", () => {
    mockQuery.error = { status: 404, message: "HTTP 404 Not Found" };
    renderScreen();

    expect(screen.getByText("This post no longer exists")).toBeTruthy();
    expect(
      screen.getByText("It may have been deleted after this alert was sent."),
    ).toBeTruthy();
    expect(screen.getByText("Back to Library")).toBeTruthy();
    // No dead-end retry, and no raw error copy.
    expect(screen.queryByText("Something went wrong")).toBeNull();
    expect(screen.queryByText("Retry")).toBeNull();
  });

  it("Back to Library navigates to the library tab", () => {
    mockQuery.error = { status: 404 };
    renderScreen();

    fireEvent.click(screen.getByText("Back to Library"));
    expect(routerReplace).toHaveBeenCalledWith("/(tabs)/library");
  });

  it("still shows the generic retryable error state for non-404 failures", () => {
    mockQuery.error = { status: 500, message: "HTTP 500 Server Error" };
    renderScreen();

    expect(screen.getByText("Something went wrong")).toBeTruthy();
    expect(screen.getByText("Retry")).toBeTruthy();
    expect(screen.queryByText("This post no longer exists")).toBeNull();
  });
});
