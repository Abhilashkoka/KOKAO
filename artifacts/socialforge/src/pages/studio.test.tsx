import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  TWEET_MAX_LENGTH,
  isOverTweetLimit,
  tweetOverBy,
  splitIntoTweets,
  THREADS_MAX_LENGTH,
  chunkOnWhitespace,
  LINKEDIN_MAX_LENGTH,
  isOverLinkedinLimit,
  splitForLinkedin,
} from "@workspace/social-limits";

/**
 * Guard: the Studio caption result's X character warning must be derived from
 * the shared @workspace/social-limits helpers so the on-screen warning always
 * matches what the server does on publish. Expected values are computed FROM
 * the shared helpers — a local re-implementation of the 280 count would drift
 * and fail these tests.
 */

// Radix selects need a few APIs jsdom doesn't implement.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
if (typeof globalThis.ResizeObserver === "undefined") {
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

const mockState: { caption: string; lastCaptionVars: any } = {
  caption: "",
  lastCaptionVars: null,
};

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("wouter/use-browser-location", () => ({
  navigate: vi.fn(),
}));

vi.mock("@workspace/api-client-react", () => {
  const idleMutation = () => ({ mutate: vi.fn(), isPending: false });
  return {
    useGenerateCaption: () => ({
      isPending: false,
      mutate: (vars: unknown, opts: any) => {
        mockState.lastCaptionVars = vars;
        opts?.onSuccess?.({ caption: mockState.caption, hashtags: [] });
      },
    }),
    useGenerateImage: idleMutation,
    useGenerateCampaign: idleMutation,
    useSuggestTopics: idleMutation,
    useSummarizeUrl: idleMutation,
    useResearchTopic: idleMutation,
    useCreateContent: idleMutation,
    useUpdateContent: idleMutation,
    useDeleteContent: idleMutation,
    useGetMe: () => ({
      data: {
        usage: { captions: 2, images: 1 },
        limits: { captions: 10, images: 5 },
      },
    }),
    useListBrandKits: () => ({ data: [] }),
    getListContentQueryKey: () => ["content"],
    getGetMeQueryKey: () => ["me"],
  };
});

import { StudioPage } from "./studio";

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <StudioPage />
    </QueryClientProvider>,
  );
}

async function generateCaption(caption: string, platform: "twitter" | "instagram" = "twitter") {
  mockState.caption = caption;
  renderPage();
  fireEvent.change(screen.getByLabelText("Prompt"), {
    target: { value: "A prompt long enough to pass validation" },
  });
  if (platform === "twitter") {
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: /platform/i }));
    await user.click(await screen.findByRole("option", { name: /twitter \/ x/i }));
  }
  fireEvent.click(screen.getByRole("button", { name: /^Caption$/i }));
  // react-hook-form submit resolution is async.
  await waitFor(() => expect(screen.getByText(caption)).toBeTruthy());
}

beforeEach(() => {
  mockState.lastCaptionVars = null;
  cleanup();
});

describe("Studio caption X character warning", () => {
  it("shows count without warning for an under-limit caption", async () => {
    const caption = "A perfectly fine short caption.";
    expect(isOverTweetLimit(caption)).toBe(false);
    await generateCaption(caption);
    expect(
      screen.getByText(`${caption.length} / ${TWEET_MAX_LENGTH} characters for X`, {
        exact: false,
      }),
    ).toBeTruthy();
    expect(screen.queryByText(/over; will post as a thread/i)).toBeNull();
  });

  it("shows no warning at exactly the limit", async () => {
    const caption = "b".repeat(TWEET_MAX_LENGTH);
    expect(tweetOverBy(caption)).toBe(0);
    await generateCaption(caption);
    expect(
      screen.getByText(`${TWEET_MAX_LENGTH} / ${TWEET_MAX_LENGTH} characters for X`, {
        exact: false,
      }),
    ).toBeTruthy();
    expect(screen.queryByText(/over; will post as a thread/i)).toBeNull();
  });

  it("warns with the shared helper's over-by count when over the limit", async () => {
    const caption = "b".repeat(TWEET_MAX_LENGTH + 37);
    expect(isOverTweetLimit(caption)).toBe(true);
    await generateCaption(caption);
    const warning = screen.getByText(
      `${caption.length} / ${TWEET_MAX_LENGTH} characters for X`,
      { exact: false },
    );
    expect(warning.textContent).toContain(`${tweetOverBy(caption)} over`);
    expect(warning.textContent).toContain(
      `will post as a thread of ${splitIntoTweets(caption).length} tweets on X`,
    );
    expect(warning.textContent).not.toContain("trimmed");
  });

  it("shows no X warning when the caption was generated for another platform", async () => {
    const caption = "e".repeat(TWEET_MAX_LENGTH + 10);
    expect(isOverTweetLimit(caption)).toBe(true);
    await generateCaption(caption, "instagram");
    expect(screen.queryByText(/characters for X/i)).toBeNull();
  });
});

