import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Guard: a 409 from a resend endpoint means "a resend is already running" —
 * it must surface as a neutral informational toast, not a destructive
 * "Resend failed" one. Other errors keep the destructive failure toast, and
 * the resend button stays disabled while a request is in flight.
 */

const toastFn = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastFn }),
}));

const linkedinMutate = vi.hoisted(() => vi.fn());
const threadsMutate = vi.hoisted(() => vi.fn());
const twitterMutate = vi.hoisted(() => vi.fn());

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock, idleMutation } = await import("../test/apiClientMock");
  return createApiClientMock({
    useResendLinkedinComments: () => ({ ...idleMutation(), mutate: linkedinMutate }),
    useResendThreadsPosts: () => ({ ...idleMutation(), mutate: threadsMutate }),
    useResendTwitterPosts: () => ({ ...idleMutation(), mutate: twitterMutate }),
  });
});

import { PendingPostsWarnings } from "./pending-posts-warning";

function renderWarnings(item: {
  id: number;
  linkedinCommentsPending?: number;
  threadsPostsPending?: number;
  twitterPostsPending?: number;
}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <PendingPostsWarnings item={item} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  cleanup();
  toastFn.mockClear();
  linkedinMutate.mockReset();
  threadsMutate.mockReset();
  twitterMutate.mockReset();
});

describe("PendingPostsWarnings resend 409 handling", () => {
  it("shows a neutral 'already in progress' toast on 409 (LinkedIn)", () => {
    linkedinMutate.mockImplementation((_vars: any, cbs: any) => {
      cbs?.onError?.({
        status: 409,
        data: { error: "A resend for this post is already in progress." },
      });
      cbs?.onSettled?.();
    });
    renderWarnings({ id: 1, linkedinCommentsPending: 2 });
    fireEvent.click(screen.getByTestId("button-resend-linkedin-comments-1"));
    expect(toastFn).toHaveBeenCalledTimes(1);
    const call = toastFn.mock.calls[0][0];
    expect(call.title).toBe("Resend already in progress");
    expect(call.variant).toBeUndefined();
    expect(call.description).toMatch(/already in progress/i);
  });

  it("shows a neutral 'already in progress' toast on 409 (Threads and X)", () => {
    const conflict = (_vars: any, cbs: any) => {
      cbs?.onError?.({ status: 409, data: { error: "Already running." } });
      cbs?.onSettled?.();
    };
    threadsMutate.mockImplementation(conflict);
    twitterMutate.mockImplementation(conflict);
    renderWarnings({ id: 2, threadsPostsPending: 1, twitterPostsPending: 1 });
    fireEvent.click(screen.getByTestId("button-resend-threads-posts-2"));
    fireEvent.click(screen.getByTestId("button-resend-twitter-posts-2"));
    expect(toastFn).toHaveBeenCalledTimes(2);
    for (const [call] of toastFn.mock.calls) {
      expect(call.title).toBe("Resend already in progress");
      expect(call.variant).toBeUndefined();
    }
  });

  it("keeps the destructive failure toast for non-409 errors", () => {
    linkedinMutate.mockImplementation((_vars: any, cbs: any) => {
      cbs?.onError?.({ status: 500, data: { error: "LinkedIn is down." } });
      cbs?.onSettled?.();
    });
    renderWarnings({ id: 3, linkedinCommentsPending: 1 });
    fireEvent.click(screen.getByTestId("button-resend-linkedin-comments-3"));
    expect(toastFn).toHaveBeenCalledTimes(1);
    const call = toastFn.mock.calls[0][0];
    expect(call.title).toBe("Resend failed");
    expect(call.variant).toBe("destructive");
    expect(call.description).toBe("LinkedIn is down.");
  });

  it("disables the resend button while a resend is in flight", () => {
    // Never settle: simulates an in-flight request.
    linkedinMutate.mockImplementation(() => {});
    renderWarnings({ id: 4, linkedinCommentsPending: 1 });
    const button = screen.getByTestId(
      "button-resend-linkedin-comments-4",
    ) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(button.disabled).toBe(true);
    expect(button.textContent).toMatch(/Resending/);
  });
});
