import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  TWEET_MAX_LENGTH,
  isOverTweetLimit,
  tweetOverBy,
  splitIntoTweets,
} from "@workspace/social-limits";

/**
 * Guard: the Studio caption result's X character warning must be derived from
 * the shared @workspace/social-limits helpers so the on-screen warning always
 * matches what the server does on publish. Expected values are computed FROM
 * the shared helpers — a local re-implementation of the 280 count would drift
 * and fail these tests.
 */

const mockState: { caption: string } = { caption: "" };

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
      mutate: (_vars: unknown, opts: any) =>
        opts?.onSuccess?.({ caption: mockState.caption, hashtags: [] }),
    }),
    useGenerateImage: idleMutation,
    useGenerateCampaign: idleMutation,
    useSuggestTopics: idleMutation,
    useSummarizeUrl: idleMutation,
    useResearchTopic: idleMutation,
    useCreateContent: idleMutation,
    useListBrandKits: () => ({ data: [] }),
    getListContentQueryKey: () => ["content"],
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

async function generateCaption(caption: string) {
  mockState.caption = caption;
  renderPage();
  fireEvent.change(screen.getByLabelText("Prompt"), {
    target: { value: "A prompt long enough to pass validation" },
  });
  fireEvent.click(screen.getByRole("button", { name: /^Caption$/i }));
  // react-hook-form submit resolution is async.
  await waitFor(() => expect(screen.getByText(caption)).toBeTruthy());
}

beforeEach(() => cleanup());

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
});
