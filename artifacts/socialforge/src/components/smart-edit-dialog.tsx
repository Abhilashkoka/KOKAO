import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetSmartEditQueryKey,
  getGetVideoJobQueryKey,
  getListVideoJobsQueryKey,
  useApproveSmartEdit,
  useCreateSmartEdit,
  useDiscardSmartEdit,
  useGetSmartEdit,
  useQuoteSmartEdit,
  useRestoreSmartEditVersion,
  type SmartEditAttemptView,
  type SmartEditBox,
  type SmartEditType,
} from "@workspace/api-client-react";
import { apiErrorMessage } from "@/lib/apiErrorMessage";
import { refreshCreditBalanceSafely } from "@/lib/refresh-credit-balance";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Check, Loader2, RotateCcw, Scissors, SquareDashed, Trash2, Undo2 } from "lucide-react";

const storage = (path: string) => `/api/storage${path}`;

export const SMART_EDIT_TYPE_OPTIONS: Array<[SmartEditType, string, string]> = [
  ["change", "Change", "Change or replace something"],
  ["remove", "Remove", "Erase what's in the box"],
  ["outfit", "Outfit", "Change what someone wears"],
  ["dialogue", "New line", "Make the person say something else"],
  ["regenerate", "Re-shoot", "Regenerate this moment"],
];

const VOICES = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"] as const;

export function formatSeconds(value: number): string {
  const minutes = Math.floor(value / 60);
  const seconds = value - minutes * 60;
  return `${minutes}:${seconds.toFixed(1).padStart(4, "0")}`;
}

/** Keep a [start, end] range inside the video and the per-edit limits. */
export function clampRange(
  start: number,
  end: number,
  duration: number,
  limits: { minSeconds: number; maxSeconds: number },
  moved: "start" | "end",
): [number, number] {
  let s = Math.max(0, Math.min(start, duration));
  let e = Math.max(0, Math.min(end, duration));
  if (moved === "start") {
    s = Math.min(s, Math.max(0, duration - limits.minSeconds));
    if (e - s < limits.minSeconds) e = Math.min(duration, s + limits.minSeconds);
    if (e - s > limits.maxSeconds) e = s + limits.maxSeconds;
  } else {
    e = Math.max(e, Math.min(duration, limits.minSeconds));
    if (e - s < limits.minSeconds) s = Math.max(0, e - limits.minSeconds);
    if (e - s > limits.maxSeconds) s = e - limits.maxSeconds;
  }
  const r = (value: number) => Math.round(value * 10) / 10;
  return [r(s), r(e)];
}

/** Thumbnails along the timeline, drawn from the video itself. */
function useTimelineFrames(src: string, duration: number, count = 10): string[] {
  const [frames, setFrames] = useState<string[]>([]);
  useEffect(() => {
    if (!duration || typeof document === "undefined") return;
    let cancelled = false;
    const video = document.createElement("video");
    video.muted = true;
    video.preload = "auto";
    video.crossOrigin = "anonymous";
    video.src = src;
    const canvas = document.createElement("canvas");
    const out: string[] = [];
    const grab = async () => {
      for (let index = 0; index < count && !cancelled; index += 1) {
        const at = Math.min(duration - 0.05, (duration * (index + 0.5)) / count);
        await new Promise<void>((resolve) => {
          const done = () => {
            video.removeEventListener("seeked", done);
            resolve();
          };
          video.addEventListener("seeked", done);
          video.currentTime = at;
          setTimeout(done, 1500);
        });
        try {
          canvas.width = 80;
          canvas.height = Math.round(80 * ((video.videoHeight || 16) / (video.videoWidth || 9)));
          canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
          out.push(canvas.toDataURL("image/jpeg", 0.6));
        } catch {
          out.push("");
        }
      }
      if (!cancelled) setFrames(out);
    };
    video.addEventListener("loadeddata", () => void grab(), { once: true });
    return () => {
      cancelled = true;
      video.removeAttribute("src");
    };
  }, [src, duration, count]);
  return frames;
}

