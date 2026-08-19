import { useEffect, useRef, useState } from "react";
import { RippleSpinner } from "@/components/ui/ripple-spinner";
import {
  useRequestUploadUrl,
  useListBrandKits,
  useCreateBrandKit,
  useUpdateBrandKit,
  useDeleteBrandKit,
  useSetDefaultBrandKit,
  useCreateBrandKitVersion,
  useDraftBrandKit,
  getListBrandKitsQueryKey,
  useGetBrandVoiceStatus,
  useCloneBrandVoice,
  usePreviewBrandVoice,
  useCreateBrandVoiceAudio,
  useRemoveBrandVoice,
  useSelectBrandVoice,
  useDeleteBrandVoiceEntry,
  useExtractBrandBaseVideoAudio,
  useDeleteBrandVoiceExtractedSample,
  type BrandKit,
  type BrandKitPayload,
  type BrandColor,
  type ExtractedBrandVoiceSample,
} from "@workspace/api-client-react";
import { apiErrorMessage } from "@/lib/apiErrorMessage";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Palette, Plus, Trash2, Star, Pencil, Wand2, Upload, X, Mic, Play, ScrollText, Copy, Check, Square, AudioLines } from "lucide-react";
import { SavedVisualsSection } from "@/components/saved-visuals";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

/** The six stock narration voices (mirrors the Video Studio picker). */
const STOCK_VOICES: { value: string; label: string }[] = [
  { value: "alloy", label: "Alloy · balanced" },
  { value: "echo", label: "Echo · calm" },
  { value: "fable", label: "Fable · expressive" },
  { value: "onyx", label: "Onyx · deep" },
  { value: "nova", label: "Nova · bright" },
  { value: "shimmer", label: "Shimmer · warm" },
];

const VOICE_ACCENTS = [
  { value: "american_english", label: "American English" },
  { value: "indian_english", label: "Indian English" },
] as const;

type VoiceAccent = (typeof VOICE_ACCENTS)[number]["value"];

function voiceAccentLabel(accent: string | null | undefined): string {
  return VOICE_ACCENTS.find((option) => option.value === accent)?.label ?? "Accent not specified";
}

/**
 * A ~60-second, brand-neutral read designed for voice-clone quality:
 * phonetically varied sentences, a question, an exclamation, numbers and
 * dates, and a warm conversational tone.
 */
export const VOICE_RECORDING_SCRIPT = `Hi there — thanks for listening in. I'd like to tell you a little about how I work and what a typical week looks like for me.

Most mornings I start around seven thirty with a cup of coffee and a quick look at my plans for the day. On March 3rd, 2025, I remember jotting down twelve ideas in about fifteen minutes — some good, some questionable, all worth exploring.

Have you ever noticed how the best ideas show up when you least expect them? Maybe in the shower, on a walk, or halfway through a completely unrelated conversation. That's exactly why I always keep a notebook nearby — it's saved me more times than I can count!

Whether it's a big launch or a small everyday win, I genuinely enjoy sharing the journey. So here's to clear thinking, honest stories, and just a touch of curiosity in everything we make together.`;

export const VOICE_RECORDING_TIPS = [
  "Record in a quiet room with soft furnishings — no echo, fans, or background music.",
  "Keep your phone or mic about 15 cm (6 inches) from your mouth.",
  "Read at your natural, conversational pace — don't whisper or over-act.",
  "Let your voice move naturally with the questions and exclamations.",
  "Do it in one continuous take and avoid long pauses; small stumbles are fine.",
];

type BrandVoiceDraft = NonNullable<BrandKitPayload["brand_voice"]>;

/** Sensible bounds for a voice-clone sample, checked client-side before upload. */
export const VOICE_SAMPLE_MIN_SECONDS = 20;
export const VOICE_SAMPLE_MAX_SECONDS = 90;
/** Roughly "nearly silent" — average RMS below this is almost certainly too quiet to clone well. */
export const VOICE_SAMPLE_MIN_RMS = 0.01;
/** Samples at or above this absolute amplitude count as clipped (pinned at full scale). */
export const VOICE_SAMPLE_CLIP_THRESHOLD = 0.985;
/** If more than this fraction of scanned samples are clipped, the recording is distorted. */
export const VOICE_SAMPLE_MAX_CLIP_RATIO = 0.01;
/**
 * Noise floor (RMS of the quietest windows) relative to speech level (RMS of
 * the loudest windows). Above this ratio the room is audibly noisy.
 */
export const VOICE_SAMPLE_MAX_NOISE_RATIO = 0.25;
/** A noise floor below this absolute RMS is quiet enough regardless of ratio. */
export const VOICE_SAMPLE_MIN_NOISE_FLOOR_RMS = 0.02;

export type VoiceSampleIssue = "too-short" | "too-long" | "too-quiet" | "clipped" | "noisy" | "echoey";

type ExtractedVoiceReviewSample = ExtractedBrandVoiceSample & {
  sourceLabel: string;
};

type ReviewedVoiceTake =
  | { kind: "local"; file: File; url: string }
  | {
      kind: "extracted";
      sampleAssetPath: string;
      url: string;
      issues: VoiceSampleIssue[];
      sourceLabel: string;
    };

/**
 * Echo / reverb detection thresholds (decay-tail heuristic).
 * After a loud speech window, a clean room's energy drops sharply. In a
 * reverberant room it decays slowly — the next window stays high relative to
 * the loud one. These constants gate that detection.
 */
/** A loud→next transition is "starting to drop" when next < current × this. */
export const VOICE_SAMPLE_ECHO_DROP_THRESHOLD = 0.9;
/** A drop is "fast" (clean room) when the next window falls below current × this. */
export const VOICE_SAMPLE_ECHO_FAST_DECAY = 0.4;
/** If this fraction of qualifying drops are slow, the room is echoey. */
export const VOICE_SAMPLE_ECHO_MIN_SLOW_FRACTION = 0.5;
/** Minimum qualifying transitions needed before applying the echo judgment. */
export const VOICE_SAMPLE_ECHO_MIN_TRANSITIONS = 3;

export const VOICE_SAMPLE_ISSUE_MESSAGES: Record<VoiceSampleIssue, string> = {
  "too-short": `The recording is shorter than ${VOICE_SAMPLE_MIN_SECONDS} seconds. Very short samples usually produce a clone that doesn't sound like you — aim for 30–60 seconds.`,
  "too-long": `The recording is longer than ${VOICE_SAMPLE_MAX_SECONDS} seconds. Extra length doesn't help the clone and can slow things down — 30–60 seconds is the sweet spot.`,
  "too-quiet": "The recording is very quiet. A near-silent sample tends to produce a flat, mumbly clone — re-record closer to the microphone at your normal speaking volume.",
  clipped:
    "The recording is too loud and sounds distorted (the audio is clipping). A crackly, overdriven sample makes the clone sound harsh — re-record a little further from the microphone or lower the input level.",
  noisy:
    "There's a lot of steady background noise in the recording (like a fan, traffic, or music). The clone will pick up that hiss — re-record somewhere quieter with soft furnishings.",
  echoey:
    "The recording sounds echoey or reverberant — like a bare-walled room or bathroom. Echo causes the clone to sound hollow and unnatural. Re-record in a softer room: carpets, curtains, cushions, or even a wardrobe with clothes will absorb the reflections.",
};

function defaultBrandVoice(): BrandVoiceDraft {
  return {
    mode: "preset",
    preset_voice: "alloy",
    delivery_style: "",
    provider: null,
    provider_voice_id: null,
    sample_asset_path: null,
    cloned_label: null,
    cloned_accent: null,
    cloned_at: null,
  };
}

/**
 * Brand Voice editor: preset picker + delivery note (saved with the draft),
 * and cloning actions (upload sample → clone → preview → remove) that talk to
 * the server immediately and create new kit versions.
 */
