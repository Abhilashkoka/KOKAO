import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Regression guard for the publish-button lock during the automatic
 * one-shot restart retry.
 *
 * useRestartRetry is unit-tested at the lib level, but that does not prove
 * the Library page actually feeds its `isRetrying` flag into the publish
 * buttons' `disabled` prop. During the retry window the underlying mutation
 * is NOT pending (the first attempt already settled), so a page gating only
 * on `isPending` would re-enable the button and let a double-click race the
 * scheduled retry. This test uses the REAL useRestartRetry (only the
 * generated hooks are mocked) and asserts the on-screen button stays
 * disabled through the whole retry window and re-enables after it settles.
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
  // Pull the REAL retry hook (and its timing constant) so the test exercises
  // the actual isRetrying wiring instead of a hand-rolled stub.
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
          title: "Locked while retrying",
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
import { RESTART_RETRY_DELAY_MS } from "@workspace/api-client-react";

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

async function openPublishToXDialog() {
  const user = userEvent.setup();
  const triggers = screen.getAllByRole("button").filter((b) => b.querySelector("svg"));
  await user.click(triggers[0]!);
  const menuItem = await screen.findByRole("menuitem", { name: /publish to x/i });
  await user.click(menuItem);
  return screen.findByRole("dialog");
}

type MutateCallbacks = {
  onSuccess?: (res: unknown) => void;
  onError?: (err: unknown) => void;
};

const restartError = () => ({
  status: 503,
  data: { error: "Server is restarting, please retry shortly" },
});

