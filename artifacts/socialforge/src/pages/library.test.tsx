import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Regression guard for the Content Library "Retry" action on failed items.
 *
 * A content item ends up in the "failed" state when the Instagram background
 * publish exhausts its bounded retries (or the recovery job reclaims a stuck
 * publish). The card must surface a one-click Retry that re-runs the existing
 * Instagram publish endpoint. These tests mock the API hooks to seed a failed
 * item and assert:
 *  - a failed item with an image and a verified IG connection shows an enabled
 *    Retry button, and clicking it calls the Instagram publish mutation with
 *    the item's id;
 *  - the button is disabled when Instagram is not verified or the item has no
 *    image (Instagram requires one);
 *  - non-failed items render no Retry button.
 */

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
    usePublishContentToTwitter: mutation,
    usePublishContentToThreads: mutation,
    useGetThreadsStatus: () => ({ data: { connected: false } }),
    useGetFacebookCredentials: () => ({ data: {} }),
    useGetInstagramCredentials: () => ({ data: mockState.igCreds }),
    useGetTwitterStatus: () => ({ data: { connected: false } }),
    useGetLinkedinStatus: () => ({ data: { connected: false } }),
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
