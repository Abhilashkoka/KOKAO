/**
 * Regression guard: the mobile content detail screen's publish buttons must
 * stay locked while useRestartRetry's automatic one-shot retry is pending.
 *
 * During the retry window the underlying mutation is NOT "isPending" (the
 * first attempt already settled with the restart 503), so a screen gating
 * only on isPending would re-enable the button and a double-tap could race
 * the scheduled retry and duplicate a post. This test uses the REAL
 * useRestartRetry hook (only the generated hooks are mocked) and asserts the
 * on-screen publish button ignores taps through the whole retry window and
 * accepts them again after the retry settles.
 *
 * Mirrors the web guard in
 * artifacts/socialforge/src/pages/library.retry-lock.test.tsx.
 */
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const publishTwitterMutate = vi.fn();
const publishInstagramMutate = vi.fn();

// Per-test switch: "draft" renders the normal publish buttons (X path);
// "failed" renders the failed-state "Retry Instagram publish" control.
const mockContent = {
  status: "draft" as "draft" | "failed",
  imagePath: null as string | null,
};

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("./apiClientMock");
  // Pull the REAL retry hook (and its timing constant) so the test exercises
  // the actual isRetrying wiring instead of a hand-rolled stub.
  const actual = await vi.importActual<typeof import("@workspace/api-client-react")>(
    "@workspace/api-client-react",
  );
  return createApiClientMock({
    useRestartRetry: actual.useRestartRetry,
    RESTART_RETRY_DELAY_MS: actual.RESTART_RETRY_DELAY_MS,
    useGetContent: () => ({
      data: {
        id: 7,
        title: "Locked while retrying",
        caption: "A caption",
        imagePath: mockContent.imagePath,
        platform: "x",
        status: mockContent.status,
        permalink: null,
        failureReason: null,
        createdAt: new Date("2026-01-01T00:00:00Z").toISOString(),
      },
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    }),
    usePublishContentToTwitter: () => ({
      mutate: publishTwitterMutate,
      isPending: false,
    }),
    usePublishContentToInstagram: () => ({
      mutate: publishInstagramMutate,
      isPending: false,
    }),
    useGetTwitterStatus: () => ({
      data: { connected: true, expired: false, accountName: "tester" },
    }),
  });
});

