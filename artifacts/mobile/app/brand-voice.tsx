import { Feather } from "@expo/vector-icons";
import { useAuth } from "@clerk/expo";
import { useAudioPlayer, useAudioRecorder, RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync } from "expo-audio";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListBrandKits,
  useGetBrandKit,
  useGetBrandVoiceStatus,
  usePreviewBrandVoice,
  useRemoveBrandVoice,
  useCloneBrandVoice,
  useRequestUploadUrl,
  useCreateBrandKitVersion,
  useCreateBrandVoiceAudio,
  useGetMe,
  useWalletGetOverview,
  useWalletRecharge,
  useWalletVerifyRecharge,
  WalletRechargeOrderGateway,
  getListBrandKitsQueryKey,
  getGetBrandKitQueryKey,
  getGetBrandVoiceStatusQueryKey,
  getWalletGetOverviewQueryKey,
  type BrandKitPayload,
} from "@workspace/api-client-react";
import {
  RazorpayCheckoutModal,
  type CheckoutRequest,
} from "@/components/RazorpayCheckoutModal";
import { verifyFailureNotice } from "@/lib/verifyFailureNotice";

import { useWalletBilling } from "@/components/QuotaInfoSheet";
import { Button, Card, Chip, EmptyState, ErrorState, Label, Skeleton } from "@/components/ui";
import colors from "@/constants/colors";
import { fonts } from "@/constants/fonts";
import { apiErrorMessage } from "@/lib/apiErrorMessage";
import { haptic } from "@/lib/haptics";

const c = colors.light;
const domain = process.env.EXPO_PUBLIC_DOMAIN;

/** The six stock narration voices (mirrors the web Brand Kit picker). */
const STOCK_VOICES: { value: string; label: string; hint: string }[] = [
  { value: "alloy", label: "Alloy", hint: "balanced" },
  { value: "echo", label: "Echo", hint: "calm" },
  { value: "fable", label: "Fable", hint: "expressive" },
  { value: "onyx", label: "Onyx", hint: "deep" },
  { value: "nova", label: "Nova", hint: "bright" },
  { value: "shimmer", label: "Shimmer", hint: "warm" },
];

/** Mirrors the web app's voice-clone sample bounds. */
const VOICE_SAMPLE_MIN_SECONDS = 20;
const VOICE_SAMPLE_MAX_SECONDS = 90;
const VOICE_SAMPLE_MAX_BYTES = 15 * 1024 * 1024; // 15 MB

/**
 * Maximum time (ms) to wait for a voice-sample PUT before giving up and
 * surfacing a network-error message.  expo-file-system/legacy has no cancel
 * API for uploadAsync, so a timeout race is the only escape hatch when the
 * device loses connectivity mid-transfer without emitting an error.
 */
const UPLOAD_TIMEOUT_MS = 60_000; // 60 s

type VoiceSampleIssue = "too-short" | "too-long" | "too-large" | "too-quiet" | "clipped" | "noisy";

const VOICE_SAMPLE_ISSUE_MESSAGES: Record<VoiceSampleIssue, string> = {
  "too-short": `The recording is shorter than ${VOICE_SAMPLE_MIN_SECONDS} seconds. Very short samples usually produce a clone that doesn't sound like you — aim for 30–60 seconds.`,
  "too-long": `The recording is longer than ${VOICE_SAMPLE_MAX_SECONDS} seconds. Extra length doesn't help the clone and can slow things down — 30–60 seconds is the sweet spot.`,
  "too-large": "The file is larger than 15 MB. Try recording at a lower quality or shortening the sample — 30–60 seconds is plenty.",
  "too-quiet":
    "The recording is very quiet. A near-silent sample tends to produce a flat, mumbly clone — re-record closer to the microphone at your normal speaking volume.",
  clipped:
    "The recording is too loud and sounds distorted (the audio is clipping). A crackly, overdriven sample makes the clone sound harsh — re-record a little further from the microphone or lower the input level.",
  noisy:
    "There's a lot of steady background noise in the recording (like a fan, traffic, or music). The clone will pick up that hiss — re-record somewhere quieter with soft furnishings.",
};

// ── Audio-quality thresholds (mirror web analyzeVoiceSample) ─────────────────
// Metering values from expo-audio are in dBFS (0 = full scale, negative = quieter).
// Convert: amplitude = 10^(dBFS / 20)

/** Average amplitude below this → too quiet. (RMS 0.01 → −40 dBFS) */
const METERING_MIN_AMP = 0.01;
/** Amplitude at or above this counts as clipped. (0.985 linear → −0.13 dBFS ≈ −1 dBFS) */
const METERING_CLIP_AMP = Math.pow(10, -1 / 20); // ≈ 0.891
/** If more than this fraction of readings are clipped → distorted. */
const METERING_MAX_CLIP_RATIO = 0.01;
/** Noise-floor / speech-level ratio above this → noisy. */
const METERING_MAX_NOISE_RATIO = 0.25;
/** Absolute noise-floor amplitude must exceed this before the ratio fires. (0.02 linear) */
const METERING_MIN_NOISE_FLOOR_AMP = 0.02;

/**
 * Analyze metering samples collected during recording and return quality
 * issues, mirroring the web app's analyzeVoiceSample heuristics.
 *
 * @param meteringDb Array of dBFS readings (negative numbers; 0 = full scale).
 */
