import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Regression guard: error toasts must surface the REAL server reason.
 *
 * The shared API client throws `ApiError`, which exposes the parsed JSON body
 * on `error.data` — its `error.response` is a raw fetch Response with no
 * usable `.data`. These pages were switched to the shared `apiErrorMessage`
 * helper so the toast shows e.g. "Seat limit reached" instead of the generic
 * "Please try again." fallback.
 *
 * Each error object below carries a DECOY at `error.response.data.error`: if a
 * future refactor goes back to axios-style `err.response.data.error` reads,
 * the toast would show the decoy (or the generic fallback) and these tests
 * fail.
 */

const SERVER_REASON = "Seat limit reached";
const DECOY = "WRONG: read from err.response.data";

/** ApiError-shaped error: real body on `.data`, decoy on `.response.data`. */
function apiError(message: string = SERVER_REASON) {
  return Object.assign(new Error("HTTP 400"), {
    name: "ApiError",
    status: 400,
    data: { error: message },
    // Decoy: real fetch Responses have no `.data`; if code reads it anyway,
    // the assertion on the toast description catches it.
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
  createInvite: ReturnType<typeof failingMutation>;
  sendTestEmail: ReturnType<typeof failingMutation>;
  retestFacebook: ReturnType<typeof failingMutation>;
} = {
  createInvite: failingMutation(),
  sendTestEmail: failingMutation(),
  retestFacebook: failingMutation(),
};

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  return createApiClientMock({
    // Team settings (owner with the team add-on enabled → invite UI renders).
    useGetMe: () => ({
      data: { team: { workspaceName: "Acme", invitedByEmail: null } },
      isLoading: false,
    }),
    useGetTeam: () => ({
      data: {
        enabled: true,
        role: "owner",
        seatsUsed: 1,
        seatLimit: 5,
        members: [],
        invites: [],
        seatRequests: [],
      },
      isLoading: false,
    }),
    useCreateTeamInvite: () => mockState.createInvite,
    // Admin notifications tab.
    useAdminGetEmailSettings: () => ({
      data: {
        sendingEnabled: false,
        fromEmail: "noreply@example.com",
        hasApiKey: true,
        testStatus: null,
        testedAt: null,
        testError: null,
      },
      isLoading: false,
    }),
    useAdminSendTestEmail: () => mockState.sendTestEmail,
    // Accounts page: a saved Facebook connection so "Re-test now" renders.
    useGetFacebookCredentials: () => ({
      data: {
        platform: "facebook",
        appConfigured: true,
        saved: true,
        verifyStatus: "verified",
        pageId: "123",
      },
      isLoading: false,
    }),
    useRetestFacebookCredentials: () => mockState.retestFacebook,
    useListAccounts: () => ({ data: [], isLoading: false }),
    useListAdConnections: () => ({ data: [], isLoading: false }),
  });
});

// Imported after the mock so the mocked module is picked up.
import { TeamSettings } from "../components/team-settings";
import { NotificationsTab } from "./admin/notifications-tab";
import { AccountsPage } from "./accounts";

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
  expect(t.description).toBe(SERVER_REASON);
  expect(t.description).not.toContain("Please try again");
  expect(t.description).not.toBe(DECOY);
}

beforeEach(() => {
  toastSpy.mockClear();
  mockState.createInvite = failingMutation();
  mockState.sendTestEmail = failingMutation();
  mockState.retestFacebook = failingMutation();
});

afterEach(() => cleanup());

describe("error toasts show the real server reason (apiErrorMessage regression)", () => {
  it("team settings: failed invite shows the server reason, not the generic fallback", () => {
    renderWithClient(<TeamSettings />);

    fireEvent.change(screen.getByPlaceholderText("teammate@example.com"), {
      target: { value: "new@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Invite$/ }));

    expect(mockState.createInvite.mutate).toHaveBeenCalled();
    expectRealReason();
  });

  it("admin notifications tab: failed test email shows the server reason", () => {
    renderWithClient(<NotificationsTab />);

    fireEvent.change(screen.getByPlaceholderText("you@example.com"), {
      target: { value: "admin@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Send test email/i }));

    expect(mockState.sendTestEmail.mutate).toHaveBeenCalled();
    expectRealReason();
  });

  it("accounts page: failed Facebook re-test shows the server reason", () => {
    renderWithClient(<AccountsPage />);

    fireEvent.click(screen.getByRole("button", { name: /Re-test now/i }));

    expect(mockState.retestFacebook.mutate).toHaveBeenCalled();
    expectRealReason();
  });

  it("apiErrorMessage itself never reads err.response.data (decoy check)", async () => {
    const { apiErrorMessage } = await import("../lib/apiErrorMessage");
    const err = apiError();
    expect(apiErrorMessage(err, "Please try again.")).toBe(SERVER_REASON);
    // An error with ONLY the axios-style shape must fall back — proving the
    // helper does not read err.response.data.
    const axiosShaped = { response: { data: { error: DECOY } } };
    expect(apiErrorMessage(axiosShaped, "Please try again.")).toBe(
      "Please try again.",
    );
  });
});
