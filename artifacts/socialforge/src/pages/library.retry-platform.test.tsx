import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Regression guard: the failed-state Retry button must target the platform
 * the item actually failed on (item.platform), not always Instagram. A
 * failed LinkedIn item retries via the LinkedIn publish endpoint with the
 * correct readiness gating and tooltip, and keeps the same retryingId +
 * useRestartRetry double-click lock proven in library.retry-lock.test.tsx.
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

const publishLinkedinMutate = vi.fn();
const publishInstagramMutate = vi.fn();

const mockState = {
  linkedinConnected: true,
};

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
          id: 21,
          title: "Failed LinkedIn post",
          caption: "LI caption",
          imagePath: null,
          platform: "linkedin",
          status: "failed",
          failureReason: "LinkedIn rejected the post",
          permalink: null,
        },
      ],
      isLoading: false,
    }),
    usePublishContentToLinkedin: () => ({
      mutate: publishLinkedinMutate,
      isPending: false,
    }),
    usePublishContentToInstagram: () => ({
      mutate: publishInstagramMutate,
      isPending: false,
    }),
    useGetLinkedinStatus: () => ({ data: { connected: mockState.linkedinConnected } }),
    useGetInstagramCredentials: () => ({ data: { verifyStatus: "unverified" } }),
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
  publishLinkedinMutate.mockReset();
  publishInstagramMutate.mockReset();
  mockState.linkedinConnected = true;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Failed-state Retry button targets the item's own platform", () => {
  it("retries a failed LinkedIn item via the LinkedIn endpoint, never Instagram, even without an image or IG connection", async () => {
    renderPage();
    const retryButton = (await screen.findByRole("button", {
      name: /^retry$/i,
    })) as HTMLButtonElement;

    // LinkedIn is connected, so the retry is enabled even though Instagram
    // is unverified and the item has no image — LinkedIn needs neither.
    expect(retryButton.disabled).toBe(false);
    expect(retryButton.title).toBe("Retry publishing to LinkedIn");

    fireEvent.click(retryButton);
    expect(publishLinkedinMutate).toHaveBeenCalledTimes(1);
    expect(publishLinkedinMutate.mock.calls[0][0]).toEqual({ id: 21 });
    expect(publishInstagramMutate).not.toHaveBeenCalled();
  });

  it("keeps the double-click lock through the automatic restart-retry window on a LinkedIn retry", async () => {
    renderPage();
    const retryButton = (await screen.findByRole("button", {
      name: /^retry$/i,
    })) as HTMLButtonElement;

    vi.useFakeTimers();
    fireEvent.click(retryButton);
    expect(publishLinkedinMutate).toHaveBeenCalledTimes(1);

    // Locked immediately by retryingId.
    const lockedNow = screen.getByRole("button", { name: /retrying/i }) as HTMLButtonElement;
    expect(lockedNow.disabled).toBe(true);
    fireEvent.click(lockedNow);
    expect(publishLinkedinMutate).toHaveBeenCalledTimes(1);

    // Restart 503 → the one-shot retry is scheduled; still locked.
    const firstCallbacks = publishLinkedinMutate.mock.calls[0][1] as MutateCallbacks;
    act(() => {
      firstCallbacks.onError?.(restartError());
    });
    const retrying = screen.getByRole("button", { name: /retrying/i }) as HTMLButtonElement;
    expect(retrying.disabled).toBe(true);
    fireEvent.click(retrying);
    expect(publishLinkedinMutate).toHaveBeenCalledTimes(1);

    // The scheduled retry fires exactly once, on the LinkedIn endpoint.
    act(() => {
      vi.advanceTimersByTime(RESTART_RETRY_DELAY_MS);
    });
    expect(publishLinkedinMutate).toHaveBeenCalledTimes(2);
    expect(publishInstagramMutate).not.toHaveBeenCalled();

    // Terminal error → control unlocks and reads "Retry" again.
    const retryCallbacks = publishLinkedinMutate.mock.calls[1][1] as MutateCallbacks;
    act(() => {
      retryCallbacks.onError?.(Object.assign(new Error("boom"), { status: 500 }));
    });
    const revived = screen.getByRole("button", { name: /^retry$/i }) as HTMLButtonElement;
    expect(revived.disabled).toBe(false);
  });

  it("disables the retry with a LinkedIn connect hint when LinkedIn is not connected", async () => {
    mockState.linkedinConnected = false;
    renderPage();
    const retryButton = (await screen.findByRole("button", {
      name: /^retry$/i,
    })) as HTMLButtonElement;
    expect(retryButton.disabled).toBe(true);
    expect(retryButton.title).toBe("Connect your LinkedIn account on the Accounts page first.");
  });
});