beforeEach(() => {
  cleanup();
  publishTwitterMutate.mockReset();
  publishInstagramMutate.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Library publish button lock during automatic restart retry", () => {
  it("keeps the Publish button disabled through the retry window and re-enables it when the retry settles", async () => {
    renderPage();
    const dialog = await openPublishToXDialog();
    const publishButton = within(dialog).getByRole("button", { name: /^publish$/i });
    expect((publishButton as HTMLButtonElement).disabled).toBe(false);

    // Fake timers from here on so we control the retry delay exactly.
    vi.useFakeTimers();
    fireEvent.click(publishButton);
    expect(publishTwitterMutate).toHaveBeenCalledTimes(1);

    // First attempt fails with the restart 503 → the hook schedules the
    // one-shot retry. The mutation is no longer pending at this point, so
    // only the isRetrying wiring can keep the button locked.
    const firstCallbacks = publishTwitterMutate.mock.calls[0][1] as MutateCallbacks;
    act(() => {
      firstCallbacks.onError?.(restartError());
    });

    const retryingButton = within(dialog).getByRole("button", { name: /retrying/i });
    expect((retryingButton as HTMLButtonElement).disabled).toBe(true);

    // A double-click during the window must not fire another publish.
    fireEvent.click(retryingButton);
    expect(publishTwitterMutate).toHaveBeenCalledTimes(1);

    // Still locked just before the retry fires.
    act(() => {
      vi.advanceTimersByTime(RESTART_RETRY_DELAY_MS - 1);
    });
    expect(
      (within(dialog).getByRole("button", { name: /retrying/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(publishTwitterMutate).toHaveBeenCalledTimes(1);

    // The scheduled retry fires exactly once after the delay.
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(publishTwitterMutate).toHaveBeenCalledTimes(2);

    // Retry settles (with a terminal, non-transient error so the dialog
    // stays open) → the button unlocks and reads "Publish" again.
    const retryCallbacks = publishTwitterMutate.mock.calls[1][1] as MutateCallbacks;
    act(() => {
      retryCallbacks.onError?.(Object.assign(new Error("boom"), { status: 500 }));
    });

    const revived = within(dialog).getByRole("button", { name: /^publish$/i });
    expect((revived as HTMLButtonElement).disabled).toBe(false);
  });

  it("unlocks the button when the automatic retry succeeds (dialog closes)", async () => {
    renderPage();
    const dialog = await openPublishToXDialog();
    vi.useFakeTimers();
    fireEvent.click(within(dialog).getByRole("button", { name: /^publish$/i }));

    const firstCallbacks = publishTwitterMutate.mock.calls[0][1] as MutateCallbacks;
    act(() => {
      firstCallbacks.onError?.(restartError());
    });
    expect(
      (within(dialog).getByRole("button", { name: /retrying/i }) as HTMLButtonElement).disabled,
    ).toBe(true);

    act(() => {
      vi.advanceTimersByTime(RESTART_RETRY_DELAY_MS);
    });
    expect(publishTwitterMutate).toHaveBeenCalledTimes(2);
    const retryCallbacks = publishTwitterMutate.mock.calls[1][1] as MutateCallbacks;
    act(() => {
      retryCallbacks.onSuccess?.({ permalink: null });
    });

    // Success closes the publish dialog — nothing is left locked.
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("Failed-state Instagram Retry button lock during automatic restart retry", () => {
  it("ignores clicks through the whole retry window and re-enables after the retry fails terminally", async () => {
    renderPage();
    const retryButton = (await screen.findByRole("button", {
      name: /^retry$/i,
    })) as HTMLButtonElement;
    expect(retryButton.disabled).toBe(false);

    vi.useFakeTimers();
    fireEvent.click(retryButton);
    expect(publishInstagramMutate).toHaveBeenCalledTimes(1);

    // Locked immediately by retryingId, even before any error arrives.
    const lockedNow = screen.getByRole("button", { name: /retrying/i }) as HTMLButtonElement;
    expect(lockedNow.disabled).toBe(true);
    fireEvent.click(lockedNow);
    expect(publishInstagramMutate).toHaveBeenCalledTimes(1);

    // First attempt fails with the restart 503 → useRestartRetry schedules
    // the one-shot retry. The mutation is not pending in this window, so
    // only the retryingId lock keeps the control inert.
    const firstCallbacks = publishInstagramMutate.mock.calls[0][1] as MutateCallbacks;
    act(() => {
      firstCallbacks.onError?.(restartError());
    });

    const retrying = screen.getByRole("button", { name: /retrying/i }) as HTMLButtonElement;
    expect(retrying.disabled).toBe(true);
    fireEvent.click(retrying);
    expect(publishInstagramMutate).toHaveBeenCalledTimes(1);

    // Still locked just before the retry fires.
    act(() => {
      vi.advanceTimersByTime(RESTART_RETRY_DELAY_MS - 1);
    });
    expect(
      (screen.getByRole("button", { name: /retrying/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(publishInstagramMutate).toHaveBeenCalledTimes(1);

    // The scheduled retry fires exactly once after the delay.
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(publishInstagramMutate).toHaveBeenCalledTimes(2);

    // Retry settles with a terminal error → retryingId clears and the
    // control reads "Retry" and is clickable again.
    const retryCallbacks = publishInstagramMutate.mock.calls[1][1] as MutateCallbacks;
    act(() => {
      retryCallbacks.onError?.(Object.assign(new Error("boom"), { status: 500 }));
    });

    const revived = screen.getByRole("button", { name: /^retry$/i }) as HTMLButtonElement;
    expect(revived.disabled).toBe(false);
  });

  it("re-enables the Retry control after the automatic retry succeeds", async () => {
    renderPage();
    const retryButton = (await screen.findByRole("button", {
      name: /^retry$/i,
    })) as HTMLButtonElement;

    vi.useFakeTimers();
    fireEvent.click(retryButton);
    const firstCallbacks = publishInstagramMutate.mock.calls[0][1] as MutateCallbacks;
    act(() => {
      firstCallbacks.onError?.(restartError());
    });
    expect(
      (screen.getByRole("button", { name: /retrying/i }) as HTMLButtonElement).disabled,
    ).toBe(true);

    act(() => {
      vi.advanceTimersByTime(RESTART_RETRY_DELAY_MS);
    });
    expect(publishInstagramMutate).toHaveBeenCalledTimes(2);
    const retryCallbacks = publishInstagramMutate.mock.calls[1][1] as MutateCallbacks;
    act(() => {
      retryCallbacks.onSuccess?.({});
    });

    const revived = screen.getByRole("button", { name: /^retry$/i }) as HTMLButtonElement;
    expect(revived.disabled).toBe(false);
  });
});
