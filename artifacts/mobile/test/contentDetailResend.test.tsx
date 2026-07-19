/**
 * Regression guard: the mobile content detail screen lets the user resend
 * missing chain pieces (LinkedIn follow-up comments, Threads and X thread
 * posts) in-app instead of pointing them at the web library.
 *
 * Verifies:
 * - pending-piece warnings render with a Resend button per platform
 * - resend calls the matching endpoint and shows a success notice
 * - a 409 shows a neutral "already in progress" notice (not an error)
 * - code "already_complete" shows a positive "already completed" notice
 *
 * Mirrors the web behavior in
 * artifacts/socialforge/src/components/pending-posts-warning.tsx.
 */
import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const resendLinkedinMutate = vi.fn();
const resendThreadsMutate = vi.fn();
const resendTwitterMutate = vi.fn();

const mockContent = {
  linkedinCommentsPending: 0,
  threadsPostsPending: 0,
  twitterPostsPending: 0,
};

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("./apiClientMock");
  return createApiClientMock({
    useGetContent: () => ({
      data: {
        id: 9,
        title: "Partially published",
        caption: "A long caption",
        imagePath: null,
        platform: "x",
        status: "published",
        permalink: null,
        failureReason: null,
        createdAt: new Date("2026-01-01T00:00:00Z").toISOString(),
        linkedinCommentsPending: mockContent.linkedinCommentsPending,
        threadsPostsPending: mockContent.threadsPostsPending,
        twitterPostsPending: mockContent.twitterPostsPending,
      },
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    }),
    useResendLinkedinComments: () => ({
      mutate: resendLinkedinMutate,
      isPending: false,
    }),
    useResendThreadsPosts: () => ({
      mutate: resendThreadsMutate,
      isPending: false,
    }),
    useResendTwitterPosts: () => ({
      mutate: resendTwitterMutate,
      isPending: false,
    }),
  });
});

// Expo / native modules the screen imports but the test never exercises.
vi.mock("expo-router", () => ({
  useLocalSearchParams: () => ({ id: "9" }),
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

type MutateCallbacks = {
  onSuccess?: (res: unknown) => void;
  onError?: (err: unknown) => void;
};

beforeEach(() => {
  cleanup();
  resendLinkedinMutate.mockReset();
  resendThreadsMutate.mockReset();
  resendTwitterMutate.mockReset();
  mockContent.linkedinCommentsPending = 0;
  mockContent.threadsPostsPending = 0;
  mockContent.twitterPostsPending = 0;
});

describe("Mobile content detail resend of missing chain pieces", () => {
  it("shows a warning and Resend button per platform with pending pieces", () => {
    mockContent.linkedinCommentsPending = 2;
    mockContent.threadsPostsPending = 1;
    mockContent.twitterPostsPending = 3;
    renderScreen();

    expect(
      screen.getByText(/2 LinkedIn follow-up comments .* still missing/),
    ).toBeTruthy();
    expect(
      screen.getByText(/1 Threads follow-up post .* still missing/),
    ).toBeTruthy();
    expect(
      screen.getByText(/3 X follow-up posts .* still missing/),
    ).toBeTruthy();
    expect(screen.getByText("Resend comments")).toBeTruthy();
    expect(screen.getAllByText("Resend posts")).toHaveLength(2);
  });

  it("shows no warnings when nothing is pending", () => {
    renderScreen();
    expect(screen.queryByText(/still missing/)).toBeNull();
  });

  it("resends LinkedIn comments and shows a success notice", () => {
    mockContent.linkedinCommentsPending = 2;
    renderScreen();

    fireEvent.click(screen.getByText("Resend comments"));
    expect(resendLinkedinMutate).toHaveBeenCalledTimes(1);
    expect(resendLinkedinMutate.mock.calls[0][0]).toEqual({ id: 9 });

    const callbacks = resendLinkedinMutate.mock.calls[0][1] as MutateCallbacks;
    act(() => {
      callbacks.onSuccess?.({ commentsTotal: 3, permalink: "https://l.example/p" });
    });
    expect(
      screen.getByText(/All 3 follow-up comment\(s\) are now posted on LinkedIn/),
    ).toBeTruthy();
  });

  it("resends Threads and X pieces via their own endpoints", () => {
    mockContent.threadsPostsPending = 1;
    mockContent.twitterPostsPending = 1;
    renderScreen();

    const buttons = screen.getAllByText("Resend posts");
    fireEvent.click(buttons[0]); // Threads block renders first
    expect(resendThreadsMutate).toHaveBeenCalledTimes(1);
    expect(resendTwitterMutate).toHaveBeenCalledTimes(0);

    fireEvent.click(buttons[1]);
    expect(resendTwitterMutate).toHaveBeenCalledTimes(1);

    const twCallbacks = resendTwitterMutate.mock.calls[0][1] as MutateCallbacks;
    act(() => {
      twCallbacks.onSuccess?.({ postsTotal: 4, permalink: null });
    });
    expect(
      screen.getByText(/All 4 post\(s\) of the thread are now live on X/),
    ).toBeTruthy();
  });

  it("treats a 409 as a neutral 'already in progress' notice", () => {
    mockContent.twitterPostsPending = 1;
    renderScreen();

    fireEvent.click(screen.getByText("Resend posts"));
    const callbacks = resendTwitterMutate.mock.calls[0][1] as MutateCallbacks;
    act(() => {
      callbacks.onError?.({
        status: 409,
        data: { error: "A resend for this post is already in progress." },
      });
    });
    expect(
      screen.getByText("A resend for this post is already in progress."),
    ).toBeTruthy();
    // Rendered as a positive/neutral notice, not the error style — the
    // error text for failures says "Could not resend".
    expect(screen.queryByText(/Could not resend/)).toBeNull();
  });

  it("treats code 'already_complete' as a positive completed notice", () => {
    mockContent.threadsPostsPending = 2;
    renderScreen();

    fireEvent.click(screen.getByText("Resend posts"));
    const callbacks = resendThreadsMutate.mock.calls[0][1] as MutateCallbacks;
    act(() => {
      callbacks.onError?.({
        status: 400,
        data: { error: "Nothing to resend.", code: "already_complete" },
      });
    });
    expect(
      screen.getByText(/already resent \(possibly from another device or by a teammate\)/),
    ).toBeTruthy();
    expect(screen.queryByText(/Could not resend/)).toBeNull();
  });

  it("shows a real failure as an error message", () => {
    mockContent.linkedinCommentsPending = 1;
    renderScreen();

    fireEvent.click(screen.getByText("Resend comments"));
    const callbacks = resendLinkedinMutate.mock.calls[0][1] as MutateCallbacks;
    act(() => {
      callbacks.onError?.({ status: 500, data: {} });
    });
    expect(
      screen.getByText("Could not resend the LinkedIn comments. Try again."),
    ).toBeTruthy();
  });
});
