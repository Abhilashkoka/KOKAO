import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  TWEET_MAX_LENGTH,
  isOverTweetLimit,
  tweetOverBy,
  LINKEDIN_MAX_LENGTH,
  isOverLinkedinLimit,
  splitForLinkedin,
} from "@workspace/social-limits";

/**
 * Two regression guards for the Content Library:
 *
 * 1. Retry action on failed items: a content item ends up "failed" when the
 *    Instagram background publish exhausts its bounded retries (or the
 *    recovery job reclaims a stuck publish). The card must surface a
 *    one-click Retry that re-runs the existing Instagram publish endpoint.
 *
 * 2. Character warnings/previews: the edit-dialog character warning and the
 *    publish dialogs' previews must be derived from the shared
 *    @workspace/social-limits helpers so the on-screen warning always matches
 *    what the server actually posts. Expected values in these tests are
 *    computed FROM the shared helpers; a component drifting to a local copy
 *    of the limits fails these assertions.
 */

// Radix menus/dialogs need a few APIs jsdom doesn't implement.
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

const publishInstagramMutate = vi.fn();

const mockState: {
  content: any[];
  igCreds: any;
} = {
  content: [],
  igCreds: {},
};

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@workspace/api-client-react", () => {
  const mutation = () => ({ mutate: vi.fn(), isPending: false });
  return {
    useListContent: () => ({ data: mockState.content, isLoading: false }),
    useDeleteContent: mutation,
    useUpdateContent: mutation,
    usePublishContentToFacebook: mutation,
    usePublishContentToInstagram: () => ({
      mutate: publishInstagramMutate,
      isPending: false,
    }),
    usePublishContentToLinkedin: mutation,
    useResendLinkedinComments: mutation,
    usePublishContentToTwitter: mutation,
    usePublishContentToThreads: mutation,
    useGetFacebookCredentials: () => ({ data: { verifyStatus: "verified" } }),
    useGetInstagramCredentials: () => ({ data: mockState.igCreds }),
    useGetTwitterStatus: () => ({ data: { connected: true, accountName: "tester" } }),
    useGetLinkedinStatus: () => ({ data: { connected: true } }),
    useGetThreadsStatus: () => ({ data: { connected: true } }),
    getListContentQueryKey: () => ["content"],
  };
});

// Imported after the mock so the mocked module is picked up.
import { LibraryPage } from "./library";

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <LibraryPage />
    </QueryClientProvider>,
  );
}

function makeItem(caption: string) {
  return {
    id: 1,
    title: "Test item",
    caption,
    imagePath: null,
    platform: "twitter",
    status: "draft",
    permalink: null,
  };
}

function renderPageWithCaption(caption: string) {
  mockState.content = [makeItem(caption)];
  return renderPage();
}

const failedItem = (overrides: Record<string, unknown> = {}) => ({
  id: 42,
  title: "Failed post",
  caption: "A caption",
  platform: "instagram",
  status: "failed",
  imagePath: "/objects/t1/uploads/abc",
  permalink: null,
  ...overrides,
});

async function openMenuAndClick(itemLabel: RegExp) {
  const user = userEvent.setup();
  // The only ghost icon button on the card is the dropdown trigger.
  const triggers = screen.getAllByRole("button").filter((b) => b.querySelector("svg"));
  await user.click(triggers[0]!);
  const menuItem = await screen.findByRole("menuitem", { name: itemLabel });
  await user.click(menuItem);
}

beforeEach(() => {
  cleanup();
  publishInstagramMutate.mockReset();
  mockState.content = [];
  mockState.igCreds = { verifyStatus: "verified" };
});

