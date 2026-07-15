import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useEffect, useState } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetContent,
  useUpdateContent,
  useDeleteContent,
  getListContentQueryKey,
  getGetContentQueryKey,
} from "@workspace/api-client-react";

import { ContentImage } from "@/components/ContentImage";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { Button, Card, Chip, ErrorState, Input, Label, Skeleton } from "@/components/ui";
import colors from "@/constants/colors";
import { fonts } from "@/constants/fonts";

const c = colors.light;

const STATUSES = ["draft", "scheduled", "published"] as const;

export default function ContentDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const contentId = Number(id);
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();

  const { data, isLoading, isError, error, refetch } = useGetContent(contentId);
  const update = useUpdateContent();
  const remove = useDeleteContent();

  const [title, setTitle] = useState("");
  const [caption, setCaption] = useState("");
  const [status, setStatus] = useState<string>("draft");
  const [dirty, setDirty] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  useEffect(() => {
    if (data && !dirty) {
      setTitle(data.title);
      setCaption(data.caption);
      setStatus(data.status);
    }
  }, [data, dirty]);

  const haptic = () => {
    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  };

  const handleSave = () => {
    haptic();
    setMessage(null);
    setErrMsg(null);
    update.mutate(
      {
        id: contentId,
        data: {
          title: title.trim(),
          caption,
          status: status as "draft" | "scheduled" | "published",
        },
      },
      {
        onSuccess: () => {
          setDirty(false);
          setMessage("Changes saved");
          queryClient.invalidateQueries({ queryKey: getListContentQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetContentQueryKey(contentId) });
        },
        onError: (err) => setErrMsg(err?.message || "Could not save changes."),
      },
    );
  };

  const handleDelete = () => {
    haptic();
    setErrMsg(null);
    remove.mutate(
      { id: contentId },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListContentQueryKey() });
          router.back();
        },
        onError: (err) => {
          setConfirmDelete(false);
          setErrMsg(err?.message || "Could not delete this item.");
        },
      },
    );
  };

  if (isLoading) {
    return (
      <View style={{ flex: 1, backgroundColor: c.background, padding: 20, gap: 14 }}>
        <Skeleton height={220} />
        <Skeleton height={40} />
        <Skeleton height={120} />
      </View>
    );
  }

  if (isError || !data) {
    return (
      <View style={{ flex: 1, backgroundColor: c.background }}>
        <ErrorState message={error?.message} onRetry={() => refetch()} />
      </View>
    );
  }

  return (
    <KeyboardAwareScrollViewCompat
      style={{ backgroundColor: c.background }}
      contentContainerStyle={{
        padding: 20,
        paddingBottom: insets.bottom + 48,
      }}
    >
      {data.imagePath ? (
        <ContentImage imagePath={data.imagePath} style={styles.image} />
      ) : null}

      <View style={styles.metaRow}>
        <Text style={styles.metaText}>{data.platform}</Text>
        <Text style={styles.metaDot}>·</Text>
        <Text style={styles.metaText}>
          {new Date(data.createdAt).toLocaleDateString()}
        </Text>
      </View>

      <Label>Title</Label>
      <Input
        value={title}
        onChangeText={(t) => {
          setTitle(t);
          setDirty(true);
        }}
        placeholder="Post title"
      />

      <Label>Caption</Label>
      <Input
        value={caption}
        onChangeText={(t) => {
          setCaption(t);
          setDirty(true);
        }}
        placeholder="Write your caption"
        multiline
        style={{ minHeight: 160 }}
      />

      <Label>Status</Label>
      <View style={styles.chipRow}>
        {STATUSES.map((s) => (
          <Chip
            key={s}
            label={s}
            selected={status === s}
            onPress={() => {
              setStatus(s);
              setDirty(true);
            }}
          />
        ))}
      </View>

      {data.permalink ? (
        <Card style={{ marginTop: 16 }}>
          <Text style={styles.permalinkLabel}>Published link</Text>
          <Text style={styles.permalink} numberOfLines={1}>
            {data.permalink}
          </Text>
        </Card>
      ) : null}

      {message ? (
        <View style={styles.messageRow}>
          <Feather name="check-circle" size={16} color={c.success} />
          <Text style={styles.messageText}>{message}</Text>
        </View>
      ) : null}
      {errMsg ? <Text style={styles.error}>{errMsg}</Text> : null}

      <Button
        title="Save changes"
        onPress={handleSave}
        loading={update.isPending}
        disabled={!dirty || !title.trim()}
        style={{ marginTop: 22 }}
      />

      {confirmDelete ? (
        <View style={styles.confirmRow}>
          <Button
            title="Cancel"
            variant="secondary"
            onPress={() => setConfirmDelete(false)}
            style={{ flex: 1 }}
          />
          <Button
            title="Delete forever"
            variant="destructive"
            onPress={handleDelete}
            loading={remove.isPending}
            style={{ flex: 1 }}
          />
        </View>
      ) : (
        <Button
          title="Delete"
          icon="trash-2"
          variant="outline"
          onPress={() => setConfirmDelete(true)}
          style={{ marginTop: 10 }}
        />
      )}
    </KeyboardAwareScrollViewCompat>
  );
}

const styles = StyleSheet.create({
  image: { width: "100%", aspectRatio: 1, borderRadius: colors.radius + 2 },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 14 },
  metaText: { fontFamily: fonts.medium, fontSize: 12, color: c.mutedForeground },
  metaDot: { color: c.mutedForeground },
  chipRow: { flexDirection: "row", gap: 8 },
  permalinkLabel: { fontFamily: fonts.semiBold, fontSize: 12, color: c.mutedForeground },
  permalink: { fontFamily: fonts.regular, fontSize: 13, color: c.primary, marginTop: 4 },
  messageRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 16,
  },
  messageText: { fontFamily: fonts.semiBold, fontSize: 13, color: c.success },
  error: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: c.destructive,
    marginTop: 12,
  },
  confirmRow: { flexDirection: "row", gap: 10, marginTop: 10 },
});