function BrandVoiceSection({
  kit,
  brandVoice,
  extractedSample,
  onExtractedSampleOpened,
  onBrandVoiceChange,
  onKitVersionCreated,
}: {
  kit: BrandKit;
  brandVoice: BrandVoiceDraft;
  extractedSample: ExtractedVoiceReviewSample | null;
  onExtractedSampleOpened: () => void;
  onBrandVoiceChange: (next: BrandVoiceDraft) => void;
  onKitVersionCreated: (payload: BrandKitPayload) => void;
}) {
  const { toast } = useToast();
  const { data: status } = useGetBrandVoiceStatus();
  const requestUploadUrl = useRequestUploadUrl();
  const cloneVoice = useCloneBrandVoice();
  const previewVoice = usePreviewBrandVoice();
  const removeVoice = useRemoveBrandVoice();
  const selectVoice = useSelectBrandVoice();
  const deleteVoiceEntry = useDeleteBrandVoiceEntry();
  const deleteExtractedSample = useDeleteBrandVoiceExtractedSample();
  const sampleFileRef = useRef<HTMLInputElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const createAudio = useCreateBrandVoiceAudio();
  const [audioScript, setAudioScript] = useState("");
  const [voiceoverUrl, setVoiceoverUrl] = useState<string | null>(null);
  const [scriptOpen, setScriptOpen] = useState(false);
  const [scriptCopied, setScriptCopied] = useState(false);
  const [sampleWarning, setSampleWarning] = useState<{
    take: ReviewedVoiceTake;
    issues: VoiceSampleIssue[];
  } | null>(null);
  /** The record-a-voice dialog: tips + script + start/stop + review playback. */
  const [recordOpen, setRecordOpen] = useState(false);
  const [recStage, setRecStage] = useState<"ready" | "recording" | "review">("ready");
  /** The finished take (recorded or picked file) awaiting the user's decision. */
  const [recorded, setRecorded] = useState<ReviewedVoiceTake | null>(null);
  /** Synchronous mirror used by close/unmount cleanup before React effects run. */
  const recordedRef = useRef<ReviewedVoiceTake | null>(null);
  /** Whether the reviewed take came from the mic (re-recordable) or a picked file. */
  const [recordedFromMic, setRecordedFromMic] = useState(true);
  const [voiceName, setVoiceName] = useState("");
  const [voiceAccent, setVoiceAccent] = useState<VoiceAccent>("american_english");
  const [confirmDeleteVoice, setConfirmDeleteVoice] = useState<{
    id: string;
    label: string;
  } | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [recordError, setRecordError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordChunksRef = useRef<BlobPart[]>([]);
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordStartRef = useRef(0);
  /** Set when recording is abandoned (unmount) so onstop discards instead of uploading. */
  const recordCancelledRef = useRef(false);
  /** Set once the editor unmounts — every await in the upload → clone chain re-checks it. */
  const disposedRef = useRef(false);
  /** Aborts an in-flight sample PUT when the editor closes. */
  const putAbortRef = useRef<AbortController | null>(null);
  /** Once clone submission starts, its route owns failure cleanup for the sample. */
  const cloneSubmittedRef = useRef(false);
  const [micPending, setMicPending] = useState(false);
  /** Current microphone RMS level (0–1), updated ~every 100 ms while recording. */
  const [audioLevel, setAudioLevel] = useState(0);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const animFrameRef = useRef<number | null>(null);

  const stopAudioLevel = () => {
    if (animFrameRef.current !== null) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    if (analyserRef.current) {
      analyserRef.current.disconnect();
      analyserRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    // Guard against calling setState after unmount: this function is invoked
    // both from the synchronous cleanup effect and from the async onstop
    // handler (which fires after the recorder's stop event queue drains).
    if (!disposedRef.current) setAudioLevel(0);
  };

  const clearRecordTimer = () => {
    if (recordTimerRef.current) {
      clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
  };

  // Never leave the mic open if the editor unmounts mid-recording. An unmount
  // is an abandoned recording, so cancel UNCONDITIONALLY — this covers the
  // stop-then-close race (recorder already "inactive" but onstop still queued)
  // and the permission-prompt race (getUserMedia resolving after unmount).
  // onstop must discard the audio rather than upload-and-clone behind the
  // user's back.
  useEffect(() => {
    return () => {
      recordCancelledRef.current = true;
      disposedRef.current = true;
      // Free an abandoned local URL or delete an unsubmitted extracted sample.
      const take = recordedRef.current;
      if (take?.kind === "local") {
        URL.revokeObjectURL(take.url);
      } else if (take?.kind === "extracted" && !cloneSubmittedRef.current) {
        deleteExtractedSample.mutate({
          id: kit.id,
          data: { sampleAssetPath: take.sampleAssetPath },
        });
      }
      recordedRef.current = null;
      putAbortRef.current?.abort();
      putAbortRef.current = null;
      clearRecordTimer();
      stopAudioLevel();
      const recorder = recorderRef.current;
      if (recorder) {
        recorder.stream.getTracks().forEach((t) => t.stop());
        if (recorder.state !== "inactive") {
          try {
            recorder.stop();
          } catch {
            // Already stopped.
          }
        }
      }
    };
  }, []);

  useEffect(() => {
    if (!extractedSample) return;
    if (cloneSubmittedRef.current) {
      // A previous sample already belongs to an in-flight clone. Never replace
      // or delete it; discard the late duplicate extraction instead.
      deleteExtractedSample.mutate({
        id: kit.id,
        data: { sampleAssetPath: extractedSample.sampleAssetPath },
      });
      onExtractedSampleOpened();
      return;
    }
    const previous = recordedRef.current;
    if (previous?.kind === "local") {
      URL.revokeObjectURL(previous.url);
    } else if (previous?.kind === "extracted") {
      deleteExtractedSample.mutate({
        id: kit.id,
        data: { sampleAssetPath: previous.sampleAssetPath },
      });
    }
    const next: ReviewedVoiceTake = {
      kind: "extracted",
      sampleAssetPath: extractedSample.sampleAssetPath,
      url: `/api/storage${extractedSample.sampleAssetPath}`,
      issues: extractedSample.issues as VoiceSampleIssue[],
      sourceLabel: extractedSample.sourceLabel,
    };
    recordedRef.current = next;
    setRecorded(next);
    setRecordedFromMic(false);
    setRecordError(null);
    setVoiceName(`${extractedSample.sourceLabel} voice`.slice(0, 120));
    setVoiceAccent("american_english");
    setRecStage("review");
    setRecordOpen(true);
    cloneSubmittedRef.current = false;
    onExtractedSampleOpened();
    // The mutation object is intentionally omitted; this effect is keyed only
    // by the newly prepared object path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extractedSample?.sampleAssetPath]);

  /** Opens the recording dialog (script + tips); the mic starts only when the
   * user presses Start recording, once they're comfortable with the script. */
  const handleRecordClick = () => {
    setRecordError(null);
    discardTake();
    setRecordedFromMic(true);
    setRecStage("ready");
    setVoiceName("");
    setVoiceAccent("american_english");
    setRecordOpen(true);
  };

  /** Drops the reviewed take and cleans up whichever storage owns it. */
  const discardTake = (cleanupExtracted = true) => {
    const take = recordedRef.current;
    if (take?.kind === "local") {
      URL.revokeObjectURL(take.url);
    } else if (
      take?.kind === "extracted" &&
      cleanupExtracted &&
      !cloneSubmittedRef.current
    ) {
      deleteExtractedSample.mutate({
        id: kit.id,
        data: { sampleAssetPath: take.sampleAssetPath },
      });
    }
    recordedRef.current = null;
    setRecorded(null);
    cloneSubmittedRef.current = false;
  };

  /** Closing the dialog abandons everything: stops the mic, drops the take. */
  const handleRecordDialogChange = (open: boolean) => {
    if (open) return;
    if (uploading || cloneVoice.isPending || cloneSubmittedRef.current) return;
    if (recording) {
      recordCancelledRef.current = true;
      stopRecording();
    }
    discardTake();
    setRecordError(null);
    setRecStage("ready");
    setRecordOpen(false);
    if (sampleFileRef.current) sampleFileRef.current.value = "";
  };

  const startRecording = async () => {
    if (micPending || recording) return;
    setRecordError(null);
    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setRecordError("This browser can't record audio — upload a file instead.");
      return;
    }
    recordCancelledRef.current = false;
    let stream: MediaStream;
    setMicPending(true);
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      if (!disposedRef.current) {
        setRecordError(
          "Microphone access was blocked. Allow the microphone for this site in your browser settings, then try again — or upload a file instead.",
        );
      }
      return;
    } finally {
      if (!disposedRef.current) setMicPending(false);
    }
    if (recordCancelledRef.current) {
      // Editor closed while the permission prompt was up — release the mic
      // immediately and never start a recorder.
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    const mimeType = MediaRecorder.isTypeSupported("audio/webm")
      ? "audio/webm"
      : MediaRecorder.isTypeSupported("audio/mp4")
        ? "audio/mp4"
        : "";
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recordChunksRef.current = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordChunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      recorder.stream.getTracks().forEach((t) => t.stop());
      clearRecordTimer();
      stopAudioLevel();
      if (!disposedRef.current) setRecording(false);
      if (recordCancelledRef.current) {
        // Abandoned (editor closed mid-recording) — discard, never upload.
        recordChunksRef.current = [];
        return;
      }
      const elapsed = (Date.now() - recordStartRef.current) / 1000;
      const type = recorder.mimeType || "audio/webm";
      const blob = new Blob(recordChunksRef.current, { type });
      recordChunksRef.current = [];
      if (elapsed < VOICE_SAMPLE_MIN_SECONDS || blob.size === 0) {
        if (disposedRef.current) return;
        setRecStage("ready");
        setRecordError(
          `That recording was only ${Math.max(1, Math.round(elapsed))} second${Math.round(elapsed) === 1 ? "" : "s"} — a good clone needs at least ${VOICE_SAMPLE_MIN_SECONDS} seconds (30–60 is ideal). Tap Record and read the recording script in one take.`,
        );
        return;
      }
      const ext = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
      const file = new File([blob], `voice-sample.${ext}`, { type });
      // Nothing uploads yet — the user listens to the take first and decides
      // whether to keep it or re-record.
      discardTake();
      const take: ReviewedVoiceTake = {
        kind: "local",
        file,
        url: URL.createObjectURL(blob),
      };
      recordedRef.current = take;
      setRecorded(take);
      setRecordedFromMic(true);
      setRecStage("review");
    };
    recorderRef.current = recorder;
    recordStartRef.current = Date.now();
    setRecordSeconds(0);
    recorder.start();
    setRecording(true);
    setRecStage("recording");
    // Start live audio level meter using an AnalyserNode on the same stream.
    // Non-critical — silently ignored if the API is unavailable.
    try {
      const Ctor: typeof AudioContext =
        (window.AudioContext ?? (window as any).webkitAudioContext) as typeof AudioContext;
      if (Ctor) {
        const ctx = new Ctor();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        ctx.createMediaStreamSource(stream).connect(analyser);
        audioCtxRef.current = ctx;
        analyserRef.current = analyser;
        const data = new Float32Array(analyser.fftSize);
        let lastUpdate = 0;
        const tick = () => {
          const now = performance.now();
          if (now - lastUpdate >= 100) {
            analyser.getFloatTimeDomainData(data);
            let sum = 0;
            for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
            setAudioLevel(Math.sqrt(sum / data.length));
            lastUpdate = now;
          }
          animFrameRef.current = requestAnimationFrame(tick);
        };
        animFrameRef.current = requestAnimationFrame(tick);
      }
    } catch {
      // Audio level meter is non-critical — ignore errors.
    }
    recordTimerRef.current = setInterval(() => {
      const elapsed = Math.floor((Date.now() - recordStartRef.current) / 1000);
      setRecordSeconds(elapsed);
      // Extra length doesn't improve the clone — stop automatically at the cap.
      if (elapsed >= VOICE_SAMPLE_MAX_SECONDS) stopRecording();
    }, 250);
  };

  const stopRecording = () => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
  };

  const formatElapsed = (total: number) =>
    `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;

  const handleCopyScript = async () => {
    try {
      await navigator.clipboard.writeText(VOICE_RECORDING_SCRIPT);
      setScriptCopied(true);
      toast({ title: "Script copied", description: "Paste it onto a teleprompter or another device." });
      setTimeout(() => setScriptCopied(false), 2000);
    } catch {
      toast({
        title: "Copy failed",
        description: "Select the script text and copy it manually.",
        variant: "destructive",
      });
    }
  };

  const cloned = brandVoice.mode === "cloned" && !!brandVoice.provider_voice_id;

  /** Saved voices; legacy kits (cloned before the library existed) synthesize
   * a one-entry list from the flat active-voice fields. */
  const voiceLibrary =
    brandVoice.voices ??
    (cloned && brandVoice.provider && brandVoice.provider_voice_id
      ? [
          {
            id: brandVoice.provider_voice_id,
            label: brandVoice.cloned_label ?? "Brand voice",
            provider: brandVoice.provider,
            provider_voice_id: brandVoice.provider_voice_id,
            sample_asset_path: brandVoice.sample_asset_path,
            ...(brandVoice.cloned_accent ? { accent: brandVoice.cloned_accent } : {}),
            cloned_at: brandVoice.cloned_at ?? new Date().toISOString(),
          },
        ]
      : []);

  const applyKitDetail = (detail: { activeVersion?: { payload?: BrandKitPayload } | null }) => {
    const payload = detail.activeVersion?.payload;
    if (!payload) return;
    onKitVersionCreated(payload);
    onBrandVoiceChange(payload.brand_voice ?? defaultBrandVoice());
    setPreviewUrl(null);
    setVoiceoverUrl(null);
  };

  const handleSelectVoice = (voiceId: string) => {
    selectVoice.mutate(
      { id: kit.id, data: { voiceId } },
      {
        onSuccess: (detail) => {
          applyKitDetail(detail);
          toast({ title: "Voice switched", description: "New videos will narrate in this voice." });
        },
        onError: (err) => {
          toast({
            title: "Switch failed",
            description: apiErrorMessage(err, "Could not switch the voice."),
            variant: "destructive",
          });
        },
      },
    );
  };

  const handleDeleteVoice = (voiceId: string) => {
    setConfirmDeleteVoice(null);
    deleteVoiceEntry.mutate(
      { id: kit.id, voiceId },
      {
        onSuccess: (detail) => {
          applyKitDetail(detail);
          toast({ title: "Voice deleted", description: "The saved voice was removed." });
        },
        onError: (err) => {
          toast({
            title: "Delete failed",
            description: apiErrorMessage(err, "Could not delete the voice."),
            variant: "destructive",
          });
        },
      },
    );
  };
  const featureOff = status ? !status.enabled : false;
  const unconfigured = status ? !status.configured : false;
  const cloningBlocked = featureOff || unconfigured;

  const handleSampleUpload = async (file: File) => {
    if (!file.type.startsWith("audio/") && file.type !== "video/webm") {
      toast({
        title: "Not an audio file",
        description: "Please pick an audio recording (MP3, WAV, M4A, or WebM).",
        variant: "destructive",
      });
      return;
    }
    if (file.size > 15 * 1024 * 1024) {
      toast({
        title: "File too large",
        description: "Voice samples must be under 15 MB (about a minute of audio).",
        variant: "destructive",
      });
      return;
    }
    // A picked file goes through the same review step as a recording: the
    // user hears it, names the voice, and only then does anything upload.
    discardTake();
    const take: ReviewedVoiceTake = {
      kind: "local",
      file,
      url: URL.createObjectURL(file),
    };
    recordedRef.current = take;
    setRecorded(take);
    setRecordedFromMic(false);
    setRecordError(null);
    setVoiceName("");
    setVoiceAccent("american_english");
    setRecStage("review");
    setRecordOpen(true);
  };

  /** "Save this voice" in the review step: quality-check, then upload+clone. */
  const handleSaveTake = async () => {
    const take = recorded;
    if (!take) return;
    const issues =
      take.kind === "local" ? await analyzeVoiceSample(take.file) : take.issues;
    if (disposedRef.current) return; // editor closed while analyzing — discard
    if (issues && issues.length > 0) {
      setSampleWarning({ take, issues });
      return;
    }
    await performSampleUpload(
      take.kind === "local" ? take.file : take.sampleAssetPath,
    );
  };

  const performSampleUpload = async (sample: File | string) => {
    if (disposedRef.current) return;
    const extractedPath = typeof sample === "string" ? sample : null;
    setUploading(true);
    try {
      let objectPath: string;
      if (typeof sample === "string") {
        objectPath = sample;
      } else {
        const { uploadURL, objectPath: uploadedPath } =
          await requestUploadUrl.mutateAsync({
            data: {
              name: sample.name,
              size: sample.size,
              contentType: sample.type,
            },
          });
        // The editor may have been closed while any of these awaits were
        // pending — re-check before every irreversible step so an abandoned
        // sample is never uploaded or cloned in the background.
        if (disposedRef.current) return;
        const abort = new AbortController();
        putAbortRef.current = abort;
        let put: Response;
        try {
          put = await fetch(uploadURL, {
            method: "PUT",
            body: sample,
            headers: { "Content-Type": sample.type },
            signal: abort.signal,
          });
        } finally {
          if (putAbortRef.current === abort) putAbortRef.current = null;
        }
        if (!put.ok) throw new Error(`Upload failed (${put.status})`);
        objectPath = uploadedPath;
      }
      if (disposedRef.current) return;
      cloneSubmittedRef.current = true;
      const detail = await cloneVoice.mutateAsync({
        id: kit.id,
        data: {
          sampleAssetPath: objectPath,
          label: voiceName.trim() || `${kit.name} voice`,
          accent: voiceAccent,
        },
      });
      // The clone request itself can't be recalled once sent, but suppress
      // every post-clone effect (kit callbacks, state, toast) after disposal.
      if (disposedRef.current) return;
      const payload = detail.activeVersion?.payload;
      if (payload) {
        onKitVersionCreated(payload);
        if (payload.brand_voice) onBrandVoiceChange(payload.brand_voice);
      }
      setPreviewUrl(null);
      setVoiceoverUrl(null);
      discardTake(false);
      setRecordOpen(false);
      setRecStage("ready");
      toast({
        title: "Voice saved",
        description:
          "It's now your active narration voice — switch between saved voices any time below.",
      });
    } catch (err) {
      if (disposedRef.current) return;
      if (extractedPath) {
        // The clone route normally removes failed samples. This cleanup also
        // covers pre-provider rejections such as a full voice library.
        deleteExtractedSample.mutate({
          id: kit.id,
          data: { sampleAssetPath: extractedPath },
        });
        discardTake(false);
        setRecordOpen(false);
        setRecStage("ready");
      }
      toast({
        title: "Cloning failed",
        description: apiErrorMessage(err, "Could not clone the voice. Please try again."),
        variant: "destructive",
      });
    } finally {
      cloneSubmittedRef.current = false;
      if (!disposedRef.current) {
        setUploading(false);
        if (sampleFileRef.current) sampleFileRef.current.value = "";
      }
    }
  };

  const handlePreview = () => {
    if (previewUrl) {
      audioRef.current?.play().catch(() => {});
      return;
    }
    previewVoice.mutate(
      { id: kit.id, data: {} },
      {
        onSuccess: ({ audioPath }) => {
          const url = `/api/storage${audioPath}`;
          setPreviewUrl(url);
          toast({ title: "Preview ready", description: "Playing your brand voice." });
        },
        onError: (err) => {
          toast({
            title: "Preview failed",
            description: apiErrorMessage(err, "Could not generate a preview."),
            variant: "destructive",
          });
        },
      },
    );
  };

  const handleRemove = () => {
    setConfirmRemove(false);
    removeVoice.mutate(
      { id: kit.id },
      {
        onSuccess: (detail) => {
          const payload = detail.activeVersion?.payload;
          if (payload) onKitVersionCreated(payload);
          onBrandVoiceChange(defaultBrandVoice());
          setPreviewUrl(null);
          setVoiceoverUrl(null);
          toast({
            title: "Brand voice removed",
            description: "Narration goes back to the stock voices.",
          });
        },
        onError: (err) => {
          toast({
            title: "Remove failed",
            description: apiErrorMessage(err, "Could not remove the brand voice."),
            variant: "destructive",
          });
        },
      },
    );
  };

  return (
    <div
      className="space-y-4 rounded-lg border border-primary/30 bg-primary/5 p-4"
      data-testid="section-brand-voice"
    >
      <div className="flex items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 shrink-0">
          <Mic className="h-4 w-4 text-primary" />
        </span>
        <p className="text-sm font-semibold">Clone your voice</p>
        {cloned && <span className="text-xs rounded bg-primary/10 text-primary px-2 py-0.5">Cloned voice active</span>}
      </div>
      <p className="text-sm text-muted-foreground">
        Give your videos a consistent narrator that sounds like you. Upload a
        short, clean voice recording (30–60 seconds works best) and we clone it
        — or pick one of the stock voices below.
      </p>

      {featureOff ? (
        <p className="text-sm text-muted-foreground" data-testid="text-brand-voice-disabled">
          Voice cloning is currently turned off. Videos use the stock voice
          picked below.
        </p>
      ) : unconfigured ? (
        <p className="text-sm text-muted-foreground" data-testid="text-brand-voice-unconfigured">
          Voice cloning isn't set up yet — ask your administrator to finish
          setting it up. Until then, videos use the stock voice picked below.
        </p>
      ) : null}

      {cloned ? (
        <div className="space-y-2">
          <p className="text-sm">
            <span className="font-medium">{brandVoice.cloned_label ?? "Brand voice"}</span>
            <span className="text-muted-foreground">
              {" "}· {voiceAccentLabel(brandVoice.cloned_accent)}
            </span>
            {brandVoice.cloned_at && (
              <span className="text-muted-foreground">
                {" "}· cloned {new Date(brandVoice.cloned_at).toLocaleDateString()}
              </span>
            )}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handlePreview}
              disabled={previewVoice.isPending || cloningBlocked}
              data-testid="button-preview-brand-voice"
            >
              <Play className="mr-1.5 h-3.5 w-3.5" />
              {previewVoice.isPending ? "Generating preview..." : "Play preview"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleRecordClick}
              disabled={uploading || cloneVoice.isPending || cloningBlocked || micPending}
              data-testid="button-record-voice-sample"
            >
              <Mic className="mr-1.5 h-3.5 w-3.5" />
              Record a new voice
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setRecordError(null);
                sampleFileRef.current?.click();
              }}
              disabled={uploading || cloneVoice.isPending || cloningBlocked}
              data-testid="button-replace-brand-voice"
            >
              <Upload className="mr-1.5 h-3.5 w-3.5" />
              {uploading || cloneVoice.isPending ? "Cloning..." : "Upload a sample"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setScriptOpen(true)}
              data-testid="button-recording-script"
            >
              <ScrollText className="mr-1.5 h-3.5 w-3.5" />
              Get recording script
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setConfirmRemove(true)}
              disabled={removeVoice.isPending}
              data-testid="button-remove-brand-voice"
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              Remove all
            </Button>
          </div>
          {voiceLibrary.length > 0 && (
            <div className="space-y-2 rounded-md border bg-background/60 p-3" data-testid="list-voice-library">
              <p className="text-sm font-medium">Saved voices</p>
              <p className="text-xs text-muted-foreground">
                Keep up to 5 voices and switch which one narrates your videos.
              </p>
              {voiceLibrary.map((v) => {
                const active = v.provider_voice_id === brandVoice.provider_voice_id;
                return (
                  <div
                    key={v.id}
                    className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2"
                    data-testid={`row-voice-${v.id}`}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{v.label}</p>
                      <p className="text-xs text-muted-foreground">
                        {voiceAccentLabel(v.accent)} · cloned {new Date(v.cloned_at).toLocaleDateString()}
                      </p>
                    </div>
                    {active ? (
                      <span
                        className="text-xs rounded bg-primary/10 text-primary px-2 py-0.5"
                        data-testid={`badge-voice-active-${v.id}`}
                      >
                        Active
                      </span>
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => handleSelectVoice(v.id)}
                        disabled={selectVoice.isPending || deleteVoiceEntry.isPending}
                        data-testid={`button-use-voice-${v.id}`}
                      >
                        Use this voice
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setConfirmDeleteVoice({ id: v.id, label: v.label })}
                      disabled={deleteVoiceEntry.isPending || selectVoice.isPending}
                      aria-label={`Delete ${v.label}`}
                      data-testid={`button-delete-voice-${v.id}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
          <p className="text-xs text-muted-foreground" data-testid="text-voice-accent-guidance">
            An existing clone keeps the accent in its original recording. To add Indian English,
            create a new clone from a naturally Indian-English recording.
          </p>
          {recordError && (
            <p className="text-sm text-destructive" data-testid="text-record-error">
              {recordError}
            </p>
          )}
          {previewUrl && (
            <audio
              ref={audioRef}
              src={previewUrl}
              controls
              autoPlay
              className="w-full"
              data-testid="audio-brand-voice-preview"
            />
          )}

          <div className="space-y-2 rounded-md border bg-background/60 p-3">
            <p className="text-sm font-medium">Create audio in your voice</p>
            <p className="text-xs text-muted-foreground">
              Type a script and we'll turn it into an audio file spoken in your
              cloned voice — play it here or download it.
            </p>
            <Textarea
              value={audioScript}
              onChange={(e) => setAudioScript(e.target.value)}
              maxLength={2500}
              placeholder="e.g. Hey everyone, welcome back to our weekly update..."
              className="resize-none"
              data-testid="input-voice-audio-script"
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                onClick={() =>
                  createAudio.mutate(
                    { id: kit.id, data: { text: audioScript.trim() } },
                    {
                      onSuccess: ({ audioPath }) => {
                        setVoiceoverUrl(`/api/storage${audioPath}`);
                        toast({
                          title: "Audio ready",
                          description: "Play it below or download the file.",
                        });
                      },
                      onError: (err) => {
                        toast({
                          title: "Audio generation failed",
                          description: apiErrorMessage(err, "Could not generate the audio."),
                          variant: "destructive",
                        });
                      },
                    },
                  )
                }
                disabled={!audioScript.trim() || createAudio.isPending || cloningBlocked}
                data-testid="button-create-voice-audio"
              >
                {createAudio.isPending ? "Generating audio..." : "Generate audio"}
              </Button>
              {voiceoverUrl && (
                <Button type="button" variant="outline" size="sm" asChild>
                  <a href={voiceoverUrl} download="voiceover.wav" data-testid="link-download-voice-audio">
                    Download
                  </a>
                </Button>
              )}
            </div>
            {voiceoverUrl && (
              <audio
                src={voiceoverUrl}
                controls
                autoPlay
                className="w-full"
                data-testid="audio-voiceover"
              />
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleRecordClick}
              disabled={uploading || cloneVoice.isPending || cloningBlocked || micPending}
              data-testid="button-record-voice-sample"
            >
              <Mic className="mr-1.5 h-3.5 w-3.5" />
              Record a voice sample
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setRecordError(null);
                sampleFileRef.current?.click();
              }}
              disabled={uploading || cloneVoice.isPending || cloningBlocked}
              data-testid="button-upload-voice-sample"
            >
              <Upload className="mr-1.5 h-3.5 w-3.5" />
              {uploading || cloneVoice.isPending ? "Cloning your voice..." : "Upload a voice sample"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setScriptOpen(true)}
              data-testid="button-recording-script"
            >
              <ScrollText className="mr-1.5 h-3.5 w-3.5" />
              Get recording script
            </Button>
          </div>
          {recordError && (
            <p className="text-sm text-destructive" data-testid="text-record-error">
              {recordError}
            </p>
          )}
        </div>
      )}
      <input
        ref={sampleFileRef}
        type="file"
        accept="audio/*,.webm"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleSampleUpload(file);
        }}
        data-testid="input-voice-sample"
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <label className="text-sm font-medium">
            {cloned ? "Fallback stock voice" : "Stock voice"}
          </label>
          <Select
            value={brandVoice.preset_voice || "alloy"}
            onValueChange={(value) => onBrandVoiceChange({ ...brandVoice, preset_voice: value })}
          >
            <SelectTrigger data-testid="select-preset-voice">
              <SelectValue placeholder="Pick a voice" />
            </SelectTrigger>
            <SelectContent>
              {STOCK_VOICES.map((v) => (
                <SelectItem key={v.value} value={v.value}>
                  {v.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium">Delivery style</label>
          <Input
            value={brandVoice.delivery_style ?? ""}
            onChange={(e) => onBrandVoiceChange({ ...brandVoice, delivery_style: e.target.value })}
            placeholder="e.g. warm, upbeat, unhurried"
            data-testid="input-delivery-style"
          />
        </div>
      </div>

      <Dialog open={scriptOpen} onOpenChange={setScriptOpen}>
        <DialogContent className="sm:max-w-[560px]" data-testid="dialog-recording-script">
          <DialogHeader>
            <DialogTitle>Your recording script</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Read this out loud in one take — it takes about a minute and is
              written to give the clone the widest range of sounds in your voice.
            </p>
            <div
              className="max-h-64 overflow-y-auto whitespace-pre-line rounded-md border bg-muted/40 p-3 text-sm"
              data-testid="text-recording-script"
            >
              {VOICE_RECORDING_SCRIPT}
            </div>
            <div className="space-y-1.5">
              <p className="text-sm font-medium">Recording tips</p>
              <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground" data-testid="list-recording-tips">
                {VOICE_RECORDING_TIPS.map((tip, i) => (
                  <li key={i}>{tip}</li>
                ))}
              </ul>
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setScriptOpen(false)}
              data-testid="button-close-recording-script"
            >
              Close
            </Button>
            <Button type="button" onClick={handleCopyScript} data-testid="button-copy-recording-script">
              {scriptCopied ? (
                <Check className="mr-1.5 h-3.5 w-3.5" />
              ) : (
                <Copy className="mr-1.5 h-3.5 w-3.5" />
              )}
              {scriptCopied ? "Copied!" : "Copy script"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={!!sampleWarning}
        onOpenChange={(open) => {
          if (!open) {
            setSampleWarning(null);
            if (sampleFileRef.current) sampleFileRef.current.value = "";
          }
        }}
      >
        <AlertDialogContent data-testid="dialog-voice-sample-warning">
          <AlertDialogHeader>
            <AlertDialogTitle>This sample may produce a poor clone</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2" data-testid="text-voice-sample-warning">
                {sampleWarning?.issues.map((issue) => (
                  <p key={issue}>{VOICE_SAMPLE_ISSUE_MESSAGES[issue]}</p>
                ))}
                <p>
                  You can go ahead anyway, but for the best result we recommend
                  re-recording with the recording script.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => {
                if (sampleWarning?.take.kind === "extracted") {
                  discardTake();
                  setRecordOpen(false);
                  setRecStage("ready");
                }
              }}
              data-testid="button-cancel-voice-sample"
            >
              Choose another recording
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const take = sampleWarning?.take;
                setSampleWarning(null);
                if (take) {
                  void performSampleUpload(
                    take.kind === "local" ? take.file : take.sampleAssetPath,
                  );
                }
              }}
              data-testid="button-upload-voice-sample-anyway"
            >
              Save anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={recordOpen} onOpenChange={handleRecordDialogChange}>
        <DialogContent
          className="sm:max-w-[560px]"
          data-testid="dialog-record-voice"
          onInteractOutside={(e) => {
            // Don't lose a take (or a live recording) to a stray click.
            if (recStage !== "ready") e.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {recStage === "review"
                ? recorded?.kind === "extracted"
                  ? "Review the extracted audio"
                  : "Listen to your recording"
                : "Record your voice"}
            </DialogTitle>
          </DialogHeader>
          {recStage === "review" && recorded ? (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                {recorded.kind === "extracted"
                  ? `This is the audio from “${recorded.sourceLabel}”. Listen for one clear speaker without music or background voices, then name and save it.`
                  : "Happy with how it sounds? Give the voice a name and save it — or record again."}
              </p>
              <audio
                src={recorded.url}
                controls
                className="w-full"
                data-testid="audio-recorded-take"
              />
              <div className="space-y-2">
                <label className="text-sm font-medium" htmlFor="voice-name-input">
                  Voice name
                </label>
                <Input
                  id="voice-name-input"
                  value={voiceName}
                  onChange={(e) => setVoiceName(e.target.value)}
                  maxLength={120}
                  placeholder={`e.g. ${kit.name} voice, Founder's voice`}
                  data-testid="input-voice-name"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Recording accent</label>
                <Select
                  value={voiceAccent}
                  onValueChange={(value) => setVoiceAccent(value as VoiceAccent)}
                >
                  <SelectTrigger data-testid="select-voice-accent">
                    <SelectValue placeholder="Choose the recording accent" />
                  </SelectTrigger>
                  <SelectContent>
                    {VOICE_ACCENTS.map((accent) => (
                      <SelectItem key={accent.value} value={accent.value}>
                        {accent.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Choose Indian English only when this recording is naturally spoken that way.
                  The clone copies the recording; this setting cannot convert an existing accent.
                </p>
              </div>
              {recordError && (
                <p className="text-sm text-destructive" data-testid="text-record-error-dialog">
                  {recordError}
                </p>
              )}
              <DialogFooter className="gap-2">
                {recorded.kind === "extracted" ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      discardTake();
                      setRecordError(null);
                      setRecordOpen(false);
                      setRecStage("ready");
                    }}
                    disabled={uploading || cloneVoice.isPending}
                    data-testid="button-cancel-extracted-voice"
                  >
                    Choose another video
                  </Button>
                ) : recordedFromMic ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      discardTake();
                      setRecordError(null);
                      setRecStage("ready");
                    }}
                    disabled={uploading || cloneVoice.isPending}
                    data-testid="button-rerecord-voice"
                  >
                    <Mic className="mr-1.5 h-3.5 w-3.5" />
                    Re-record
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      discardTake();
                      setRecordError(null);
                      if (sampleFileRef.current) sampleFileRef.current.value = "";
                      sampleFileRef.current?.click();
                    }}
                    disabled={uploading || cloneVoice.isPending}
                    data-testid="button-pick-another-file"
                  >
                    <Upload className="mr-1.5 h-3.5 w-3.5" />
                    Choose another file
                  </Button>
                )}
                <Button
                  type="button"
                  onClick={() => void handleSaveTake()}
                  disabled={uploading || cloneVoice.isPending || cloningBlocked}
                  data-testid="button-save-voice-take"
                >
                  {uploading || cloneVoice.isPending ? "Saving voice..." : "Save this voice"}
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Read the script below out loud in one take (30–60 seconds is
                ideal). Take your time — recording only starts when you press
                the button.
              </p>
              <div className="space-y-2">
                <label className="text-sm font-medium">Recording accent</label>
                <Select
                  value={voiceAccent}
                  onValueChange={(value) => setVoiceAccent(value as VoiceAccent)}
                >
                  <SelectTrigger data-testid="select-voice-accent">
                    <SelectValue placeholder="Choose the recording accent" />
                  </SelectTrigger>
                  <SelectContent>
                    {VOICE_ACCENTS.map((accent) => (
                      <SelectItem key={accent.value} value={accent.value}>
                        {accent.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Select Indian English when your sample is naturally spoken in Indian English.
                  A clone learns its accent from the recording itself.
                </p>
              </div>
              <div
                className="max-h-48 overflow-y-auto whitespace-pre-line rounded-md border bg-muted/40 p-3 text-sm"
                data-testid="text-recording-script-inline"
              >
                {VOICE_RECORDING_SCRIPT}
              </div>
              {recStage === "ready" && (
                <ul
                  className="list-disc space-y-1 pl-5 text-xs text-muted-foreground"
                  data-testid="list-room-echo-tips"
                >
                  {VOICE_RECORDING_TIPS.map((tip, i) => (
                    <li key={i}>{tip}</li>
                  ))}
                </ul>
              )}
              {recStage === "recording" && (
                <div className="space-y-2">
                  <span
                    className="inline-flex items-center gap-1.5 text-sm font-medium tabular-nums text-destructive"
                    data-testid="text-recording-elapsed"
                  >
                    <span className="h-2 w-2 animate-pulse rounded-full bg-destructive" aria-hidden />
                    {formatElapsed(recordSeconds)}
                  </span>
                  <div className="space-y-1" data-testid="audio-level-meter">
                    <div
                      className="h-2 w-full overflow-hidden rounded-full bg-muted"
                      role="meter"
                      aria-label="Microphone level"
                      aria-valuenow={Math.round(Math.min(100, audioLevel * 200))}
                      aria-valuemin={0}
                      aria-valuemax={100}
                    >
                      <div
                        className={[
                          "h-full transition-none",
                          audioLevel < VOICE_SAMPLE_MIN_RMS
                            ? "bg-muted-foreground/40"
                            : audioLevel < 0.5
                              ? "bg-green-500"
                              : audioLevel < 0.85
                                ? "bg-amber-500"
                                : "bg-red-500",
                        ].join(" ")}
                        style={{ width: `${Math.min(100, audioLevel * 200)}%` }}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {audioLevel < VOICE_SAMPLE_MIN_RMS
                        ? "Too quiet — move closer to the microphone"
                        : audioLevel < 0.5
                          ? "Good level"
                          : audioLevel < 0.85
                            ? "Getting loud — move back a little"
                            : "Clipping — move back from the microphone"}
                    </p>
                  </div>
                  <p className="text-xs text-muted-foreground" data-testid="text-recording-hint">
                    Read at your natural pace — we'll stop automatically at{" "}
                    {formatElapsed(VOICE_SAMPLE_MAX_SECONDS)}. Aim for 30–60 seconds.
                  </p>
                </div>
              )}
              {recordError && (
                <p className="text-sm text-destructive" data-testid="text-record-error-dialog">
                  {recordError}
                </p>
              )}
              <DialogFooter>
                {recStage === "recording" ? (
                  <Button
                    type="button"
                    variant="destructive"
                    onClick={stopRecording}
                    data-testid="button-stop-voice-recording"
                  >
                    <Square className="mr-1.5 h-3.5 w-3.5" />
                    Stop recording
                  </Button>
                ) : (
                  <Button
                    type="button"
                    onClick={() => void startRecording()}
                    disabled={micPending}
                    data-testid="button-start-voice-recording"
                  >
                    <Mic className="mr-1.5 h-3.5 w-3.5" />
                    {micPending ? "Waiting for microphone..." : "Start recording"}
                  </Button>
                )}
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={!!confirmDeleteVoice}
        onOpenChange={(open) => {
          if (!open) setConfirmDeleteVoice(null);
        }}
      >
        <AlertDialogContent data-testid="dialog-delete-voice">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{confirmDeleteVoice?.label}"?</AlertDialogTitle>
            <AlertDialogDescription>
              This saved voice is deleted at the provider and cannot be
              restored. If it's your active voice, the newest remaining saved
              voice takes over.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete-voice">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmDeleteVoice) handleDeleteVoice(confirmDeleteVoice.id);
              }}
              data-testid="button-confirm-delete-voice"
            >
              Delete voice
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this brand voice?</AlertDialogTitle>
            <AlertDialogDescription>
              New videos will be narrated with the stock voices instead. The
              cloned voice is deleted at the provider and cannot be restored —
              you can always clone it again from a fresh sample.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction onClick={handleRemove} data-testid="button-confirm-remove-voice">
              Remove voice
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

const BASE_VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm"];
const MAX_BASE_VIDEO_MB = 100;
const MAX_BASE_VIDEOS = 12;

type BaseVideoEntry = NonNullable<BrandKitPayload["base_videos"]>[number];

/**
 * Reusable pre-recorded lip-sync base videos stored on the kit, each mapped
 * to a default narration voice (cloned or a stock voice). Edits ride the
 * normal "save brand" full-payload version write.
 */
function BaseVideosSection({
  kitId,
  baseVideos,
  savedBaseVideos,
  hasClonedVoice,
  onAudioExtracted,
  onChange,
}: {
  kitId: number;
  baseVideos: BaseVideoEntry[];
  savedBaseVideos: BaseVideoEntry[];
  hasClonedVoice: boolean;
  onAudioExtracted: (sample: ExtractedVoiceReviewSample) => void;
  onChange: (next: BaseVideoEntry[]) => void;
}) {
  const { toast } = useToast();
  const { data: voiceStatus } = useGetBrandVoiceStatus();
  const requestUploadUrl = useRequestUploadUrl();
  const extractAudio = useExtractBrandBaseVideoAudio();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [extractingId, setExtractingId] = useState<string | null>(null);
  const cloningBlocked = voiceStatus
    ? !voiceStatus.enabled || !voiceStatus.configured
    : false;

  const patch = (id: string, changes: Partial<BaseVideoEntry>) =>
    onChange(baseVideos.map((v) => (v.id === id ? { ...v, ...changes } : v)));

  // If the kit's cloned voice is gone, "cloned" mappings are meaningless —
  // make the fallback explicit instead of silently resolving at generation.
  useEffect(() => {
    if (hasClonedVoice) return;
    if (!baseVideos.some((v) => v.voice_mode === "cloned")) return;
    onChange(
      baseVideos.map((v) =>
        v.voice_mode === "cloned"
          ? { ...v, voice_mode: "preset", preset_voice: v.preset_voice || "alloy" }
          : v,
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasClonedVoice, baseVideos]);

  const handleUpload = async (file: File) => {
    if (!BASE_VIDEO_TYPES.includes(file.type)) {
      toast({
        title: "Unsupported file",
        description: "Use an MP4, MOV, or WebM video.",
        variant: "destructive",
      });
      return;
    }
    if (file.size > MAX_BASE_VIDEO_MB * 1024 * 1024) {
      toast({
        title: "Video too large",
        description: `Keep it under ${MAX_BASE_VIDEO_MB} MB.`,
        variant: "destructive",
      });
      return;
    }
    setUploading(true);
    try {
      const { uploadURL, objectPath } = await requestUploadUrl.mutateAsync({
        data: { name: file.name, size: file.size, contentType: file.type },
      });
      const put = await fetch(uploadURL, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": file.type },
      });
      if (!put.ok) throw new Error(`Upload failed (${put.status})`);
      onChange([
        ...baseVideos,
        {
          id: `bv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          label: file.name.replace(/\.[^.]+$/, "").slice(0, 120) || "Base video",
          video_path: objectPath,
          voice_mode: hasClonedVoice ? "cloned" : "preset",
          preset_voice: hasClonedVoice ? null : "alloy",
        },
      ]);
      toast({
        title: "Video added",
        description: "Remember to save the brand to keep it.",
      });
    } catch (err) {
      toast({
        title: "Upload failed",
        description: apiErrorMessage(err, "Could not upload the video."),
        variant: "destructive",
      });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const handleExtractAudio = async (video: BaseVideoEntry) => {
    setExtractingId(video.id);
    try {
      const sample = await extractAudio.mutateAsync({
        id: kitId,
        baseVideoId: video.id,
      });
      onAudioExtracted({ ...sample, sourceLabel: video.label || "Base video" });
      toast({
        title: "Audio extracted",
        description: "Listen to the sample before choosing whether to clone it.",
      });
    } catch (err) {
      toast({
        title: "Could not extract audio",
        description: apiErrorMessage(
          err,
          "This video may not contain a usable spoken audio track.",
        ),
        variant: "destructive",
      });
    } finally {
      setExtractingId(null);
    }
  };

  return (
    <div className="space-y-3 rounded-lg border p-4" data-testid="section-base-videos">
      <div>
        <p className="text-sm font-semibold">Lip-sync base videos</p>
        <p className="text-xs text-muted-foreground">
          Save pre-recorded clips of yourself (or your team) here and pick each
          clip's default voice. In Video Studio's Lip Sync you can reuse them
          without re-uploading — and still switch the voice per video.
        </p>
      </div>
      {baseVideos.map((v) => {
        const saved = savedBaseVideos.some((candidate) => candidate.id === v.id);
        const extracting = extractingId === v.id;
        return (
          <div
            key={v.id}
            className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 p-2"
            data-testid={`row-base-video-${v.id}`}
          >
            <Input
              value={v.label}
              onChange={(e) => patch(v.id, { label: e.target.value })}
              className="h-8 w-44 flex-1 min-w-32"
              placeholder="Label"
              data-testid={`input-base-video-label-${v.id}`}
            />
            <Select
              value={v.voice_mode === "cloned" ? "cloned" : v.preset_voice || "alloy"}
              onValueChange={(value) =>
                patch(
                  v.id,
                  value === "cloned"
                    ? { voice_mode: "cloned", preset_voice: null }
                    : { voice_mode: "preset", preset_voice: value },
                )
              }
            >
              <SelectTrigger className="h-8 w-44" data-testid={`select-base-video-voice-${v.id}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {hasClonedVoice && <SelectItem value="cloned">My cloned voice</SelectItem>}
                {STOCK_VOICES.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void handleExtractAudio(v)}
              disabled={!saved || cloningBlocked || extractingId !== null}
              title={
                saved
                  ? "Extract this video's audio for voice cloning"
                  : "Save the Brand Kit before extracting audio"
              }
              data-testid={`button-extract-base-video-audio-${v.id}`}
            >
              <AudioLines className="mr-1.5 h-3.5 w-3.5" />
              {extracting ? "Extracting..." : saved ? "Use audio for voice" : "Save brand first"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onChange(baseVideos.filter((x) => x.id !== v.id))}
              data-testid={`button-remove-base-video-${v.id}`}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        );
      })}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={uploading || baseVideos.length >= MAX_BASE_VIDEOS}
        onClick={() => fileRef.current?.click()}
        data-testid="button-add-base-video"
      >
        <Upload className="mr-1.5 h-3.5 w-3.5" />
        {uploading ? "Uploading..." : "Add a base video"}
      </Button>
      <input
        ref={fileRef}
        type="file"
        accept={BASE_VIDEO_TYPES.join(",")}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleUpload(file);
        }}
        data-testid="input-base-video-file"
      />
    </div>
  );
}

function commaList(input: string): string[] {
  return input
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function lineList(input: string): string[] {
  return input
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

function swatches(payload: BrandKitPayload | null | undefined): string[] {
  if (!payload) return [];
  return [...payload.colors.primary, ...payload.colors.secondary, ...payload.colors.neutral]
    .map((c) => c.hex)
    .filter(Boolean)
    .slice(0, 6);
}

function brandLogoUrl(payload: BrandKitPayload | null | undefined): string | null {
  if (!payload?.logos) return null;
  return (
    payload.logos.primary?.url ||
    payload.logos.icon_mark?.url ||
    payload.logos.favicon?.url ||
    null
  );
}

/** Logo tile with a letter-mark fallback when there is no (or a broken) logo. */
function BrandLogo({
  url,
  name,
  accent,
}: {
  url: string | null;
  name: string;
  accent: string;
}) {
  const [failed, setFailed] = useState(false);
  // A previously broken logo URL latches `failed`; clear it whenever the URL
  // changes so a newly pulled (working) logo gets a fresh load attempt.
  useEffect(() => {
    setFailed(false);
  }, [url]);
  const showImage = url && !failed;
  return (
    <div className="h-16 w-16 rounded-xl bg-white border border-border shadow-md flex items-center justify-center overflow-hidden shrink-0">
      {showImage ? (
        <img
          src={url}
          alt={`${name} logo`}
          className="h-full w-full object-contain p-1.5"
          onError={() => setFailed(true)}
        />
      ) : (
        <span
          className="text-2xl font-extrabold"
          style={{ color: accent }}
          aria-hidden="true"
        >
          {(name.trim()[0] ?? "?").toUpperCase()}
        </span>
      )}
    </div>
  );
}

const COLOR_GROUPS = [
  { key: "primary", label: "Primary" },
  { key: "secondary", label: "Secondary" },
  { key: "neutral", label: "Neutral" },
] as const;

/** A small editor for one color group (primary/secondary/neutral). */
function ColorGroupEditor({
  label,
  colors,
  onChange,
}: {
  label: string;
  colors: BrandColor[];
  onChange: (next: BrandColor[]) => void;
}) {
  const update = (i: number, patch: Partial<BrandColor>) => {
    onChange(colors.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  };
  const remove = (i: number) => onChange(colors.filter((_, idx) => idx !== i));
  const add = () => onChange([...colors, { name: "", hex: "#000000", usage: "" }]);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{label}</span>
        <Button type="button" variant="outline" size="sm" onClick={add}>
          <Plus className="h-3.5 w-3.5 mr-1" /> Add
        </Button>
      </div>
      {colors.length === 0 ? (
        <p className="text-xs text-muted-foreground">No colors yet.</p>
      ) : (
        <div className="space-y-2">
          {colors.map((c, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                type="color"
                value={/^#[0-9a-fA-F]{6}$/.test(c.hex) ? c.hex : "#000000"}
                onChange={(e) => update(i, { hex: e.target.value })}
                className="w-11 p-1 h-9 shrink-0"
              />
              <Input
                value={c.hex}
                onChange={(e) => update(i, { hex: e.target.value })}
                placeholder="#000000"
                className="w-28 shrink-0"
              />
              <Input
                value={c.name}
                onChange={(e) => update(i, { name: e.target.value })}
                placeholder="Name"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="text-muted-foreground shrink-0"
                onClick={() => remove(i)}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function BrandKitsPage() {
  const { data: kits, isLoading } = useListBrandKits();
  const createBrandKit = useCreateBrandKit();
  const updateBrandKit = useUpdateBrandKit();
  const deleteBrandKit = useDeleteBrandKit();
  const setDefaultBrandKit = useSetDefaultBrandKit();
  const createVersion = useCreateBrandKitVersion();
  const draftBrandKit = useDraftBrandKit();
  const requestUploadUrl = useRequestUploadUrl();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const logoFileRef = useRef<HTMLInputElement>(null);
  const [logoUploading, setLogoUploading] = useState(false);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListBrandKitsQueryKey() });

  // --- Create dialog state ---
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [brandType, setBrandType] = useState<"primary" | "sub_brand">("primary");
  const [isDefault, setIsDefault] = useState(false);
  const [draftUrl, setDraftUrl] = useState("");
  const [draftNotes, setDraftNotes] = useState("");
  const [creating, setCreating] = useState(false);

  const resetCreate = () => {
    setName("");
    setBrandType("primary");
    setIsDefault(false);
    setDraftUrl("");
    setDraftNotes("");
  };

  const handleCreate = async () => {
    if (!name.trim()) return;
    setCreating(true);
    try {
      let payload: BrandKitPayload | null = null;
      if (draftUrl.trim() || draftNotes.trim()) {
        try {
          const draft = await draftBrandKit.mutateAsync({
            data: {
              url: draftUrl.trim() || undefined,
              notes: draftNotes.trim() || undefined,
              brandName: name.trim(),
            },
          });
          payload = draft.payload;
        } catch {
          toast({
            title: "AI draft unavailable",
            description: "Creating a blank brand you can fill in.",
          });
        }
      }
      const created = await createBrandKit.mutateAsync({
        data: { name: name.trim(), brandType, isDefault, payload },
      });
      invalidate();
      setCreateOpen(false);
      resetCreate();
      if (payload) {
        const colorCount =
          payload.colors.primary.length +
          payload.colors.secondary.length +
          payload.colors.neutral.length;
        const capturedLogo = brandLogoUrl(payload) ? "the logo, " : "";
        toast({
          title: "Brand created from AI draft",
          description: `Captured ${capturedLogo}${colorCount} color${colorCount === 1 ? "" : "s"}, ${payload.voice.traits.length} voice trait${payload.voice.traits.length === 1 ? "" : "s"}, ${payload.identity.audience.length} audience group${payload.identity.audience.length === 1 ? "" : "s"}. Review and adjust below.`,
        });
        // Open the editor so the user can see exactly what the AI extracted.
        openEdit(created);
      } else {
        toast({ title: "Brand created" });
      }
    } catch (err) {
      const status = (err as { status?: number })?.status;
      toast({
        title: status === 402 ? "Plan limit reached" : "Could not create brand",
        description:
          status === 402 ? "Upgrade your plan to add more brands." : undefined,
        variant: "destructive",
      });
    } finally {
      setCreating(false);
    }
  };

  // --- Edit dialog state ---
  const [editKit, setEditKit] = useState<BrandKit | null>(null);
  const [editName, setEditName] = useState("");
  const [draft, setDraft] = useState<BrandKitPayload | null>(null);
  const [extractedVoiceSample, setExtractedVoiceSample] =
    useState<ExtractedVoiceReviewSample | null>(null);
  // Text-field mirrors for list-based payload fields.
  const [audience, setAudience] = useState("");
  const [traits, setTraits] = useState("");
  const [dos, setDos] = useState("");
  const [donts, setDonts] = useState("");
  const [imagery, setImagery] = useState("");
  // Pull-from-website inside the edit dialog.
  const [pullUrl, setPullUrl] = useState("");
  const [pulling, setPulling] = useState(false);

  const handlePullFromWebsite = async () => {
    if (!pullUrl.trim() || !draft) return;
    setPulling(true);
    try {
      const pulled = await draftBrandKit.mutateAsync({
        data: { url: pullUrl.trim(), brandName: editName.trim() || undefined },
      });
      const p = pulled.payload;
      const pulledColors =
        p.colors.primary.length +
        p.colors.secondary.length +
        p.colors.neutral.length;
      const pulledLogo = brandLogoUrl(p);
      setDraft((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          identity: {
            ...prev.identity,
            tagline: prev.identity.tagline || p.identity.tagline,
            description: prev.identity.description || p.identity.description,
            industry: prev.identity.industry || p.identity.industry,
          },
          colors: pulledColors > 0 ? p.colors : prev.colors,
          logos: pulledLogo
            ? {
                ...prev.logos,
                primary: p.logos.primary ?? prev.logos?.primary ?? null,
                icon_mark: p.logos.icon_mark ?? prev.logos?.icon_mark ?? null,
                favicon: p.logos.favicon ?? prev.logos?.favicon ?? null,
              }
            : prev.logos,
        };
      });
      if (!audience.trim() && p.identity.audience.length > 0) {
        setAudience(p.identity.audience.join(", "));
      }
      if (!traits.trim() && p.voice.traits.length > 0) {
        setTraits(p.voice.traits.join(", "));
      }
      if (pulledColors > 0 || pulledLogo) {
        toast({
          title: "Pulled from website",
          description: `Found ${pulledLogo ? "the logo and " : ""}${pulledColors} color${pulledColors === 1 ? "" : "s"}. Review the Colors tab, then save.`,
        });
      } else {
        toast({
          title: "Nothing usable found",
          description:
            "The website could not be read or had no detectable logo or colors.",
          variant: "destructive",
        });
      }
    } catch {
      toast({
        title: "Could not pull from website",
        description: "Check the URL and try again.",
        variant: "destructive",
      });
    } finally {
      setPulling(false);
    }
  };

  const openEdit = (kit: BrandKit) => {
    const p = kit.activeVersion?.payload ?? null;
    if (!p) {
      toast({
        title: "No active version",
        description: "This brand has no editable version yet.",
        variant: "destructive",
      });
      return;
    }
    // Deep clone so edits don't mutate cached query data, then fill any
    // missing sections defensively so the editor never crashes on a
    // partial payload.
    const raw = JSON.parse(JSON.stringify(p)) as Partial<BrandKitPayload>;
    const clone: BrandKitPayload = {
      ...raw,
      identity: {
        brand_name: kit.name,
        brand_slug: "",
        tagline: "",
        description: "",
        industry: "",
        audience: [],
        ...(raw.identity ?? {}),
      },
      voice: {
        traits: [],
        dos: [],
        donts: [],
        caption_style: "",
        cta_style: "",
        ...(raw.voice ?? {}),
      },
      colors: {
        primary: [],
        secondary: [],
        neutral: [],
        ...(raw.colors ?? {}),
      },
      logos: {
        primary: null,
        secondary: null,
        icon_mark: null,
        favicon: null,
        usage_rules: [],
        ...(raw.logos ?? {}),
      },
      visual_style: {
        imagery_style: [],
        icon_style: "",
        illustration_style: "",
        motion_style: "",
        ...(raw.visual_style ?? {}),
      },
    } as BrandKitPayload;
    setEditKit(kit);
    setEditName(kit.name);
    setPullUrl("");
    setExtractedVoiceSample(null);
    setDraft(clone);
    setAudience((clone.identity.audience ?? []).join(", "));
    setTraits((clone.voice.traits ?? []).join(", "));
    setDos((clone.voice.dos ?? []).join("\n"));
    setDonts((clone.voice.donts ?? []).join("\n"));
    setImagery((clone.visual_style.imagery_style ?? []).join(", "));
  };

  const closeEdit = () => {
    setExtractedVoiceSample(null);
    setEditKit(null);
    setDraft(null);
  };

  const handleSaveEdit = async () => {
    if (!editKit || !draft) return;
    const payload: BrandKitPayload = {
      ...draft,
      identity: { ...draft.identity, audience: commaList(audience) },
      voice: {
        ...draft.voice,
        traits: commaList(traits),
        dos: lineList(dos),
        donts: lineList(donts),
      },
      visual_style: {
        ...draft.visual_style,
        imagery_style: commaList(imagery),
      },
    };
    try {
      if (editName.trim() && editName.trim() !== editKit.name) {
        await updateBrandKit.mutateAsync({
          id: editKit.id,
          data: { name: editName.trim() },
        });
      }
      await createVersion.mutateAsync({
        id: editKit.id,
        data: {
          payload,
          sourceType: "manual",
          approvalStatus: "approved",
          activate: true,
        },
      });
      toast({ title: "Brand updated" });
      invalidate();
      closeEdit();
    } catch {
      toast({ title: "Could not save brand", variant: "destructive" });
    }
  };

  const handleSetDefault = (id: number) => {
    setDefaultBrandKit.mutate(
      { id },
      {
        onSuccess: () => {
          toast({ title: "Default brand updated" });
          invalidate();
        },
        onError: () =>
          toast({ title: "Could not set default", variant: "destructive" }),
      },
    );
  };

  // window.confirm is blocked inside the sandboxed preview iframe, so we use
  // a proper dialog for archive confirmation.
  const [archiveTarget, setArchiveTarget] = useState<BrandKit | null>(null);

  const confirmArchive = () => {
    if (!archiveTarget) return;
    deleteBrandKit.mutate(
      { id: archiveTarget.id },
      {
        onSuccess: () => {
          toast({ title: "Brand archived" });
          invalidate();
          setArchiveTarget(null);
        },
        onError: () => {
          toast({ title: "Could not archive brand", variant: "destructive" });
          setArchiveTarget(null);
        },
      },
    );
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-48" />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-64 rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  const items = kits ?? [];

  const patchDraft = (fn: (p: BrandKitPayload) => BrandKitPayload) => {
    setDraft((prev) => (prev ? fn(prev) : prev));
  };

  const handleLogoUpload = async (file: File) => {
    if (!file.type.startsWith("image/")) {
      toast({
        title: "Not an image",
        description: "Please pick an image file (PNG, JPG, SVG, or WebP).",
        variant: "destructive",
      });
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast({
        title: "File too large",
        description: "Logo images must be under 5 MB.",
        variant: "destructive",
      });
      return;
    }
    setLogoUploading(true);
    try {
      const { uploadURL, objectPath } = await requestUploadUrl.mutateAsync({
        data: { name: file.name, size: file.size, contentType: file.type },
      });
      const put = await fetch(uploadURL, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": file.type },
      });
      if (!put.ok) throw new Error(`Upload failed (${put.status})`);
      const servedUrl = `/api/storage${objectPath}`;
      patchDraft((p) => ({
        ...p,
        logos: {
          ...p.logos,
          primary: { url: servedUrl, type: "uploaded" },
        },
      }));
      toast({
        title: "Logo uploaded",
        description: "Save the brand to keep this logo.",
      });
    } catch (err) {
      toast({
        title: "Upload failed",
        description: err instanceof Error ? err.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setLogoUploading(false);
      if (logoFileRef.current) logoFileRef.current.value = "";
    }
  };

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight">Brand Kits</h1>
          <p className="text-muted-foreground text-lg mt-1">
            Manage brand identity, colors, and voice used across AI generation.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)} className="shadow-md">
          <Plus className="h-4 w-4 mr-2" /> New Brand
        </Button>
      </div>

      {items.length === 0 ? (
        <div className="text-center py-24 bg-card rounded-2xl border border-border shadow-sm">
          <Palette className="mx-auto h-16 w-16 text-muted mb-4" />
          <h3 className="text-xl font-bold">No Brands Yet</h3>
          <p className="text-muted-foreground mt-2 mb-6">
            Create your first brand to keep AI content consistent and on-brand.
          </p>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4 mr-2" /> Create Brand
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {items.map((kit, i) => {
            const payload = kit.activeVersion?.payload ?? null;
            const displayName = payload?.identity.brand_name?.trim() || kit.name;
            const colors = swatches(payload);
            const logoUrl = brandLogoUrl(payload);
            const accent = colors[0] ?? "hsl(255 85% 55%)";
            const gradient =
              colors.length >= 3
                ? `linear-gradient(135deg, ${colors[0]} 0%, ${colors[1]} 50%, ${colors[2]} 100%)`
                : colors.length === 2
                  ? `linear-gradient(135deg, ${colors[0]} 0%, ${colors[1]} 100%)`
                  : colors.length === 1
                    ? `linear-gradient(135deg, ${colors[0]} 0%, ${colors[0]} 100%)`
                    : null;
            return (
              <Card
                key={kit.id}
                className="overflow-hidden flex flex-col group hover:shadow-lg transition-all duration-300 border-border animate-in fade-in"
                style={{ animationDelay: `${i * 50}ms` }}
              >
                <CardContent className="flex-1 p-5 flex flex-col gap-4 relative">
                  {kit.isDefault && (
                    <span className="absolute top-3 right-3 inline-flex items-center gap-1 text-xs font-semibold bg-muted text-foreground px-2 py-0.5 rounded-full border border-border">
                      <Star className="h-3 w-3 fill-current" /> Default
                    </span>
                  )}
                  <div className="flex items-end justify-between gap-3">
                    <BrandLogo url={logoUrl} name={displayName} accent={accent} />
                    <div className={`flex gap-1 pb-1 ${kit.isDefault ? "mr-20" : ""}`}>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => openEdit(kit)}
                        title="Edit"
                        data-testid={`button-edit-kit-${kit.id}`}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive/60 hover:text-destructive hover:bg-destructive/10"
                        onClick={() => setArchiveTarget(kit)}
                        title="Archive"
                        data-testid={`button-archive-kit-${kit.id}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>

                  <div className="min-w-0">
                    <h3 className="font-bold text-xl truncate">{displayName}</h3>
                    <p className="text-xs text-muted-foreground truncate">
                      {payload?.identity.tagline ||
                        payload?.identity.industry ||
                        (kit.brandType === "sub_brand" ? "Sub-brand" : "Primary brand")}
                    </p>
                  </div>

                  {payload &&
                    COLOR_GROUPS.some((g) => payload.colors[g.key].length > 0) && (
                      <div className="space-y-2.5">
                        {COLOR_GROUPS.map((g) => {
                          const group = payload.colors[g.key].filter((c) => c.hex);
                          if (group.length === 0) return null;
                          const shown = group.slice(0, 4);
                          return (
                            <div key={g.key}>
                              <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">
                                {g.label}
                              </p>
                              <div className="flex flex-wrap gap-1.5">
                                {shown.map((c, idx) => (
                                  <div
                                    key={idx}
                                    className="flex items-center gap-1.5 rounded-md border border-border bg-muted/30 pl-1 pr-2 py-1"
                                    title={c.name || c.hex}
                                  >
                                    <span
                                      className="h-4 w-4 rounded border border-black/10 shrink-0"
                                      style={{ backgroundColor: c.hex }}
                                    />
                                    <span className="text-[10px] font-mono text-muted-foreground">
                                      {c.hex.toUpperCase()}
                                    </span>
                                  </div>
                                ))}
                                {group.length > shown.length && (
                                  <span className="text-[10px] text-muted-foreground self-center">
                                    +{group.length - shown.length} more
                                  </span>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}

                  {payload && payload.voice.traits.length > 0 && (
                    <div>
                      <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">
                        Voice
                      </p>
                      <div className="flex flex-wrap gap-1">
                        {payload.voice.traits.slice(0, 4).map((t) => (
                          <span
                            key={t}
                            className="text-xs bg-muted px-2 py-1 rounded-md font-medium"
                          >
                            {t}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="mt-auto pt-1">
                    {!kit.isDefault && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full"
                        onClick={() => handleSetDefault(kit.id)}
                        disabled={setDefaultBrandKit.isPending}
                      >
                        <Star className="h-3.5 w-3.5 mr-1.5" /> Set as default
                      </Button>
                    )}
                  </div>
                </CardContent>
                <div
                  className={`h-20 w-full ${gradient ? "" : "bg-card border-t border-border"}`}
                  style={gradient ? { background: gradient } : undefined}
                />
              </Card>
            );
          })}
        </div>
      )}

      <SavedVisualsSection />

      {/* Archive confirmation dialog */}
      <Dialog
        open={!!archiveTarget}
        onOpenChange={(o) => !o && setArchiveTarget(null)}
      >
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>Archive brand</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Archive "{archiveTarget?.name}"? It will be removed from your list
            and can no longer be used for new content.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setArchiveTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmArchive}
              disabled={deleteBrandKit.isPending}
              data-testid="button-confirm-archive"
            >
              {deleteBrandKit.isPending ? (
                <RippleSpinner className="mr-2 h-4 w-4" />
              ) : null}
              Archive
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create dialog */}
      <Dialog
        open={createOpen}
        onOpenChange={(o) => {
          setCreateOpen(o);
          if (!o) resetCreate();
        }}
      >
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>Create Brand</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4 max-h-[60vh] overflow-y-auto px-1">
            <div className="space-y-2">
              <label className="text-sm font-medium">Brand name</label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Acme Coffee"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Type</label>
                <Select
                  value={brandType}
                  onValueChange={(v) => setBrandType(v as "primary" | "sub_brand")}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="primary">Primary</SelectItem>
                    <SelectItem value="sub_brand">Sub-brand</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Default</label>
                <label className="flex items-center gap-2 h-10 text-sm">
                  <input
                    type="checkbox"
                    checked={isDefault}
                    onChange={(e) => setIsDefault(e.target.checked)}
                    className="h-4 w-4"
                  />
                  Use as default brand
                </label>
              </div>
            </div>

            <div className="rounded-lg border border-border p-3 space-y-3 bg-muted/20">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Wand2 className="h-4 w-4" /> Draft with AI (optional)
              </div>
              <p className="text-xs text-muted-foreground">
                Add a website or notes and we'll pre-fill colors, voice, and more.
              </p>
              <Input
                value={draftUrl}
                onChange={(e) => setDraftUrl(e.target.value)}
                placeholder="https://yourbrand.com"
              />
              <Textarea
                value={draftNotes}
                onChange={(e) => setDraftNotes(e.target.value)}
                placeholder="Describe voice, audience, colors..."
                className="resize-none"
              />
            </div>

            <div
              className="rounded-lg border border-primary/30 bg-primary/5 p-3 flex items-start gap-2.5"
              data-testid="hint-voice-clone-on-create"
            >
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/10 shrink-0 mt-0.5">
                <Mic className="h-3.5 w-3.5 text-primary" />
              </span>
              <p className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">Want videos narrated in your own voice?</span>{" "}
                Once this brand is created, open it and go to the Voice tab to
                clone your voice from a short recording.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={creating || !name.trim()}>
              {creating ? (
                <RippleSpinner className="mr-2 h-4 w-4" />
              ) : draftUrl.trim() || draftNotes.trim() ? (
                <Wand2 className="mr-2 h-4 w-4" />
              ) : null}
              Create Brand
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={!!editKit} onOpenChange={(o) => !o && closeEdit()}>
        <DialogContent className="sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle>Edit Brand</DialogTitle>
          </DialogHeader>
          {draft && (
            <Tabs defaultValue="identity" className="w-full">
              <TabsList className="grid w-full grid-cols-3">
                <TabsTrigger value="identity">Identity</TabsTrigger>
                <TabsTrigger value="voice">Voice</TabsTrigger>
                <TabsTrigger value="colors">Colors</TabsTrigger>
              </TabsList>

              <div className="max-h-[55vh] overflow-y-auto px-1 py-4">
                <TabsContent value="identity" className="space-y-4 mt-0">
                  <div className="rounded-lg border border-border p-3 space-y-2 bg-muted/20">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <Wand2 className="h-4 w-4" /> Pull from website
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Fetch the logo and real brand colors directly from a site.
                      Existing colors will be replaced; review before saving.
                    </p>
                    <div className="flex gap-2">
                      <Input
                        value={pullUrl}
                        onChange={(e) => setPullUrl(e.target.value)}
                        placeholder="https://yourbrand.com"
                        data-testid="input-pull-url"
                      />
                      <Button
                        variant="secondary"
                        onClick={handlePullFromWebsite}
                        disabled={pulling || !pullUrl.trim()}
                        data-testid="button-pull-website"
                      >
                        {pulling ? (
                          <RippleSpinner className="h-4 w-4" />
                        ) : (
                          "Pull"
                        )}
                      </Button>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Brand name</label>
                    <Input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Display name</label>
                    <Input
                      value={draft.identity.brand_name}
                      onChange={(e) =>
                        patchDraft((p) => ({
                          ...p,
                          identity: { ...p.identity, brand_name: e.target.value },
                        }))
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Tagline</label>
                    <Input
                      value={draft.identity.tagline}
                      onChange={(e) =>
                        patchDraft((p) => ({
                          ...p,
                          identity: { ...p.identity, tagline: e.target.value },
                        }))
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Logo</label>
                    <div className="flex items-center gap-2">
                      <input
                        ref={logoFileRef}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) void handleLogoUpload(file);
                        }}
                        data-testid="input-logo-file"
                      />
                      <Button
                        variant="secondary"
                        onClick={() => logoFileRef.current?.click()}
                        disabled={logoUploading}
                        data-testid="button-upload-logo"
                      >
                        {logoUploading ? (
                          <RippleSpinner className="h-4 w-4 mr-2" />
                        ) : (
                          <Upload className="h-4 w-4 mr-2" />
                        )}
                        Upload
                      </Button>
                      <span className="text-xs text-muted-foreground">
                        PNG, JPG, SVG, or WebP — up to 5 MB.
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      {brandLogoUrl(draft) && (
                        <img
                          src={brandLogoUrl(draft)!}
                          alt="Logo preview"
                          className="h-9 w-9 rounded-md border border-border object-contain bg-white p-0.5 shrink-0"
                          onError={(e) => {
                            e.currentTarget.style.display = "none";
                          }}
                        />
                      )}
                      <Input
                        value={draft.logos?.primary?.url ?? ""}
                        onChange={(e) => {
                          const url = e.target.value.trim();
                          patchDraft((p) => ({
                            ...p,
                            logos: {
                              ...p.logos,
                              primary: url ? { url, type: "external" } : null,
                            },
                          }));
                        }}
                        placeholder="https://yourbrand.com/logo.png"
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Shown on the brand card. Captured automatically when
                      drafting from a website.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Industry</label>
                    <Input
                      value={draft.identity.industry}
                      onChange={(e) =>
                        patchDraft((p) => ({
                          ...p,
                          identity: { ...p.identity, industry: e.target.value },
                        }))
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Description</label>
                    <Textarea
                      value={draft.identity.description}
                      onChange={(e) =>
                        patchDraft((p) => ({
                          ...p,
                          identity: { ...p.identity, description: e.target.value },
                        }))
                      }
                      className="resize-none"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">
                      Audience <span className="text-muted-foreground">(comma separated)</span>
                    </label>
                    <Input
                      value={audience}
                      onChange={(e) => setAudience(e.target.value)}
                      placeholder="e.g. young professionals, coffee lovers"
                    />
                  </div>
                </TabsContent>

                <TabsContent value="voice" className="space-y-4 mt-0">
                  {editKit && (
                    <BrandVoiceSection
                      kit={editKit}
                      brandVoice={draft.brand_voice ?? defaultBrandVoice()}
                      extractedSample={extractedVoiceSample}
                      onExtractedSampleOpened={() => setExtractedVoiceSample(null)}
                      onBrandVoiceChange={(next) =>
                        patchDraft((p) => ({ ...p, brand_voice: next }))
                      }
                      onKitVersionCreated={() => invalidate()}
                    />
                  )}
                  <BaseVideosSection
                    kitId={editKit!.id}
                    baseVideos={draft.base_videos ?? []}
                    savedBaseVideos={
                      editKit?.activeVersion?.payload?.base_videos ?? []
                    }
                    hasClonedVoice={draft.brand_voice?.mode === "cloned"}
                    onAudioExtracted={setExtractedVoiceSample}
                    onChange={(next) =>
                      patchDraft((p) => ({ ...p, base_videos: next }))
                    }
                  />

                  <div className="space-y-2">
                    <label className="text-sm font-medium">
                      Traits <span className="text-muted-foreground">(comma separated)</span>
                    </label>
                    <Input
                      value={traits}
                      onChange={(e) => setTraits(e.target.value)}
                      placeholder="e.g. friendly, bold, witty"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Caption style</label>
                    <Input
                      value={draft.voice.caption_style}
                      onChange={(e) =>
                        patchDraft((p) => ({
                          ...p,
                          voice: { ...p.voice, caption_style: e.target.value },
                        }))
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">CTA style</label>
                    <Input
                      value={draft.voice.cta_style}
                      onChange={(e) =>
                        patchDraft((p) => ({
                          ...p,
                          voice: { ...p.voice, cta_style: e.target.value },
                        }))
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">
                      Do's <span className="text-muted-foreground">(one per line)</span>
                    </label>
                    <Textarea
                      value={dos}
                      onChange={(e) => setDos(e.target.value)}
                      className="resize-none"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">
                      Don'ts <span className="text-muted-foreground">(one per line)</span>
                    </label>
                    <Textarea
                      value={donts}
                      onChange={(e) => setDonts(e.target.value)}
                      className="resize-none"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">
                      Imagery style <span className="text-muted-foreground">(comma separated)</span>
                    </label>
                    <Input
                      value={imagery}
                      onChange={(e) => setImagery(e.target.value)}
                      placeholder="e.g. warm tones, lifestyle, minimal"
                    />
                  </div>
                </TabsContent>

                <TabsContent value="colors" className="space-y-5 mt-0">
                  <ColorGroupEditor
                    label="Primary"
                    colors={draft.colors.primary}
                    onChange={(next) =>
                      patchDraft((p) => ({
                        ...p,
                        colors: { ...p.colors, primary: next },
                      }))
                    }
                  />
                  <ColorGroupEditor
                    label="Secondary"
                    colors={draft.colors.secondary}
                    onChange={(next) =>
                      patchDraft((p) => ({
                        ...p,
                        colors: { ...p.colors, secondary: next },
                      }))
                    }
                  />
                  <ColorGroupEditor
                    label="Neutral"
                    colors={draft.colors.neutral}
                    onChange={(next) =>
                      patchDraft((p) => ({
                        ...p,
                        colors: { ...p.colors, neutral: next },
                      }))
                    }
                  />
                </TabsContent>
              </div>
            </Tabs>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={closeEdit} disabled={logoUploading}>
              Cancel
            </Button>
            <Button
              onClick={handleSaveEdit}
              disabled={
                logoUploading || createVersion.isPending || updateBrandKit.isPending
              }
            >
              {createVersion.isPending || updateBrandKit.isPending ? (
                <RippleSpinner className="mr-2 h-4 w-4" />
              ) : null}
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * Decode the sample in the browser and flag likely clone-ruining problems
 * (duration outside a sensible range, nearly silent audio). Returns null when
 * the sample looks fine or when it can't be analyzed (unsupported codec or no
 * Web Audio API) — analysis failures never block the upload.
 */
export async function analyzeVoiceSample(file: File): Promise<VoiceSampleIssue[] | null> {
  const Ctor: typeof AudioContext | undefined =
    typeof window !== "undefined"
      ? (window.AudioContext ?? (window as any).webkitAudioContext)
      : undefined;
  if (!Ctor) return null;
  let ctx: AudioContext | null = null;
  try {
    ctx = new Ctor();
    const buffer = await ctx.decodeAudioData(await file.arrayBuffer());
    const issues: VoiceSampleIssue[] = [];
    if (buffer.duration < VOICE_SAMPLE_MIN_SECONDS) issues.push("too-short");
    else if (buffer.duration > VOICE_SAMPLE_MAX_SECONDS) issues.push("too-long");

    const data = buffer.getChannelData(0);
    if (data.length > 0) {
      // Sample at a stride so even long files stay cheap to scan.
      const stride = Math.max(1, Math.floor(data.length / 200_000));
      let sum = 0;
      let count = 0;
      let clippedCount = 0;
      const sampled: number[] = [];
      for (let i = 0; i < data.length; i += stride) {
        sum += data[i] * data[i];
        if (Math.abs(data[i]) >= VOICE_SAMPLE_CLIP_THRESHOLD) clippedCount++;
        count++;
        sampled.push(data[i]);
      }
      const rms = count > 0 ? Math.sqrt(sum / count) : 0;
      if (rms < VOICE_SAMPLE_MIN_RMS) issues.push("too-quiet");
      else if (count > 0 && clippedCount / count > VOICE_SAMPLE_MAX_CLIP_RATIO) {
        issues.push("clipped");
      } else {
        // Noise-floor heuristic: split the scan into short windows and compare
        // the quietest stretches (pauses = room noise) against the loudest
        // stretches (speech). A high floor means steady background noise.
        const WINDOW_COUNT = 50;
        const windowSize = Math.floor(sampled.length / WINDOW_COUNT);
        if (windowSize >= 4) {
          const windowRms: number[] = [];
          for (let w = 0; w < WINDOW_COUNT; w++) {
            let wSum = 0;
            const start = w * windowSize;
            for (let i = start; i < start + windowSize; i++) {
              wSum += sampled[i] * sampled[i];
            }
            windowRms.push(Math.sqrt(wSum / windowSize));
          }
          // Sort a copy — the original sequential order is needed for echo detection.
          const windowRmsSorted = [...windowRms].sort((a, b) => a - b);
          const tail = Math.max(1, Math.floor(WINDOW_COUNT * 0.2));
          const mean = (arr: number[]) =>
            arr.reduce((a, b) => a + b, 0) / arr.length;
          const noiseFloor = mean(windowRmsSorted.slice(0, tail));
          const speechLevel = mean(windowRmsSorted.slice(-tail));
          if (
            speechLevel >= VOICE_SAMPLE_MIN_RMS &&
            noiseFloor >= VOICE_SAMPLE_MIN_NOISE_FLOOR_RMS &&
            noiseFloor / speechLevel > VOICE_SAMPLE_MAX_NOISE_RATIO
          ) {
            issues.push("noisy");
          }
          // Echo / reverb heuristic: in a reverberant room, energy after a loud
          // speech burst decays slowly — the next window keeps a large fraction
          // of the loud window's RMS instead of dropping sharply. Look at
          // sequential transitions where energy starts to fall (next <
          // current × DROP_THRESHOLD) and count how many of those drops are
          // "slow" (next > current × FAST_DECAY). Too many slow drops → echoey.
          if (speechLevel >= VOICE_SAMPLE_MIN_RMS) {
            let slowDecays = 0;
            let qualifyingTransitions = 0;
            const loudMin = speechLevel * 0.3;
            for (let i = 0; i < windowRms.length - 1; i++) {
              const cur = windowRms[i];
              const nxt = windowRms[i + 1];
              if (cur > loudMin && nxt < cur * VOICE_SAMPLE_ECHO_DROP_THRESHOLD) {
                qualifyingTransitions++;
                if (nxt > cur * VOICE_SAMPLE_ECHO_FAST_DECAY) slowDecays++;
              }
            }
            if (
              qualifyingTransitions >= VOICE_SAMPLE_ECHO_MIN_TRANSITIONS &&
              slowDecays / qualifyingTransitions > VOICE_SAMPLE_ECHO_MIN_SLOW_FRACTION
            ) {
              issues.push("echoey");
            }
          }
        }
      }
    }
    return issues.length > 0 ? issues : null;
  } catch {
    // Undecodable in this browser — let the server-side flow handle it.
    return null;
  } finally {
    void ctx?.close().catch(() => {});
  }
}
