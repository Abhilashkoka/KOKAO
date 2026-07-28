import { Feather } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import {
  useListNotifications,
  useMarkNotificationRead,
  getListNotificationsQueryKey,
} from "@workspace/api-client-react";

import colors from "@/constants/colors";
import { fonts } from "@/constants/fonts";
import { apiErrorMessage } from "@/lib/apiErrorMessage";

const c = colors.light;

/** Notification type emitted once when a new workspace gets its welcome credit bundle. */
export const SIGNUP_CREDITS_GRANTED = "signup_credits_granted";

/**
 * One-time dismissible welcome banner on the mobile home screen, driven by the
 * unread `signup_credits_granted` notification (parity with the web dashboard
 * banner). Dismissing marks the notification read via the existing mark-read
 * endpoint, so it never reappears. Renders nothing when no unread notification
 * of that type exists.
 */
export function WelcomeCreditsBanner() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: notifications } = useListNotifications(undefined, {
    query: { queryKey: getListNotificationsQueryKey() },
  });
  const markRead = useMarkNotificationRead();
  const [dismissError, setDismissError] = React.useState<string | null>(null);

  const welcome = notifications?.find(
    (n) => n.type === SIGNUP_CREDITS_GRANTED,
  );
  if (!welcome) return null;

  const dismiss = () => {
    if (markRead.isPending) return;
    setDismissError(null);
    markRead.mutate(
      { id: welcome.id },
      {
        onSuccess: () =>
          queryClient.invalidateQueries({
            queryKey: getListNotificationsQueryKey(),
          }),
        onError: (err) =>
          setDismissError(
            apiErrorMessage(err, "Couldn't dismiss right now. Tap X to try again."),
          ),
      },
    );
  };

  return (
    <View style={styles.banner} testID="banner-welcome-credits">
      <View style={styles.iconBox}>
        <Feather name="gift" size={18} color={c.primary} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.title}>{welcome.title}</Text>
        <Text style={styles.message}>{welcome.message}</Text>
        {dismissError ? (
          <Text style={styles.dismissError} testID="text-dismiss-error">
            {dismissError}
          </Text>
        ) : null}
        <Pressable
          onPress={() => router.push("/(tabs)/studio")}
          style={({ pressed }) => [styles.cta, { opacity: pressed ? 0.85 : 1 }]}
          testID="button-start-creating"
        >
          <Feather name="zap" size={14} color="#ffffff" />
          <Text style={styles.ctaText}>Start creating</Text>
        </Pressable>
      </View>
      <Pressable
        onPress={dismiss}
        disabled={markRead.isPending}
        accessibilityLabel="Dismiss welcome banner"
        hitSlop={8}
        style={({ pressed }) => [
          styles.closeBtn,
          { opacity: markRead.isPending ? 0.4 : pressed ? 0.7 : 1 },
        ]}
        testID="button-dismiss-welcome"
      >
        <Feather name="x" size={16} color={c.mutedForeground} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    marginTop: 20,
    padding: 14,
    borderRadius: colors.radius + 2,
    borderWidth: 1,
    borderColor: c.primary + "4D",
    backgroundColor: c.primary + "1A",
  },
  iconBox: {
    width: 36,
    height: 36,
    borderRadius: 12,
    backgroundColor: c.primary + "26",
    borderWidth: 1,
    borderColor: c.primary + "33",
    alignItems: "center",
    justifyContent: "center",
  },
  title: { fontFamily: fonts.semiBold, fontSize: 14, color: c.foreground },
  message: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: c.mutedForeground,
    marginTop: 2,
  },
  dismissError: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: c.destructive,
    marginTop: 6,
  },
  cta: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    alignSelf: "flex-start",
    marginTop: 10,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 10,
    backgroundColor: c.primary,
  },
  ctaText: { fontFamily: fonts.semiBold, fontSize: 12, color: "#ffffff" },
  closeBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
});