// Expo / native modules the screen imports but the test never exercises.
vi.mock("expo-router", () => ({
  useLocalSearchParams: () => ({ id: "7" }),
  useRouter: () => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }),
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
// The compat wrapper is compiled with the classic JSX runtime and no React
// import, which breaks under vitest's transform — replace it with a plain
// passthrough (the test never exercises keyboard behavior).
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
import { RESTART_RETRY_DELAY_MS } from "@workspace/api-client-react";

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

type MutateCallbacks = {
  onSuccess?: (res: unknown) => void;
  onError?: (err: unknown) => void;
};

const restartError = () => ({
  status: 503,
  data: { error: "Server is restarting, please retry shortly" },
});

/**
 * react-native-web's Pressable does not render role="button", so we target
 * the "X" label: clicks bubble up to the pressable, and the disabled state
 * is detected via an aria-disabled ancestor.
 */
function xPublishLabel(): HTMLElement {
  return screen.getByText("X");
}

function xPublishLocked(): boolean {
  return xPublishLabel().closest('[aria-disabled="true"]') !== null;
}

beforeEach(() => {
  cleanup();
  publishTwitterMutate.mockReset();
  publishInstagramMutate.mockReset();
  mockContent.status = "draft";
  mockContent.imagePath = null;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Mobile content detail publish lock during automatic restart retry", () => {
  it("ignores taps through the retry window and re-enables after the retry settles", () => {
    renderScreen();

    expect(xPublishLocked()).toBe(false);

    // Fake timers from here on so we control the retry delay exactly.
    vi.useFakeTimers();
    fireEvent.click(xPublishLabel());
    expect(publishTwitterMutate).toHaveBeenCalledTimes(1);

    // First attempt fails with the restart 503 → the hook schedules the
    // one-shot retry. The mutation is no longer pending at this point, so
    // only the isRetrying wiring can keep the button locked.
    const firstCallbacks = publishTwitterMutate.mock.calls[0][1] as MutateCallbacks;
    act(() => {
      firstCallbacks.onError?.(restartError());
    });

    expect(xPublishLocked()).toBe(true);

    // A double-tap during the window must not fire another publish.
    fireEvent.click(xPublishLabel());
    expect(publishTwitterMutate).toHaveBeenCalledTimes(1);

    // Still locked (and still tap-proof) just before the retry fires.
    act(() => {
      vi.advanceTimersByTime(RESTART_RETRY_DELAY_MS - 1);
    });
    expect(xPublishLocked()).toBe(true);
    fireEvent.click(xPublishLabel());
    expect(publishTwitterMutate).toHaveBeenCalledTimes(1);

    // The scheduled retry fires exactly once after the delay.
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(publishTwitterMutate).toHaveBeenCalledTimes(2);

    // Retry settles with a terminal (non-transient) error → the lock lifts
    // and a fresh tap publishes again.
    const retryCallbacks = publishTwitterMutate.mock.calls[1][1] as MutateCallbacks;
    act(() => {
      retryCallbacks.onError?.(Object.assign(new Error("boom"), { status: 500 }));
    });

    expect(xPublishLocked()).toBe(false);
    fireEvent.click(xPublishLabel());
    expect(publishTwitterMutate).toHaveBeenCalledTimes(3);
  });

  it("unlocks the button when the automatic retry succeeds", () => {
    renderScreen();
    vi.useFakeTimers();
    fireEvent.click(xPublishLabel());

    const firstCallbacks = publishTwitterMutate.mock.calls[0][1] as MutateCallbacks;
    act(() => {
      firstCallbacks.onError?.(restartError());
    });
    expect(xPublishLocked()).toBe(true);

    act(() => {
      vi.advanceTimersByTime(RESTART_RETRY_DELAY_MS);
    });
    expect(publishTwitterMutate).toHaveBeenCalledTimes(2);
    const retryCallbacks = publishTwitterMutate.mock.calls[1][1] as MutateCallbacks;
    act(() => {
      retryCallbacks.onSuccess?.({ permalink: null });
    });

    expect(xPublishLocked()).toBe(false);
    fireEvent.click(xPublishLabel());
    expect(publishTwitterMutate).toHaveBeenCalledTimes(3);
  });
});

/**
 * Failed-state control: when the item is status "failed" the screen shows a
 * separate "Retry Instagram publish" button (handleRetryInstagram). It shares
 * the same anyPublishPending gate as the normal publish buttons, so it must
 * also ignore taps during useRestartRetry's automatic retry window.
 */
function igRetryLabel(): HTMLElement {
  return screen.getByText("Retry Instagram publish");
}

function igRetryLocked(): boolean {
  return igRetryLabel().closest('[aria-disabled="true"]') !== null;
}

describe("Mobile failed-state 'Retry Instagram publish' lock during automatic restart retry", () => {
  beforeEach(() => {
    mockContent.status = "failed";
    mockContent.imagePath = "/objects/t1/uploads/img.png";
  });

  it("ignores taps through the retry window and re-enables after the retry settles", () => {
    renderScreen();

    expect(igRetryLocked()).toBe(false);

    vi.useFakeTimers();
    fireEvent.click(igRetryLabel());
    expect(publishInstagramMutate).toHaveBeenCalledTimes(1);

    // First attempt fails with the restart 503 → the hook schedules the
    // one-shot retry. The mutation is no longer pending, so only the
    // isRetrying wiring can keep the retry button locked.
    const firstCallbacks = publishInstagramMutate.mock.calls[0][1] as MutateCallbacks;
    act(() => {
      firstCallbacks.onError?.(restartError());
    });

    expect(igRetryLocked()).toBe(true);

    // A double-tap during the window must not re-run the Instagram publish.
    fireEvent.click(igRetryLabel());
    expect(publishInstagramMutate).toHaveBeenCalledTimes(1);

    // Still locked (and still tap-proof) just before the retry fires.
    act(() => {
      vi.advanceTimersByTime(RESTART_RETRY_DELAY_MS - 1);
    });
    expect(igRetryLocked()).toBe(true);
    fireEvent.click(igRetryLabel());
    expect(publishInstagramMutate).toHaveBeenCalledTimes(1);

    // The scheduled retry fires exactly once after the delay.
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(publishInstagramMutate).toHaveBeenCalledTimes(2);

    // Retry settles with a terminal error → the lock lifts and a fresh tap
    // retries again.
    const retryCallbacks = publishInstagramMutate.mock.calls[1][1] as MutateCallbacks;
    act(() => {
      retryCallbacks.onError?.(Object.assign(new Error("boom"), { status: 500 }));
    });

    expect(igRetryLocked()).toBe(false);
    fireEvent.click(igRetryLabel());
    expect(publishInstagramMutate).toHaveBeenCalledTimes(3);
  });

  it("unlocks the retry button when the automatic retry succeeds", () => {
    renderScreen();
    vi.useFakeTimers();
    fireEvent.click(igRetryLabel());

    const firstCallbacks = publishInstagramMutate.mock.calls[0][1] as MutateCallbacks;
    act(() => {
      firstCallbacks.onError?.(restartError());
    });
    expect(igRetryLocked()).toBe(true);

    act(() => {
      vi.advanceTimersByTime(RESTART_RETRY_DELAY_MS);
    });
    expect(publishInstagramMutate).toHaveBeenCalledTimes(2);
    const retryCallbacks = publishInstagramMutate.mock.calls[1][1] as MutateCallbacks;
    act(() => {
      retryCallbacks.onSuccess?.({});
    });

    expect(igRetryLocked()).toBe(false);
    fireEvent.click(igRetryLabel());
    expect(publishInstagramMutate).toHaveBeenCalledTimes(3);
  });
});
