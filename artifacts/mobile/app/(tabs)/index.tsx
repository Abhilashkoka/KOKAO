import { useAuth } from "@clerk/expo";
import { Feather } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import React from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  useGetMe,
  useListContent,
  useListNotifications,
  useListVideoJobs,
  getListNotificationsQueryKey,
  getListVideoJobsQueryKey,
} from "@workspace/api-client-react";

import { Badge, Card, ErrorState, Skeleton } from "@/components/ui";
import { ConsentPrompt } from "@/components/ConsentPrompt";
import { OnboardingWizard } from "@/components/OnboardingWizard";
import { getGetFirstPostProgressQueryKey } from "@workspace/api-client-react";

import { GettingStartedChecklist } from "@/components/GettingStartedChecklist";
import { WelcomeCreditsBanner } from "@/components/WelcomeCreditsBanner";
import {
  TeamMembershipCard,
  TeamWelcomeModal,
} from "@/components/TeamMembership";
import colors from "@/constants/colors";
import { fonts } from "@/constants/fonts";
import { hasPendingPieces, PENDING_TEXT } from "@/lib/contentPending";

const c = colors.light;

function UsageRow({
  label,
  used,
  limit,
}: {
  label: string;
  used: number;
  limit: number;
}) {
  const unlimited = limit === -1;
  const pct = unlimited ? 0 : limit === 0 ? 1 : Math.min(1, used / limit);
  return (
    <View style={styles.usageRow}>
      <View style={styles.usageHeader}>
        <Text style={styles.usageLabel}>{label}</Text>
        <Text style={styles.usageValue}>
          {used} / {unlimited ? "Unlimited" : limit}
        </Text>
      </View>
      <View style={styles.track}>
        <View
          style={[
            styles.fill,
            {
              width: unlimited ? "100%" : `${Math.round(pct * 100)}%`,
              backgroundColor: unlimited
                ? c.accent
                : pct >= 1
                  ? c.destructive
                  : c.primary,
            },
          ]}
        />
      </View>
    </View>
  );
}

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { signOut } = useAuth();
  const queryClient = useQueryClient();
  const me = useGetMe();
  const content = useListContent();
  const notifications = useListNotifications(undefined, {
    query: {
      queryKey: getListNotificationsQueryKey(),
      // Keep the bell badge live: poll while visible; foreground returns
      // refetch via the AppState → focusManager bridge in _layout.
      refetchInterval: 30_000,
      refetchIntervalInBackground: false,
    },
  });
  const unreadCount = notifications.data?.length ?? 0;

  // Poll for in-flight video jobs so the Home tab shows a live indicator when
  // the user backgrounds the app mid-generation and returns to the Home tab.
  // Mirrors the active-only polling pattern from videos.tsx.
  const videoJobsQuery = useListVideoJobs({
    query: {
      queryKey: getListVideoJobsQueryKey(),
      refetchInterval: (query) =>
        query.state.data?.some(
          (job) => job.status === "queued" || job.status === "processing",
        )
          ? 5000
          : false,
      refetchIntervalInBackground: false,
    },
  });
  const activeVideoCount = (videoJobsQuery.data ?? []).filter(
    (job) => job.status === "queued" || job.status === "processing",
  ).length;

  const recent = (content.data ?? []).slice(0, 3);

  const onRefresh = () => {
    me.refetch();
    content.refetch();
    notifications.refetch();
    videoJobsQuery.refetch();
    // Keep the getting-started checklist in sync when users complete steps
    // elsewhere (studio, accounts) and pull to refresh on Home.
    queryClient.invalidateQueries({
      queryKey: getGetFirstPostProgressQueryKey(),
    });
  };

  const handleSignOut = async () => {
    await signOut();
    queryClient.clear();
    router.replace("/(auth)/sign-in");
  };

  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentContainerStyle={{
        paddingTop: insets.top + 20,
        paddingBottom: insets.bottom + 110,
        paddingHorizontal: 20,
      }}
      refreshControl={
        <RefreshControl
          refreshing={me.isRefetching || content.isRefetching}
          onRefresh={onRefresh}
        />
      }
    >
      <View style={styles.topRow}>
        <View>
          <Text style={styles.hello}>KOKAO</Text>
          {me.isLoading ? (
            <Skeleton height={22} width={160} style={{ marginTop: 6 }} />
          ) : (
            <Text style={styles.workspace}>
              {me.data?.tenant.name ?? "Workspace"}
            </Text>
          )}
        </View>
        <View style={{ flexDirection: "row", gap: 10 }}>
          <Pressable
            onPress={() => router.push("/notifications")}
            accessibilityLabel={
              unreadCount > 0
                ? `Notifications, ${unreadCount} unread`
                : "Notifications"
            }
            style={({ pressed }) => [styles.iconBtn, { opacity: pressed ? 0.7 : 1 }]}
          >
            <Feather name="bell" size={18} color={c.mutedForeground} />
            {unreadCount > 0 ? (
              <View style={styles.unreadBadge}>
                <Text style={styles.unreadBadgeText}>
                  {unreadCount > 9 ? "9+" : unreadCount}
                </Text>
              </View>
            ) : null}
          </Pressable>
          <Pressable
            onPress={() => router.push("/privacy")}
            accessibilityLabel="Privacy settings"
            style={({ pressed }) => [styles.iconBtn, { opacity: pressed ? 0.7 : 1 }]}
          >
            <Feather name="shield" size={18} color={c.mutedForeground} />
          </Pressable>
          <Pressable
            onPress={handleSignOut}
            style={({ pressed }) => [styles.iconBtn, { opacity: pressed ? 0.7 : 1 }]}
          >
            <Feather name="log-out" size={18} color={c.mutedForeground} />
          </Pressable>
        </View>
      </View>

      {/* In-progress video indicator — shown whenever any job is queued or
          processing so users who background the app mid-generation always see
          a live signal on the Home tab. Tapping it jumps to the Videos screen. */}
      {activeVideoCount > 0 ? (
        <Pressable
          onPress={() => router.push("/videos")}
          style={({ pressed }) => [
            styles.generatingBanner,
            { opacity: pressed ? 0.85 : 1 },
          ]}
          accessibilityLabel={`${activeVideoCount} video${activeVideoCount > 1 ? "s" : ""} generating — tap to view`}
          testID="banner-video-generating"
        >
          <ActivityIndicator size="small" color={c.primaryForeground} style={{ marginRight: 8 }} />
          <Text style={styles.generatingText}>
            {activeVideoCount === 1
              ? "1 video is generating…"
              : `${activeVideoCount} videos generating…`}
          </Text>
          <Feather name="chevron-right" size={16} color={c.primaryForeground} style={{ marginLeft: "auto" }} />
        </Pressable>
      ) : null}

      {me.isError ? (
        <ErrorState message={me.error?.message} onRetry={() => me.refetch()} />
      ) : (
        <>
          <OnboardingWizard />
          {/* The wizard asks the consent question itself; keep the one-time
              consent prompt out of the way until onboarding is done to avoid
              stacked modals. */}
          {me.data?.brandOnboardingComplete ? <ConsentPrompt /> : null}
          <WelcomeCreditsBanner />
          <GettingStartedChecklist />
          <TeamWelcomeModal />
          <TeamMembershipCard />
          <Card style={{ marginTop: 20 }}>
            <View style={styles.planRow}>
              <Text style={styles.cardTitle}>Monthly usage</Text>
              {me.data ? (
                <Badge label={me.data.tenant.plan.toUpperCase()} tone="accent" />
              ) : null}
            </View>
            {me.isLoading ? (
              <View style={{ gap: 12, marginTop: 12 }}>
                <Skeleton height={14} />
                <Skeleton height={14} />
              </View>
            ) : me.data ? (
              <>
                <UsageRow
                  label="AI captions"
                  used={me.data.usage.captions}
                  limit={me.data.limits.captions}
                />
                <UsageRow
                  label="AI images"
                  used={me.data.usage.images}
                  limit={me.data.limits.images}
                />
              </>
            ) : null}
          </Card>

          <View style={styles.quickRow}>
            <Pressable
              style={({ pressed }) => [styles.quickCard, { opacity: pressed ? 0.85 : 1 }]}
              onPress={() => router.push("/(tabs)/studio")}
            >
              <View style={[styles.quickIcon, { backgroundColor: c.primary }]}>
                <Feather name="zap" size={18} color="#ffffff" />
              </View>
              <Text style={styles.quickTitle}>AI Studio</Text>
              <Text style={styles.quickSub}>Generate captions and images</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [styles.quickCard, { opacity: pressed ? 0.85 : 1 }]}
              onPress={() => router.push("/(tabs)/accounts")}
            >
              <View style={[styles.quickIcon, { backgroundColor: c.accent }]}>
                <Feather name="link" size={18} color={c.accentForeground} />
              </View>
              <Text style={styles.quickTitle}>Accounts</Text>
              <Text style={styles.quickSub}>Check connection health</Text>
            </Pressable>
          </View>

          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Recent content</Text>
            <Pressable onPress={() => router.push("/(tabs)/library")}>
              <Text style={styles.sectionLink}>View all</Text>
            </Pressable>
          </View>

          {content.isLoading ? (
            <View style={{ gap: 10 }}>
              <Skeleton height={64} />
              <Skeleton height={64} />
            </View>
          ) : recent.length === 0 ? (
            <Card>
              <Text style={styles.emptyText}>
                No content yet. Create your first post in the AI Studio.
              </Text>
            </Card>
          ) : (
            <View style={{ gap: 10 }}>
              {recent.map((item) => (
                <Pressable
                  key={item.id}
                  onPress={() =>
                    router.push({ pathname: "/content/[id]", params: { id: String(item.id) } })
                  }
                  style={({ pressed }) => [{ opacity: pressed ? 0.85 : 1 }]}
                >
                  <Card style={styles.recentCard}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.recentTitle} numberOfLines={1}>
                        {item.title}
                      </Text>
                      <Text style={styles.recentCaption} numberOfLines={1}>
                        {item.caption || "No caption"}
                      </Text>
                      {hasPendingPieces(item) ? (
                        <View style={styles.pendingRow}>
                          <Feather name="alert-circle" size={12} color={PENDING_TEXT} />
                          <Text style={styles.pendingText}>Some pieces missing</Text>
                        </View>
                      ) : null}
                    </View>
                    <Badge
                      label={item.status}
                      tone={item.status === "published" ? "success" : "muted"}
                    />
                  </Card>
                </Pressable>
              ))}
            </View>
          )}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  topRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  hello: {
    fontFamily: fonts.bold,
    fontSize: 13,
    letterSpacing: 2,
    color: c.primary,
  },
  workspace: { fontFamily: fonts.bold, fontSize: 24, color: c.foreground, marginTop: 4 },
  iconBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: c.muted,
    alignItems: "center",
    justifyContent: "center",
  },
  unreadBadge: {
    position: "absolute",
    top: -2,
    right: -2,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    paddingHorizontal: 4,
    backgroundColor: c.destructive,
    alignItems: "center",
    justifyContent: "center",
  },
  unreadBadgeText: { fontFamily: fonts.bold, fontSize: 9, color: "#ffffff" },
  planRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  cardTitle: { fontFamily: fonts.semiBold, fontSize: 15, color: c.foreground },
  usageRow: { marginTop: 16 },
  usageHeader: { flexDirection: "row", justifyContent: "space-between", marginBottom: 6 },
  usageLabel: { fontFamily: fonts.medium, fontSize: 13, color: c.mutedForeground },
  usageValue: { fontFamily: fonts.semiBold, fontSize: 13, color: c.foreground },
  track: { height: 8, borderRadius: 4, backgroundColor: c.muted, overflow: "hidden" },
  fill: { height: 8, borderRadius: 4 },
  quickRow: { flexDirection: "row", gap: 12, marginTop: 14 },
  quickCard: {
    flex: 1,
    backgroundColor: c.card,
    borderRadius: colors.radius + 2,
    borderWidth: 1,
    borderColor: c.border,
    padding: 14,
  },
  quickIcon: {
    width: 36,
    height: 36,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 10,
  },
  quickTitle: { fontFamily: fonts.semiBold, fontSize: 14, color: c.foreground },
  quickSub: { fontFamily: fonts.regular, fontSize: 12, color: c.mutedForeground, marginTop: 3 },
  sectionHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 26,
    marginBottom: 12,
  },
  sectionTitle: { fontFamily: fonts.semiBold, fontSize: 16, color: c.foreground },
  sectionLink: { fontFamily: fonts.semiBold, fontSize: 13, color: c.primary },
  recentCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 12,
  },
  recentTitle: { fontFamily: fonts.semiBold, fontSize: 14, color: c.foreground },
  recentCaption: { fontFamily: fonts.regular, fontSize: 12, color: c.mutedForeground, marginTop: 2 },
  pendingRow: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 4 },
  pendingText: { fontFamily: fonts.medium, fontSize: 11, color: PENDING_TEXT },
  emptyText: { fontFamily: fonts.regular, fontSize: 13, color: c.mutedForeground },
  generatingBanner: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: c.primary,
    borderRadius: colors.radius,
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginTop: 16,
  },
  generatingText: {
    fontFamily: fonts.semiBold,
    fontSize: 13,
    color: c.primaryForeground,
  },
});
