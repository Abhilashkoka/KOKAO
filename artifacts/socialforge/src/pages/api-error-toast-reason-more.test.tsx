import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Regression guard (companion to api-error-toast-reason.test.tsx): the
 * library, schedule, pending-posts warning, and admin tenants surfaces were
 * also switched to the shared `apiErrorMessage` helper. These tests pin that
 * their failure toasts show the REAL server reason from `error.data.error`,
 * never the generic "Please try again." fallback and never an axios-style
 * `err.response.data.error` decoy.
 */

const SERVER_REASON = "Seat limit reached";
const DECOY = "WRONG: read from err.response.data";

/** ApiError-shaped error: real body on `.data`, decoy on `.response.data`. */
function apiError(message: string = SERVER_REASON) {
  return Object.assign(new Error("HTTP 400"), {
    name: "ApiError",
    status: 400,
    data: { error: message },
    response: { status: 400, data: { error: DECOY } },
  });
}

/** Mutation stub whose mutate() immediately fails with an ApiError. */
function failingMutation(err: unknown = apiError()) {
  return {
    mutate: vi.fn((_vars: unknown, opts?: { onError?: (e: unknown) => void }) =>
      opts?.onError?.(err),
    ),
    mutateAsync: vi.fn().mockRejectedValue(err),
    isPending: false,
    isError: false,
    isSuccess: false,
    data: undefined,
    error: null,
    reset: vi.fn(),
  };
}

const toastSpy = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy }),
}));

const mockState: {
  publishFacebook: ReturnType<typeof failingMutation>;
  retrySchedule: ReturnType<typeof failingMutation>;
  resendLinkedin: ReturnType<typeof failingMutation>;
  decideSeatRequest: ReturnType<typeof failingMutation>;
} = {
  publishFacebook: failingMutation(),
  retrySchedule: failingMutation(),
  resendLinkedin: failingMutation(),
  decideSeatRequest: failingMutation(),
};

// One failed Facebook post, shared by the library card and the schedule row.
const failedItem = {
  id: 7,
  title: "Failed Facebook post",
  caption: "FB caption",
  imagePath: null,
  platform: "facebook",
  status: "failed",
  failureReason: "Facebook rejected the post",
  permalink: null,
};

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  return createApiClientMock({
    // Synchronous passthrough for the one-shot restart-retry layer: the
    // mutation fails immediately and is reported as a non-retried error, so
    // the page's onError path (the apiErrorMessage call) runs directly.
    useRestartRetry: () => ({
      isRetrying: false,
      run: (
        m: { mutate: (v: unknown, o?: unknown) => void },
        vars: unknown,
        cbs: {
          onSuccess?: (r: unknown) => void;
          onError?: (e: unknown, i: { retried: boolean }) => void;
        },
      ) =>
        m.mutate(vars, {
          onSuccess: cbs.onSuccess,
          onError: (e: unknown) => cbs.onError?.(e, { retried: false }),
        }),
    }),
    // Library + schedule data.
    useListContent: () => ({ data: [failedItem], isLoading: false }),
    useListSchedules: () => ({
      data: [
        {
          id: 31,
          contentItemId: failedItem.id,
          platform: "facebook",
          scheduledAt: new Date("2026-08-01T12:00:00Z").toISOString(),
          status: "failed",
          failureReason: "Facebook rejected the post",
          retryCount: 0,
        },
      ],
      isLoading: false,
    }),
    // Facebook connected so the Retry buttons are enabled.
    useGetFacebookCredentials: () => ({
      data: { platform: "facebook", verifyStatus: "verified", pageId: "123" },
      isLoading: false,
    }),
    usePublishContentToFacebook: () => mockState.publishFacebook,
    useRetrySchedule: () => mockState.retrySchedule,
    useResendLinkedinComments: () => mockState.resendLinkedin,
    // Admin tenants tab: one pending seat request so Approve renders.
    useGetMe: () => ({ data: { isOwner: true }, isLoading: false }),
    useAdminListTenants: () => ({ data: [], isLoading: false }),
    useAdminListSeatRequests: () => ({
      data: [
        {
          id: 5,
          tenantName: "Acme",
          tenantEmail: "owner@acme.test",
          tenantPlan: "pro",
          requestedSeats: 4,
          currentSeatLimit: 2,
          seatsUsed: 2,
          note: null,
          status: "pending",
          grantedSeats: null,
        },
      ],
      isLoading: false,
    }),
    useAdminDecideSeatRequest: () => mockState.decideSeatRequest,
  });
});

// Imported after the mock so the mocked module is picked up.
import { LibraryPage } from "./library";
import { SchedulePage } from "./schedule";
import { PendingPostsWarnings } from "../components/pending-posts-warning";
import { TenantsTab } from "./admin/tenants-tab";

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

/** The description of the last destructive toast fired. */
function lastErrorToast() {
  const calls = toastSpy.mock.calls.filter(
    ([arg]) => arg?.variant === "destructive",
  );
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][0] as { title?: string; description?: string };
}

function expectRealReason() {
  const t = lastErrorToast();
  expect(t.description).toContain(SERVER_REASON);
  expect(t.description).not.toContain("Please try again");
  expect(t.description).not.toContain(DECOY);
}

beforeEach(() => {
  toastSpy.mockClear();
  mockState.publishFacebook = failingMutation();
  mockState.retrySchedule = failingMutation();
  mockState.resendLinkedin = failingMutation();
  mockState.decideSeatRequest = failingMutation();
});

afterEach(() => cleanup());

describe("more error toasts show the real server reason (apiErrorMessage regression)", () => {
  it("library: failed publish retry shows the server reason", () => {
    renderWithClient(<LibraryPage />);

    fireEvent.click(screen.getByRole("button", { name: /^Retry$/ }));

    expect(mockState.publishFacebook.mutate).toHaveBeenCalled();
    const t = lastErrorToast();
    expect(t.title).toBe("Retry failed");
    expectRealReason();
  });

  it("schedule: failed schedule retry shows the server reason", () => {
    renderWithClient(<SchedulePage />);

    fireEvent.click(screen.getByTestId("button-retry-schedule-31"));

    expect(mockState.retrySchedule.mutate).toHaveBeenCalled();
    const t = lastErrorToast();
    expect(t.title).toBe("Retry failed");
    expectRealReason();
  });

  it("pending-posts warning: failed resend shows the server reason", () => {
    renderWithClient(
      <PendingPostsWarnings
        item={{ id: 7, linkedinCommentsPending: 2 }}
      />,
    );

    fireEvent.click(screen.getByTestId("button-resend-linkedin-comments-7"));

    expect(mockState.resendLinkedin.mutate).toHaveBeenCalled();
    const t = lastErrorToast();
    expect(t.title).toBe("Resend failed");
    expectRealReason();
  });

  it("admin tenants tab: failed seat-request decision shows the server reason", () => {
    renderWithClient(<TenantsTab />);

    fireEvent.click(screen.getByRole("button", { name: /^Approve$/ }));

    expect(mockState.decideSeatRequest.mutate).toHaveBeenCalled();
    const t = lastErrorToast();
    expect(t.title).toBe("Could not save decision");
    expectRealReason();
  });
});
