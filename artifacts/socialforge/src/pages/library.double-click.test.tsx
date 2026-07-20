import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, act, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Regression guard for the SYNCHRONOUS in-flight guard on the Library
 * page's publish-adjacent buttons (the failed-item Retry and the publish
 * dialog buttons).
 *
 * React state updates are batched/async, so two clicks dispatched in the
 * same frame both run before the `disabled` re-render lands — a page that
 * relies only on `retryingId` / `isPending` state would fire the mutation
 * twice. These tests dispatch two clicks inside a single `act()` (so no
 * re-render happens in between) and assert the mutation fired exactly once,
 * proving the ref-based guard (mirroring usePendingResendActions) works.
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

const publishTwitterMutate = vi.fn();
const publishInstagramMutate = vi.fn();

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  const actual = await vi.importActual<typeof import("@workspace/api-client-react")>(
    "@workspace/api-client-react",
  );
  return createApiClientMock({
    useRestartRetry: actual.useRestartRetry,
    RESTART_RETRY_DELAY_MS: actual.RESTART_RETRY_DELAY_MS,
    useListContent: () => ({
      data: [
        {
          id: 7,
          title: "Draft for X",
          caption: "A caption",
          imagePath: null,
          platform: "twitter",
          status: "draft",
          permalink: null,
        },
        {
          id: 8,
          title: "Failed Instagram post",
          caption: "IG caption",
          imagePath: "/objects/tenant/uploads/img.png",
          platform: "instagram",
          status: "failed",
          failureReason: "Instagram rejected the media",
          permalink: null,
        },
      ],
      isLoading: false,
    }),
    usePublishContentToTwitter: () => ({
      mutate: publishTwitterMutate,
      isPending: false,
    }),
    usePublishContentToInstagram: () => ({
      mutate: publishInstagramMutate,
      isPending: false,
    }),
    useGetTwitterStatus: () => ({ data: { connected: true, accountName: "tester" } }),
    useGetInstagramCredentials: () => ({ data: { verifyStatus: "verified" } }),
    getListContentQueryKey: () => ["content"],
  });
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

type MutateCallbacks = {
  onSuccess?: (res: unknown) => void;
  onError?: (err: unknown) => void;
};

beforeEach(() => {
  cleanup();
  publishTwitterMutate.mockReset();
  publishInstagramMutate.mockReset();
});

describe("Failed-item Retry button synchronous double-click guard", () => {
  it("fires the retry mutation only once when double-clicked in the same frame", async () => {
    renderPage();
    const retryButton = (await screen.findByRole("button", {
      name: /^retry$/i,
    })) as HTMLButtonElement;

    // Two clicks inside a single act(): no re-render between them, so the
    // state-based `disabled` cannot help — only the ref guard can.
    act(() => {
      retryButton.click();
      retryButton.click();
    });

    expect(publishInstagramMutate).toHaveBeenCalledTimes(1);
  });

  it("allows a fresh retry after the previous one settles with an error", async () => {
    renderPage();
    const retryButton = (await screen.findByRole("button", {
      name: /^retry$/i,
    })) as HTMLButtonElement;

    act(() => {
      retryButton.click();
      retryButton.click();
    });
    expect(publishInstagramMutate).toHaveBeenCalledTimes(1);

    // Terminal (non-transient) failure clears both the guard and retryingId.
    const callbacks = publishInstagramMutate.mock.calls[0][1] as MutateCallbacks;
    act(() => {
      callbacks.onError?.(Object.assign(new Error("boom"), { status: 500 }));
    });

    const revived = (await screen.findByRole("button", {
      name: /^retry$/i,
    })) as HTMLButtonElement;
    expect(revived.disabled).toBe(false);
    act(() => {
      revived.click();
    });
    expect(publishInstagramMutate).toHaveBeenCalledTimes(2);
  });
});

describe("Publish dialog button synchronous double-click guard", () => {
  it("fires the X publish mutation only once when double-clicked in the same frame", async () => {
    renderPage();
    const user = userEvent.setup();
    const triggers = screen.getAllByRole("button").filter((b) => b.querySelector("svg"));
    await user.click(triggers[0]!);
    const menuItem = await screen.findByRole("menuitem", { name: /publish to x/i });
    await user.click(menuItem);
    const dialog = await screen.findByRole("dialog");
    const publishButton = within(dialog).getByRole("button", {
      name: /^publish$/i,
    }) as HTMLButtonElement;

    act(() => {
      publishButton.click();
      publishButton.click();
    });

    expect(publishTwitterMutate).toHaveBeenCalledTimes(1);
  });
});
