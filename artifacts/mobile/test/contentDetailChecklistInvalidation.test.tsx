/**
 * Regression guard: publishing from the mobile content detail screen keeps
 * the Home getting-started checklist live. Every publish path (Facebook,
 * Instagram, LinkedIn, X, Threads, and the Instagram retry) must invalidate
 * the first-post-progress query (getGetFirstPostProgressQueryKey) on
 * success, or the checklist's "publish" step stays unticked until an app
 * restart. These tests fail if that invalidation is removed.
 */
import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const publishFacebookMutate = vi.fn();
const publishInstagramMutate = vi.fn();
const publishLinkedinMutate = vi.fn();
const publishTwitterMutate = vi.fn();
const publishThreadsMutate = vi.fn();

const mockContent = {
  status: "draft" as string,
};

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock, idleMutation } = await import("./apiClientMock");
  type RunCallbacks = {
    onSuccess?: (res: unknown) => void;
    onRetrying?: (reason: string) => void;
    onError?: (err: unknown, info: { retried: boolean }) => void;
  };
  return createApiClientMock({
    useGetContent: () => ({
      data: {
        id: 9,
        title: "Ready to publish",
        caption: "A caption",
        imagePath: "/objects/img.png",
        platform: "instagram",
        status: mockContent.status,
        permalink: null,
        failureReason: mockContent.status === "failed" ? "processing error" : null,
        createdAt: new Date("2026-01-01T00:00:00Z").toISOString(),
        linkedinCommentsPending: 0,
        threadsPostsPending: 0,
        twitterPostsPending: 0,
      },
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    }),
    usePublishContentToFacebook: () => ({ ...idleMutation(), mutate: publishFacebookMutate }),
    usePublishContentToInstagram: () => ({ ...idleMutation(), mutate: publishInstagramMutate }),
    usePublishContentToLinkedin: () => ({ ...idleMutation(), mutate: publishLinkedinMutate }),
    usePublishContentToTwitter: () => ({ ...idleMutation(), mutate: publishTwitterMutate }),
    usePublishContentToThreads: () => ({ ...idleMutation(), mutate: publishThreadsMutate }),
    // Pass-through retry wrapper: run the mutation once, forwarding the
    // success/error callbacks the screen provides.
    useRestartRetry: () => ({
      isRetrying: false,
      run: (
        mutation: { mutate: (vars: unknown, opts?: unknown) => void },
        vars: unknown,
        callbacks: RunCallbacks,
      ) =>
        mutation.mutate(vars, {
          onSuccess: callbacks.onSuccess,
          onError: (err: unknown) => callbacks.onError?.(err, { retried: false }),
        }),
    }),
    useGetFacebookCredentials: () => ({ data: { saved: true, verifyStatus: "verified" } }),
    useGetInstagramCredentials: () => ({ data: { saved: true, verifyStatus: "verified" } }),
    useGetLinkedinStatus: () => ({ data: { connected: true, expired: false } }),
    useGetTwitterStatus: () => ({ data: { connected: true, expired: false } }),
    useGetThreadsStatus: () => ({ data: { connected: true, expired: false } }),
    useListSchedules: () => ({ data: [], isLoading: false }),
  });
});

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

import ContentDetailScreen from "../app/content/[id]";
import { getGetFirstPostProgressQueryKey } from "@workspace/api-client-react";

type MutateCallbacks = {
  onSuccess?: (res: unknown) => void;
  onError?: (err: unknown) => void;
};

const FIRST_POST_KEY = getGetFirstPostProgressQueryKey();

function invalidatedFirstPost(spy: ReturnType<typeof vi.fn>) {
  return spy.mock.calls.some(
    ([arg]) =>
      JSON.stringify((arg as { queryKey?: unknown })?.queryKey) ===
      JSON.stringify(FIRST_POST_KEY),
  );
}

function renderScreen() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const invalidateSpy = vi.spyOn(client, "invalidateQueries");
  render(
    <QueryClientProvider client={client}>
      <ContentDetailScreen />
    </QueryClientProvider>,
  );
  return { invalidateSpy };
}

beforeEach(() => {
  cleanup();
  publishFacebookMutate.mockReset();
  publishInstagramMutate.mockReset();
  publishLinkedinMutate.mockReset();
  publishTwitterMutate.mockReset();
  publishThreadsMutate.mockReset();
  mockContent.status = "draft";
});

function expectPublishInvalidates(
  buttonTitle: string,
  mutateMock: ReturnType<typeof vi.fn>,
  successPayload: unknown = {},
) {
  const { invalidateSpy } = renderScreen();
  fireEvent.click(screen.getByText(buttonTitle));
  expect(mutateMock).toHaveBeenCalledTimes(1);
  expect(mutateMock.mock.calls[0][0]).toEqual({ id: 9 });

  const cbs = mutateMock.mock.calls[0][1] as MutateCallbacks;
  expect(invalidatedFirstPost(invalidateSpy)).toBe(false);
  act(() => {
    cbs.onSuccess?.(successPayload);
  });
  expect(invalidatedFirstPost(invalidateSpy)).toBe(true);
  return { invalidateSpy };
}

describe("Content detail publish paths invalidate first-post progress (mobile)", () => {
  it("Facebook publish invalidates the checklist query", () => {
    expectPublishInvalidates("Facebook", publishFacebookMutate, {
      permalink: "https://fb.example/p",
    });
  });

  it("Instagram publish invalidates the checklist query", () => {
    expectPublishInvalidates("Instagram", publishInstagramMutate);
  });

  it("LinkedIn publish invalidates the checklist query", () => {
    expectPublishInvalidates("LinkedIn", publishLinkedinMutate, {
      permalink: "https://li.example/p",
      commentsPosted: 0,
    });
  });

  it("X publish invalidates the checklist query", () => {
    expectPublishInvalidates("X", publishTwitterMutate, {
      permalink: "https://x.example/p",
      tweetCount: 1,
    });
  });

  it("Threads publish invalidates the checklist query", () => {
    expectPublishInvalidates("Threads", publishThreadsMutate, {
      permalink: "https://th.example/p",
      postsPublished: 1,
    });
  });

  it("Instagram retry after a failed publish invalidates the checklist query", () => {
    mockContent.status = "failed";
    const { invalidateSpy } = renderScreen();
    fireEvent.click(screen.getByText("Retry Instagram publish"));
    expect(publishInstagramMutate).toHaveBeenCalledTimes(1);

    const cbs = publishInstagramMutate.mock.calls[0][1] as MutateCallbacks;
    expect(invalidatedFirstPost(invalidateSpy)).toBe(false);
    act(() => {
      cbs.onSuccess?.({});
    });
    expect(invalidatedFirstPost(invalidateSpy)).toBe(true);
  });

  it("a failed publish does not invalidate the checklist query", () => {
    const { invalidateSpy } = renderScreen();
    fireEvent.click(screen.getByText("Facebook"));
    const cbs = publishFacebookMutate.mock.calls[0][1] as MutateCallbacks;
    act(() => {
      cbs.onError?.({ status: 500, data: { error: "boom" } });
    });
    expect(invalidatedFirstPost(invalidateSpy)).toBe(false);
  });
});
