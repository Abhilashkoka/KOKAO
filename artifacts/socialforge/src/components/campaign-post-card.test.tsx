import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { IMAGE_TWEAKS } from "@workspace/studio-presets";
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

// Resilient mock: unknown hooks fall back to an idle stub, so adding a new
// hook to the component does not break these tests.
const generateImageMutate = vi.hoisted(() => vi.fn());

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock, idleMutation } = await import("../test/apiClientMock");
  return createApiClientMock({
    useGenerateImage: () => ({ ...idleMutation(), mutate: generateImageMutate }),
  });
});

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

/**
 * Guard: campaign variant images offer the SAME quick style tweak chips as
 * the single-image Studio card, sourced from the shared
 * @workspace/studio-presets IMAGE_TWEAKS list. Clicking a chip regenerates
 * the variant's image with the shared instruction appended to the prompt,
 * and the result still flows through onImageGenerated (which powers the
 * "use for all platforms" flow).
 */
describe("CampaignPostCard image style tweak chips", () => {
  function renderWithImage(onImageGenerated?: (platform: string, image: unknown) => void) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={client}>
        <CampaignPostCard
          post={{ platform: "instagram", caption: "A cozy cafe post", hashtags: [], imagePrompt: "A cozy cafe interior" } as any}
          brief="test brief"
          image={{ imagePath: "/objects/t/uploads/x", b64Json: "aaaa" }}
          onImageGenerated={onImageGenerated as any}
        />
      </QueryClientProvider>,
    );
  }

  it("shows no tweak chips before an image exists", () => {
    renderCard("instagram", "caption");
    for (const t of IMAGE_TWEAKS) {
      expect(
        screen.queryByTestId(`button-campaign-image-tweak-instagram-${t.label.toLowerCase().replace(/\s+/g, "-")}`),
      ).toBeNull();
    }
  });

  it("renders every shared tweak chip once an image exists", () => {
    renderWithImage();
    for (const t of IMAGE_TWEAKS) {
      expect(
        screen.getByTestId(`button-campaign-image-tweak-instagram-${t.label.toLowerCase().replace(/\s+/g, "-")}`).textContent,
      ).toBe(t.label);
    }
  });

  it("clicking a chip regenerates with the shared instruction appended and reports via onImageGenerated", () => {
    generateImageMutate.mockClear();
    const onImageGenerated = vi.fn();
    renderWithImage(onImageGenerated);
    const tweak = IMAGE_TWEAKS[0];
    fireEvent.click(
      screen.getByTestId(`button-campaign-image-tweak-instagram-${tweak.label.toLowerCase().replace(/\s+/g, "-")}`),
    );
    expect(generateImageMutate).toHaveBeenCalledTimes(1);
    const [vars, opts] = generateImageMutate.mock.calls[0];
    expect(vars.data.prompt).toBe(`A cozy cafe interior ${tweak.instruction}`);
    const res = { imagePath: "/objects/t/uploads/y", b64Json: "bbbb" };
    (opts as any).onSuccess(res);
    expect(onImageGenerated).toHaveBeenCalledWith("instagram", res);
  });

  it("successful image generation invalidates the /me quota query", async () => {
    generateImageMutate.mockClear();
    const { getGetMeQueryKey } = await import("@workspace/api-client-react");
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    render(
      <QueryClientProvider client={client}>
        <CampaignPostCard
          post={{ platform: "instagram", caption: "A cozy cafe post", hashtags: [], imagePrompt: "A cozy cafe interior" } as any}
          brief="test brief"
        />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByTestId("button-campaign-image-instagram"));
    const [, opts] = generateImageMutate.mock.calls[0];
    (opts as any).onSuccess({ imagePath: "/objects/t/uploads/z", b64Json: "cccc" });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: getGetMeQueryKey() });
  });

  it("plain regenerate sends the untweaked prompt", () => {
    generateImageMutate.mockClear();
    renderWithImage();
    fireEvent.click(screen.getByTestId("button-campaign-image-instagram"));
    expect(generateImageMutate).toHaveBeenCalledTimes(1);
    expect(generateImageMutate.mock.calls[0][0].data.prompt).toBe("A cozy cafe interior");
  });
});
