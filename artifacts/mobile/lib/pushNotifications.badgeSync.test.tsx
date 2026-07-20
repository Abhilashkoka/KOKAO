// @vitest-environment jsdom
import React from "react";
import { render, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let isSignedIn = true;
vi.mock("@clerk/expo", () => ({ useAuth: () => ({ isSignedIn, userId: "u1" }) }));
vi.mock("expo-router", () => ({ router: { push: vi.fn() } }));

let appStateListener: ((state: string) => void) | null = null;
const removeMock = vi.fn();
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  AppState: {
    addEventListener: (_event: string, cb: (state: string) => void) => {
      appStateListener = cb;
      return { remove: removeMock };
    },
  },
}));

const listNotificationsMock = vi.fn();
vi.mock("@workspace/api-client-react", () => ({
  useListFeatureFlags: () => ({ data: undefined }),
  getListFeatureFlagsQueryKey: () => ["feature-flags"],
  useRegisterPushToken: () => ({ mutateAsync: vi.fn() }),
  listNotifications: (...a: unknown[]) => listNotificationsMock(...a),
}));

const setBadgeCountMock = vi.fn(async (_n: number) => true);
vi.mock("expo-notifications", () => ({
  setBadgeCountAsync: (n: number) => setBadgeCountMock(n),
}));

import { useForegroundBadgeSync } from "./pushNotifications";

function Harness() {
  useForegroundBadgeSync();
  return null;
}

describe("useForegroundBadgeSync", () => {
  beforeEach(() => {
    isSignedIn = true;
    appStateListener = null;
    listNotificationsMock.mockReset();
    setBadgeCountMock.mockClear();
    removeMock.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it("syncs the badge to the unread count on mount", async () => {
    listNotificationsMock.mockResolvedValue([{ id: 1 }, { id: 2 }]);
    render(<Harness />);
    await waitFor(() => expect(setBadgeCountMock).toHaveBeenCalledWith(2));
    expect(listNotificationsMock).toHaveBeenCalledTimes(1);
  });

  it("clears the badge when everything was read elsewhere and the app foregrounds", async () => {
    listNotificationsMock.mockResolvedValue([{ id: 1 }]);
    render(<Harness />);
    await waitFor(() => expect(setBadgeCountMock).toHaveBeenCalledWith(1));

    listNotificationsMock.mockResolvedValue([]);
    appStateListener!("active");
    await waitFor(() => expect(setBadgeCountMock).toHaveBeenCalledWith(0));
    expect(listNotificationsMock).toHaveBeenCalledTimes(2);
  });

  it("ignores non-active app-state transitions", async () => {
    listNotificationsMock.mockResolvedValue([]);
    render(<Harness />);
    await waitFor(() => expect(setBadgeCountMock).toHaveBeenCalledTimes(1));

    appStateListener!("background");
    appStateListener!("inactive");
    await new Promise((r) => setTimeout(r, 10));
    expect(listNotificationsMock).toHaveBeenCalledTimes(1);
  });

  it("leaves the badge untouched when the fetch fails", async () => {
    listNotificationsMock.mockRejectedValue(new Error("network"));
    render(<Harness />);
    await waitFor(() => expect(listNotificationsMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));
    expect(setBadgeCountMock).not.toHaveBeenCalled();
  });

  it("does nothing while signed out and removes the listener on unmount", async () => {
    isSignedIn = false;
    const view = render(<Harness />);
    await new Promise((r) => setTimeout(r, 10));
    expect(listNotificationsMock).not.toHaveBeenCalled();
    expect(appStateListener).toBeNull();
    view.unmount();

    isSignedIn = true;
    const second = render(<Harness />);
    listNotificationsMock.mockResolvedValue([]);
    await waitFor(() => expect(appStateListener).toBeTruthy());
    second.unmount();
    expect(removeMock).toHaveBeenCalled();
  });
});
