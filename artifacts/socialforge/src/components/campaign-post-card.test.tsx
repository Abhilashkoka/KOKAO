import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  TWEET_MAX_LENGTH,
  isOverTweetLimit,
  tweetOverBy,
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
    expect(warning.textContent).toContain("will post as a thread on X");
    expect(warning.textContent).not.toContain("trimmed");
  });

  it("renders no X warning for non-twitter platforms", () => {
    renderCard("linkedin", "a".repeat(TWEET_MAX_LENGTH + 50));
    expect(screen.queryByText(/characters for X/i)).toBeNull();
  });
});
