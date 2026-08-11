/**
 * Regression guard: the mobile Studio keeps the Home getting-started
 * checklist live. Successful caption generation, image generation, and
 * draft save must each invalidate the first-post-progress query
 * (getGetFirstPostProgressQueryKey), or the checklist goes stale until an
 * app restart. These tests fail if any of those invalidations are removed
 * from the success handlers.
 */
import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const genCaptionMutate = vi.fn();
const genImageMutate = vi.fn();
const createContentMutate = vi.fn();

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock, idleMutation } = await import("./apiClientMock");
  return createApiClientMock({
    useGetMe: () => ({
      data: {
        tenant: { id: 1, name: "Test Workspace", plan: "free" },
        usage: { captions: 0, images: 0 },
        limits: { captions: 10, images: 10 },
        credits: { captionCredits: 0, imageCredits: 0 },
        team: null,
      },
      isLoading: false,
    }),
    useListBrandKits: () => ({ data: [], isLoading: false }),
    useGenerateCaption: () => ({ ...idleMutation(), mutate: genCaptionMutate }),
    useGenerateImage: () => ({ ...idleMutation(), mutate: genImageMutate }),
    useCreateContent: () => ({ ...idleMutation(), mutate: createContentMutate }),
  });
});

vi.mock("expo-router", () => ({
  router: { push: vi.fn(), back: vi.fn(), replace: vi.fn() },
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("@expo/vector-icons", () => ({
  Feather: Object.assign(() => null, { glyphMap: {} }),
}));
vi.mock("expo-haptics", () => ({
  impactAsync: vi.fn(),
  ImpactFeedbackStyle: { Light: "light" },
}));
vi.mock("expo-image", () => ({
  Image: () => null,
}));
vi.mock("@/components/KeyboardAwareScrollViewCompat", async () => {
  const { ScrollView } = await import("react-native");
  return {
    KeyboardAwareScrollViewCompat: ({ children, ...props }: any) => (
      <ScrollView {...props}>{children}</ScrollView>
    ),
  };
});
vi.mock("@/components/VoiceNoteButton", () => ({
  VoiceNoteButton: () => null,
}));
vi.mock("@/components/ContentImage", () => ({
  ContentImage: () => null,
}));
vi.mock("@/lib/analytics", () => ({
  track: vi.fn(),
  trackFeatureUse: vi.fn(),
}));

import StudioScreen from "../app/(tabs)/studio";
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
      <StudioScreen />
    </QueryClientProvider>,
  );
  return { invalidateSpy };
}

function typePrompt() {
  fireEvent.change(
    screen.getByPlaceholderText("e.g. Announcing our new summer collection"),
    { target: { value: "A prompt for a post" } },
  );
}

beforeEach(() => {
  cleanup();
  genCaptionMutate.mockReset();
  genImageMutate.mockReset();
  createContentMutate.mockReset();
});

describe("Studio first-post checklist invalidation (mobile)", () => {
  it("invalidates first-post progress after a successful caption generation", () => {
    const { invalidateSpy } = renderScreen();
    typePrompt();
    fireEvent.click(screen.getByText("Generate caption"));
    expect(genCaptionMutate).toHaveBeenCalledTimes(1);

    const cbs = genCaptionMutate.mock.calls[0][1] as MutateCallbacks;
    expect(invalidatedFirstPost(invalidateSpy)).toBe(false);
    act(() => {
      cbs.onSuccess?.({ caption: "Hello world", hashtags: ["#hi"] });
    });
    expect(invalidatedFirstPost(invalidateSpy)).toBe(true);
  });

  it("invalidates first-post progress after a successful image generation", () => {
    const { invalidateSpy } = renderScreen();
    typePrompt();
    fireEvent.click(screen.getByText("Image"));
    expect(genImageMutate).toHaveBeenCalledTimes(1);

    const cbs = genImageMutate.mock.calls[0][1] as MutateCallbacks;
    expect(invalidatedFirstPost(invalidateSpy)).toBe(false);
    act(() => {
      cbs.onSuccess?.({ b64Json: "aGk=", imagePath: "/objects/img.png" });
    });
    expect(invalidatedFirstPost(invalidateSpy)).toBe(true);
  });

  it("invalidates first-post progress after a successful draft save", () => {
    const { invalidateSpy } = renderScreen();
    typePrompt();
    // Generate a caption first so the "Save to library" button appears.
    fireEvent.click(screen.getByText("Generate caption"));
    const genCbs = genCaptionMutate.mock.calls[0][1] as MutateCallbacks;
    act(() => {
      genCbs.onSuccess?.({ caption: "Hello world", hashtags: [] });
    });
    invalidateSpy.mockClear();

    fireEvent.click(screen.getByText("Save to library"));
    expect(createContentMutate).toHaveBeenCalledTimes(1);

    const saveCbs = createContentMutate.mock.calls[0][1] as MutateCallbacks;
    expect(invalidatedFirstPost(invalidateSpy)).toBe(false);
    act(() => {
      saveCbs.onSuccess?.({ id: 1 });
    });
    expect(invalidatedFirstPost(invalidateSpy)).toBe(true);
  });

  it("does not invalidate first-post progress when generation fails", () => {
    const { invalidateSpy } = renderScreen();
    typePrompt();
    fireEvent.click(screen.getByText("Generate caption"));
    const cbs = genCaptionMutate.mock.calls[0][1] as MutateCallbacks;
    act(() => {
      cbs.onError?.({ status: 500, data: { error: "boom" } });
    });
    expect(invalidatedFirstPost(invalidateSpy)).toBe(false);
  });
});
