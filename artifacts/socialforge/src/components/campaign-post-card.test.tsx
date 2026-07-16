import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
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
 * Guard: the campaign post card's X character warning must be derived from the
 * shared @workspace/social-limits helpers, so what the user sees always
 * matches what the server does when publishing. Expected values in these
 * tests are computed FROM the shared helpers — if the component drifts to a
 * local copy of the limit or its own counting, these assertions break.
 */

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@workspace/api-client-react", () => ({
  useGenerateImage: () => ({ mutate: vi.fn(), isPending: false }),
  useCreateContent: () => ({ mutate: vi.fn(), isPending: false }),
  getListContentQueryKey: () => ["content"],
}));

import { CampaignPostCard } from "./campaign-post-card";

function renderCard(platform: string, caption: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CampaignPostCard
        post={{ platform, caption, hashtags: [], imagePrompt: "" } as any}
        brief="test brief"
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => cleanup());

describe("CampaignPostCard X character warning", () => {
  it("shows no over-limit warning for an under-limit twitter caption", () => {
    const caption = "Short caption under the limit.";
    expect(isOverTweetLimit(caption)).toBe(false);
    renderCard("twitter", caption);
    expect(
      screen.getByText(`${caption.length} / ${TWEET_MAX_LENGTH} characters for X`, {
        exact: false,
      }),
    ).toBeTruthy();
    expect(screen.queryByText(/over; will post as a thread/i)).toBeNull();
  });

  it("shows no over-limit warning for an exactly at-limit caption", () => {
    const caption = "a".repeat(TWEET_MAX_LENGTH);
    expect(isOverTweetLimit(caption)).toBe(false);
    expect(tweetOverBy(caption)).toBe(0);
    renderCard("twitter", caption);
    expect(
      screen.getByText(`${TWEET_MAX_LENGTH} / ${TWEET_MAX_LENGTH} characters for X`, {
        exact: false,
      }),
    ).toBeTruthy();
    expect(screen.queryByText(/over; will post as a thread/i)).toBeNull();
  });

  it("warns with the shared helper's over-by count for an over-limit caption", () => {
    const caption = "a".repeat(TWEET_MAX_LENGTH + 20);
    expect(isOverTweetLimit(caption)).toBe(true);
    renderCard("twitter", caption);
    const warning = screen.getByText(
      `${caption.length} / ${TWEET_MAX_LENGTH} characters for X`,
      { exact: false },
    );
    // The displayed over-by number must equal the shared helper's output.
    expect(warning.textContent).toContain(`${tweetOverBy(caption)} over`);
    expect(warning.textContent).toContain(
      `will post as a thread of ${splitIntoTweets(caption).length} tweets on X`,
    );
    expect(warning.textContent).not.toContain("trimmed");
  });

  it("renders no X warning for non-twitter platforms", () => {
    renderCard("linkedin", "a".repeat(TWEET_MAX_LENGTH + 50));
    expect(screen.queryByText(/characters for X/i)).toBeNull();
  });
});

describe("CampaignPostCard Threads character warning", () => {
  it("shows count without warning for an under-limit threads caption", () => {
    const caption = "Short caption under the Threads limit.";
    renderCard("threads", caption);
    expect(
      screen.getByText(`${caption.length} / ${THREADS_MAX_LENGTH} characters for Threads`, {
        exact: false,
      }),
    ).toBeTruthy();
    expect(screen.queryByText(/over; will post as a chain/i)).toBeNull();
  });

  it("warns with the shared helper's chunk count for an over-limit threads caption", () => {
    const caption = "t".repeat(THREADS_MAX_LENGTH + 40);
    const chunks = chunkOnWhitespace(caption, THREADS_MAX_LENGTH);
    expect(chunks.length).toBeGreaterThan(1);
    renderCard("threads", caption);
    const warning = screen.getByText(
      `${caption.length} / ${THREADS_MAX_LENGTH} characters for Threads`,
      { exact: false },
    );
    expect(warning.textContent).toContain(
      `will post as a chain of ${chunks.length} connected posts on Threads`,
    );
  });

  it("renders no Threads warning for other platforms", () => {
    renderCard("twitter", "t".repeat(THREADS_MAX_LENGTH + 40));
    expect(screen.queryByText(/characters for Threads/i)).toBeNull();
  });
});

describe("CampaignPostCard LinkedIn character warning", () => {
  it("shows count without warning for an under-limit linkedin caption", () => {
    const caption = "Short caption under the LinkedIn limit.";
    expect(isOverLinkedinLimit(caption)).toBe(false);
    renderCard("linkedin", caption);
    expect(
      screen.getByText(`${caption.length} / ${LINKEDIN_MAX_LENGTH} characters for LinkedIn`, {
        exact: false,
      }),
    ).toBeTruthy();
    expect(screen.queryByText(/follow-up comment/i)).toBeNull();
  });

  it("warns with the shared helper's comment count for an over-limit linkedin caption", () => {
    const caption = "l".repeat(LINKEDIN_MAX_LENGTH + 100);
    expect(isOverLinkedinLimit(caption)).toBe(true);
    const commentCount = splitForLinkedin(caption).comments.length;
    renderCard("linkedin", caption);
    const warning = screen.getByText(
      `${caption.length} / ${LINKEDIN_MAX_LENGTH} characters for LinkedIn`,
      { exact: false },
    );
    expect(warning.textContent).toContain(
      `the rest will be posted as ${commentCount} follow-up comment${commentCount === 1 ? "" : "s"} on LinkedIn`,
    );
  });

  it("renders no LinkedIn warning for other platforms", () => {
    renderCard("twitter", "l".repeat(LINKEDIN_MAX_LENGTH + 100));
    expect(screen.queryByText(/characters for LinkedIn/i)).toBeNull();
  });
});
