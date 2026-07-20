import { Feather } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import React from "react";
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  useListNotifications,
  useMarkNotificationRead,
  useMarkAllNotificationsRead,
  getListNotificationsQueryKey,
  type Notification,
} from "@workspace/api-client-react";

import { Card, ErrorState, Skeleton } from "@/components/ui";
import colors from "@/constants/colors";
import { fonts } from "@/constants/fonts";
import { mapLinkUrlToRoute } from "@/lib/notificationLinks";

const c = colors.light;

const INBOX_PARAMS = { all: true } as const;

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const diffMs = Date.now() - date.getTime();
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  });
}

function NotificationRow({
  item,
  onPress,
}: {
  item: Notification;
  onPress: (item: Notification) => void;
}) {
  const unread = !item.readAt;
  return (
    <Pressable
      onPress={() => onPress(item)}
      accessibilityLabel={unread ? "Unread notification, tap to mark read" : "Notification"}
      style={({ pressed }) => [{ opacity: pressed ? 0.85 : 1 }]}
    >
      <Card style={unread ? { ...styles.row, ...styles.rowUnread } : styles.row}>
        <View style={styles.dotColumn}>
          <View style={[styles.dot, { backgroundColor: unread ? c.primary : "transparent" }]} />
        </View>
        <View style={{ flex: 1 }}>
          <View style={styles.rowHeader}>
            <Text
              style={[styles.rowTitle, unread ? styles.rowTitleUnread : null]}
              numberOfLines={2}
            >
              {item.title}
            </Text>
            <Text style={styles.rowWhen}>{formatWhen(item.createdAt)}</Text>
          </View>
          <Text style={styles.rowMessage}>{item.message}</Text>
        </View>
      </Card>
    </Pressable>
  );
}

export default function NotificationsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();
  const list = useListNotifications(INBOX_PARAMS, {
    query: { queryKey: getListNotificationsQueryKey(INBOX_PARAMS) },
  });
  const markRead = useMarkNotificationRead();
  const markAllRead = useMarkAllNotificationsRead();

  const notifications = list.data ?? [];
  const unreadCount = notifications.filter((n) => !n.readAt).length;

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getListNotificationsQueryKey(INBOX_PARAMS) });
    queryClient.invalidateQueries({ queryKey: getListNotificationsQueryKey() });
  };

  const handlePress = (item: Notification) => {
    if (!item.readAt) {
      // Optimistically flip to read so the row updates immediately.
      queryClient.setQueryData<Notification[]>(
        getListNotificationsQueryKey(INBOX_PARAMS),
        (old) =>
          old?.map((n) =>
            n.id === item.id ? { ...n, readAt: new Date().toISOString() } : n,
          ),
      );
      markRead.mutate(
        { id: item.id },
        {
          onSettled: invalidate,
        },
      );
    }

    const target = mapLinkUrlToRoute(item.linkUrl);
    if (target) {
      router.push(target);
    }
  };

  const handleMarkAllRead = () => {
    if (markAllRead.isPending) return;
    const now = new Date().toISOString();
    queryClient.setQueryData<Notification[]>(
      getListNotificationsQueryKey(INBOX_PARAMS),
      (old) => old?.map((n) => (n.readAt ? n : { ...n, readAt: now })),
    );
    markAllRead.mutate(undefined, { onSettled: invalidate });
  };

  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentContainerStyle={{
        paddingTop: 16,
        paddingBottom: insets.bottom + 40,
        paddingHorizontal: 20,
      }}
      refreshControl={
        <RefreshControl refreshing={list.isRefetching} onRefresh={() => list.refetch()} />
      }
    >
      <View style={styles.headerRow}>
        <Text style={styles.headerText}>
          {unreadCount > 0
            ? `${unreadCount} unread`
            : notifications.length > 0
              ? "All caught up"
              : ""}
        </Text>
        <View style={styles.headerActions}>
          {unreadCount > 0 && (
            <Pressable
              onPress={handleMarkAllRead}
              disabled={markAllRead.isPending}
              accessibilityLabel="Mark all notifications read"
              style={({ pressed }) => [
                styles.settingsBtn,
                { opacity: pressed || markAllRead.isPending ? 0.7 : 1 },
              ]}
            >
              <Feather name="check-circle" size={14} color={c.mutedForeground} />
              <Text style={styles.settingsText}>Mark all read</Text>
            </Pressable>
          )}
          <Pressable
            onPress={() => router.push("/notification-settings")}
            accessibilityLabel="Notification settings"
            style={({ pressed }) => [styles.settingsBtn, { opacity: pressed ? 0.7 : 1 }]}
          >
            <Feather name="settings" size={14} color={c.mutedForeground} />
            <Text style={styles.settingsText}>Settings</Text>
          </Pressable>
        </View>
      </View>

      {list.isLoading ? (
        <View style={{ gap: 10 }}>
          <Skeleton height={72} />
          <Skeleton height={72} />
          <Skeleton height={72} />
        </View>
      ) : list.isError ? (
        <ErrorState message={list.error?.message} onRetry={() => list.refetch()} />
      ) : notifications.length === 0 ? (
        <Card style={styles.emptyCard}>
          <Feather name="bell-off" size={22} color={c.mutedForeground} />
          <Text style={styles.emptyTitle}>No notifications yet</Text>
          <Text style={styles.emptyText}>
            Alerts about publishing, connections, and your account will show up here.
          </Text>
        </Card>
      ) : (
        <View style={{ gap: 10 }}>
          {notifications.map((item) => (
            <NotificationRow key={item.id} item={item} onPress={handlePress} />
          ))}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  headerRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 14,
    minHeight: 28,
  },
  headerText: { fontFamily: fonts.medium, fontSize: 13, color: c.mutedForeground },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 8 },
  settingsBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 16,
    backgroundColor: c.muted,
  },
  settingsText: { fontFamily: fonts.semiBold, fontSize: 12, color: c.mutedForeground },
  row: { flexDirection: "row", gap: 10, paddingVertical: 14 },
  rowUnread: { borderColor: c.primary, borderWidth: 1 },
  dotColumn: { paddingTop: 5 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  rowHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 8,
  },
  rowTitle: {
    fontFamily: fonts.medium,
    fontSize: 14,
    color: c.foreground,
    flex: 1,
  },
  rowTitleUnread: { fontFamily: fonts.semiBold },
  rowWhen: { fontFamily: fonts.regular, fontSize: 11, color: c.mutedForeground, marginTop: 2 },
  rowMessage: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: c.mutedForeground,
    marginTop: 4,
    lineHeight: 18,
  },
  emptyCard: { alignItems: "center", paddingVertical: 30, gap: 8 },
  emptyTitle: { fontFamily: fonts.semiBold, fontSize: 15, color: c.foreground },
  emptyText: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: c.mutedForeground,
    textAlign: "center",
    lineHeight: 18,
  },
});
