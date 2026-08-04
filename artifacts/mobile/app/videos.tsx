import { Feather } from "@expo/vector-icons";
import { useAuth } from "@clerk/expo";
import { useVideoPlayer, VideoView } from "expo-video";
import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import {
  cancelVideoJob,
  useGetAiSpendRates,
  useListFeatureFlags,
  useListVideoJobs,
  getGetAiSpendRatesQueryKey,
  getListFeatureFlagsQueryKey,
  getListVideoJobsQueryKey,
  type VideoJob,
} from "@workspace/api-client-react";

import { ContentImage } from "@/components/ContentImage";
import { Badge, EmptyState, ErrorState, Skeleton } from "@/components/ui";
import colors from "@/constants/colors";
import { fonts } from "@/constants/fonts";
import { haptic } from "@/lib/haptics";
import { formatVideoAiSpend } from "@/lib/videoSpend";

const c = colors.light;
const domain = process.env.EXPO_PUBLIC_DOMAIN;

const ENGINE_TITLES: Record<string, string> = {
  text_to_video: "Text to Video",
  image_to_video: "Animate Photo",
  slideshow: "Photo Slideshow",
  topic_to_video: "Topic to Video",
};

/** Progress % from the job's REAL pipeline stage — mirrors the web Video Studio. */
const STAGE_PROGRESS: Record<string, number> = {
  "Getting started": 8,
  "Preparing your photos": 20,
  "Writing the script": 18,
  "Voicing the narration": 32,
  "Finding the right footage": 48,
  "Creating AI imagery": 48,
  "Filming your character": 48,
  "Sketching the storyboard": 55,
  "Saving the storyboard": 80,
  "Loading your storyboard": 12,
  "Animating your storyboard": 45,
  "Generating the video": 40,
  "Animating your image": 40,
  "Composing the slideshow": 55,
  "Composing the video": 70,
  "Running quality checks": 88,
  "Saving to your library": 96,
};

function stageProgress(job: VideoJob): number {
  if (job.status === "queued") return 5;
  return STAGE_PROGRESS[job.stage ?? ""] ?? 60;
}

function statusBadge(status: VideoJob["status"]): {
  label: string;
  tone: "muted" | "success" | "destructive" | "accent";
} {
  switch (status) {
    case "succeeded":
      return { label: "Ready", tone: "success" };
    case "failed":
      return { label: "Failed", tone: "destructive" };
    case "cancelled":
      return { label: "Cancelled", tone: "muted" };
    case "awaiting_review":
      return { label: "Awaiting review", tone: "accent" };
    case "processing":
      return { label: "Generating", tone: "accent" };
    default:
      return { label: "Queued", tone: "muted" };
  }
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/**
 * Inline player for a finished video. Storage is tenant-scoped behind Clerk,
 * so the stream request carries the same bearer token ContentImage uses.
 */
function JobVideoPlayer({ job }: { job: VideoJob }) {
  const { getToken } = useAuth();
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    getToken().then((t) => {
      if (mounted) setToken(t);
    });
    return () => {
      mounted = false;
    };
  }, [getToken]);

  const uri =
    domain && token && job.videoPath
      ? `https://${domain}/api/storage${job.videoPath}`
      : null;
  const player = useVideoPlayer(
    uri ? { uri, headers: { Authorization: `Bearer ${token}` } } : null,
  );

  // Portrait (9:16) is the common case; keep the player a sane height either way.
  const ratio = job.aspectRatio === "16:9" ? 16 / 9 : job.aspectRatio === "1:1" ? 1 : 9 / 16;
  return (
    <View style={[styles.playerWrap, { aspectRatio: ratio }]}>
      {uri ? (
        <VideoView
          player={player}
          style={StyleSheet.absoluteFill}
          contentFit="contain"
          nativeControls
        />
      ) : (
        <ActivityIndicator color="#ffffff" style={StyleSheet.absoluteFill} />
      )}
    </View>
  );
}

