import { describe, expect, it, vi } from "vitest";

vi.mock("@clerk/expo", () => ({ useAuth: () => ({ isSignedIn: false }) }));
vi.mock("expo-router", () => ({ router: { push: vi.fn() } }));
vi.mock("@workspace/api-client-react", () => ({
  useListFeatureFlags: () => ({ data: undefined }),
  getListFeatureFlagsQueryKey: () => ["feature-flags"],
  useRegisterPushToken: () => ({ mutateAsync: vi.fn() }),
}));

import { resolveNotificationRoute } from "./pushNotifications";

describe("resolveNotificationRoute", () => {
  it("maps library links to the library tab", () => {
    expect(
      resolveNotificationRoute({ url: "/library", type: "scheduled_publish_failed" }),
    ).toBe("/(tabs)/library");
    expect(
      resolveNotificationRoute({ url: "/library?item=5", type: "scheduled_post_published" }),
    ).toBe("/(tabs)/library");
  });

  it("maps account links to the accounts tab", () => {
    expect(
      resolveNotificationRoute({ url: "/accounts", type: "social_connection_failed" }),
    ).toBe("/(tabs)/accounts");
  });

  it("falls back to the notifications screen for web-only or unknown targets", () => {
    expect(
      resolveNotificationRoute({ url: "/settings", type: "team_member_joined" }),
    ).toBe("/notifications");
    expect(resolveNotificationRoute({ url: "/admin", type: "sweep_stalled" })).toBe(
      "/notifications",
    );
    expect(resolveNotificationRoute({ url: "/ads", type: "ads_change_failed" })).toBe(
      "/notifications",
    );
    expect(resolveNotificationRoute({ type: "seat_request_decided" })).toBe(
      "/notifications",
    );
    expect(resolveNotificationRoute(undefined)).toBe("/notifications");
    expect(resolveNotificationRoute({ url: 42 })).toBe("/notifications");
  });
});
