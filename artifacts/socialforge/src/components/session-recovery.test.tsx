import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SessionRecovery } from "./session-recovery";

const state = vi.hoisted(() => ({ reload: vi.fn() }));
vi.mock("@clerk/react", () => ({
  useClerk: () => ({ session: { reload: state.reload } }),
}));
vi.mock("@/lib/brand", () => ({ useBrand: () => ({ appName: "KOKAO" }) }));

beforeEach(() => {
  vi.clearAllMocks();
  state.reload.mockResolvedValue(undefined);
});
afterEach(cleanup);

describe("session recovery", () => {
  it("explains the rejected session without automatically signing out or retrying", () => {
    const onRetry = vi.fn();
    const onSignOut = vi.fn();
    render(<SessionRecovery onRetry={onRetry} onSignOut={onSignOut} />);
    expect(screen.getByRole("heading", { name: "Reconnect your sign-in" })).toBeTruthy();
    expect(onSignOut).not.toHaveBeenCalled();
    expect(onRetry).not.toHaveBeenCalled();
    expect(state.reload).not.toHaveBeenCalled();
  });

  it("restores Clerk's session before retrying cookie-authenticated API verification", async () => {
    const onRetry = vi.fn().mockResolvedValue(undefined);
    const onSignOut = vi.fn();
    render(<SessionRecovery onRetry={onRetry} onSignOut={onSignOut} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry connection" }));
    await waitFor(() => expect(onRetry).toHaveBeenCalledTimes(1));
    expect(state.reload.mock.invocationCallOrder[0]).toBeLessThan(onRetry.mock.invocationCallOrder[0]);
    expect(onSignOut).not.toHaveBeenCalled();
  });

  it("keeps the session when API verification still fails and permits another retry", async () => {
    const onRetry = vi.fn().mockRejectedValue(new Error("401"));
    const onSignOut = vi.fn();
    render(<SessionRecovery onRetry={onRetry} onSignOut={onSignOut} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry connection" }));
    expect((await screen.findByRole("alert")).textContent).toContain("still cannot be verified");
    expect(onSignOut).not.toHaveBeenCalled();
    onRetry.mockResolvedValue(undefined);
    fireEvent.click(screen.getByRole("button", { name: "Retry connection" }));
    await waitFor(() => expect(onRetry).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("does not retry the API when Clerk cannot restore the session", async () => {
    state.reload.mockRejectedValue(new Error("Network unavailable"));
    const onRetry = vi.fn();
    const onSignOut = vi.fn();
    render(<SessionRecovery onRetry={onRetry} onSignOut={onSignOut} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry connection" }));
    await screen.findByRole("alert");
    expect(onRetry).not.toHaveBeenCalled();
    expect(onSignOut).not.toHaveBeenCalled();
  });

  it("signs out only when the user explicitly chooses to", async () => {
    const onSignOut = vi.fn().mockResolvedValue(undefined);
    render(<SessionRecovery onRetry={vi.fn()} onSignOut={onSignOut} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign out and sign in again" }));
    await waitFor(() => expect(onSignOut).toHaveBeenCalledTimes(1));
  });
});
