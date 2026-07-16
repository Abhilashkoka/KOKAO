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
  usePublishContentToLinkedin,
  usePublishContentToTwitter,
  usePublishContentToThreads,
  useGetFacebookCredentials,
  useGetInstagramCredentials,
  useGetLinkedinStatus,
  useGetTwitterStatus,
  useGetThreadsStatus,
  getListContentQueryKey,
  getGetContentQueryKey,
  mutateWithRestartRetry,
} from "@workspace/api-client-react";
import {
  TWEET_MAX_LENGTH,
  THREADS_MAX_LENGTH,
  splitForLinkedin,
  splitIntoTweets,
  chunkOnWhitespace,
  isOverLinkedinLimit,
} from "@workspace/social-limits";

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
  const publishLinkedin = usePublishContentToLinkedin();
  const publishTwitter = usePublishContentToTwitter();
  const publishThreads = usePublishContentToThreads();
  const { data: fbCreds } = useGetFacebookCredentials();
  const { data: igCreds } = useGetInstagramCredentials();
  const { data: liStatus } = useGetLinkedinStatus();
  const { data: twStatus } = useGetTwitterStatus();
  const { data: thStatus } = useGetThreadsStatus();

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
  const liReady = !!liStatus?.connected && !liStatus?.expired;
  const twReady = !!twStatus?.connected && !twStatus?.expired;
  const thReady = !!thStatus?.connected && !thStatus?.expired;
  const liExpired = !!liStatus?.expired;
  const twExpired = !!twStatus?.expired;
  const thExpired = !!thStatus?.expired;

  const anyPublishPending =
    publishFacebook.isPending ||
    publishInstagram.isPending ||
    publishLinkedin.isPending ||
    publishTwitter.isPending ||
    publishThreads.isPending;

  const captionText = caption.trim();
  const liSplit = splitForLinkedin(captionText);
  const tweetChunks = splitIntoTweets(captionText);
  const threadsChunks = chunkOnWhitespace(captionText, THREADS_MAX_LENGTH);
  const splitWarnings: string[] = [];
  if (liReady && isOverLinkedinLimit(captionText)) {
    splitWarnings.push(
      `LinkedIn: this caption is over the limit, so the rest will be added as ${liSplit.comments.length} comment(s).`,
    );
  }
  if (twReady && captionText.length > TWEET_MAX_LENGTH) {
    splitWarnings.push(
      `X: this caption is over the ${TWEET_MAX_LENGTH}-character limit, so it will post as a thread of ${tweetChunks.length} tweets.`,
    );
  }
  if (thReady && captionText.length > THREADS_MAX_LENGTH) {
    splitWarnings.push(
      `Threads: this caption is over the ${THREADS_MAX_LENGTH}-character limit, so it will post as a chain of ${threadsChunks.length} connected posts.`,
    );
  }

  const expiredNames = [
    liExpired ? "LinkedIn" : null,
    twExpired ? "X" : null,
    thExpired ? "Threads" : null,
  ].filter((n): n is string => n !== null);

  const invalidateContent = () => {
    queryClient.invalidateQueries({ queryKey: getListContentQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetContentQueryKey(contentId) });
  };

  // Shown while the automatic one-shot retry (server-restart 503) is pending.
  const restartRetryingMsg = (platform: string) =>
    `The server is restarting. Retrying the ${platform} publish automatically in a few seconds...`;
  const restartRetryFailedPrefix =
    "The automatic retry after the server restart also failed. ";

  const publishErrText = (
    err: unknown,
    retried: boolean,
    fallback: string,
  ) => {
    if (retried) setPublishMsg(null);
    return (retried ? restartRetryFailedPrefix : "") + apiErrorText(err, fallback);
  };

  const handlePublishFacebook = () => {
    haptic();
    setPublishMsg(null);
    setPublishErr(null);
    mutateWithRestartRetry(publishFacebook, { id: contentId }, {
      onSuccess: () => {
        setPublishMsg("Published to Facebook. Your post is live.");
        invalidateContent();
      },
      onRetrying: () => setPublishMsg(restartRetryingMsg("Facebook")),
      onError: (err, { retried }) => {
        setPublishErr(
          publishErrText(
            err,
            retried,
            "Could not publish to Facebook. Check your Page connection on the web app.",
          ),
        );
      },
    });
  };

  const handlePublishInstagram = () => {
    haptic();
    setPublishMsg(null);
    setPublishErr(null);
    mutateWithRestartRetry(publishInstagram, { id: contentId }, {
      onSuccess: () => {
        setPublishMsg(
          "Publishing to Instagram. This will update to Published once it's live.",
        );
        invalidateContent();
      },
      onRetrying: () => setPublishMsg(restartRetryingMsg("Instagram")),
      onError: (err, { retried }) => {
        setPublishErr(
          publishErrText(
            err,
            retried,
            "Could not publish to Instagram. Check your Instagram connection on the web app.",
          ),
        );
      },
    });
  };

  // One-click retry for a failed Instagram publish. Re-uses the same publish
  // endpoint, which flips the item back to "publishing"; the screen's polling
  // then picks up the new state.
  const handleRetryInstagram = () => {
    haptic();
    setPublishMsg(null);
    setPublishErr(null);
    mutateWithRestartRetry(publishInstagram, { id: contentId }, {
      onSuccess: () => {
        setPublishMsg(
          "Retrying publish. Instagram is processing your image again — this will update to Published once it's live.",
        );
        invalidateContent();
      },
      onRetrying: () => setPublishMsg(restartRetryingMsg("Instagram")),
      onError: (err, { retried }) => {
        setPublishErr(
          publishErrText(
            err,
            retried,
            "Could not retry the Instagram publish. Check your Instagram connection on the web app.",
          ),
        );
      },
    });
  };

  const handlePublishLinkedin = () => {
    haptic();
    setPublishMsg(null);
    setPublishErr(null);
    mutateWithRestartRetry(publishLinkedin, { id: contentId }, {
      onSuccess: (res) => {
        if (res?.commentWarning) {
          setPublishMsg(null);
          setPublishErr(
            `Published to LinkedIn, but some comments failed. ${res.commentWarning} You can resend the missing comments from the web library.`,
          );
        } else {
          const extra =
            res?.commentsPosted && res.commentsPosted > 0
              ? ` The rest of your caption was added as ${res.commentsPosted} comment(s).`
              : "";
          setPublishMsg(`Published to LinkedIn. Your post is live.${extra}`);
        }
        invalidateContent();
      },
      onRetrying: () => setPublishMsg(restartRetryingMsg("LinkedIn")),
      onError: (err, { retried }) => {
        setPublishErr(
          publishErrText(
            err,
            retried,
            "Could not publish to LinkedIn. Check your LinkedIn connection on the web app.",
          ),
        );
      },
    });
  };

  const handlePublishTwitter = () => {
    haptic();
    setPublishMsg(null);
    setPublishErr(null);
    mutateWithRestartRetry(publishTwitter, { id: contentId }, {
      onSuccess: (res) => {
        const extra =
          res?.tweetCount && res.tweetCount > 1
            ? ` Your caption was posted as a thread of ${res.tweetCount} tweets.`
            : "";
        setPublishMsg(`Published to X. Your post is live.${extra}`);
        invalidateContent();
      },
      onRetrying: () => setPublishMsg(restartRetryingMsg("X")),
      onError: (err, { retried }) => {
        setPublishErr(
          publishErrText(
            err,
            retried,
            "Could not publish to X. Check your X connection on the web app.",
          ),
        );
      },
    });
  };

  const handlePublishThreads = () => {
    haptic();
    setPublishMsg(null);
    setPublishErr(null);
    mutateWithRestartRetry(publishThreads, { id: contentId }, {
      onSuccess: (res) => {
        if (res?.publishWarning) {
          setPublishMsg(null);
          setPublishErr(
            `Published to Threads, but some follow-up posts failed. ${res.publishWarning}`,
          );
        } else {
          const extra =
            res?.postsPublished && res.postsPublished > 1
              ? ` Your caption was posted as a chain of ${res.postsPublished} connected posts.`
              : "";
          setPublishMsg(`Published to Threads. Your post is live.${extra}`);
        }
        invalidateContent();
      },
      onRetrying: () => setPublishMsg(restartRetryingMsg("Threads")),
      onError: (err, { retried }) => {
        setPublishErr(
          publishErrText(
            err,
            retried,
            "Could not publish to Threads. Check your Threads connection on the web app.",
          ),
        );
      },
    });
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
      ) : data.status === "failed" ? (
        <>
          <View style={styles.brokenBox}>
            <Feather name="alert-triangle" size={14} color={c.destructive} />
            <Text style={styles.brokenText}>
              {data.failureReason
                ? `The Instagram publish failed: ${data.failureReason}`
                : "The Instagram publish failed."}
            </Text>
          </View>
          <Button
            title="Retry Instagram publish"
            icon="refresh-cw"
            onPress={handleRetryInstagram}
            loading={publishInstagram.isPending}
            disabled={!data.imagePath}
            style={{ marginTop: 10 }}
          />
          {!data.imagePath ? (
            <Text style={styles.publishHint}>
              Instagram needs an image. Generate one for this post in the
              Studio first.
            </Text>
          ) : null}
          {igBroken ? (
            <Text style={styles.publishHint}>
              Your Instagram connection stopped working. Reconnect it from
              KOKAO on the web before retrying.
            </Text>
          ) : null}
        </>
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
                  disabled={anyPublishPending && !publishFacebook.isPending}
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
                  disabled={
                    (anyPublishPending && !publishInstagram.isPending) ||
                    !data.imagePath
                  }
                  style={{ flex: 1 }}
                />
              ) : null}
            </View>
          ) : null}
          {liReady || twReady || thReady ? (
            <View style={[styles.publishRow, fbReady || igReady ? { marginTop: 10 } : null]}>
              {liReady ? (
                <Button
                  title="LinkedIn"
                  icon="linkedin"
                  variant="secondary"
                  onPress={handlePublishLinkedin}
                  loading={publishLinkedin.isPending}
                  disabled={anyPublishPending && !publishLinkedin.isPending}
                  style={{ flex: 1 }}
                />
              ) : null}
              {twReady ? (
                <Button
                  title="X"
                  icon="twitter"
                  variant="secondary"
                  onPress={handlePublishTwitter}
                  loading={publishTwitter.isPending}
                  disabled={anyPublishPending && !publishTwitter.isPending}
                  style={{ flex: 1 }}
                />
              ) : null}
              {thReady ? (
                <Button
                  title="Threads"
                  icon="at-sign"
                  variant="secondary"
                  onPress={handlePublishThreads}
                  loading={publishThreads.isPending}
                  disabled={anyPublishPending && !publishThreads.isPending}
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
          {splitWarnings.map((w) => (
            <Text key={w} style={styles.publishHint}>
              {w} Your full message is preserved.
            </Text>
          ))}
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
          {expiredNames.length > 0 ? (
            <View style={styles.brokenBox}>
              <Feather name="alert-triangle" size={14} color={c.destructive} />
              <Text style={styles.brokenText}>
                {`Your ${expiredNames.join(" and ")} connection${expiredNames.length > 1 ? "s" : ""} expired. Reconnect ${expiredNames.length > 1 ? "them" : "it"} from KOKAO on the web.`}
              </Text>
            </View>
          ) : null}
          {!fbReady &&
          !igReady &&
          !liReady &&
          !twReady &&
          !thReady &&
          !fbBroken &&
          !igBroken &&
          expiredNames.length === 0 ? (
            <Text style={styles.publishHint}>
              No verified accounts to publish to. Connect your social accounts
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
