import { Feather } from "@expo/vector-icons";
import { useAuth } from "@clerk/expo";
import * as Clipboard from "expo-clipboard";
import { useVideoPlayer, VideoView } from "expo-video";
import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  cancelVideoJob,
  useGenerateVideo,
  useGetAiSpendRates,
  useListFeatureFlags,
  useListVideoJobs,
  getGetAiSpendRatesQueryKey,
  getListFeatureFlagsQueryKey,
  getListVideoJobsQueryKey,
  type VideoJob,
  type VideoStoryboardScene,
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

/**
 * Mobile mirror of the web Video Studio's FinalShotPrompts: for finished
 * text-to-video jobs, each shot's AI-polished `renderVisual` (the exact prompt
 * that rendered) is revealed on demand with Copy and "Use as new brief"
 * actions. Renders nothing when no polish was stored (older jobs, or plans
 * rendered as approved).
 */
function FinalShotPrompts({
  scenes,
  onCopy,
  onUseAsBrief,
}: {
  scenes: VideoStoryboardScene[];
  onCopy: (text: string) => void;
  /** Prefill the text-to-video brief with this polished prompt. */
  onUseAsBrief: (text: string) => void;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const polished = scenes
    .map((scene, i) => ({ scene, shot: i + 1 }))
    .filter(({ scene }) => (scene.renderVisual ?? "").trim().length > 0);
  if (polished.length === 0) return null;
  return (
    <View style={{ gap: 8 }} testID="final-shot-prompts">
      <Text style={styles.promptsTitle}>Final shot prompts</Text>
      <Text style={styles.promptsHint}>
        Your approved shot text was polished by AI into the exact prompt each
        shot rendered from.
      </Text>
      {polished.map(({ scene, shot }) => (
        <View key={scene.id} style={styles.promptCard} testID={`final-prompt-scene-${scene.id}`}>
          <View style={styles.promptHeaderRow}>
            <Badge label={`Shot ${shot}`} tone="muted" />
            <Pressable
              onPress={() => {
                haptic();
                setOpen((o) => ({ ...o, [scene.id]: !o[scene.id] }));
              }}
              hitSlop={8}
              testID={`button-toggle-final-prompt-${scene.id}`}
            >
              <Text style={styles.promptToggleText}>
                {open[scene.id] ? "Hide final prompt" : "Show final prompt"}
              </Text>
            </Pressable>
          </View>
          <Text style={styles.promptLabel}>Your approved text</Text>
          <Text style={styles.promptText}>{scene.visual}</Text>
          {open[scene.id] ? (
            <View style={{ gap: 6 }} testID={`text-final-prompt-${scene.id}`}>
              <Text style={styles.promptLabel}>Final rendered prompt (AI-polished)</Text>
              <Text style={styles.promptText}>{scene.renderVisual}</Text>
              <View style={styles.promptActionsRow}>
                <Pressable
                  onPress={() => onCopy(scene.renderVisual ?? "")}
                  style={({ pressed }) => [styles.promptAction, pressed && { opacity: 0.7 }]}
                  testID={`button-copy-final-prompt-${scene.id}`}
                >
                  <Feather name="copy" size={13} color={c.foreground} />
                  <Text style={styles.promptActionText}>Copy</Text>
                </Pressable>
                <Pressable
                  onPress={() => onUseAsBrief(scene.renderVisual ?? "")}
                  style={({ pressed }) => [styles.promptAction, pressed && { opacity: 0.7 }]}
                  testID={`button-use-final-prompt-${scene.id}`}
                >
                  <Feather name="film" size={13} color={c.foreground} />
                  <Text style={styles.promptActionText}>Use as new brief</Text>
                </Pressable>
              </View>
            </View>
          ) : null}
        </View>
      ))}
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
  onCopyPrompt,
  onUseAsBrief,
}: {
  job: VideoJob;
  expanded: boolean;
  onToggle: () => void;
  aiSpend: string | null;
  cancelling: boolean;
  onCancel: () => void;
  onCopyPrompt: (text: string) => void;
  onUseAsBrief: (text: string) => void;
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
          {job.engine === "text_to_video" && job.storyboard ? (
            <FinalShotPrompts
              scenes={job.storyboard.scenes}
              onCopy={onCopyPrompt}
              onUseAsBrief={onUseAsBrief}
            />
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
  const [prompt, setPrompt] = useState("");
  const listRef = useRef<FlatList | null>(null);
  const generateVideo = useGenerateVideo();

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

  // Text-to-video briefs can be started (and re-used) right from mobile;
  // same kill switch as the web studio (default on, mirroring web).
  const videoGenEnabled = featureFlags.data?.videoGen ?? true;

  const handleGenerate = () => {
    if (!prompt.trim() || generateVideo.isPending) return;
    haptic();
    setNotice(null);
    generateVideo.mutate(
      { data: { engine: "text_to_video", prompt: prompt.trim() } },
      {
        onSuccess: () => {
          setPrompt("");
          setNotice("Video queued — it will show up below with its progress.");
          void jobsQuery.refetch();
        },
        onError: (err) => {
          const anyErr = err as { data?: { error?: string } | null; message?: string };
          setNotice(
            (anyErr?.data && typeof anyErr.data.error === "string" && anyErr.data.error) ||
              anyErr?.message ||
              "Couldn't start the video. Please try again.",
          );
        },
      },
    );
  };

  const handleCopyPrompt = async (text: string) => {
    try {
      await Clipboard.setStringAsync(text);
      haptic();
      setNotice("Prompt copied to your clipboard.");
    } catch {
      setNotice("Couldn't copy — select the text and copy it manually.");
    }
  };

  const handleUseAsBrief = (text: string) => {
    haptic();
    setPrompt(text);
    setNotice("Brief prefilled — tweak it and generate.");
    listRef.current?.scrollToOffset({ offset: 0, animated: true });
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      {videoGenEnabled ? (
        <View style={styles.composer}>
          <Text style={styles.composerTitle}>Text to Video</Text>
          <TextInput
            value={prompt}
            onChangeText={setPrompt}
            placeholder="Describe the video you want…"
            placeholderTextColor={c.mutedForeground}
            multiline
            style={styles.composerInput}
            testID="input-video-brief"
          />
          <Pressable
            onPress={handleGenerate}
            disabled={!prompt.trim() || generateVideo.isPending}
            style={({ pressed }) => [
              styles.composerButton,
              (!prompt.trim() || generateVideo.isPending) && { opacity: 0.5 },
              pressed && { opacity: 0.8 },
            ]}
            testID="button-generate-video"
          >
            {generateVideo.isPending ? (
              <ActivityIndicator size="small" color="#ffffff" />
            ) : (
              <Feather name="film" size={14} color="#ffffff" />
            )}
            <Text style={styles.composerButtonText}>Generate video</Text>
          </Pressable>
        </View>
      ) : null}
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
          ref={listRef}
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
              aiSpend={formatVideoAiSpend(
                videoRatePaise,
                item.units,
                // Charge-time snapshot wins over the current rate, but the
                // aiSpend kill switch still hides the line entirely.
                aiSpendEnabled ? item.chargedRatePaise : 0,
              )}
              cancelling={cancellingId === item.id}
              onCancel={() => void handleCancel(item.id)}
              onCopyPrompt={(text) => void handleCopyPrompt(text)}
              onUseAsBrief={handleUseAsBrief}
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
  composer: {
    margin: 20,
    marginBottom: 0,
    padding: 14,
    gap: 10,
    backgroundColor: c.card,
    borderRadius: colors.radius,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.border,
  },
  composerTitle: { fontFamily: fonts.semiBold, fontSize: 14, color: c.foreground },
  composerInput: {
    minHeight: 64,
    maxHeight: 140,
    padding: 10,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.border,
    backgroundColor: c.background,
    fontFamily: fonts.regular,
    fontSize: 13,
    color: c.foreground,
    textAlignVertical: "top",
  },
  composerButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: c.primary,
  },
  composerButtonText: { fontFamily: fonts.semiBold, fontSize: 13, color: "#ffffff" },
  promptsTitle: { fontFamily: fonts.semiBold, fontSize: 13, color: c.foreground },
  promptsHint: { fontFamily: fonts.regular, fontSize: 11, color: c.mutedForeground },
  promptCard: {
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.border,
    backgroundColor: c.muted,
    padding: 10,
    gap: 6,
  },
  promptHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  promptToggleText: { fontFamily: fonts.semiBold, fontSize: 12, color: c.primary },
  promptLabel: {
    fontFamily: fonts.semiBold,
    fontSize: 10,
    letterSpacing: 0.6,
    textTransform: "uppercase",
    color: c.mutedForeground,
  },
  promptText: { fontFamily: fonts.regular, fontSize: 12, color: c.foreground },
  promptActionsRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 2 },
  promptAction: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.border,
    backgroundColor: c.card,
  },
  promptActionText: { fontFamily: fonts.semiBold, fontSize: 12, color: c.foreground },
});
