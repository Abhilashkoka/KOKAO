import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import * as Linking from "expo-linking";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import React, { useEffect, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
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
  useRestartRetry,
  useResendLinkedinComments,
  useResendThreadsPosts,
  useResendTwitterPosts,
  useListSchedules,
  useCreateSchedule,
  useDeleteSchedule,
  getListSchedulesQueryKey,
} from "@workspace/api-client-react";
import { SchedulePicker } from "@/components/SchedulePicker";
import { ContentImage } from "@/components/ContentImage";
import { buildSplitWarnings } from "@/components/publishSplitWarnings";
import { buildExpiredNames, buildExpiredBannerText } from "@/components/expiredConnectionBanner";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { Button, Card, Chip, ErrorState, Input, Label, Skeleton } from "@/components/ui";
import colors from "@/constants/colors";
import { fonts } from "@/constants/fonts";

const c = colors.light;

const STATUSES = ["draft", "scheduled", "published"] as const;

// Amber tone for the "some pieces are still missing" warning blocks,
// matching the web app's pending-posts warnings.
const PENDING_TEXT = "#b45309";
const PENDING_BG = "#fffbeb";
const PENDING_BORDER = "#fcd34d";

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

  const { data: schedules } = useListSchedules({
    query: { queryKey: getListSchedulesQueryKey() },
  });
  const createSchedule = useCreateSchedule();
  const deleteSchedule = useDeleteSchedule();
  const [showSchedulePicker, setShowSchedulePicker] = useState(false);
  const [scheduleMsg, setScheduleMsg] = useState<string | null>(null);
  const [scheduleErr, setScheduleErr] = useState<string | null>(null);

  const existingSchedule = (schedules ?? []).find(
    (s) => s.contentItemId === contentId && s.status === "pending",
  );

  const publishFacebook = usePublishContentToFacebook();
  const publishInstagram = usePublishContentToInstagram();
  const publishLinkedin = usePublishContentToLinkedin();
  const publishTwitter = usePublishContentToTwitter();
  const publishThreads = usePublishContentToThreads();
  // Keeps the publish buttons disabled during the automatic one-shot retry
  // window, when the underlying mutation is not "pending" but a second tap
  // would race the scheduled retry and could double-post.
  const { isRetrying: publishRetryPending, run: runPublishWithRetry } = useRestartRetry();
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
  const [publishedLink, setPublishedLink] = useState<string | null>(null);

  const resendLinkedinComments = useResendLinkedinComments();
  const resendThreadsPosts = useResendThreadsPosts();
  const resendTwitterPosts = useResendTwitterPosts();
  const [resendMsg, setResendMsg] = useState<string | null>(null);
  const [resendErr, setResendErr] = useState<string | null>(null);
  const [resendLink, setResendLink] = useState<string | null>(null);

  const openLink = (url: string) => {
    haptic();
    if (Platform.OS === "web") {
      Linking.openURL(url);
    } else {
      WebBrowser.openBrowserAsync(url);
    }
  };

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
    publishThreads.isPending ||
    publishRetryPending;

  const captionText = caption.trim();
  const splitWarnings = buildSplitWarnings(captionText, {
    linkedinReady: liReady,
    twitterReady: twReady,
    threadsReady: thReady,
  });

  const expiredNames = buildExpiredNames({
    linkedinExpired: liExpired,
    twitterExpired: twExpired,
    threadsExpired: thExpired,
  });

  const linkedinPending = data?.linkedinCommentsPending ?? 0;
  const threadsPending = data?.threadsPostsPending ?? 0;
  const twitterPending = data?.twitterPostsPending ?? 0;
  const anyResendPending =
    resendLinkedinComments.isPending ||
    resendThreadsPosts.isPending ||
    resendTwitterPosts.isPending;

  const invalidateContent = () => {
    queryClient.invalidateQueries({ queryKey: getListContentQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetContentQueryKey(contentId) });
  };

  // Shown while the automatic one-shot retry (server-restart 503 or a
  // network blip) is pending. Server-side dedupe makes the retry safe.
  const restartRetryingMsg = (platform: string, reason: "restart" | "network" = "restart") =>
    reason === "network"
      ? `The connection blinked. Retrying the ${platform} publish automatically in a few seconds...`
      : `The server is restarting. Retrying the ${platform} publish automatically in a few seconds...`;
  const restartRetryFailedPrefix = "The automatic retry also failed. ";

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
    setPublishedLink(null);
    runPublishWithRetry(publishFacebook, { id: contentId }, {
      onSuccess: (res) => {
        setPublishMsg("Published to Facebook. Your post is live.");
        setPublishedLink(res?.permalink ?? null);
        invalidateContent();
      },
      onRetrying: (reason) => setPublishMsg(restartRetryingMsg("Facebook", reason)),
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
    setPublishedLink(null);
    runPublishWithRetry(publishInstagram, { id: contentId }, {
      onSuccess: () => {
        setPublishMsg(
          "Publishing to Instagram. This will update to Published once it's live.",
        );
        invalidateContent();
      },
      onRetrying: (reason) => setPublishMsg(restartRetryingMsg("Instagram", reason)),
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
    setPublishedLink(null);
    runPublishWithRetry(publishInstagram, { id: contentId }, {
      onSuccess: () => {
        setPublishMsg(
          "Retrying publish. Instagram is processing your image again — this will update to Published once it's live.",
        );
        invalidateContent();
      },
      onRetrying: (reason) => setPublishMsg(restartRetryingMsg("Instagram", reason)),
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
    setPublishedLink(null);
    runPublishWithRetry(publishLinkedin, { id: contentId }, {
      onSuccess: (res) => {
        if (res?.commentWarning) {
          setPublishMsg(null);
          setPublishErr(
            `Published to LinkedIn, but some comments failed. ${res.commentWarning} You can resend the missing comments below.`,
          );
        } else {
          const extra =
            res?.commentsPosted && res.commentsPosted > 0
              ? ` The rest of your caption was added as ${res.commentsPosted} comment(s).`
              : "";
          setPublishMsg(`Published to LinkedIn. Your post is live.${extra}`);
        }
        setPublishedLink(res?.permalink ?? null);
        invalidateContent();
      },
      onRetrying: (reason) => setPublishMsg(restartRetryingMsg("LinkedIn", reason)),
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
    setPublishedLink(null);
    runPublishWithRetry(publishTwitter, { id: contentId }, {
      onSuccess: (res) => {
        const extra =
          res?.tweetCount && res.tweetCount > 1
            ? ` Your caption was posted as a thread of ${res.tweetCount} tweets.`
            : "";
        setPublishMsg(`Published to X. Your post is live.${extra}`);
        setPublishedLink(res?.permalink ?? null);
        invalidateContent();
      },
      onRetrying: (reason) => setPublishMsg(restartRetryingMsg("X", reason)),
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
    setPublishedLink(null);
    runPublishWithRetry(publishThreads, { id: contentId }, {
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
        setPublishedLink(res?.permalink ?? null);
        invalidateContent();
      },
      onRetrying: (reason) => setPublishMsg(restartRetryingMsg("Threads", reason)),
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

  // A 409 means a resend for this post is already running (e.g. a rapid
  // double tap or another device) — nothing failed, so show a neutral
  // informational notice. Likewise, code "already_complete" means a
  // concurrent resend already posted everything — good news, so show a
  // positive notice and refresh the item so the warning disappears.
  const resendErrorNotice = (err: unknown, fallback: string) => {
    const e = err as {
      status?: number;
      data?: { error?: string; code?: string };
    } | null;
    const message = e?.data?.error;
    const code = e?.data?.code;
    if (code === "already_complete") {
      setResendMsg(
        "All posts are live — the missing pieces were already resent (possibly from another device or by a teammate).",
      );
      invalidateContent();
      return;
    }
    if (e?.status === 409) {
      setResendMsg(
        message ||
          "A resend for this post is already running. Wait for it to finish before trying again.",
      );
      return;
    }
    setResendErr(message || fallback);
  };

  const startResend = () => {
    haptic();
    setResendMsg(null);
    setResendErr(null);
    setResendLink(null);
  };

  const handleResendLinkedinComments = () => {
    startResend();
    resendLinkedinComments.mutate(
      { id: contentId },
      {
        onSuccess: (res) => {
          if (res?.commentWarning) {
            setResendErr(res.commentWarning);
          } else {
            setResendMsg(
              `All ${res?.commentsTotal ?? ""} follow-up comment(s) are now posted on LinkedIn.`,
            );
          }
          setResendLink(res?.permalink ?? null);
          invalidateContent();
        },
        onError: (err) =>
          resendErrorNotice(err, "Could not resend the LinkedIn comments. Try again."),
      },
    );
  };

  const handleResendThreadsPosts = () => {
    startResend();
    resendThreadsPosts.mutate(
      { id: contentId },
      {
        onSuccess: (res) => {
          if (res?.publishWarning) {
            setResendErr(res.publishWarning);
          } else {
            setResendMsg(
              `All ${res?.postsTotal ?? ""} post(s) of the thread are now live on Threads.`,
            );
          }
          setResendLink(res?.permalink ?? null);
          invalidateContent();
        },
        onError: (err) =>
          resendErrorNotice(err, "Could not resend the missing Threads posts. Try again."),
      },
    );
  };

  const handleResendTwitterPosts = () => {
    startResend();
    resendTwitterPosts.mutate(
      { id: contentId },
      {
        onSuccess: (res) => {
          if (res?.publishWarning) {
            setResendErr(res.publishWarning);
          } else {
            setResendMsg(
              `All ${res?.postsTotal ?? ""} post(s) of the thread are now live on X.`,
            );
          }
          setResendLink(res?.permalink ?? null);
          invalidateContent();
        },
        onError: (err) =>
          resendErrorNotice(err, "Could not resend the missing X posts. Try again."),
      },
    );
  };

  const handleScheduleConfirm = (platform: string, scheduledAt: Date) => {
    haptic();
    setScheduleMsg(null);
    setScheduleErr(null);
    createSchedule.mutate(
      {
        data: {
          contentItemId: contentId,
          platform,
          scheduledAt: scheduledAt.toISOString(),
        },
      },
      {
        onSuccess: () => {
          setShowSchedulePicker(false);
          // Keep any unsaved title/caption edits: only flip the local status,
          // never clear the dirty flag here (the server already set the
          // content status to "scheduled").
          setStatus("scheduled");
          setScheduleMsg(
            `Scheduled for ${scheduledAt.toLocaleString(undefined, {
              weekday: "short",
              day: "numeric",
              month: "short",
              hour: "2-digit",
              minute: "2-digit",
            })} on ${platform}.`,
          );
          queryClient.invalidateQueries({ queryKey: getListSchedulesQueryKey() });
          invalidateContent();
        },
        onError: (err) =>
          setScheduleErr(apiErrorText(err, "Could not schedule this post.")),
      },
    );
  };

  const handleCancelSchedule = () => {
    if (!existingSchedule) return;
    haptic();
    setScheduleMsg(null);
    setScheduleErr(null);
    deleteSchedule.mutate(
      { id: existingSchedule.id },
      {
        onSuccess: () => {
          update.mutate(
            { id: contentId, data: { status: "draft" } },
            {
              onSuccess: () => {
                setStatus("draft");
                setScheduleMsg("Schedule cancelled. This post is back to a draft.");
              },
              onError: () => {
                setScheduleErr(
                  "The schedule was cancelled, but the post status could not be reset. Pick a status and save changes.",
                );
              },
              onSettled: () => {
                queryClient.invalidateQueries({ queryKey: getListSchedulesQueryKey() });
                invalidateContent();
              },
            },
          );
        },
        onError: (err) =>
          setScheduleErr(apiErrorText(err, "Could not cancel the schedule.")),
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
              if (s === "scheduled") {
                // Scheduling needs a date and time — open the picker instead
                // of silently flipping the status. One pending schedule per
                // post: if one exists, point at it instead of adding another.
                if (existingSchedule) {
                  setScheduleErr(null);
                  setScheduleMsg(
                    "This post is already scheduled. Cancel the schedule below to pick a new time.",
                  );
                  return;
                }
                setScheduleMsg(null);
                setScheduleErr(null);
                setShowSchedulePicker(true);
                return;
              }
              setShowSchedulePicker(false);
              setStatus(s);
              setDirty(true);
            }}
          />
        ))}
      </View>

      {showSchedulePicker ? (
        <SchedulePicker
          defaultPlatform={data.platform}
          pending={createSchedule.isPending}
          onConfirm={handleScheduleConfirm}
          onCancel={() => setShowSchedulePicker(false)}
        />
      ) : null}

      {existingSchedule ? (
        <Card style={{ marginTop: 12 }}>
          <View style={styles.scheduleRow}>
            <Feather name="clock" size={16} color={c.primary} />
            <Text style={styles.scheduleText}>
              {`Scheduled for ${new Date(existingSchedule.scheduledAt).toLocaleString(undefined, {
                weekday: "short",
                day: "numeric",
                month: "short",
                hour: "2-digit",
                minute: "2-digit",
              })} on ${existingSchedule.platform}.`}
            </Text>
          </View>
          <Button
            title="Cancel schedule"
            icon="x"
            variant="outline"
            onPress={handleCancelSchedule}
            loading={deleteSchedule.isPending}
            style={{ marginTop: 10 }}
          />
        </Card>
      ) : null}

      {scheduleMsg ? (
        <View style={styles.messageRow}>
          <Feather name="check-circle" size={16} color={c.success} />
          <Text style={styles.messageText}>{scheduleMsg}</Text>
        </View>
      ) : null}
      {scheduleErr ? <Text style={styles.error}>{scheduleErr}</Text> : null}

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
            disabled={!data.imagePath || anyPublishPending}
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
                {buildExpiredBannerText(expiredNames)}
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

      {linkedinPending > 0 ? (
        <View style={styles.pendingBox}>
          <View style={styles.pendingRow}>
            <Feather name="alert-circle" size={14} color={PENDING_TEXT} />
            <Text style={styles.pendingText}>
              {`${linkedinPending} LinkedIn follow-up comment${linkedinPending === 1 ? "" : "s"} with the rest of the caption ${linkedinPending === 1 ? "is" : "are"} still missing from the published post.`}
            </Text>
          </View>
          <Button
            title={resendLinkedinComments.isPending ? "Resending..." : "Resend comments"}
            icon="rotate-cw"
            variant="outline"
            onPress={handleResendLinkedinComments}
            loading={resendLinkedinComments.isPending}
            disabled={anyResendPending && !resendLinkedinComments.isPending}
            style={{ marginTop: 10 }}
          />
        </View>
      ) : null}

      {threadsPending > 0 ? (
        <View style={styles.pendingBox}>
          <View style={styles.pendingRow}>
            <Feather name="alert-circle" size={14} color={PENDING_TEXT} />
            <Text style={styles.pendingText}>
              {`${threadsPending} Threads follow-up post${threadsPending === 1 ? "" : "s"} with the rest of the caption ${threadsPending === 1 ? "is" : "are"} still missing from the published thread.`}
            </Text>
          </View>
          <Button
            title={resendThreadsPosts.isPending ? "Resending..." : "Resend posts"}
            icon="rotate-cw"
            variant="outline"
            onPress={handleResendThreadsPosts}
            loading={resendThreadsPosts.isPending}
            disabled={anyResendPending && !resendThreadsPosts.isPending}
            style={{ marginTop: 10 }}
          />
        </View>
      ) : null}

      {twitterPending > 0 ? (
        <View style={styles.pendingBox}>
          <View style={styles.pendingRow}>
            <Feather name="alert-circle" size={14} color={PENDING_TEXT} />
            <Text style={styles.pendingText}>
              {`${twitterPending} X follow-up post${twitterPending === 1 ? "" : "s"} with the rest of the caption ${twitterPending === 1 ? "is" : "are"} still missing from the published thread.`}
            </Text>
          </View>
          <Button
            title={resendTwitterPosts.isPending ? "Resending..." : "Resend posts"}
            icon="rotate-cw"
            variant="outline"
            onPress={handleResendTwitterPosts}
            loading={resendTwitterPosts.isPending}
            disabled={anyResendPending && !resendTwitterPosts.isPending}
            style={{ marginTop: 10 }}
          />
        </View>
      ) : null}

      {resendMsg ? (
        <View style={styles.messageRow}>
          <Feather name="check-circle" size={16} color={c.success} />
          <Text style={styles.messageText}>{resendMsg}</Text>
        </View>
      ) : null}
      {resendErr ? <Text style={styles.error}>{resendErr}</Text> : null}

      {resendLink ? (
        <Button
          title="View post"
          icon="external-link"
          variant="secondary"
          onPress={() => openLink(resendLink)}
          style={{ marginTop: 10 }}
        />
      ) : null}

      {publishedLink ? (
        <Button
          title="View post"
          icon="external-link"
          variant="secondary"
          onPress={() => openLink(publishedLink)}
          style={{ marginTop: 10 }}
        />
      ) : null}

      {data.permalink ? (
        <Pressable
          onPress={() => openLink(data.permalink!)}
          accessibilityRole="link"
          accessibilityLabel="Open published post"
        >
          <Card style={{ marginTop: 16 }}>
            <View style={styles.permalinkRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.permalinkLabel}>Published link</Text>
                <Text style={styles.permalink} numberOfLines={1}>
                  {data.permalink}
                </Text>
              </View>
              <Feather name="external-link" size={16} color={c.primary} />
            </View>
          </Card>
        </Pressable>
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
  permalinkRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  permalinkLabel: { fontFamily: fonts.semiBold, fontSize: 12, color: c.mutedForeground },
  permalink: { fontFamily: fonts.regular, fontSize: 13, color: c.primary, marginTop: 4 },
  messageRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 16,
  },
  messageText: { fontFamily: fonts.semiBold, fontSize: 13, color: c.success },
  scheduleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  scheduleText: {
    flex: 1,
    fontFamily: fonts.medium,
    fontSize: 13,
    color: c.foreground,
  },
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
  pendingBox: {
    marginTop: 12,
    backgroundColor: PENDING_BG,
    borderColor: PENDING_BORDER,
    borderWidth: 1,
    borderRadius: colors.radius,
    padding: 10,
  },
  pendingRow: {
    flexDirection: "row",
    gap: 8,
  },
  pendingText: {
    flex: 1,
    fontFamily: fonts.regular,
    fontSize: 12,
    color: PENDING_TEXT,
    lineHeight: 17,
  },
  brokenText: {
    flex: 1,
    fontFamily: fonts.regular,
    fontSize: 12,
    color: c.destructive,
    lineHeight: 17,
  },
});
