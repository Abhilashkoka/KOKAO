import { useRouter } from "expo-router";
import React, { useState } from "react";
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useListContent, type ContentItem } from "@workspace/api-client-react";

import { Feather } from "@expo/vector-icons";

import { ContentImage } from "@/components/ContentImage";
import { Badge, Chip, EmptyState, ErrorState, Skeleton } from "@/components/ui";
import colors from "@/constants/colors";
import { fonts } from "@/constants/fonts";

const c = colors.light;

const FILTERS = ["all", "draft", "scheduled", "published"] as const;

const PENDING_TEXT = "#92600a";

function hasPendingPieces(item: ContentItem): boolean {
  return (
    (item.linkedinCommentsPending ?? 0) > 0 ||
    (item.threadsPostsPending ?? 0) > 0 ||
    (item.twitterPostsPending ?? 0) > 0
  );
}

function statusTone(status: string): "muted" | "success" | "accent" {
  if (status === "published") return "success";
  if (status === "scheduled") return "accent";
  return "muted";
}

export default function LibraryScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("all");
  const { data, isLoading, isError, error, refetch, isRefetching } = useListContent();

  const items = (data ?? []).filter((i) => filter === "all" || i.status === filter);

  const renderItem = ({ item }: { item: ContentItem }) => (
    <Pressable
      onPress={() =>
        router.push({ pathname: "/content/[id]", params: { id: String(item.id) } })
      }
      style={({ pressed }) => [styles.row, { opacity: pressed ? 0.85 : 1 }]}
    >
      {item.imagePath ? (
        <ContentImage imagePath={item.imagePath} style={styles.thumb} />
      ) : (
        <View style={[styles.thumb, styles.thumbEmpty]}>
          <Text style={styles.thumbLetter}>{item.title.slice(0, 1).toUpperCase()}</Text>
        </View>
      )}
      <View style={{ flex: 1 }}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {item.title}
        </Text>
        <Text style={styles.rowCaption} numberOfLines={2}>
          {item.caption || "No caption yet"}
        </Text>
        <View style={styles.rowMeta}>
          <Badge label={item.status} tone={statusTone(item.status)} />
          <Text style={styles.rowPlatform}>{item.platform}</Text>
        </View>
        {hasPendingPieces(item) ? (
          <View style={styles.pendingRow}>
            <Feather name="alert-circle" size={12} color={PENDING_TEXT} />
            <Text style={styles.pendingText}>Some pieces missing</Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <View style={{ paddingTop: insets.top + 20, paddingHorizontal: 20 }}>
        <Text style={styles.title}>Content Library</Text>
        <View style={styles.filterRow}>
          {FILTERS.map((f) => (
            <Chip key={f} label={f} selected={filter === f} onPress={() => setFilter(f)} />
          ))}
        </View>
      </View>

      {isLoading ? (
        <View style={{ padding: 20, gap: 12 }}>
          <Skeleton height={84} />
          <Skeleton height={84} />
          <Skeleton height={84} />
        </View>
      ) : isError ? (
        <ErrorState message={error?.message} onRetry={() => refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          icon="folder"
          title={filter === "all" ? "No content yet" : `No ${filter} content`}
          subtitle="Generate a post in the AI Studio and save it to your library."
        />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(item) => String(item.id)}
          renderItem={renderItem}
          contentContainerStyle={{
            paddingHorizontal: 20,
            paddingTop: 8,
            paddingBottom: insets.bottom + 110,
            gap: 12,
          }}
          refreshControl={
            <RefreshControl refreshing={isRefetching} onRefresh={refetch} />
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  title: { fontFamily: fonts.bold, fontSize: 24, color: c.foreground },
  filterRow: { flexDirection: "row", gap: 8, marginTop: 14, marginBottom: 10 },
  row: {
    flexDirection: "row",
    gap: 12,
    backgroundColor: c.background,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: colors.radius + 2,
    padding: 12,
  },
  thumb: { width: 68, height: 68, borderRadius: colors.radius },
  thumbEmpty: {
    backgroundColor: c.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  thumbLetter: { fontFamily: fonts.bold, fontSize: 22, color: c.accentForeground },
  rowTitle: { fontFamily: fonts.semiBold, fontSize: 14, color: c.foreground },
  rowCaption: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: c.mutedForeground,
    marginTop: 2,
    lineHeight: 17,
  },
  rowMeta: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 6 },
  rowPlatform: { fontFamily: fonts.medium, fontSize: 11, color: c.mutedForeground },
  pendingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    marginTop: 6,
    alignSelf: "flex-start",
    backgroundColor: "#fef3c7",
    borderWidth: 1,
    borderColor: "#fcd34d",
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  pendingText: { fontFamily: fonts.medium, fontSize: 11, color: PENDING_TEXT },
});
