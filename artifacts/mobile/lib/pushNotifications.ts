import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import { useAuth } from "@clerk/expo";
import {
  useListFeatureFlags,
  getListFeatureFlagsQueryKey,
  useRegisterPushToken,
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
 * Renderless mount point for push registration; lives inside both the Clerk
 * and QueryClient providers in the root layout.
 */
export function PushRegistrar() {
  usePushRegistration();
  return null;
}
