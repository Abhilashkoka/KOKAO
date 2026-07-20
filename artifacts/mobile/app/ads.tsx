import { Feather } from "@expo/vector-icons";
import React from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  useGetAdsStatus,
  getGetAdsStatusQueryKey,
  useListAdConnections,
  getListAdConnectionsQueryKey,
  useListAdDrafts,
  getListAdDraftsQueryKey,
  useListAdsChangeLog,
  getListAdsChangeLogQueryKey,
} from "@workspace/api-client-react";
import type {
  AdAccountConnection,
  AdsChangeLogEntry,
  AdsDraft,
} from "@workspace/api-client-react";

import { Badge, Card, EmptyState, ErrorState, Skeleton } from "@/components/ui";
import colors from "@/constants/colors";
import { fonts } from "@/constants/fonts";

const c = colors.light;

const PLATFORM_LABELS: Record<string, string> = {
  meta: "Meta",
  google: "Google",
  linkedin: "LinkedIn",
  tiktok: "TikTok",
};

function platformLabel(platform: string): string {
  return (
    PLATFORM_LABELS[platform] ??
    platform.charAt(0).toUpperCase() + platform.slice(1)
  );
}

function formatDateTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function titleCase(value: string): string {
  return value
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function connectionTone(
  conn: AdAccountConnection,
): "success" | "destructive" | "muted" {
  if (conn.status !== "connected") return "muted";
  if (conn.verifyStatus === "failed") return "destructive";
  return "success";
}

function connectionStatusLabel(conn: AdAccountConnection): string {
  if (conn.status !== "connected") return "Setup pending";
  if (conn.verifyStatus === "failed") return "Needs attention";
  return "Connected";
}

function draftTone(status: string): "success" | "destructive" | "muted" | "accent" {
  if (status === "applied") return "success";
  if (status === "failed") return "destructive";
  if (status === "draft" || status === "approved") return "accent";
  return "muted";
}

function ConnectionRow({ conn }: { conn: AdAccountConnection }) {
  const tone = connectionTone(conn);
  return (
    <View style={styles.row}>
      <View style={styles.rowMain}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {conn.adAccountName || conn.adAccountId}
        </Text>
        <Text style={styles.rowSubtitle} numberOfLines={1}>
          {platformLabel(conn.platform)}
          {conn.verifyStatus === "failed" && conn.verifyError
            ? ` — ${conn.verifyError}`
            : ""}
        </Text>
      </View>
      <Badge label={connectionStatusLabel(conn)} tone={tone} />
    </View>
  );
}

function DraftRow({ draft }: { draft: AdsDraft }) {
  return (
    <View style={styles.row}>
      <View style={styles.rowMain}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {draft.targetName}
        </Text>
        <Text style={styles.rowSubtitle} numberOfLines={1}>
          {platformLabel(draft.platform)} · {titleCase(draft.action)}{" "}
          {titleCase(draft.targetType)}
        </Text>
      </View>
      <Badge label={titleCase(draft.status)} tone={draftTone(draft.status)} />
    </View>
  );
}

function ChangeLogRow({ entry }: { entry: AdsChangeLogEntry }) {
  const when = formatDateTime(entry.createdAt);
  return (
    <View style={styles.row}>
      <View style={styles.rowMain}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {entry.targetName}
        </Text>
        <Text style={styles.rowSubtitle} numberOfLines={1}>
          {platformLabel(entry.platform)} · {titleCase(entry.action)}
          {when ? ` · ${when}` : ""}
        </Text>
        {entry.outcome === "failed" && entry.failureReason ? (
          <Text style={styles.rowError} numberOfLines={2}>
            {entry.failureReason}
          </Text>
        ) : null}
      </View>
      <Badge
        label={entry.outcome === "applied" ? "Applied" : "Failed"}
        tone={entry.outcome === "applied" ? "success" : "destructive"}
      />
    </View>
  );
}

export default function AdsScreen() {
  const insets = useSafeAreaInsets();
  const status = useGetAdsStatus({
    query: { queryKey: getGetAdsStatusQueryKey() },
  });
  const connections = useListAdConnections({
    query: { queryKey: getListAdConnectionsQueryKey() },
  });
  const drafts = useListAdDrafts({
    query: { queryKey: getListAdDraftsQueryKey() },
  });
  const changeLog = useListAdsChangeLog({
    query: { queryKey: getListAdsChangeLogQueryKey() },
  });

  const refreshing =
    status.isRefetching ||
    connections.isRefetching ||
    drafts.isRefetching ||
    changeLog.isRefetching;
  const refetchAll = () => {
    status.refetch();
    connections.refetch();
    drafts.refetch();
    changeLog.refetch();
  };

  if (status.isLoading || connections.isLoading) {
    return (
      <ScrollView
        style={{ backgroundColor: c.background }}
        contentContainerStyle={styles.container}
      >
        <Skeleton height={90} />
        <Skeleton height={140} />
        <Skeleton height={140} />
      </ScrollView>
    );
  }

  if (status.isError || !status.data) {
    return (
      <ScrollView
        style={{ backgroundColor: c.background }}
        contentContainerStyle={styles.container}
      >
        <ErrorState message={status.error?.message} onRetry={refetchAll} />
      </ScrollView>
    );
  }

  if (!status.data.enabled) {
    return (
      <ScrollView
        style={{ backgroundColor: c.background }}
        contentContainerStyle={styles.container}
      >
        <EmptyState
          icon="slash"
          title="Ads is unavailable"
          subtitle="The paid media module is currently turned off for this platform."
        />
      </ScrollView>
    );
  }

  const connectionList = connections.data ?? [];
  const recentDrafts = (drafts.data ?? []).slice(0, 5);
  const recentChanges = (changeLog.data ?? []).slice(0, 5);

  return (
    <ScrollView
      style={{ backgroundColor: c.background }}
      contentContainerStyle={[styles.container, { paddingBottom: insets.bottom + 40 }]}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refetchAll} />}
    >
      <Card style={styles.card}>
        <View style={styles.cardHeader}>
          <Feather name="link" size={16} color={c.primary} />
          <Text style={styles.cardTitle}>Ad account connections</Text>
        </View>
        {connections.isError ? (
          <Text style={styles.hint}>Connections could not be loaded right now.</Text>
        ) : connectionList.length === 0 ? (
          <Text style={styles.hint}>
            No ad accounts connected yet. Connect one from the web app under Ads.
          </Text>
        ) : (
          connectionList.map((conn) => <ConnectionRow key={conn.id} conn={conn} />)
        )}
      </Card>

      <Card style={styles.card}>
        <View style={styles.cardHeader}>
          <Feather name="file-text" size={16} color={c.primary} />
          <Text style={styles.cardTitle}>Recent drafts</Text>
        </View>
        {drafts.isLoading ? (
          <Skeleton height={40} />
        ) : drafts.isError ? (
          <Text style={styles.hint}>Drafts could not be loaded right now.</Text>
        ) : recentDrafts.length === 0 ? (
          <Text style={styles.hint}>No ad drafts yet.</Text>
        ) : (
          recentDrafts.map((draft) => <DraftRow key={draft.id} draft={draft} />)
        )}
      </Card>

      <Card style={styles.card}>
        <View style={styles.cardHeader}>
          <Feather name="activity" size={16} color={c.primary} />
          <Text style={styles.cardTitle}>Recent activity</Text>
        </View>
        {changeLog.isLoading ? (
          <Skeleton height={40} />
        ) : changeLog.isError ? (
          <Text style={styles.hint}>Activity could not be loaded right now.</Text>
        ) : recentChanges.length === 0 ? (
          <Text style={styles.hint}>No applied changes yet.</Text>
        ) : (
          recentChanges.map((entry) => <ChangeLogRow key={entry.id} entry={entry} />)
        )}
      </Card>

      <Text style={styles.hint}>
        This is a read-only summary. To review, approve, or edit ad changes, use the
        web app under Ads.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, gap: 14 },
  card: { gap: 10, padding: 16 },
  cardHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  cardTitle: {
    fontFamily: fonts.semiBold,
    fontSize: 15,
    color: c.foreground,
    flex: 1,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  rowMain: { flex: 1, gap: 2 },
  rowTitle: { fontFamily: fonts.medium, fontSize: 13, color: c.foreground },
  rowSubtitle: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: c.mutedForeground,
  },
  rowError: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: c.destructive,
  },
  hint: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: c.mutedForeground,
    lineHeight: 17,
  },
});
