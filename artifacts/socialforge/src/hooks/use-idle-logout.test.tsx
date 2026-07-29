/**
 * Inactivity auto-logout: the warning countdown, the "stay signed in" reset,
 * the actual sign-out at the full timeout, and the disabled no-op.
 *
 * Time is driven by fake timers so the 1s idle clock and the countdown are
 * deterministic. `Date.now()` is advanced together with the timers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import type { SessionTimeoutSettingsView } from "@workspace/api-client-react";

const mockState: {
  settings: SessionTimeoutSettingsView | undefined;
  isSignedIn: boolean;
} = {
  settings: { enabled: true, timeoutMinutes: 5, warningSeconds: 60 },
  isSignedIn: true,
};

const signOut = vi.fn();

vi.mock("@clerk/react", () => ({
  useAuth: () => ({
    isLoaded: true,
    isSignedIn: mockState.isSignedIn,
    signOut,
  }),
}));

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  return createApiClientMock({
    useSessionTimeoutGetSettings: () => ({
      data: mockState.settings,
      isLoading: false,
    }),
  });
});

import { IdleLogoutWarning, LAST_ACTIVITY_KEY, INACTIVITY_SIGNOUT_FLAG } from "./use-idle-logout";

// Fake "now" that the timers advance in lockstep with.
let fakeNow = 0;

function advance(ms: number) {
  act(() => {
    fakeNow += ms;
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  cleanup();
  signOut.mockClear();
  localStorage.clear();
  sessionStorage.clear();
  mockState.settings = { enabled: true, timeoutMinutes: 5, warningSeconds: 60 };
  mockState.isSignedIn = true;
  fakeNow = 1_000_000;
  vi.useFakeTimers();
  vi.setSystemTime(fakeNow);
  // Keep Date.now aligned with the fake clock as we advance it.
  vi.spyOn(Date, "now").mockImplementation(() => fakeNow);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useIdleLogout warning", () => {
  it("shows the warning and ticks the countdown once idle passes the threshold", () => {
    render(<IdleLogoutWarning />);
    // timeout 5min = 300s, warning 60s -> warn at 240s idle.
    expect(screen.queryByTestId("idle-logout-warning")).toBeNull();

    // Just before the warning threshold: still hidden.
    advance(239_000);
    expect(screen.queryByTestId("idle-logout-warning")).toBeNull();

    // Cross the threshold.
    advance(1_000); // 240s idle
    expect(screen.getByTestId("idle-logout-warning")).toBeTruthy();
    expect(screen.getByTestId("idle-countdown").textContent).toBe("60");

    // Countdown decreases as idle grows.
    advance(1_000); // 241s idle -> 59s remaining
    expect(screen.getByTestId("idle-countdown").textContent).toBe("59");
  });

  it("'Stay signed in' resets activity and hides the dialog", () => {
    render(<IdleLogoutWarning />);
    advance(241_000);
    expect(screen.getByTestId("idle-logout-warning")).toBeTruthy();

    act(() => {
      screen.getByTestId("button-stay-signed-in").click();
    });
    expect(screen.queryByTestId("idle-logout-warning")).toBeNull();
    // Activity timestamp was refreshed to now.
    expect(Number(localStorage.getItem(LAST_ACTIVITY_KEY))).toBe(fakeNow);

    // A tick right after: still hidden because idle reset.
    advance(1_000);
    expect(screen.queryByTestId("idle-logout-warning")).toBeNull();
    expect(signOut).not.toHaveBeenCalled();
  });

  it("signs out at the full timeout and flags the reason", () => {
    render(<IdleLogoutWarning />);
    advance(299_000);
    expect(signOut).not.toHaveBeenCalled();

    advance(1_000); // 300s idle -> full timeout
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(INACTIVITY_SIGNOUT_FLAG)).toBe("1");
    // Warning is dismissed on sign-out.
    expect(screen.queryByTestId("idle-logout-warning")).toBeNull();

    // Latched: further ticks don't call signOut again.
    advance(5_000);
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the feature is disabled", () => {
    mockState.settings = { enabled: false, timeoutMinutes: 5, warningSeconds: 60 };
    render(<IdleLogoutWarning />);
    advance(600_000);
    expect(screen.queryByTestId("idle-logout-warning")).toBeNull();
    expect(signOut).not.toHaveBeenCalled();
  });

  it("does nothing while signed out", () => {
    mockState.isSignedIn = false;
    render(<IdleLogoutWarning />);
    advance(600_000);
    expect(screen.queryByTestId("idle-logout-warning")).toBeNull();
    expect(signOut).not.toHaveBeenCalled();
  });

  it("adopts new thresholds delivered by a refetch without a remount", () => {
    // Start with the 5min/60s default: warn at 240s idle.
    const { rerender } = render(<IdleLogoutWarning />);
    advance(239_000);
    expect(screen.queryByTestId("idle-logout-warning")).toBeNull();

    // An admin shortens the timeout; the background refetch delivers it.
    // Simulate that by swapping the mock's returned data and rerendering the
    // SAME tree (no unmount) — the hook's effects re-read the new thresholds.
    mockState.settings = { enabled: true, timeoutMinutes: 5, warningSeconds: 120 };
    rerender(<IdleLogoutWarning />);

    // Warning window is now 120s, so at 239s idle (< 300s timeout) the warning
    // is already showing even though nothing was remounted.
    expect(screen.getByTestId("idle-logout-warning")).toBeTruthy();
    // 300s - 239s = 61s remaining.
    expect(screen.getByTestId("idle-countdown").textContent).toBe("61");
  });
});