function analyzeVoiceSampleFromMetering(meteringDb: number[]): VoiceSampleIssue[] {
  const issues: VoiceSampleIssue[] = [];
  if (meteringDb.length < 4) return issues; // not enough data to be meaningful

  // Convert each dBFS reading to a linear amplitude value.
  const amps = meteringDb.map((db) => Math.pow(10, db / 20));

  const meanAmp = amps.reduce((a, b) => a + b, 0) / amps.length;

  if (meanAmp < METERING_MIN_AMP) {
    issues.push("too-quiet");
    return issues; // no point checking noise on a silent track
  }

  const clippedCount = amps.filter((a) => a >= METERING_CLIP_AMP).length;
  if (clippedCount / amps.length > METERING_MAX_CLIP_RATIO) {
    issues.push("clipped");
    return issues; // clipped track — noise check would be misleading
  }

  // Noise-floor heuristic: compare the quietest 20 % of readings (pauses /
  // room noise) against the loudest 20 % (speech peaks). A high ratio means
  // there is substantial steady background noise.
  const sorted = [...amps].sort((a, b) => a - b);
  const tail = Math.max(1, Math.floor(sorted.length * 0.2));
  const mean = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const noiseFloor = mean(sorted.slice(0, tail));
  const speechLevel = mean(sorted.slice(-tail));

  if (
    speechLevel >= METERING_MIN_AMP &&
    noiseFloor >= METERING_MIN_NOISE_FLOOR_AMP &&
    noiseFloor / speechLevel > METERING_MAX_NOISE_RATIO
  ) {
    issues.push("noisy");
  }

  return issues;
}

/**
 * A ~60-second, brand-neutral read designed for voice-clone quality.
 */
const VOICE_RECORDING_SCRIPT = `Hi there — thanks for listening in. I'd like to tell you a little about how I work and what a typical week looks like for me.

Most mornings I start around seven thirty with a cup of coffee and a quick look at my plans for the day. On March 3rd, 2025, I remember jotting down twelve ideas in about fifteen minutes — some good, some questionable, all worth exploring.

Have you ever noticed how the best ideas show up when you least expect them? Maybe in the shower, on a walk, or halfway through a completely unrelated conversation. That's exactly why I always keep a notebook nearby — it's saved me more times than I can count!

Whether it's a big launch or a small everyday win, I genuinely enjoy sharing the journey. So here's to clear thinking, honest stories, and just a touch of curiosity in everything we make together.`;

const VOICE_RECORDING_TIPS = [
  "Record in a quiet room with soft furnishings — no echo, fans, or background music.",
  "Keep your phone about 15 cm (6 inches) from your mouth.",
  "Read at your natural, conversational pace — don't whisper or over-act.",
  "Let your voice move naturally with the questions and exclamations.",
  "Do it in one continuous take and avoid long pauses; small stumbles are fine.",
];

