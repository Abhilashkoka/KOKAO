// @vitest-environment jsdom
import React from "react";
import { render, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pushMock = vi.fn();
vi.mock("expo-router", () => ({ router: { push: (...a: unknown[]) => pushMock(...a) } }));
vi.mock("@clerk/expo", () => ({ useAuth: () => ({ isSignedIn: true, userId: "u1" }) }));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("@workspace/api-client-react", () => ({
  useListFeatureFlags: () => ({ data: undefined }),
  getListFeatureFlagsQueryKey: () => ["feature-flags"],
  useRegisterPushToken: () => ({ mutateAsync: vi.fn() }),
}));

let responseListener: ((r: unknown) => void) | null = null;
const removeMock = vi.fn();
let lastResponse: unknown = null;
const clearMock = vi.fn(async () => {
  lastResponse = null;
});

vi.mock("expo-notifications", () => ({
  addNotificationResponseReceivedListener: (cb: (r: unknown) => void) => {
    responseListener = cb;
    return { remove: removeMock };
  },
  getLastNotificationResponseAsync: async () => lastResponse,
  clearLastNotificationResponseAsync: clearMock,
}));

import { useNotificationTapNavigation } from "./pushNotifications";

function Harness() {
  useNotificationTapNavigation();
  return null;
}

function makeResponse(id: string, date: number, data: Record<string, unknown>) {
  return {
    notification: {
      date,
      request: { identifier: id, content: { data } },
    },
  };
}

describe("useNotificationTapNavigation", () => {
  beforeEach(() => {
    pushMock.mockClear();
    clearMock.mockClear();
    removeMock.mockClear();
    responseListener = null;
    lastResponse = null;
  });

  afterEach(() => {
    cleanup();
  });

  it("navigates on a warm tap via the response listener", async () => {
    render(<Harness />);
    await waitFor(() => expect(responseListener).toBeTruthy());
    responseListener!(makeResponse("n1", 100, { url: "/library", type: "scheduled_publish_failed" }));
    expect(pushMock).toHaveBeenCalledWith("/(tabs)/library");
  });

  it("navigates on cold start from the stored last response and clears it", async () => {
    lastResponse = makeResponse("n2", 200, { url: "/accounts", type: "social_connection_failed" });
    render(<Harness />);
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/(tabs)/accounts"));
    expect(clearMock).toHaveBeenCalled();
  });

  it("does not replay an already-handled cold-start response after remount", async () => {
    lastResponse = makeResponse("n3", 300, { url: "/library", type: "scheduled_post_published" });
    const first = render(<Harness />);
    await waitFor(() => expect(pushMock).toHaveBeenCalledTimes(1));
    first.unmount();

    // The clear API wiped the stored response, so a fresh mount (normal
    // launch without a tap) must not navigate.
    render(<Harness />);
    await waitFor(() => expect(responseListener).toBeTruthy());
    await new Promise((r) => setTimeout(r, 10));
    expect(pushMock).toHaveBeenCalledTimes(1);
  });

  it("does not navigate on a normal launch with no stored response", async () => {
    render(<Harness />);
    await waitFor(() => expect(responseListener).toBeTruthy());
    await new Promise((r) => setTimeout(r, 10));
    expect(pushMock).not.toHaveBeenCalled();
  });
});
