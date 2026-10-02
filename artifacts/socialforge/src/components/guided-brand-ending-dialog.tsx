import type { ReactNode } from "react";
import type { GuidedBrandEndingOffer } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AlertTriangle, Film, Loader2, RotateCcw } from "lucide-react";

export type GuidedBrandEndingSelection = "replace" | "keep" | "append";

export function formatEndingSeconds(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}s`;
}

export function brandEndingCanReplace(offer: GuidedBrandEndingOffer | null): boolean {
  return !!offer?.available && !!offer.replaceSceneId;
}

type Option = {
  value: GuidedBrandEndingSelection;
  title: string;
  badge?: string;
  duration: number | null | undefined;
  body: ReactNode;
};

export function GuidedBrandEndingDialog({
  open,
  offer,
  choice,
  onChoiceChange,
  error,
  stale,
  loading,
  pending,
  onConfirm,
  onCancel,
  onRefresh,
}: {
  open: boolean;
  offer: GuidedBrandEndingOffer | null;
  choice: GuidedBrandEndingSelection | null;
  onChoiceChange: (choice: GuidedBrandEndingSelection) => void;
  error: string | null;
  /** The offer token was rejected or the draft changed; a fresh offer is required. */
  stale: boolean;
  loading: boolean;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onRefresh: () => void;
}) {
  const canReplace = brandEndingCanReplace(offer);
  const audioNote = offer?.hasAudio
    ? "the saved clip’s original audio"
    : "silence (this clip has no audio)";
  const options: Option[] = [
    ...(canReplace
      ? [{
          value: "replace" as const,
          title: "Replace the final scene with my animation",
          badge: "Recommended",
          duration: offer?.replacementDurationSeconds,
          body: (
            <>
              <p>
                Swaps out the last scene
                {offer?.replaceSceneDescription ? <> (“{offer.replaceSceneDescription}”{offer.sceneDurationSeconds != null ? `, ${formatEndingSeconds(offer.sceneDurationSeconds)}` : ""})</> : null}{" "}
                for your full uploaded clip.
              </p>
              <p className="font-bold text-foreground" data-testid="text-brand-ending-replace-audio">
                This replaces the ENTIRE last scene, including its scripted narration and dialogue. Those lines will not be heard. The ending plays {audioNote} instead.
              </p>
              <p>Credits: AI generation of that scene is skipped. Existing script and cast costs are unchanged.</p>
            </>
          ),
        }]
      : []),
    {
      value: "keep",
      title: "Keep my scripted story, no outro",
      duration: offer?.storyDurationSeconds,
      body: (
        <>
          <p>Every scene, line and narration plays as scripted. The Brand Kit animation is not added to this video.</p>
          <p>Credits: all scenes are generated as usual.</p>
        </>
      ),
    },
    {
      value: "append",
      title: "Keep the story and add my animation after it",
      duration: offer?.appendedDurationSeconds,
      body: (
        <>
          <p>The full story and narration play, then your whole clip follows with {audioNote}.</p>
          <p>Credits: all scenes are generated as usual. The uploaded clip itself has no AI generation charge.</p>
        </>
      ),
    },
  ];

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !pending) onCancel(); }}>
      <DialogContent className="max-h-[92dvh] max-w-3xl overflow-y-auto" data-testid="dialog-guided-brand-ending">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Film className="h-4 w-4 text-primary" />How should this story end?</DialogTitle>
          <DialogDescription>
            Your Brand Kit has an uploaded ending animation. Pick how it’s used before generation starts. Nothing is queued or charged until you confirm.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 md:grid-cols-[200px_1fr]">
          <div className="space-y-2">
            <div className="relative aspect-[9/16] overflow-hidden rounded-lg border bg-[#0d0d0d]">
              {offer?.clipPath ? (
                <video
                  key={offer.clipPath}
                  src={`/api/storage${offer.clipPath}`}
                  className="absolute inset-0 h-full w-full object-contain"
                  controls
                  playsInline
                  preload="metadata"
                  data-testid="video-brand-ending-preview"
                />
              ) : (
                <span className="absolute inset-0 grid place-items-center text-[11px] text-white/60">{loading ? "Loading…" : "No preview"}</span>
              )}
            </div>
            <p className="text-[11px] leading-snug text-muted-foreground" data-testid="text-brand-ending-clip-info">
              Clip: {formatEndingSeconds(offer?.clipDurationSeconds)} · {offer?.hasAudio ? "has audio" : "no audio"}. The whole clip plays at original speed, fitted to frame with no cropping.
            </p>
          </div>
          <div role="radiogroup" aria-label="Story ending" className="space-y-2">
            {options.map((option) => {
              const selected = choice === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={pending || loading || stale}
                  onClick={() => onChoiceChange(option.value)}
                  className={`w-full rounded-lg border p-3 text-left transition-colors disabled:opacity-60 ${selected ? "border-primary bg-primary/5 ring-1 ring-primary" : "hover:border-foreground/30"}`}
                  data-testid={`radio-brand-ending-${option.value}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <span className={`mt-0.5 h-3.5 w-3.5 shrink-0 rounded-full border-2 ${selected ? "border-primary bg-primary" : "border-muted-foreground/50"}`} aria-hidden />
                      <span className="text-sm font-semibold">{option.title}</span>
                      {option.badge && <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] uppercase tracking-[0.12em] text-primary">{option.badge}</span>}
                    </div>
                    <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground" data-testid={`text-brand-ending-duration-${option.value}`}>
                      ≈ {formatEndingSeconds(option.duration)}
                    </span>
                  </div>
                  <div className="mt-1.5 space-y-1 pl-5 text-xs text-muted-foreground">{option.body}</div>
                </button>
              );
            })}
          </div>
        </div>
        {error && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" role="alert" data-testid="error-brand-ending">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="space-y-2">
              <p>{error}</p>
              {stale && (
                <Button type="button" size="sm" variant="outline" onClick={onRefresh} disabled={loading} data-testid="button-brand-ending-refresh">
                  {loading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="mr-1.5 h-3.5 w-3.5" />}Get a fresh offer
                </Button>
              )}
            </div>
          </div>
        )}
        <DialogFooter className="gap-2">
          <Button type="button" variant="ghost" onClick={onCancel} disabled={pending} data-testid="button-brand-ending-cancel">
            Cancel (nothing charged)
          </Button>
          <Button type="button" onClick={onConfirm} disabled={!choice || pending || loading || stale || !offer?.token} data-testid="button-brand-ending-confirm">
            {pending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}Confirm and generate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