describe("Content Library retry action", () => {
  it("shows an enabled Retry on a failed item and re-runs the Instagram publish", () => {
    mockState.content = [failedItem()];
    renderPage();

    const retry = screen.getByRole("button", { name: /retry/i });
    expect((retry as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(retry);
    expect(publishInstagramMutate).toHaveBeenCalledTimes(1);
    expect(publishInstagramMutate.mock.calls[0][0]).toEqual({ id: 42 });
  });

  it("disables Retry when the Instagram connection is not verified", () => {
    mockState.igCreds = { verifyStatus: "failed" };
    mockState.content = [failedItem()];
    renderPage();

    expect((screen.getByRole("button", { name: /retry/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("disables Retry when the item has no image (Instagram requires one)", () => {
    mockState.content = [failedItem({ imagePath: null })];
    renderPage();

    expect((screen.getByRole("button", { name: /retry/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders no Retry button for non-failed items", () => {
    mockState.content = [
      failedItem({ id: 1, status: "draft" }),
      failedItem({ id: 2, status: "published" }),
      failedItem({ id: 3, status: "publishing" }),
    ];
    renderPage();

    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  });
});

describe("Library edit dialog X character warning", () => {
  it("warns using the shared helpers when the caption is over the limit, and clears at/under the limit", async () => {
    const over = "c".repeat(TWEET_MAX_LENGTH + 42);
    expect(isOverTweetLimit(over)).toBe(true);
    renderPageWithCaption(over);
    await openMenuAndClick(/edit/i);

    const dialog = await screen.findByRole("dialog");
    const counter = within(dialog).getByText(/characters for X/i);
    expect(counter.textContent).toContain(`${over.length} / ${TWEET_MAX_LENGTH}`);
    expect(counter.textContent).toContain(`${tweetOverBy(over)} over`);

    // Editing down to exactly the limit clears the warning.
    const atLimit = "c".repeat(TWEET_MAX_LENGTH);
    expect(isOverTweetLimit(atLimit)).toBe(false);
    const textarea = within(dialog).getAllByRole("textbox")[1]!;
    fireEvent.change(textarea, { target: { value: atLimit } });
    await waitFor(() => {
      const updated = within(dialog).getByText(/characters for X/i);
      expect(updated.textContent).toContain(`${TWEET_MAX_LENGTH} / ${TWEET_MAX_LENGTH}`);
      expect(updated.textContent).not.toContain("over;");
    });

    // And an under-limit caption shows the plain count.
    const under = "short caption";
    fireEvent.change(textarea, { target: { value: under } });
    await waitFor(() => {
      const updated = within(dialog).getByText(/characters for X/i);
      expect(updated.textContent).toContain(`${under.length} / ${TWEET_MAX_LENGTH}`);
      expect(updated.textContent).not.toContain("over;");
    });
  });
});

describe("Library publish-to-X dialog preview", () => {
  it("shows no thread warning for an at-limit caption", async () => {
    const caption = "d".repeat(TWEET_MAX_LENGTH);
    expect(isOverTweetLimit(caption)).toBe(false);
    renderPageWithCaption(caption);
    await openMenuAndClick(/publish to x/i);

    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(`${caption.length} characters / ${TWEET_MAX_LENGTH}`, {
        exact: false,
      }),
    ).toBeTruthy();
    expect(within(dialog).queryByText(/posted as a thread/i)).toBeNull();
  });

  it("warns that an over-limit caption posts as a thread, gated by the shared helper", async () => {
    // 300 'e's: one hard-split at 280 => exactly 2 tweets in the preview.
    const caption = "e".repeat(TWEET_MAX_LENGTH + 20);
    expect(isOverTweetLimit(caption)).toBe(true);
    expect(tweetOverBy(caption)).toBe(20);
    renderPageWithCaption(caption);
    await openMenuAndClick(/publish to x/i);

    const dialog = await screen.findByRole("dialog");
    // Full caption is previewed (the server threads instead of truncating).
    expect(within(dialog).getByText(caption)).toBeTruthy();
    expect(
      within(dialog).getByText(`${caption.length} characters \u00b7 2 tweets`, { exact: false }),
    ).toBeTruthy();
    expect(within(dialog).getByText(/posted as a thread of 2 tweets/i)).toBeTruthy();
  });
});

describe("Library publish-to-LinkedIn dialog preview", () => {
  it("previews the full caption and warns about follow-up comments, gated by splitForLinkedin", async () => {
    const caption = "f".repeat(LINKEDIN_MAX_LENGTH + 5);
    expect(isOverLinkedinLimit(caption)).toBe(true);
    const commentCount = splitForLinkedin(caption).comments.length;
    expect(commentCount).toBeGreaterThan(0);
    renderPageWithCaption(caption);
    await openMenuAndClick(/publish to linkedin/i);

    const dialog = await screen.findByRole("dialog");
    // Full caption is previewed (the server posts overflow as comments, no trimming).
    expect(within(dialog).getByText(caption)).toBeTruthy();
    expect(
      within(dialog).getByText(`${caption.length} / ${LINKEDIN_MAX_LENGTH} characters`, {
        exact: false,
      }),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(
        `the rest will be posted as ${commentCount} follow-up comment${commentCount === 1 ? "" : "s"}`,
        { exact: false },
      ),
    ).toBeTruthy();
  });

  it("previews the untrimmed caption with no warning when under the limit", async () => {
    const caption = "A normal LinkedIn caption.";
    expect(isOverLinkedinLimit(caption)).toBe(false);
    expect(splitForLinkedin(caption).comments).toHaveLength(0);
    renderPageWithCaption(caption);
    await openMenuAndClick(/publish to linkedin/i);

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(caption)).toBeTruthy();
    expect(within(dialog).queryByText(/will be trimmed before posting/i)).toBeNull();
  });
});
