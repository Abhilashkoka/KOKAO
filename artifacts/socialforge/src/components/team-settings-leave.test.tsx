import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Leaving a workspace on web must land the member cleanly in their own
 * fresh personal workspace: the leave handler must clear the WHOLE query
 * cache (so no content/brand-kit/account data from the old workspace
 * lingers) and then do a full reload to the app base path.
 */

const mockState: {
  leaveMutate: ReturnType<typeof vi.fn>;
} = {
  leaveMutate: vi.fn(),
};

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock, idleMutation } = await import(
    "../test/apiClientMock"
  );
  return createApiClientMock({
    useGetMe: () => ({
      data: {
        team: { workspaceName: "Acme Workspace", invitedByEmail: null },
      },
      isLoading: false,
    }),
    useGetTeam: () => ({
      data: {
        enabled: false,
        role: "member",
        seatsUsed: 2,
        seatLimit: 3,
        members: [],
        invites: [],
        seatRequests: [],
      },
      isLoading: false,
    }),
    useLeaveTeam: () => ({
      ...idleMutation(),
      mutate: mockState.leaveMutate,
    }),
  });
});

import { TeamSettings } from "./team-settings";

describe("TeamSettings leave-workspace flow", () => {
  let assignSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockState.leaveMutate = vi.fn();
    assignSpy = vi.fn();
    Object.defineProperty(window, "location", {
      value: { ...window.location, assign: assignSpy },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  function renderWithClient() {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const clearSpy = vi.spyOn(client, "clear");
    render(
      <QueryClientProvider client={client}>
        <TeamSettings />
      </QueryClientProvider>,
    );
    return { client, clearSpy };
  }

  it("on confirmed leave, clears the entire query cache and reloads to the base path", () => {
    const { clearSpy } = renderWithClient();

    fireEvent.click(screen.getByRole("button", { name: /leave this workspace/i }));
    fireEvent.click(screen.getByRole("button", { name: /^leave$/i }));

    expect(mockState.leaveMutate).toHaveBeenCalledTimes(1);

    // Simulate the server confirming the leave.
    const opts = mockState.leaveMutate.mock.calls[0][1] as {
      onSuccess: () => void;
    };
    opts.onSuccess();

    // The whole cache is dropped immediately (not just team queries),
    // so no old-workspace data can render while the reload is pending.
    expect(clearSpy).toHaveBeenCalledTimes(1);

    // Full reload to the artifact base path (not a hardcoded "/").
    expect(assignSpy).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(assignSpy).toHaveBeenCalledTimes(1);
    expect(assignSpy).toHaveBeenCalledWith(import.meta.env.BASE_URL);
  });

  it("on leave failure, stays put without clearing the cache or reloading", () => {
    const { clearSpy } = renderWithClient();

    fireEvent.click(screen.getByRole("button", { name: /leave this workspace/i }));
    fireEvent.click(screen.getByRole("button", { name: /^leave$/i }));

    const opts = mockState.leaveMutate.mock.calls[0][1] as {
      onError: (err: unknown) => void;
    };
    opts.onError(new Error("boom"));

    vi.runAllTimers();
    expect(clearSpy).not.toHaveBeenCalled();
    expect(assignSpy).not.toHaveBeenCalled();
  });
});