function RangeTimeline({
  duration,
  start,
  end,
  playhead,
  frames,
  onChange,
  onSeek,
}: {
  duration: number;
  start: number;
  end: number;
  playhead: number;
  frames: string[];
  onChange: (moved: "start" | "end", value: number) => void;
  onSeek: (value: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef<"start" | "end" | null>(null);
  const toTime = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || !rect.width) return 0;
    return Math.max(0, Math.min(duration, ((clientX - rect.left) / rect.width) * duration));
  };
  const pct = (value: number) => `${duration ? (value / duration) * 100 : 0}%`;
  const onPointerMove = (event: ReactPointerEvent) => {
    if (dragging.current) onChange(dragging.current, toTime(event.clientX));
  };
  return (
    <div className="space-y-1" data-testid="smart-edit-timeline">
      <div
        ref={trackRef}
        className="relative h-14 select-none overflow-hidden rounded-md border bg-muted"
        onPointerMove={onPointerMove}
        onPointerUp={() => (dragging.current = null)}
        onPointerLeave={() => (dragging.current = null)}
        onPointerDown={(event) => {
          if (event.target === trackRef.current || (event.target as HTMLElement).dataset.frame) onSeek(toTime(event.clientX));
        }}
      >
        <div className="absolute inset-0 flex">
          {frames.map((frame, index) =>
            frame ? (
              <img key={index} data-frame="1" src={frame} alt="" className="h-full flex-1 object-cover opacity-80" draggable={false} />
            ) : (
              <div key={index} data-frame="1" className="h-full flex-1" />
            ),
          )}
        </div>
        <div className="absolute inset-y-0 bg-background/60" style={{ left: 0, width: pct(start) }} />
        <div className="absolute inset-y-0 bg-background/60" style={{ left: pct(end), right: 0 }} />
        <div className="absolute inset-y-0 border-y-2 border-primary" style={{ left: pct(start), width: `calc(${pct(end)} - ${pct(start)})` }} />
        {(["start", "end"] as const).map((which) => (
          <button
            key={which}
            type="button"
            aria-label={which === "start" ? "Edit start" : "Edit end"}
            className="absolute inset-y-0 w-3 -translate-x-1/2 cursor-ew-resize rounded-sm bg-primary"
            style={{ left: pct(which === "start" ? start : end) }}
            onPointerDown={(event) => {
              event.stopPropagation();
              (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
              dragging.current = which;
            }}
            onPointerMove={onPointerMove}
            onPointerUp={() => (dragging.current = null)}
            onKeyDown={(event) => {
              const step = event.shiftKey ? 1 : 0.1;
              if (event.key === "ArrowLeft") onChange(which, (which === "start" ? start : end) - step);
              if (event.key === "ArrowRight") onChange(which, (which === "start" ? start : end) + step);
            }}
            data-testid={`smart-edit-handle-${which}`}
          />
        ))}
        <div className="pointer-events-none absolute inset-y-0 w-px bg-foreground" style={{ left: pct(playhead) }} />
      </div>
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{formatSeconds(start)}</span>
        <span data-testid="smart-edit-range-length">{(end - start).toFixed(1)}s selected</span>
        <span>{formatSeconds(end)}</span>
      </div>
    </div>
  );
}

/** Drag a box on the paused frame. Values are normalized 0–1. */
function BoxOverlay({ box, onChange, active }: { box: SmartEditBox | null; onChange: (box: SmartEditBox | null) => void; active: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const point = (event: ReactPointerEvent) => {
    const rect = ref.current!.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    };
  };
  return (
    <div
      ref={ref}
      className={`absolute inset-0 ${active ? "cursor-crosshair" : "pointer-events-none"}`}
      onPointerDown={(event) => {
        if (!active) return;
        (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
        origin.current = point(event);
        onChange({ ...origin.current, width: 0, height: 0 });
      }}
      onPointerMove={(event) => {
        if (!active || !origin.current) return;
        const p = point(event);
        onChange({
          x: Math.min(origin.current.x, p.x),
          y: Math.min(origin.current.y, p.y),
          width: Math.abs(p.x - origin.current.x),
          height: Math.abs(p.y - origin.current.y),
        });
      }}
      onPointerUp={() => {
        origin.current = null;
        if (box && (box.width < 0.02 || box.height < 0.02)) onChange(null);
      }}
      data-testid="smart-edit-box-overlay"
    >
      {box && box.width > 0 && (
        <div
          className="absolute rounded-sm border-2 border-dashed border-primary bg-primary/15"
          style={{ left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.width * 100}%`, height: `${box.height * 100}%` }}
          data-testid="smart-edit-box"
        />
      )}
    </div>
  );
}

function AttemptCard({
  attempt,
  currentVersionId,
  busy,
  onApprove,
  onDiscard,
  onRetry,
}: {
  attempt: SmartEditAttemptView;
  currentVersionId: string;
  busy: boolean;
  onApprove: () => void;
  onDiscard: () => void;
  onRetry: () => void;
}) {
  const label = SMART_EDIT_TYPE_OPTIONS.find(([id]) => id === attempt.type)?.[1] ?? attempt.type;
  const stale = attempt.status === "ready" && attempt.baseVersionId !== currentVersionId;
  return (
    <div className="space-y-2 rounded-lg border p-3" data-testid={`smart-edit-attempt-${attempt.id}`}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{label}</span>
        <span className="text-muted-foreground">{formatSeconds(attempt.startSec)}–{formatSeconds(attempt.endSec)}</span>
        <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-xs" data-testid={`smart-edit-status-${attempt.id}`}>
          {attempt.status === "generating" ? attempt.stage ?? "Generating…" : attempt.status === "ready" ? "Ready to review" : attempt.status}
        </span>
      </div>
      {(attempt.instruction || attempt.dialogueText) && (
        <p className="text-xs text-muted-foreground">“{attempt.dialogueText ?? attempt.instruction}”</p>
      )}
      {attempt.status === "generating" && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Regenerating only this cut. The rest of your video is untouched.</p>
      )}
      {attempt.status === "failed" && <p className="text-xs text-destructive" role="alert">{attempt.error}</p>}
      {attempt.status === "ready" && attempt.clipPath && (
        <div className="grid gap-2 sm:grid-cols-2">
          <figure className="space-y-1">
            <figcaption className="text-xs text-muted-foreground">Before</figcaption>
            <video src={storage(attempt.cutPath)} controls playsInline className="max-h-56 w-full rounded-md bg-black" data-testid={`smart-edit-before-${attempt.id}`} />
          </figure>
          <figure className="space-y-1">
            <figcaption className="text-xs text-muted-foreground">After</figcaption>
            <video src={storage(attempt.clipPath)} controls playsInline className="max-h-56 w-full rounded-md bg-black" data-testid={`smart-edit-after-${attempt.id}`} />
          </figure>
        </div>
      )}
      {stale && <p className="text-xs text-amber-700 dark:text-amber-300">The video changed after this cut was made. Try again to edit the current version.</p>}
      <div className="flex flex-wrap gap-2">
        {attempt.status === "ready" && !stale && (
          <Button type="button" size="sm" disabled={busy} onClick={onApprove} data-testid={`button-smart-edit-approve-${attempt.id}`}>
            {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Check className="mr-1.5 h-3.5 w-3.5" />}Approve &amp; stitch
          </Button>
        )}
        {(attempt.status === "ready" || attempt.status === "failed") && (
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onRetry} data-testid={`button-smart-edit-retry-${attempt.id}`}>
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" />Try again
          </Button>
        )}
        {(attempt.status === "ready" || attempt.status === "failed" || attempt.status === "generating") && (
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onDiscard} data-testid={`button-smart-edit-discard-${attempt.id}`}>
            <Trash2 className="mr-1.5 h-3.5 w-3.5" />Discard
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Smart Edit: mark a range (and optionally a box), describe the change,
 * regenerate only that cut, compare, approve, and the video is re-stitched.
 * Repeatable on any part, as many times as needed.
 */
export function SmartEditDialog({
  open,
  onOpenChange,
  job,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  job: { id: number; videoPath?: string | null; currentVideoPath?: string | null; aspectRatio?: string | null };
}) {
  const queryClient = useQueryClient();
  const state = useGetSmartEdit(job.id, {
    query: {
      enabled: open,
      refetchInterval: (query: { state: { data?: { edits?: SmartEditAttemptView[] } } }) =>
        (query.state.data?.edits ?? []).some((edit: SmartEditAttemptView) => edit.status === "generating") ? 4000 : false,
    } as never,
  });
  const create = useCreateSmartEdit();
  const quote = useQuoteSmartEdit();
  const approve = useApproveSmartEdit();
  const discard = useDiscardSmartEdit();
  const restore = useRestoreSmartEditVersion();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [duration, setDuration] = useState(0);
  const [playhead, setPlayhead] = useState(0);
  const [range, setRange] = useState<[number, number]>([0, 3]);
  const [box, setBox] = useState<SmartEditBox | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [type, setType] = useState<SmartEditType>("change");
  const [instruction, setInstruction] = useState("");
  const [dialogueText, setDialogueText] = useState("");
  const [voice, setVoice] = useState<string>("brand");
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [credits, setCredits] = useState<number | null>(null);
  const [freeSeconds, setFreeSeconds] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);

  const data = state.data;
  const limits = data?.limits ?? { minSeconds: 1, maxSeconds: 12, keepVersions: 10 };
  const src = storage(data?.currentVideoPath ?? job.currentVideoPath ?? job.videoPath ?? "");
  const frames = useTimelineFrames(src, duration);

  const refresh = useCallback(
    (next?: unknown) => {
      if (next) queryClient.setQueryData(getGetSmartEditQueryKey(job.id), next);
      void queryClient.invalidateQueries({ queryKey: getGetVideoJobQueryKey(job.id) });
      void queryClient.invalidateQueries({ queryKey: getListVideoJobsQueryKey() });
    },
    [job.id, queryClient],
  );

  // A new version means a different video: reset the marks.
  useEffect(() => {
    setBox(null);
    setPlayhead(0);
  }, [data?.currentVersionId]);

  // Live price for the marked edit.
  const quoteKey = JSON.stringify([type, range, Boolean(box), dialogueText.length > 0]);
  useEffect(() => {
    if (!open || !duration) return;
    const timer = setTimeout(() => {
      quote.mutate(
        { jobId: job.id, data: { type, startSec: range[0], endSec: range[1], box, instruction: instruction || "x x x", dialogueText: type === "dialogue" ? dialogueText || "xx" : null } },
        {
          onSuccess: (result) => {
            setCredits(result.credits);
            setFreeSeconds((result.freeCredits ?? 0) > 0 ? result.freeSeconds ?? 0 : 0);
          },
          onError: () => {
            setCredits(null);
            setFreeSeconds(0);
          },
        },
      );
    }, 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quoteKey, open, duration]);

  const moveRange = (moved: "start" | "end", value: number) => {
    const next = clampRange(moved === "start" ? value : range[0], moved === "end" ? value : range[1], duration, limits, moved);
    setRange(next);
    if (videoRef.current) videoRef.current.currentTime = moved === "start" ? next[0] : next[1];
  };

  const submit = (preset?: SmartEditAttemptView) => {
    setError(null);
    const request = preset
      ? { type: preset.type, startSec: preset.startSec, endSec: preset.endSec, box: preset.box ?? null, instruction: preset.instruction, dialogueText: preset.dialogueText }
      : { type, startSec: range[0], endSec: range[1], box, instruction, dialogueText: type === "dialogue" ? dialogueText : null };
    create.mutate(
      {
        jobId: job.id,
        data: {
          ...request,
          baseVersionId: data?.currentVersionId ?? null,
          ...(request.type === "dialogue" ? { consent, ...(voice !== "brand" ? { voice: voice as (typeof VOICES)[number] } : {}) } : {}),
        },
      },
      {
        onSuccess: (next) => {
          refresh(next);
          if (!preset) {
            setInstruction("");
            setDialogueText("");
          }
        },
        onError: (cause) => setError(apiErrorMessage(cause, "Could not start this edit.")),
        onSettled: () => refreshCreditBalanceSafely(queryClient),
      },
    );
  };

  const act = (attempt: SmartEditAttemptView, action: "approve" | "discard") => {
    setBusyId(attempt.id);
    setError(null);
    const mutation = action === "approve" ? approve : discard;
    mutation.mutate(
      { jobId: job.id, editId: attempt.id },
      {
        onSuccess: (next) => refresh(next),
        onError: (cause) => setError(apiErrorMessage(cause, action === "approve" ? "Could not apply this edit." : "Could not discard this edit.")),
        onSettled: () => setBusyId(null),
      },
    );
  };

  const needsBox = type === "remove";
  const ready =
    duration > 0 &&
    !create.isPending &&
    (!needsBox || Boolean(box)) &&
    (type === "dialogue" ? dialogueText.trim().length >= 2 && consent : type === "remove" || type === "regenerate" || instruction.trim().length >= 3);
  const openAttempts = useMemo(
    () => (data?.edits ?? []).filter((edit) => edit.status !== "discarded" && edit.status !== "approved"),
    [data?.edits],
  );
  const vertical = (job.aspectRatio ?? "9:16") === "9:16" || job.aspectRatio === "4:5" || job.aspectRatio === "3:4";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-5xl overflow-y-auto" data-testid="dialog-smart-edit">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Scissors className="h-4 w-4" /> Smart Edit</DialogTitle>
          <DialogDescription>
            Mark a part of the video, describe the change, and only that cut is regenerated. Nothing changes until you approve.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="space-y-3">
            <div className={`relative mx-auto overflow-hidden rounded-lg bg-black ${vertical ? "max-w-[300px]" : ""}`}>
              <video
                ref={videoRef}
                src={src}
                controls={!drawing}
                playsInline
                crossOrigin="anonymous"
                className="block w-full"
                onLoadedMetadata={(event) => {
                  const total = event.currentTarget.duration || 0;
                  setDuration(total);
                  setRange(clampRange(0, Math.min(3, total), total, limits, "end"));
                }}
                onTimeUpdate={(event) => setPlayhead(event.currentTarget.currentTime)}
                data-testid="smart-edit-video"
              />
              <BoxOverlay box={box} onChange={setBox} active={drawing} />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" size="sm" variant={drawing ? "default" : "outline"} onClick={() => { videoRef.current?.pause(); setDrawing((value) => !value); }} data-testid="button-smart-edit-draw">
                <SquareDashed className="mr-1.5 h-3.5 w-3.5" />{drawing ? "Done marking" : box ? "Redraw area" : "Mark area"}
              </Button>
              {box && <Button type="button" size="sm" variant="ghost" onClick={() => setBox(null)}>Clear area</Button>}
              <Button type="button" size="sm" variant="ghost" onClick={() => moveRange("start", playhead)} data-testid="button-smart-edit-set-start">Start here</Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => moveRange("end", playhead)} data-testid="button-smart-edit-set-end">End here</Button>
            </div>
            {duration > 0 && (
              <RangeTimeline
                duration={duration}
                start={range[0]}
                end={range[1]}
                playhead={playhead}
                frames={frames}
                onChange={moveRange}
                onSeek={(value) => {
                  if (videoRef.current) videoRef.current.currentTime = value;
                }}
              />
            )}
            <p className="text-xs text-muted-foreground">
              Up to {limits.maxSeconds}s per edit. {box ? "Only the marked area changes." : "Without a marked area the whole frame can change."}
            </p>
          </div>

          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-1.5">
              {SMART_EDIT_TYPE_OPTIONS.map(([id, title, hint]) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={type === id}
                  onClick={() => setType(id)}
                  className={`rounded-lg border p-2 text-left text-xs transition-colors ${type === id ? "border-primary bg-primary/5" : "hover:bg-muted/60"}`}
                  data-testid={`button-smart-edit-type-${id}`}
                >
                  <span className="block text-sm font-medium">{title}</span>
                  <span className="text-muted-foreground">{hint}</span>
                </button>
              ))}
            </div>
            {type === "dialogue" ? (
              <div className="space-y-2">
                <Label htmlFor="smart-edit-line">New line</Label>
                <Textarea id="smart-edit-line" rows={3} maxLength={600} value={dialogueText} onChange={(event) => setDialogueText(event.target.value)} placeholder="What should they say instead?" data-testid="input-smart-edit-line" />
                <Select value={voice} onValueChange={setVoice}>
                  <SelectTrigger data-testid="select-smart-edit-voice"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="brand">Brand Kit voice</SelectItem>
                    {VOICES.map((item) => <SelectItem key={item} value={item}>{item[0]!.toUpperCase() + item.slice(1)}</SelectItem>)}
                  </SelectContent>
                </Select>
                <label className="flex items-start gap-2 text-xs">
                  <Checkbox checked={consent} onCheckedChange={(checked) => setConsent(checked === true)} data-testid="checkbox-smart-edit-consent" />
                  <span>I have permission to make the person in this video say the new line.</span>
                </label>
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor="smart-edit-instruction">{type === "remove" ? "Anything to add? (optional)" : type === "regenerate" ? "Direction (optional)" : "Describe the change"}</Label>
                <Textarea
                  id="smart-edit-instruction"
                  rows={3}
                  maxLength={600}
                  value={instruction}
                  onChange={(event) => setInstruction(event.target.value)}
                  placeholder={type === "outfit" ? "e.g. a white lab coat over a blue shirt" : type === "regenerate" ? "e.g. slower push-in, warmer light" : "e.g. make the bottle label say 'Night Glow'"}
                  data-testid="input-smart-edit-instruction"
                />
              </div>
            )}
            {needsBox && !box && <p className="text-xs text-amber-700 dark:text-amber-300">Mark the area to remove on the video.</p>}
            {error && <p className="text-sm text-destructive" role="alert" data-testid="error-smart-edit">{error}</p>}
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground" data-testid="smart-edit-credits">
                {credits === null
                  ? ""
                  : freeSeconds > 0 && credits === 0
                    ? `Free — first ${freeSeconds}s of this video's first edit are on us`
                    : freeSeconds > 0
                      ? `First ${freeSeconds}s free · you pay ≈ ${credits.toLocaleString("en-IN", { maximumFractionDigits: 1 })} credits`
                      : `≈ ${credits.toLocaleString("en-IN", { maximumFractionDigits: 1 })} credits`}
              </span>
              <Button type="button" disabled={!ready} onClick={() => submit()} data-testid="button-smart-edit-generate">
                {create.isPending ? <><Loader2 className="mr-1.5 h-4 w-4 animate-spin" />Cutting…</> : "Generate edit"}
              </Button>
            </div>

            {openAttempts.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-sm font-semibold">Edits to review</h4>
                {openAttempts.map((attempt) => (
                  <AttemptCard
                    key={attempt.id}
                    attempt={attempt}
                    currentVersionId={data?.currentVersionId ?? "v0"}
                    busy={busyId === attempt.id}
                    onApprove={() => act(attempt, "approve")}
                    onDiscard={() => act(attempt, "discard")}
                    onRetry={() => submit(attempt)}
                  />
                ))}
              </div>
            )}

            {(data?.versions.length ?? 0) > 1 && (
              <div className="space-y-1.5" data-testid="smart-edit-versions">
                <h4 className="text-sm font-semibold">Versions</h4>
                <ul className="space-y-1">
                  {data!.versions.slice().reverse().map((version) => (
                    <li key={version.id} className="flex items-center gap-2 text-xs">
                      <span className={version.id === data!.currentVersionId ? "font-medium" : "text-muted-foreground"}>
                        {version.label}
                      </span>
                      {version.id === data!.currentVersionId ? (
                        <span className="rounded-full bg-primary/10 px-2 py-0.5">Current</span>
                      ) : (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 text-xs"
                          disabled={restore.isPending}
                          onClick={() =>
                            restore.mutate(
                              { jobId: job.id, versionId: version.id },
                              { onSuccess: (next) => refresh(next), onError: (cause) => setError(apiErrorMessage(cause, "Could not restore this version.")) },
                            )
                          }
                          data-testid={`button-smart-edit-restore-${version.id}`}
                        >
                          <Undo2 className="mr-1 h-3 w-3" />Restore
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
