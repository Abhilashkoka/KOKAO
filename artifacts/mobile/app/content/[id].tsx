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
  usePublishContentToFacebook,
  usePublishContentToInstagram,
  useGetFacebookCredentials,
  useGetInstagramCredentials,
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

  const { data, isLoading, isError, error, refetch } = useGetContent(contentId, {
    query: {
      queryKey: getGetContentQueryKey(contentId),
      // Instagram publishes asynchronously (the item sits in "publishing"
      // while Meta processes the image). Poll so the screen flips to
      // published/failed without a manual refresh.
      refetchInterval: (query) =>
        query.state.data?.status === "publishing" ? 4000 : false,
    },
  });
  const update = useUpdateContent();
  const remove = useDeleteContent();

  const publishFacebook = usePublishContentToFacebook();
  const publishInstagram = usePublishContentToInstagram();
  const { data: fbCreds } = useGetFacebookCredentials();
  const { data: igCreds } = useGetInstagramCredentials();

  const [title, setTitle] = useState("");
  const [caption, setCaption] = useState("");
  const [status, setStatus] = useState<string>("draft");
  const [dirty, setDirty] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [publishMsg, setPublishMsg] = useState<string | null>(null);
  const [publishErr, setPublishErr] = useState<string | null>(null);

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

  const apiErrorText = (err: unknown, fallback: string) => {
    const data = (err as { data?: { error?: string } } | null)?.data;
    return data?.error || (err as Error | null)?.message || fallback;
  };

  const fbReady = fbCreds?.verifyStatus === "verified";
  const igReady = igCreds?.verifyStatus === "verified";
  const fbBroken = !!fbCreds?.saved && fbCreds?.verifyStatus === "failed";
  const igBroken = !!igCreds?.saved && igCreds?.verifyStatus === "failed";

  const invalidateContent = () => {
    queryClient.invalidateQueries({ queryKey: getListContentQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetContentQueryKey(contentId) });
  };

  const handlePublishFacebook = () => {
    haptic();
    setPublishMsg(null);
    setPublishErr(null);
    publishFacebook.mutate(
      { id: contentId },
      {
        onSuccess: () => {
          setPublishMsg("Published to Facebook. Your post is live.");
          invalidateContent();
        },
        onError: (err) => {
          setPublishErr(
            apiErrorText(
              err,
              "Could not publish to Facebook. Check your Page connection on the web app.",
            ),
          );
        },
      },
    );
  };

  const handlePublishInstagram = () => {
    haptic();
    setPublishMsg(null);
    setPublishErr(null);
    publishInstagram.mutate(
      { id: contentId },
      {
        onSuccess: () => {
          setPublishMsg(
            "Publishing to Instagram. This will update to Published once it's live.",
          );
          invalidateContent();
        },
        onError: (err) => {
          setPublishErr(
            apiErrorText(
              err,
              "Could not publish to Instagram. Check your Instagram connection on the web app.",
            ),
          );
        },
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

      <View style={{ marginTop: 16 }}>
        <Label>Publish</Label>
      </View>
      {data.status === "publishing" ? (
        <Card>
          <Text style={styles.publishNote}>
            Instagram is processing this post. It will switch to Published once
            it&apos;s live.
          </Text>
        </Card>
      ) : (
        <>
          {fbReady || igReady ? (
            <View style={styles.publishRow}>
              {fbReady ? (
                <Button
                  title="Facebook"
                  icon="facebook"
                  variant="secondary"
                  onPress={handlePublishFacebook}
                  loading={publishFacebook.isPending}
                  disabled={publishInstagram.isPending}
                  style={{ flex: 1 }}
                />
              ) : null}
              {igReady ? (
                <Button
                  title="Instagram"
                  icon="instagram"
                  variant="secondary"
                  onPress={handlePublishInstagram}
                  loading={publishInstagram.isPending}
                  disabled={publishFacebook.isPending || !data.imagePath}
                  style={{ flex: 1 }}
                />
              ) : null}
            </View>
          ) : null}
          {igReady && !data.imagePath ? (
            <Text style={styles.publishHint}>
              Instagram needs an image. Generate one for this post in the Studio
              first.
            </Text>
          ) : null}
          {fbBroken || igBroken ? (
            <View style={styles.brokenBox}>
              <Feather name="alert-triangle" size={14} color={c.destructive} />
              <Text style={styles.brokenText}>
                {fbBroken && igBroken
                  ? "Your Facebook and Instagram connections stopped working. Reconnect them from KOKAO on the web."
                  : fbBroken
                    ? "Your Facebook Page connection stopped working. Reconnect it from KOKAO on the web."
                    : "Your Instagram connection stopped working. Reconnect it from KOKAO on the web."}
              </Text>
            </View>
          ) : null}
          {!fbReady && !igReady && !fbBroken && !igBroken ? (
            <Text style={styles.publishHint}>
              No verified accounts to publish to. Connect Facebook or Instagram
              from KOKAO on the web.
            </Text>
          ) : null}
        </>
      )}

      {publishMsg ? (
        <View style={styles.messageRow}>
          <Feather name="check-circle" size={16} color={c.success} />
          <Text style={styles.messageText}>{publishMsg}</Text>
        </View>
      ) : null}
      {publishErr ? <Text style={styles.error}>{publishErr}</Text> : null}

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
  publishRow: { flexDirection: "row", gap: 10 },
  publishHint: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: c.mutedForeground,
    marginTop: 8,
    lineHeight: 17,
  },
  publishNote: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: c.mutedForeground,
    lineHeight: 18,
  },
  brokenBox: {
    flexDirection: "row",
    gap: 8,
    marginTop: 8,
    backgroundColor: "#fdecec",
    borderRadius: colors.radius,
    padding: 10,
  },
  brokenText: {
    flex: 1,
    fontFamily: fonts.regular,
    fontSize: 12,
    color: c.destructive,
    lineHeight: 17,
  },
});
