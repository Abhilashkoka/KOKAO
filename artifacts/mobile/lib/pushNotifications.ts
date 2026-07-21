import { useEffect, useRef } from "react";
import { AppState, Platform } from "react-native";
import { useAuth } from "@clerk/expo";
import { router, type Href } from "expo-router";
import {
  useListFeatureFlags,
  getListFeatureFlagsQueryKey,
  useRegisterPushToken,
  listNotifications,
  markNotificationRead,
} from "@workspace/api-client-react";

/**
 * Registers this device for push notifications once per signed-in session.
 *
 * Flow: skip entirely on web (Expo push is native-only) and when the
 * platform-wide push kill switch is off; otherwise ask the OS for
 * notification permission, fetch the device's Expo push token, and register
 * it with the API bound to the signed-in user. Everything is best-effort —
 * a denied permission or a network hiccup never surfaces an error, the
 * device simply doesn't receive pushes.
 */
export function usePushRegistration() {
  const { isSignedIn, userId } = useAuth();
  const featuresQuery = useListFeatureFlags({
    query: {
      queryKey: getListFeatureFlagsQueryKey(),
      enabled: !!isSignedIn && Platform.OS !== "web",
    },
  });
  const registerMutation = useRegisterPushToken();
  const registeredFor = useRef<string | null>(null);

  const pushEnabled = featuresQuery.data?.pushNotifications === true;

  useEffect(() => {
    if (Platform.OS === "web") return;
    if (!isSignedIn || !userId || !pushEnabled) return;
    if (registeredFor.current === userId) return;

    let cancelled = false;

    (async () => {
      try {
        const Device = await import("expo-device");
        if (!Device.isDevice) return; // simulators have no push tokens

        const Notifications = await import("expo-notifications");

        // NotificationPermissionsStatus extends expo's PermissionResponse,
        // but that base type doesn't always resolve across the monorepo's
        // hoisted type packages — read `granted` through a narrow local view.
        type PermissionView = { granted?: boolean; status?: string };
        let permission = (await Notifications.getPermissionsAsync()) as unknown as PermissionView;
        if (!permission.granted && permission.status !== "granted") {
          permission =
            (await Notifications.requestPermissionsAsync()) as unknown as PermissionView;
        }
        if (!permission.granted && permission.status !== "granted") return;

        if (Platform.OS === "android") {
          await Notifications.setNotificationChannelAsync("default", {
            name: "Default",
            importance: Notifications.AndroidImportance.DEFAULT,
          });
        }

        const token = (await Notifications.getExpoPushTokenAsync()).data;
        if (cancelled || !token) return;

        await registerMutation.mutateAsync({
          data: {
            token,
            platform: Platform.OS === "ios" ? "ios" : "android",
          },
        });
        if (!cancelled) registeredFor.current = userId;
      } catch {
        // Best-effort: permission denials, missing native module (Expo Go
        // limitations), or network failures just mean no push this session.
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSignedIn, userId, pushEnabled]);
}

/**
 * Map a push payload's `data` (server-set web linkUrl + notification type)
 * to a mobile route. The server's linkUrl values are WEB paths, so only the
 * ones with a mobile counterpart deep-link there; everything else lands on
 * the in-app notifications screen, which always shows the item itself.
 */
export function resolveNotificationRoute(data: unknown): Href {
  const d = (data ?? {}) as {
    url?: unknown;
    type?: unknown;
    contentItemId?: unknown;
  };
  const url = typeof d.url === "string" ? d.url : "";
  if (url === "/library" || url.startsWith("/library?")) {
    // Publish outcomes include the specific content item's id — open that
    // post's edit screen directly; without one, the library list is the
    // closest useful destination.
    const rawId = d.contentItemId;
    const id =
      typeof rawId === "number" && Number.isInteger(rawId) && rawId > 0
        ? rawId
        : typeof rawId === "string" && /^\d+$/.test(rawId) && Number(rawId) > 0
          ? Number(rawId)
          : null;
    if (id !== null) {
      return { pathname: "/content/[id]", params: { id: String(id) } };
    }
    return "/(tabs)/library";
  }
  if (url === "/accounts" || url.startsWith("/accounts?")) {
    return "/(tabs)/accounts";
  }
  if (url === "/ads" || url.startsWith("/ads?")) {
    return "/ads";
  }
  if (url === "/settings" || url.startsWith("/settings?")) {
    return "/settings";
  }
  // /admin and anything unknown have no mobile screen —
  // the notifications feed is the actionable fallback for all of them.
  return "/notifications";
}

/**
 * Extract the in-app notification id the server attached to the push
 * payload, if any. Mirrors contentItemId parsing: accepts a positive
 * integer as a number or numeric string, rejects everything else.
 */
export function extractNotificationId(data: unknown): number | null {
  const raw = (data as { notificationId?: unknown } | null | undefined)
    ?.notificationId;
  if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) return raw;
  if (typeof raw === "string" && /^\d+$/.test(raw) && Number(raw) > 0) {
    return Number(raw);
  }
  return null;
}

/**
 * A push tap that deep-links PAST the notifications inbox (straight to a
 * post or the accounts tab) means the user acted on the alert without ever
 * seeing the inbox — mark the matching in-app notification read so the
 * badge and inbox count stop nagging, then re-sync the app-icon badge from
 * the fresh unread count. Entirely best-effort: offline or an
 * already-dismissed row just leaves the badge to the next foreground sync.
 */
async function markPushNotificationHandled(
  notificationId: number,
): Promise<void> {
  try {
    await markNotificationRead(notificationId);
  } catch {
    // 404 (already read/dismissed elsewhere) or network failure — the
    // foreground badge sync will reconcile later either way.
  }
  try {
    const unread = await listNotifications();
    if (Array.isArray(unread)) await syncBadgeCount(unread.length);
  } catch {
    // Best-effort: leave the badge as-is.
  }
}

/**
 * Navigates when the user taps a push notification. Handles both warm taps
 * (app backgrounded — response listener) and cold starts (app killed —
 * getLastNotificationResponseAsync), deduping by response identifier +
 * timestamp so the cold-start read never double-fires after the listener
 * already handled it. Only navigates while signed in; the tabs layout's
 * auth redirect owns the signed-out case. Best-effort like registration —
 * a missing native module (Expo Go, web) just means taps don't deep-link.
 */
export function useNotificationTapNavigation() {
  const { isSignedIn } = useAuth();
  const handledKey = useRef<string | null>(null);

  useEffect(() => {
    if (Platform.OS === "web" || !isSignedIn) return;

    let cancelled = false;
    let subscription: { remove: () => void } | null = null;

    type ResponseView = {
      notification?: {
        date?: number;
        request?: { identifier?: string; content?: { data?: unknown } };
      };
    };

    const handle = (response: ResponseView | null) => {
      if (cancelled || !response?.notification) return;
      const { date, request } = response.notification;
      const key = `${request?.identifier ?? "?"}:${date ?? "?"}`;
      if (handledKey.current === key) return;
      handledKey.current = key;
      const data = request?.content?.data;
      const route = resolveNotificationRoute(data);
      try {
        router.push(route);
      } catch {
        // Navigation not ready or route missing — leave the user where they are.
      }
      // Deep links skip the inbox, so the alert would stay unread forever —
      // mark it read server-side and re-sync the badge. Taps landing ON the
      // notifications screen keep their unread state so the item is visible.
      if (route !== "/notifications") {
        const notificationId = extractNotificationId(data);
        if (notificationId !== null) {
          void markPushNotificationHandled(notificationId);
        }
      }
    };

    (async () => {
      try {
        const Notifications = await import("expo-notifications");
        if (cancelled) return;
        subscription = Notifications.addNotificationResponseReceivedListener(
          (response) => handle(response as unknown as ResponseView),
        );
        // Cold start: the tap that launched the app fired before the
        // listener existed, so read it back explicitly. Clear it once
        // consumed — the OS persists the "last response" across launches,
        // so without the clear a later normal launch would replay the old
        // tap and yank the user to the wrong screen.
        const last = await Notifications.getLastNotificationResponseAsync();
        if (last) {
          handle(last as unknown as ResponseView);
          try {
            await Notifications.clearLastNotificationResponseAsync?.();
          } catch {
            // Older SDKs without the clear API fall back to the in-memory
            // dedupe key, which at least prevents replay within a session.
          }
        }
      } catch {
        // Best-effort: no native notifications module in this environment.
      }
    })();

    return () => {
      cancelled = true;
      subscription?.remove();
    };
  }, [isSignedIn]);
}

/**
 * Sync the app-icon badge to the given unread count (0 clears it).
 * Native-only and best-effort: on web or when the native module is missing
 * (Expo Go limitations) it silently does nothing. Never throws.
 */
export async function syncBadgeCount(unreadCount: number): Promise<void> {
  if (Platform.OS === "web") return;
  try {
    const Notifications = await import("expo-notifications");
    await Notifications.setBadgeCountAsync(Math.max(0, unreadCount));
  } catch {
    // Best-effort: missing module or OS refusal just leaves the badge as-is.
  }
}

/**
 * Keeps the app-icon badge honest when notifications are read elsewhere
 * (e.g. on the web app): whenever the app comes to the foreground — and
 * once on sign-in — refetch the unread notification count from the API and
 * sync the badge. Native-only and best-effort: fetch failures leave the
 * badge untouched.
 */
export function useForegroundBadgeSync() {
  const { isSignedIn } = useAuth();

  useEffect(() => {
    if (Platform.OS === "web" || !isSignedIn) return;

    let cancelled = false;
    let inFlight = false;

    const sync = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        // Default (no params) = unread-only list.
        const unread = await listNotifications();
        if (!cancelled && Array.isArray(unread)) {
          await syncBadgeCount(unread.length);
        }
      } catch {
        // Best-effort: offline or API error just leaves the badge as-is.
      } finally {
        inFlight = false;
      }
    };

    // Initial sync covers the cold-start case (app opened fresh after
    // notifications were read on the web).
    void sync();

    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void sync();
    });

    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, [isSignedIn]);
}

/**
 * Renderless mount point for push registration and notification-tap
 * navigation; lives inside both the Clerk and QueryClient providers in the
 * root layout.
 */
export function PushRegistrar() {
  usePushRegistration();
  useNotificationTapNavigation();
  useForegroundBadgeSync();
  return null;
}