function JobCard({
  job,
  expanded,
  onToggle,
  aiSpend,
  cancelling,
  onCancel,
}: {
  job: VideoJob;
  expanded: boolean;
  onToggle: () => void;
  aiSpend: string | null;
  cancelling: boolean;
  onCancel: () => void;
}) {
  const badge = statusBadge(job.status);
  const running = job.status === "queued" || job.status === "processing";
  const playable = job.status === "succeeded" && !!job.videoPath;
  const title =
    job.prompt?.trim() || ENGINE_TITLES[job.engine] || "Video";

  return (
    <Pressable
      onPress={() => {
        if (!playable) return;
        haptic();
        onToggle();
      }}
      style={({ pressed }) => [styles.card, pressed && playable && { opacity: 0.9 }]}
      testID={`card-video-job-${job.id}`}
    >
      <View style={styles.cardRow}>
        {job.thumbnailPath ? (
          <ContentImage imagePath={job.thumbnailPath} style={styles.thumb} />
        ) : (
          <View style={[styles.thumb, styles.thumbFallback]}>
            <Feather name="film" size={18} color={c.mutedForeground} />
          </View>
        )}
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={styles.cardTitle} numberOfLines={2}>
            {title}
          </Text>
          <View style={styles.metaRow}>
            <Badge label={badge.label} tone={badge.tone} />
            <Text style={styles.metaText}>
              {ENGINE_TITLES[job.engine] ?? job.engine} · {formatWhen(job.createdAt)}
            </Text>
          </View>
        </View>
        {playable ? (
          <Feather
            name={expanded ? "chevron-up" : "play-circle"}
            size={22}
            color={c.primary}
          />
        ) : null}
      </View>

      {running ? (
        <View style={{ marginTop: 10, gap: 6 }}>
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${stageProgress(job)}%` }]} />
          </View>
          <Text style={styles.stageText}>
            {job.status === "queued" ? "Waiting to start…" : (job.stage ?? "Generating…")}
          </Text>
          {job.status === "queued" ? (
            <Pressable
              onPress={() => {
                if (cancelling) return;
                haptic();
                onCancel();
              }}
              disabled={cancelling}
              style={({ pressed }) => [
                styles.cancelButton,
                (pressed || cancelling) && { opacity: 0.6 },
              ]}
              testID={`button-cancel-video-job-${job.id}`}
            >
              {cancelling ? (
                <ActivityIndicator size="small" color={c.destructive} />
              ) : (
                <Feather name="x" size={14} color={c.destructive} />
              )}
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {job.status === "failed" && job.error ? (
        <Text style={styles.errorText}>{job.error}</Text>
      ) : null}
      {job.status === "awaiting_review" ? (
        <Text style={styles.stageText}>
          A storyboard is waiting for review — open KOKAO on the web to edit and render it.
        </Text>
      ) : null}

      {expanded && playable ? (
        <View style={{ marginTop: 12, gap: 8 }}>
          <JobVideoPlayer job={job} />
          {aiSpend ? (
            <Text style={styles.spendText} testID="text-video-ai-spent">
              AI amount spent: {aiSpend}
            </Text>
          ) : null}
        </View>
      ) : null}
    </Pressable>
  );
}

export default function VideosScreen() {
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [cancellingId, setCancellingId] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const jobsQuery = useListVideoJobs({
    query: {
      queryKey: getListVideoJobsQueryKey(),
      // Poll while anything is still generating so progress and the finished
      // video show up without the user leaving and reopening the screen.
      refetchInterval: (query) =>
        query.state.data?.some(
          (job) => job.status === "queued" || job.status === "processing",
        )
          ? 5000
          : false,
    },
  });

  // "AI amount spent" (kill-switch gated): only fetch the rates when the
  // aiSpend flag is on; a zero/absent rate renders nothing either way.
  const featureFlags = useListFeatureFlags({
    query: { queryKey: getListFeatureFlagsQueryKey(), staleTime: 60_000 },
  });
  const aiSpendEnabled = featureFlags.data?.aiSpend ?? false;
  const aiSpendRates = useGetAiSpendRates({
    query: {
      queryKey: getGetAiSpendRatesQueryKey(),
      staleTime: 60_000,
      enabled: aiSpendEnabled,
    },
  });
  const videoRatePaise = aiSpendEnabled ? (aiSpendRates.data?.videoPaise ?? 0) : 0;

  const jobs = jobsQuery.data;

  // Cancel a still-queued job. Mirrors the web Video Studio: a 409 means
  // generation already started, so the job will finish (and charge) normally.
  const handleCancel = async (jobId: number) => {
    if (cancellingId !== null) return;
    setCancellingId(jobId);
    setNotice(null);
    try {
      await cancelVideoJob(jobId);
      setNotice("Video cancelled — nothing was charged; any reserved credit was returned.");
    } catch (err) {
      const status = (err as { status?: number })?.status;
      setNotice(
        status === 409
          ? "Too late to cancel — generation already started, so it will finish normally."
          : "Couldn't cancel the video. It will finish normally.",
      );
    } finally {
      setCancellingId(null);
      void jobsQuery.refetch();
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      {jobsQuery.isLoading ? (
        <View style={{ padding: 20, gap: 12 }}>
          <Skeleton height={92} />
          <Skeleton height={92} />
          <Skeleton height={92} />
        </View>
      ) : jobsQuery.isError ? (
        <ErrorState
          message="Couldn't load your videos."
          onRetry={() => void jobsQuery.refetch()}
        />
      ) : !jobs || jobs.length === 0 ? (
        <EmptyState
          icon="video"
          title="No videos yet"
          subtitle="Videos you generate in KOKAO show up here with their progress."
        />
      ) : (
        <FlatList
          ListHeaderComponent={
            notice ? (
              <Pressable
                onPress={() => setNotice(null)}
                style={styles.noticeBanner}
                testID="banner-video-cancel-notice"
              >
                <Text style={styles.noticeText}>{notice}</Text>
              </Pressable>
            ) : null
          }
          data={jobs}
          keyExtractor={(job) => String(job.id)}
          contentContainerStyle={{ padding: 20, gap: 12, paddingBottom: 40 }}
          refreshControl={
            <RefreshControl
              refreshing={jobsQuery.isRefetching}
              onRefresh={() => void jobsQuery.refetch()}
              tintColor={c.primary}
            />
          }
          renderItem={({ item }) => (
            <JobCard
              job={item}
              expanded={expandedId === item.id}
              onToggle={() =>
                setExpandedId((prev) => (prev === item.id ? null : item.id))
              }
              aiSpend={formatVideoAiSpend(videoRatePaise, item.units)}
              cancelling={cancellingId === item.id}
              onCancel={() => void handleCancel(item.id)}
            />
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: c.card,
    borderRadius: colors.radius,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.border,
    padding: 14,
  },
  cardRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  thumb: { width: 52, height: 52, borderRadius: 10 },
  thumbFallback: {
    backgroundColor: c.muted,
    alignItems: "center",
    justifyContent: "center",
  },
  cardTitle: { fontFamily: fonts.semiBold, fontSize: 14, color: c.foreground },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  metaText: { fontFamily: fonts.regular, fontSize: 12, color: c.mutedForeground },
  progressTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: c.muted,
    overflow: "hidden",
  },
  progressFill: { height: "100%", borderRadius: 3, backgroundColor: c.primary },
  stageText: {
    marginTop: 8,
    fontFamily: fonts.regular,
    fontSize: 12,
    color: c.mutedForeground,
  },
  errorText: {
    marginTop: 8,
    fontFamily: fonts.regular,
    fontSize: 12,
    color: c.destructive,
  },
  playerWrap: {
    width: "100%",
    maxHeight: 420,
    borderRadius: 12,
    overflow: "hidden",
    backgroundColor: "#000000",
    alignSelf: "center",
  },
  spendText: { fontFamily: fonts.regular, fontSize: 12, color: c.mutedForeground },
  cancelButton: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 6,
    marginTop: 4,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.destructive,
  },
  cancelText: { fontFamily: fonts.semiBold, fontSize: 12, color: c.destructive },
  noticeBanner: {
    backgroundColor: c.muted,
    borderRadius: colors.radius,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.border,
    padding: 12,
    marginBottom: 12,
  },
  noticeText: { fontFamily: fonts.regular, fontSize: 12, color: c.foreground },
});