function formatElapsed(total: number) {
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export default function BrandVoiceScreen() {
  const queryClient = useQueryClient();
  const { getToken } = useAuth();
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => {
    let mounted = true;
    getToken().then((t) => {
      if (mounted) setToken(t);
    });
    return () => { mounted = false; };
  }, [getToken]);

  const kitsQuery = useListBrandKits(undefined, {
    query: { queryKey: getListBrandKitsQueryKey() },
  });
  const status = useGetBrandVoiceStatus({
    query: { queryKey: getGetBrandVoiceStatusQueryKey() },
  });

  const kits = React.useMemo(
    () => (kitsQuery.data ?? []).filter((k) => !k.isArchived),
    [kitsQuery.data],
  );
  const [selectedKitId, setSelectedKitId] = useState<number | null>(null);
  const kitId =
    selectedKitId ??
    kits.find((k) => k.isDefault)?.id ??
    kits[0]?.id ??
    null;

  const detailQuery = useGetBrandKit(kitId ?? 0, {
    query: {
      queryKey: getGetBrandKitQueryKey(kitId ?? 0),
      enabled: kitId !== null,
    },
  });
  const detail = detailQuery.data;
  const activePayload = detail?.activeVersion?.payload;
  const brandVoice = activePayload?.brand_voice ?? null;
  const cloned = brandVoice?.mode === "cloned" && !!brandVoice.provider_voice_id;

  const featureOff = status.data ? !status.data.enabled : false;
  const unconfigured = status.data ? !status.data.configured : false;
  const cloningBlocked = featureOff || unconfigured;

  // Local edits to the stock voice / delivery style.
  const [presetVoice, setPresetVoice] = useState<string | null>(null);
  const [deliveryStyle, setDeliveryStyle] = useState<string | null>(null);
  useEffect(() => {
    setPresetVoice(null);
    setDeliveryStyle(null);
  }, [kitId]);
  const effectiveVoice = presetVoice ?? brandVoice?.preset_voice ?? "alloy";
  const effectiveStyle = deliveryStyle ?? brandVoice?.delivery_style ?? "";
  const dirty =
    (presetVoice !== null && presetVoice !== (brandVoice?.preset_voice ?? "alloy")) ||
    (deliveryStyle !== null && deliveryStyle !== (brandVoice?.delivery_style ?? ""));

  // ── Clone flow state ──────────────────────────────────────────────────────
  const [cloneOpen, setCloneOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [micPending, setMicPending] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [recordError, setRecordError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [sampleWarning, setSampleWarning] = useState<{
    uri: string;
    name: string;
    type: string;
    sizeBytes: number;
    issues: VoiceSampleIssue[];
  } | null>(null);
  const [showScript, setShowScript] = useState(false);

  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordStartRef = useRef(0);
  const disposedRef = useRef(false);
  /** Metering readings (dBFS) collected during recording for quality analysis. */
  const meteringRef = useRef<number[]>([]);

  const recorder = useAudioRecorder(
    { ...RecordingPresets.HIGH_QUALITY, isMeteringEnabled: true },
  );

  // Clean up on unmount.
  useEffect(() => {
    return () => {
      disposedRef.current = true;
      clearRecordTimer();
    };
  }, []);

  // Reset clone state when kit changes.
  useEffect(() => {
    setCloneOpen(false);
    setRecording(false);
    setRecordSeconds(0);
    setRecordError(null);
    setUploading(false);
    setSampleWarning(null);
    clearRecordTimer();
  }, [kitId]);

  const clearRecordTimer = () => {
    if (recordTimerRef.current) {
      clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
  };

  const previewVoice = usePreviewBrandVoice();
  const removeVoice = useRemoveBrandVoice();
  const cloneVoice = useCloneBrandVoice();
  const requestUploadUrl = useRequestUploadUrl();
  const createVersion = useCreateBrandKitVersion();
  const createAudio = useCreateBrandVoiceAudio();

  // ── Wallet cost estimate for audio generation ─────────────────────────────
  const walletBilling = useWalletBilling();
  const walletOverview = useWalletGetOverview({
    query: { queryKey: getWalletGetOverviewQueryKey(), staleTime: 60_000 },
  });
  const captionRatePaise = walletOverview.data?.rates?.captionPaise ?? 0;
  const showAudioEstimate = walletBilling && walletOverview.data != null && captionRatePaise > 0;
  const audioWalletShortfall =
    showAudioEstimate && captionRatePaise > (walletOverview.data?.balancePaise ?? 0);

  const meQuery = useGetMe();
  const isOwner = meQuery.data?.team ? meQuery.data.team.role === "owner" : true;

  const rechargeWallet = useWalletRecharge();
  const verifyRecharge = useWalletVerifyRecharge();
  const [rechargeCheckout, setRechargeCheckout] = useState<CheckoutRequest | null>(null);
  const [rechargeNotice, setRechargeNotice] = useState<{
    kind: "success" | "error" | "info";
    text: string;
  } | null>(null);

  const handleRecharge = async () => {
    const shortfallPaise = Math.max(
      0,
      captionRatePaise - (walletOverview.data?.balancePaise ?? 0),
    );
    const amountPaise = Math.max(1000, Math.ceil(shortfallPaise / 1000) * 1000);
    setRechargeNotice(null);
    try {
      const order = await rechargeWallet.mutateAsync({ data: { amountPaise } });
      if (order.gateway === WalletRechargeOrderGateway.cashfree) {
        // Cashfree's JS SDK is not available in the native app — open the web
        // wallet page so the user can complete the top-up there.
        const url = domain ? `https://${domain}/settings?tab=billing` : null;
        if (url) {
          await Linking.openURL(url);
        } else {
          setRechargeNotice({ kind: "info", text: "Please recharge your wallet from the web app." });
        }
        return;
      }
      if (!order.razorpayOrderId || !order.keyId) {
        setRechargeNotice({
          kind: "error",
          text: "Checkout isn't available in the app yet — please recharge from the web app.",
        });
        return;
      }
      setRechargeCheckout({
        mode: "order",
        keyId: order.keyId,
        orderId: order.razorpayOrderId,
        amountPaise: order.totalPaise,
        title: "Recharge wallet",
        description: `Top up ₹${(amountPaise / 100).toFixed(0)}`,
      });
    } catch (error) {
      setRechargeNotice({
        kind: "error",
        text: apiErrorMessage(error, "Couldn't start checkout. Please try again."),
      });
    }
  };

  const handleRechargeSuccess = (result: {
    paymentId: string;
    signature: string;
    orderId?: string;
  }) => {
    const active = rechargeCheckout;
    setRechargeCheckout(null);
    if (!active || active.mode !== "order") return;
    setRechargeNotice({ kind: "info", text: "Confirming your payment..." });
    verifyRecharge.mutate(
      {
        data: {
          razorpayOrderId: result.orderId,
          razorpayPaymentId: result.paymentId,
          razorpaySignature: result.signature,
        },
      },
      {
        onSuccess: () => {
          setRechargeNotice({
            kind: "success",
            text: "Wallet topped up — you can now generate audio.",
          });
          void queryClient.invalidateQueries({
            queryKey: getWalletGetOverviewQueryKey(),
          });
        },
        onError: (error) => {
          const n = verifyFailureNotice(
            error,
            "Payment still processing. Your wallet balance will update shortly.",
            "Payment received; your wallet will be credited shortly.",
          );
          setRechargeNotice(n);
          void queryClient.invalidateQueries({
            queryKey: getWalletGetOverviewQueryKey(),
          });
        },
      },
    );
  };

  const player = useAudioPlayer();
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [audioScript, setAudioScript] = useState("");
  const [generatedAudioPath, setGeneratedAudioPath] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "info" | "error"; text: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  useEffect(() => {
    setPreviewPath(null);
    setGeneratedAudioPath(null);
    setAudioScript("");
    setNotice(null);
  }, [kitId]);

  const playPath = (audioPath: string) => {
    if (!domain || !token) return;
    player.replace({
      uri: `https://${domain}/api/storage${audioPath}`,
      headers: { Authorization: `Bearer ${token}` },
    });
    player.seekTo(0);
    player.play();
  };

  const handlePreview = () => {
    haptic();
    if (previewPath) { playPath(previewPath); return; }
    if (kitId === null) return;
    previewVoice.mutate(
      { id: kitId, data: {} },
      {
        onSuccess: ({ audioPath }) => {
          setPreviewPath(audioPath);
          setNotice({ kind: "info", text: "Preview ready — playing your brand voice." });
          playPath(audioPath);
        },
        onError: (err) => {
          setNotice({ kind: "error", text: apiErrorMessage(err, "Could not generate a preview.") });
        },
      },
    );
  };

  const handleGenerateAudio = () => {
    haptic();
    if (kitId === null || !audioScript.trim()) return;
    setGeneratedAudioPath(null);
    createAudio.mutate(
      { id: kitId, data: { text: audioScript.trim() } },
      {
        onSuccess: ({ audioPath }) => {
          setGeneratedAudioPath(audioPath);
          setNotice({ kind: "info", text: "Audio ready — playing now." });
          playPath(audioPath);
        },
        onError: (err) => {
          setNotice({ kind: "error", text: apiErrorMessage(err, "Could not generate audio.") });
        },
      },
    );
  };

  const handleShareAudio = async () => {
    if (!domain || !generatedAudioPath) return;
    const url = `https://${domain}/api/storage${generatedAudioPath}`;
    try {
      await Share.share({ url, message: url });
    } catch {
      // user dismissed — ignore
    }
  };

  const afterVersionChange = () => {
    queryClient.invalidateQueries({ queryKey: getListBrandKitsQueryKey() });
    if (kitId !== null) {
      queryClient.invalidateQueries({ queryKey: getGetBrandKitQueryKey(kitId) });
    }
  };

  const handleRemove = () => {
    setConfirmRemove(false);
    if (kitId === null) return;
    removeVoice.mutate(
      { id: kitId },
      {
        onSuccess: () => {
          setPreviewPath(null);
          setPresetVoice(null);
          setDeliveryStyle(null);
          setNotice({ kind: "info", text: "Brand voice removed. Narration goes back to the stock voices." });
          afterVersionChange();
        },
        onError: (err) => {
          setNotice({ kind: "error", text: apiErrorMessage(err, "Could not remove the brand voice.") });
        },
      },
    );
  };

  const handleSavePreset = () => {
    haptic();
    if (kitId === null || !activePayload) return;
    const payload = JSON.parse(JSON.stringify(activePayload)) as BrandKitPayload;
    const existingVoice = payload.brand_voice;
    payload.brand_voice = {
      mode: existingVoice?.mode ?? "preset",
      provider: existingVoice?.provider ?? null,
      provider_voice_id: existingVoice?.provider_voice_id ?? null,
      sample_asset_path: existingVoice?.sample_asset_path ?? null,
      cloned_label: existingVoice?.cloned_label ?? null,
      cloned_at: existingVoice?.cloned_at ?? null,
      preset_voice: effectiveVoice,
      delivery_style: effectiveStyle,
    };
    createVersion.mutate(
      { id: kitId, data: { payload, sourceType: "manual", approvalStatus: "approved", activate: true } },
      {
        onSuccess: () => {
          setPresetVoice(null);
          setDeliveryStyle(null);
          setNotice({ kind: "info", text: "Voice settings saved." });
          afterVersionChange();
        },
        onError: (err) => {
          setNotice({ kind: "error", text: apiErrorMessage(err, "Could not save the voice settings.") });
        },
      },
    );
  };

  // ── Recording ─────────────────────────────────────────────────────────────

  const startRecording = async () => {
    if (micPending || recording) return;
    setRecordError(null);
    setMicPending(true);
    meteringRef.current = []; // reset quality samples for this take
    try {
      const perm = await requestRecordingPermissionsAsync();
      if (!perm.granted) {
        setRecordError("Allow microphone access to record a voice sample.");
        return;
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      recordStartRef.current = Date.now();
      setRecordSeconds(0);
      setRecording(true);
      recordTimerRef.current = setInterval(() => {
        const elapsed = Math.floor((Date.now() - recordStartRef.current) / 1000);
        setRecordSeconds(elapsed);
        // Collect metering sample for quality analysis.
        const state = recorder.getStatus();
        if (typeof state.metering === "number") {
          meteringRef.current.push(state.metering);
        }
        if (elapsed >= VOICE_SAMPLE_MAX_SECONDS) {
          void stopRecording();
        }
      }, 250);
    } catch {
      setRecordError("Could not start recording — check that microphone access is allowed in Settings.");
    } finally {
      if (!disposedRef.current) setMicPending(false);
    }
  };

  const stopRecording = async () => {
    clearRecordTimer();
    if (!recording) return;
    try {
      await recorder.stop();
      setRecording(false);
      const uri = recorder.uri;
      if (!uri) {
        setRecordError("The recording could not be saved. Try again.");
        return;
      }
      const elapsed = Math.floor((Date.now() - recordStartRef.current) / 1000);
      if (elapsed < VOICE_SAMPLE_MIN_SECONDS) {
        setRecordError(
          `That was only ${Math.max(1, elapsed)} second${elapsed === 1 ? "" : "s"} — aim for 30–60 seconds. Tap Record and read the script in one take.`,
        );
        return;
      }
      const ext = uri.split(".").pop()?.toLowerCase() || "m4a";
      const type = ext === "m4a" ? "audio/mp4" : `audio/${ext}`;
      let sizeBytes = 0;
      try {
        const info = await FileSystem.getInfoAsync(uri);
        if (info.exists && "size" in info) sizeBytes = (info as { exists: true; size: number }).size ?? 0;
      } catch { /* best-effort */ }
      const issues: VoiceSampleIssue[] = [];
      if (elapsed > VOICE_SAMPLE_MAX_SECONDS) issues.push("too-long");
      if (sizeBytes > VOICE_SAMPLE_MAX_BYTES) issues.push("too-large");
      // Quality analysis from metering data collected during recording.
      if (issues.length === 0) {
        const qualityIssues = analyzeVoiceSampleFromMetering(meteringRef.current);
        issues.push(...qualityIssues);
      }
      if (issues.length > 0) {
        setSampleWarning({ uri, name: `voice-sample.${ext}`, type, sizeBytes, issues });
        return;
      }
      await performUpload({ uri, name: `voice-sample.${ext}`, type, sizeBytes });
    } catch {
      setRecording(false);
      setRecordError("Could not finish the recording. Try again.");
    }
  };

  // ── File picking ──────────────────────────────────────────────────────────

  const pickAudioFile = async () => {
    setRecordError(null);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ["audio/*", "video/webm"],
        copyToCacheDirectory: true,
      });
      if (result.canceled) return;
      const asset = result.assets[0];
      if (!asset) return;
      const uri = asset.uri;
      const name = asset.name ?? "voice-sample";
      const type = asset.mimeType ?? "audio/mpeg";
      const sizeBytes = asset.size ?? 0;
      if (sizeBytes > VOICE_SAMPLE_MAX_BYTES) {
        setSampleWarning({ uri, name, type, sizeBytes, issues: ["too-large"] });
        return;
      }
      await performUpload({ uri, name, type, sizeBytes });
    } catch {
      setRecordError("Could not open the file picker. Try again.");
    }
  };

  // ── Upload + clone chain ──────────────────────────────────────────────────

  const performUpload = async (file: { uri: string; name: string; type: string; sizeBytes: number }) => {
    if (kitId === null) return;
    if (disposedRef.current) return;
    setUploading(true);
    setRecordError(null);
    try {
      const { uploadURL, objectPath } = await requestUploadUrl.mutateAsync({
        data: { name: file.name, size: file.sizeBytes, contentType: file.type },
      });
      if (disposedRef.current) return;

      // Race the upload against a timeout so a stalled connection (network
      // drops without emitting an error) never leaves the user stuck forever.
      // expo-file-system/legacy has no cancel API, so the timeout is the only
      // escape hatch; the upload will eventually be garbage-collected.
      const uploadTimeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("UPLOAD_TIMEOUT")), UPLOAD_TIMEOUT_MS),
      );
      let uploadResult: { status: number; body: string };
      try {
        uploadResult = await Promise.race([
          FileSystem.uploadAsync(uploadURL, file.uri, {
            httpMethod: "PUT",
            uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
            headers: { "Content-Type": file.type },
          }),
          uploadTimeoutPromise,
        ]);
      } catch (uploadErr) {
        if (!disposedRef.current) {
          const isTimeout =
            uploadErr instanceof Error && uploadErr.message === "UPLOAD_TIMEOUT";
          setRecordError(
            isTimeout
              ? "Upload timed out — check your connection and try again."
              : "Upload failed — check your connection and try again.",
          );
        }
        return;
      }
      if (uploadResult.status < 200 || uploadResult.status >= 300) {
        // Set a specific message directly — a plain Error's .message isn't
        // extracted by apiErrorMessage so the generic fallback would show.
        if (!disposedRef.current) {
          setRecordError(
            `Upload failed (${uploadResult.status}). Check your connection and try again.`,
          );
        }
        return;
      }
      if (disposedRef.current) return;

      const kitName = detail?.name ?? "Brand Kit";
      await cloneVoice.mutateAsync({
        id: kitId,
        data: { sampleAssetPath: objectPath, label: `${kitName} voice` },
      });
      if (disposedRef.current) return;

      setCloneOpen(false);
      setPreviewPath(null);
      setNotice({ kind: "info", text: "Brand voice cloned! Generating preview…" });
      afterVersionChange();

      // Auto-play a 10-second preview immediately after cloning so the user
      // can confirm the voice sounds right without a separate tap.
      const previewKitId = kitId;
      previewVoice.mutate(
        { id: previewKitId, data: {} },
        {
          onSuccess: ({ audioPath }) => {
            if (disposedRef.current) return;
            setPreviewPath(audioPath);
            setNotice({ kind: "info", text: "Brand voice cloned — preview playing." });
            playPath(audioPath);
          },
          onError: (err) => {
            if (disposedRef.current) return;
            setNotice({
              kind: "info",
              text: `Brand voice cloned! ${apiErrorMessage(err, "Tap 'Play preview' to hear it.")}`,
            });
          },
        },
      );
    } catch (err) {
      if (disposedRef.current) return;
      setRecordError(apiErrorMessage(err, "Cloning failed. Please try again."));
    } finally {
      if (!disposedRef.current) setUploading(false);
    }
  };

  // ── Early returns ─────────────────────────────────────────────────────────

  if (kitsQuery.isLoading) {
    return (
      <View style={styles.pad}>
        <Skeleton height={90} />
        <Skeleton height={160} style={{ marginTop: 12 }} />
      </View>
    );
  }
  if (kitsQuery.isError) {
    return (
      <View style={styles.pad}>
        <ErrorState message={kitsQuery.error?.message} onRetry={() => kitsQuery.refetch()} />
      </View>
    );
  }
  if (kits.length === 0) {
    return (
      <View style={styles.pad}>
        <EmptyState
          icon="mic"
          title="No brand kits yet"
          subtitle="Create a brand kit in the web app first — its voice settings will show up here."
        />
      </View>
    );
  }

  const busyCloning = uploading || requestUploadUrl.isPending || cloneVoice.isPending;

  // ── Main render ───────────────────────────────────────────────────────────

  return (
    <ScrollView contentContainerStyle={styles.pad} keyboardShouldPersistTaps="handled">
      {kits.length > 1 ? (
        <>
          <Label>Brand</Label>
          <View style={styles.chipRow}>
            {kits.map((kit) => (
              <Chip
                key={kit.id}
                label={kit.isDefault ? `${kit.name} (default)` : kit.name}
                selected={kitId === kit.id}
                onPress={() => setSelectedKitId(kit.id)}
              />
            ))}
          </View>
        </>
      ) : null}

      {featureOff ? (
        <Card style={styles.noticeCard}>
          <Text style={styles.noticeText} testID="text-brand-voice-disabled">
            Voice cloning is currently turned off. Videos use the stock voice picked below.
          </Text>
        </Card>
      ) : unconfigured ? (
        <Card style={styles.noticeCard}>
          <Text style={styles.noticeText} testID="text-brand-voice-unconfigured">
            Voice cloning isn't set up yet — ask your administrator to finish setting it up. Until then,
            videos use the stock voice picked below.
          </Text>
        </Card>
      ) : null}

      {/* ── Brand voice card ── */}
      <Card style={styles.card}>
        <View style={styles.cardHeader}>
          <View style={styles.iconWrap}>
            <Feather name="mic" size={16} color={c.primary} />
          </View>
          <Text style={styles.cardTitle}>Brand voice</Text>
          {cloned ? (
            <View style={styles.clonedBadge}>
              <Text style={styles.clonedBadgeText}>Cloned voice active</Text>
            </View>
          ) : null}
        </View>

        {detailQuery.isLoading ? (
          <Skeleton height={60} />
        ) : cloned && brandVoice ? (
          <View style={{ gap: 10 }}>
            <Text style={styles.bodyText}>
              <Text style={styles.bodyStrong}>{brandVoice.cloned_label ?? "Brand voice"}</Text>
              {brandVoice.cloned_at
                ? ` · cloned ${new Date(brandVoice.cloned_at).toLocaleDateString()}`
                : ""}
            </Text>
            <Text style={styles.mutedText}>
              Video narration is spoken in this cloned voice.
            </Text>
            <View style={styles.btnRow}>
              <Button
                title={previewVoice.isPending ? "Generating..." : "Play preview"}
                variant="secondary"
                loading={previewVoice.isPending}
                disabled={previewVoice.isPending || featureOff || unconfigured}
                onPress={handlePreview}
              />
              <Button
                title="Re-clone"
                variant="secondary"
                disabled={cloningBlocked || busyCloning}
                onPress={() => { setCloneOpen(true); setRecordError(null); }}
              />
              <Button
                title="Remove"
                variant="destructive"
                disabled={removeVoice.isPending}
                loading={removeVoice.isPending}
                onPress={() => setConfirmRemove(true)}
              />
            </View>

            {/* Generate audio in cloned voice */}
            <View style={styles.divider} />
            <Text style={styles.cardTitle}>Generate audio</Text>
            <Text style={styles.mutedText}>
              Type a script and generate an audio file spoken in your cloned voice.
            </Text>
            <TextInput
              value={audioScript}
              onChangeText={setAudioScript}
              placeholder="Type your script here… (up to 2500 characters)"
              placeholderTextColor={c.mutedForeground}
              style={[styles.input, styles.scriptInput]}
              multiline
              maxLength={2500}
              testID="input-audio-script"
            />
            <Text style={styles.charCount}>{audioScript.length} / 2500</Text>
            {showAudioEstimate && audioScript.trim() ? (
              <View style={styles.walletEstimateBox}>
                <Text style={styles.walletEstimateText} testID="text-audio-wallet-estimate">
                  {`≈ \u20B9${(captionRatePaise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} — reserved up front, settled to actual cost.`}
                </Text>
                {audioWalletShortfall ? (
                  <View style={styles.walletShortfallRow}>
                    <Text style={styles.walletShortfallText} testID="text-audio-wallet-estimate-shortfall">
                      {`Your wallet balance (\u20B9${((walletOverview.data?.balancePaise ?? 0) / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}) can't cover this — recharge before generating.`}
                    </Text>
                    {isOwner ? (
                      <Pressable
                        onPress={() => void handleRecharge()}
                        disabled={rechargeWallet.isPending}
                        style={({ pressed }) => [
                          styles.rechargeButton,
                          rechargeWallet.isPending && { opacity: 0.5 },
                          pressed && { opacity: 0.8 },
                        ]}
                        testID="button-audio-wallet-recharge"
                      >
                        <Text style={styles.rechargeButtonText}>
                          {rechargeWallet.isPending ? "Opening…" : "Recharge"}
                        </Text>
                      </Pressable>
                    ) : null}
                    {rechargeNotice ? (
                      <Text
                        style={[
                          styles.rechargeNoticeText,
                          rechargeNotice.kind === "error" && { color: c.destructive },
                          rechargeNotice.kind === "success" && { color: c.primary },
                        ]}
                        testID="text-audio-wallet-recharge-notice"
                      >
                        {rechargeNotice.text}
                      </Text>
                    ) : null}
                  </View>
                ) : null}
              </View>
            ) : null}
            <Button
              title={createAudio.isPending ? "Generating…" : "Generate audio"}
              loading={createAudio.isPending}
              disabled={!audioScript.trim() || createAudio.isPending || featureOff || unconfigured}
              onPress={handleGenerateAudio}
              testID="button-generate-audio"
            />
            {generatedAudioPath ? (
              <View style={styles.btnRow}>
                <Button
                  title="Play again"
                  variant="secondary"
                  onPress={() => playPath(generatedAudioPath)}
                />
                <Button
                  title="Share / Save"
                  variant="secondary"
                  onPress={handleShareAudio}
                />
              </View>
            ) : null}
          </View>
        ) : (
          <View style={{ gap: 10 }}>
            <Text style={styles.mutedText} testID="text-brand-voice-stock">
              Narration uses the stock voice picked below. Clone your own voice to make videos sound like you.
            </Text>
            {!cloningBlocked ? (
              <Button
                title="Clone your voice"
                icon="mic"
                onPress={() => { setCloneOpen(true); setRecordError(null); }}
                disabled={busyCloning}
              />
            ) : null}
          </View>
        )}
      </Card>

      {/* ── Stock voice card ── */}
      <Card style={styles.card}>
        <Text style={styles.cardTitle}>Stock voice</Text>
        <Text style={styles.mutedText}>
          {cloned ? "Used when the cloned voice isn't available." : "The narrator for your videos."}
        </Text>
        <View style={styles.voiceGrid}>
          {STOCK_VOICES.map((v) => {
            const selected = effectiveVoice === v.value;
            return (
              <Pressable
                key={v.value}
                testID={`voice-${v.value}`}
                onPress={() => { haptic(); setPresetVoice(v.value); }}
                style={({ pressed }) => [
                  styles.voiceOption,
                  selected && styles.voiceOptionSelected,
                  { opacity: pressed ? 0.85 : 1 },
                ]}
              >
                <Text style={[styles.voiceLabel, selected && styles.voiceLabelSelected]}>{v.label}</Text>
                <Text style={[styles.voiceHint, selected && styles.voiceHintSelected]}>{v.hint}</Text>
              </Pressable>
            );
          })}
        </View>

        <Label>Delivery style</Label>
        <TextInput
          value={effectiveStyle}
          onChangeText={setDeliveryStyle}
          placeholder="e.g. upbeat and friendly, slower pace"
          placeholderTextColor={c.mutedForeground}
          style={styles.input}
          testID="input-delivery-style"
        />

        <Button
          title={createVersion.isPending ? "Saving..." : "Save voice settings"}
          disabled={!dirty || createVersion.isPending || !activePayload}
          loading={createVersion.isPending}
          onPress={handleSavePreset}
        />
      </Card>

      {notice ? (
        <Text
          style={[styles.notice, notice.kind === "error" && styles.noticeError]}
          testID="text-brand-voice-notice"
        >
          {notice.text}
        </Text>
      ) : null}

      {detailQuery.isFetching && !detailQuery.isLoading ? (
        <ActivityIndicator style={{ marginTop: 8 }} color={c.mutedForeground} />
      ) : null}

      {/* ── Wallet recharge modal ── */}
      {rechargeCheckout ? (
        <RazorpayCheckoutModal
          request={rechargeCheckout}
          onSuccess={handleRechargeSuccess}
          onFailure={(message) => {
            setRechargeCheckout(null);
            setRechargeNotice({ kind: "error", text: message || "Payment failed. Please try again." });
          }}
          onDismiss={() => setRechargeCheckout(null)}
        />
      ) : null}

      {/* ── Remove confirmation modal ── */}
      <Modal
        visible={confirmRemove}
        transparent
        animationType="fade"
        onRequestClose={() => setConfirmRemove(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Remove brand voice?</Text>
            <Text style={styles.mutedText}>
              Video narration will go back to the stock voices. The cloned voice can't be restored
              without re-uploading a sample.
            </Text>
            <View style={styles.btnRow}>
              <Button title="Cancel" variant="secondary" onPress={() => setConfirmRemove(false)} />
              <Button title="Remove" variant="destructive" onPress={handleRemove} />
            </View>
          </View>
        </View>
      </Modal>

      {/* ── Clone voice modal ── */}
      <Modal
        visible={cloneOpen}
        transparent
        animationType="slide"
        onRequestClose={() => {
          if (!busyCloning && !recording) setCloneOpen(false);
        }}
      >
        <View style={styles.modalBackdrop}>
          <ScrollView
            style={{ width: "100%", maxWidth: 480 }}
            contentContainerStyle={styles.cloneCard}
            keyboardShouldPersistTaps="handled"
          >
            <View style={styles.cloneHeader}>
              <Text style={styles.modalTitle}>Clone your voice</Text>
              {!busyCloning && !recording ? (
                <Pressable onPress={() => setCloneOpen(false)} hitSlop={12}>
                  <Feather name="x" size={20} color={c.mutedForeground} />
                </Pressable>
              ) : null}
            </View>

            <Text style={styles.mutedText}>
              Read the script below into your phone's mic for 30–60 seconds. A quiet room makes the
              biggest difference in clone quality.
            </Text>

            {/* Script box */}
            <View style={styles.scriptBox}>
              <ScrollView style={{ maxHeight: 160 }} nestedScrollEnabled>
                <Text style={styles.scriptText}>{VOICE_RECORDING_SCRIPT}</Text>
              </ScrollView>
            </View>

            {/* Tips */}
            <Pressable
              onPress={() => setShowScript((v) => !v)}
              style={styles.tipsToggle}
              testID="button-show-tips"
            >
              <Feather name={showScript ? "chevron-up" : "chevron-down"} size={14} color={c.primary} />
              <Text style={styles.tipsToggleText}>{showScript ? "Hide tips" : "Show recording tips"}</Text>
            </Pressable>
            {showScript ? (
              <View style={styles.tipsList}>
                {VOICE_RECORDING_TIPS.map((tip, i) => (
                  <Text key={i} style={styles.tipText}>• {tip}</Text>
                ))}
              </View>
            ) : null}

            {/* Recording controls */}
            <View style={styles.recordControls}>
              {recording ? (
                <>
                  <Button
                    title="Stop recording"
                    icon="square"
                    variant="destructive"
                    onPress={() => { void stopRecording(); }}
                  />
                  <View style={styles.elapsedRow}>
                    <View style={styles.recDot} />
                    <Text style={styles.elapsedText} testID="text-recording-elapsed">
                      {formatElapsed(recordSeconds)}
                    </Text>
                    <Text style={styles.mutedText}>
                      / {formatElapsed(VOICE_SAMPLE_MAX_SECONDS)} max
                    </Text>
                  </View>
                  <Text style={styles.mutedText}>
                    Aim for 30–60 seconds — we'll stop automatically at{" "}
                    {formatElapsed(VOICE_SAMPLE_MAX_SECONDS)}.
                  </Text>
                </>
              ) : busyCloning ? (
                <View style={styles.uploadingRow}>
                  <ActivityIndicator color={c.primary} />
                  <Text style={styles.mutedText}>
                    {cloneVoice.isPending ? "Cloning your voice…" : "Uploading sample…"}
                  </Text>
                </View>
              ) : (
                <View style={styles.btnCol}>
                  <Button
                    title={micPending ? "Starting…" : "Record a sample"}
                    icon="mic"
                    loading={micPending}
                    disabled={micPending || cloningBlocked}
                    onPress={() => { void startRecording(); }}
                  />
                  <Button
                    title="Pick an audio file"
                    icon="upload"
                    variant="secondary"
                    disabled={cloningBlocked}
                    onPress={() => { void pickAudioFile(); }}
                  />
                </View>
              )}
            </View>

            {recordError ? (
              <Text style={styles.errorText} testID="text-record-error">
                {recordError}
              </Text>
            ) : null}

            {!recording && !busyCloning ? (
              <Button
                title="Cancel"
                variant="secondary"
                onPress={() => setCloneOpen(false)}
                style={{ marginTop: 4 }}
              />
            ) : null}
          </ScrollView>
        </View>
      </Modal>

      {/* ── Sample warning modal ── */}
      <Modal
        visible={!!sampleWarning}
        transparent
        animationType="fade"
        onRequestClose={() => setSampleWarning(null)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>This sample may produce a poor clone</Text>
            <View style={{ gap: 8 }}>
              {sampleWarning?.issues.map((issue) => (
                <Text key={issue} style={styles.mutedText} testID={`text-sample-issue-${issue}`}>
                  {VOICE_SAMPLE_ISSUE_MESSAGES[issue]}
                </Text>
              ))}
              <Text style={styles.mutedText}>
                You can go ahead anyway, but for the best result we recommend re-recording with the script.
              </Text>
            </View>
            <View style={styles.btnRow}>
              <Button
                title="Choose another"
                variant="secondary"
                onPress={() => setSampleWarning(null)}
              />
              <Button
                title="Upload anyway"
                onPress={() => {
                  const w = sampleWarning;
                  setSampleWarning(null);
                  if (w) void performUpload({ uri: w.uri, name: w.name, type: w.type, sizeBytes: w.sizeBytes });
                }}
              />
            </View>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  pad: { padding: 16, gap: 12 },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 4 },
  card: { gap: 10 },
  noticeCard: { backgroundColor: c.muted },
  noticeText: { fontFamily: fonts.medium, fontSize: 13, color: c.mutedForeground, lineHeight: 19 },
  cardHeader: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  iconWrap: {
    width: 30, height: 30, borderRadius: 15,
    backgroundColor: c.accent, alignItems: "center", justifyContent: "center",
  },
  cardTitle: { fontFamily: fonts.semiBold, fontSize: 15, color: c.foreground },
  clonedBadge: { backgroundColor: c.accent, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 },
  clonedBadgeText: { fontFamily: fonts.semiBold, fontSize: 11, color: c.primary },
  bodyText: { fontFamily: fonts.regular, fontSize: 14, color: c.foreground },
  bodyStrong: { fontFamily: fonts.semiBold },
  mutedText: { fontFamily: fonts.regular, fontSize: 13, color: c.mutedForeground, lineHeight: 19 },
  btnRow: { flexDirection: "row", gap: 10, marginTop: 4, flexWrap: "wrap" },
  btnCol: { gap: 10 },
  voiceGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  voiceOption: {
    width: "31%", minWidth: 96, borderWidth: 1, borderColor: c.border,
    borderRadius: colors.radius, paddingVertical: 10, paddingHorizontal: 8,
    alignItems: "center", backgroundColor: c.background,
  },
  voiceOptionSelected: { borderColor: c.primary, backgroundColor: c.accent },
  voiceLabel: { fontFamily: fonts.semiBold, fontSize: 13, color: c.foreground },
  voiceLabelSelected: { color: c.primary },
  voiceHint: { fontFamily: fonts.regular, fontSize: 11, color: c.mutedForeground },
  voiceHintSelected: { color: c.primary },
  input: {
    borderWidth: 1, borderColor: c.border, borderRadius: colors.radius,
    paddingHorizontal: 12, paddingVertical: 10,
    fontFamily: fonts.regular, fontSize: 14, color: c.foreground,
    backgroundColor: c.background, marginBottom: 8,
  },
  scriptInput: {
    minHeight: 100,
    textAlignVertical: "top",
    marginBottom: 2,
  },
  charCount: {
    fontFamily: fonts.regular,
    fontSize: 11,
    color: c.mutedForeground,
    textAlign: "right",
    marginBottom: 4,
  },
  divider: {
    height: 1,
    backgroundColor: c.border,
    marginVertical: 4,
  },
  notice: { fontFamily: fonts.medium, fontSize: 13, color: c.mutedForeground },
  noticeError: { color: c.destructive },
  errorText: { fontFamily: fonts.medium, fontSize: 13, color: c.destructive, lineHeight: 19 },
  // Modals
  modalBackdrop: {
    flex: 1, backgroundColor: "rgba(0,0,0,0.4)",
    alignItems: "center", justifyContent: "center", padding: 24,
  },
  modalCard: {
    backgroundColor: c.background, borderRadius: colors.radius * 2,
    padding: 20, gap: 12, width: "100%", maxWidth: 420,
  },
  modalTitle: { fontFamily: fonts.semiBold, fontSize: 16, color: c.foreground },
  // Clone modal
  cloneCard: {
    backgroundColor: c.background, borderRadius: colors.radius * 2,
    padding: 20, gap: 12, margin: 24,
  },
  cloneHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  scriptBox: {
    borderWidth: 1, borderColor: c.border, borderRadius: colors.radius,
    backgroundColor: c.muted, padding: 12,
  },
  scriptText: { fontFamily: fonts.regular, fontSize: 13, color: c.foreground, lineHeight: 20 },
  tipsToggle: { flexDirection: "row", alignItems: "center", gap: 4, paddingVertical: 2 },
  tipsToggleText: { fontFamily: fonts.medium, fontSize: 13, color: c.primary },
  tipsList: { gap: 6 },
  tipText: { fontFamily: fonts.regular, fontSize: 12, color: c.mutedForeground, lineHeight: 18 },
  recordControls: { gap: 10 },
  elapsedRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  recDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: c.destructive },
  elapsedText: { fontFamily: fonts.semiBold, fontSize: 18, color: c.destructive },
  uploadingRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  walletEstimateBox: { gap: 4 },
  walletEstimateText: { fontFamily: fonts.regular, fontSize: 12, color: c.mutedForeground },
  walletShortfallRow: { gap: 6 },
  walletShortfallText: { fontFamily: fonts.regular, fontSize: 12, color: c.destructive },
  rechargeButton: {
    alignSelf: "flex-start",
    backgroundColor: c.primary,
    borderRadius: colors.radius,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  rechargeButtonText: { fontFamily: fonts.semiBold, fontSize: 12, color: "#ffffff" },
  rechargeNoticeText: { fontFamily: fonts.regular, fontSize: 12, color: c.mutedForeground },
});
