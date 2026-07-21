import { describe, expect, it, vi } from "vitest";

vi.mock("@clerk/expo", () => ({ useAuth: () => ({ isSignedIn: false }) }));
vi.mock("expo-router", () => ({ router: { push: vi.fn() } }));
vi.mock("@workspace/api-client-react", () => ({
  useListFeatureFlags: () => ({ data: undefined }),
  getListFeatureFlagsQueryKey: () => ["feature-flags"],
  useRegisterPushToken: () => ({ mutateAsync: vi.fn() }),
  listNotifications: vi.fn(),
  markNotificationRead: vi.fn(),
}));

import {
  extractNotificationId,
  resolveNotificationRoute,
} from "./pushNotifications";

describe("resolveNotificationRoute", () => {
  it("maps library links to the library tab", () => {
    expect(
      resolveNotificationRoute({ url: "/library", type: "scheduled_publish_failed" }),
    ).toBe("/(tabs)/library");
    expect(
      resolveNotificationRoute({ url: "/library?item=5", type: "scheduled_post_published" }),
    ).toBe("/(tabs)/library");
  });

  it("opens the specific post when a content item id is present", () => {
    expect(
      resolveNotificationRoute({
        url: "/library",
        type: "scheduled_post_published",
        contentItemId: 42,
      }),
    ).toEqual({ pathname: "/content/[id]", params: { id: "42" } });
    expect(
      resolveNotificationRoute({
        url: "/library",
        type: "scheduled_publish_failed",
        contentItemId: "7",
      }),
    ).toEqual({ pathname: "/content/[id]", params: { id: "7" } });
    expect(
      resolveNotificationRoute({
        url: "/library",
        type: "publish_interrupted",
        contentItemId: 13,
      }),
    ).toEqual({ pathname: "/content/[id]", params: { id: "13" } });
  });

  it("falls back to the library tab when the content item id is invalid", () => {
    expect(
      resolveNotificationRoute({
        url: "/library",
        type: "scheduled_post_published",
        contentItemId: "not-a-number",
      }),
    ).toBe("/(tabs)/library");
    expect(
      resolveNotificationRoute({
        url: "/library",
        type: "scheduled_post_published",
        contentItemId: "0",
      }),
    ).toBe("/(tabs)/library");
    expect(
      resolveNotificationRoute({
        url: "/library",
        type: "publish_interrupted",
        contentItemId: -5,
      }),
    ).toBe("/(tabs)/library");
    expect(
      resolveNotificationRoute({
        url: "/library",
        type: "scheduled_publish_failed",
        contentItemId: null,
      }),
    ).toBe("/(tabs)/library");
  });

  it("maps account links to the accounts tab", () => {
    expect(
      resolveNotificationRoute({ url: "/accounts", type: "social_connection_failed" }),
    ).toBe("/(tabs)/accounts");
  });

  it("routes ads alerts to the ads screen", () => {
    expect(resolveNotificationRoute({ url: "/ads", type: "ads_change_failed" })).toBe(
      "/ads",
    );
    expect(
      resolveNotificationRoute({ url: "/ads?draft=3", type: "ads_change_applied" }),
    ).toBe("/ads");
  });

  it("routes settings alerts to the settings screen", () => {
    expect(
      resolveNotificationRoute({ url: "/settings", type: "team_member_joined" }),
    ).toBe("/settings");
    expect(
      resolveNotificationRoute({ url: "/settings?tab=billing", type: "seat_request_decided" }),
    ).toBe("/settings");
  });

  it("falls back to the notifications screen for web-only or unknown targets", () => {
    expect(resolveNotificationRoute({ url: "/admin", type: "sweep_stalled" })).toBe(
      "/notifications",
    );
    expect(resolveNotificationRoute({ type: "seat_request_decided" })).toBe(
      "/notifications",
    );
    expect(resolveNotificationRoute(undefined)).toBe("/notifications");
    expect(resolveNotificationRoute({ url: 42 })).toBe("/notifications");
  });
});

describe("extractNotificationId", () => {
  it("accepts positive integer ids as numbers or numeric strings", () => {
    expect(extractNotificationId({ notificationId: 42 })).toBe(42);
    expect(extractNotificationId({ notificationId: "7" })).toBe(7);
  });

  it("rejects missing or invalid ids", () => {
    expect(extractNotificationId({})).toBeNull();
    expect(extractNotificationId(undefined)).toBeNull();
    expect(extractNotificationId(null)).toBeNull();
    expect(extractNotificationId({ notificationId: 0 })).toBeNull();
    expect(extractNotificationId({ notificationId: -3 })).toBeNull();
    expect(extractNotificationId({ notificationId: 1.5 })).toBeNull();
    expect(extractNotificationId({ notificationId: "abc" })).toBeNull();
    expect(extractNotificationId({ notificationId: "0" })).toBeNull();
  });
});