describe("Studio caption Threads character warning", () => {
  it("shows count without warning for an under-limit caption", async () => {
    const caption = "A perfectly fine short caption for Threads.";
    await generateCaption(caption);
    expect(
      screen.getByText(`${caption.length} / ${THREADS_MAX_LENGTH} characters for Threads`, {
        exact: false,
      }),
    ).toBeTruthy();
    expect(screen.queryByText(/over; will post as a chain/i)).toBeNull();
  });

  it("warns with the shared helper's chunk count when over the Threads limit", async () => {
    const caption = "t".repeat(THREADS_MAX_LENGTH + 60);
    const chunks = chunkOnWhitespace(caption, THREADS_MAX_LENGTH);
    expect(chunks.length).toBeGreaterThan(1);
    await generateCaption(caption);
    const warning = screen.getByText(
      `${caption.length} / ${THREADS_MAX_LENGTH} characters for Threads`,
      { exact: false },
    );
    expect(warning.textContent).toContain(
      `will post as a chain of ${chunks.length} connected posts on Threads`,
    );
  });
});

describe("Studio caption LinkedIn character warning", () => {
  it("shows count without warning for an under-limit caption", async () => {
    const caption = "A perfectly fine short caption for LinkedIn.";
    expect(isOverLinkedinLimit(caption)).toBe(false);
    await generateCaption(caption);
    expect(
      screen.getByText(`${caption.length} / ${LINKEDIN_MAX_LENGTH} characters for LinkedIn`, {
        exact: false,
      }),
    ).toBeTruthy();
    expect(screen.queryByText(/follow-up comment/i)).toBeNull();
  });

  it("warns with the shared helper's comment count when over the LinkedIn limit", async () => {
    const caption = "l".repeat(LINKEDIN_MAX_LENGTH + 200);
    expect(isOverLinkedinLimit(caption)).toBe(true);
    const commentCount = splitForLinkedin(caption).comments.length;
    await generateCaption(caption);
    const warning = screen.getByText(
      `${caption.length} / ${LINKEDIN_MAX_LENGTH} characters for LinkedIn`,
      { exact: false },
    );
    expect(warning.textContent).toContain(
      `the rest will be posted as ${commentCount} follow-up comment${commentCount === 1 ? "" : "s"} on LinkedIn`,
    );
  });
});

describe("Studio caption regenerate and tweak chips", () => {
  it("shows tweak chips and a Regenerate button after a caption is generated", async () => {
    await generateCaption("A caption to tweak.", "instagram");
    expect(screen.getByTestId("button-tweak-shorter")).toBeTruthy();
    expect(screen.getByTestId("button-tweak-punchier")).toBeTruthy();
    expect(screen.getByTestId("button-tweak-more-formal")).toBeTruthy();
    expect(screen.getByTestId("button-regenerate-caption")).toBeTruthy();
  });

  it("appends the tweak instruction to the prompt when a chip is clicked", async () => {
    await generateCaption("A caption to tweak.", "instagram");
    const basePrompt = mockState.lastCaptionVars.data.prompt;
    fireEvent.click(screen.getByTestId("button-tweak-shorter"));
    await waitFor(() =>
      expect(mockState.lastCaptionVars.data.prompt).toBe(
        `${basePrompt} Make the caption shorter and more concise.`,
      ),
    );
  });

  it("regenerate resends the original prompt without any tweak instruction", async () => {
    await generateCaption("A caption to tweak.", "instagram");
    const basePrompt = mockState.lastCaptionVars.data.prompt;
    fireEvent.click(screen.getByTestId("button-tweak-punchier"));
    await waitFor(() =>
      expect(mockState.lastCaptionVars.data.prompt).toContain("punchier"),
    );
    fireEvent.click(screen.getByTestId("button-regenerate-caption"));
    await waitFor(() =>
      expect(mockState.lastCaptionVars.data.prompt).toBe(basePrompt),
    );
  });
});
