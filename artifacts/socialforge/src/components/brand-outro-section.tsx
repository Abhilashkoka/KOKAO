import { useEffect, useRef, useState } from "react";
import { useRequestUploadUrl } from "@workspace/api-client-react";
import { apiErrorMessage } from "@/lib/apiErrorMessage";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { AlertCircle, Film, RotateCcw, Upload, X, Sparkles } from "lucide-react";

export type OutroPreset = "fade" | "zoom" | "slide";
export type VideoOutro = {
  enabled: boolean;
  mode: "preset" | "upload";
  preset: OutroPreset;
  duration_seconds: number;
  background_color: string;
  clip_path: string | null;
};

export const OUTRO_MIN_SECONDS = 2;
export const OUTRO_MAX_SECONDS = 5;
export const OUTRO_MAX_BYTES = 40 * 1024 * 1024;
export const OUTRO_CLIP_MIN_SECONDS = 1;
export const OUTRO_CLIP_MAX_SECONDS = 10;
export const OUTRO_CLIP_TYPES = ["video/mp4", "video/webm"];
const LOGO_EXT = /\.(png|jpe?g|webp)(\?|#|$)/i;

/** Reads a local video's duration in seconds (null if the browser can't decode it). */
export function probeVideoDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.preload = "metadata";
    const done = (d: number | null) => {
      URL.revokeObjectURL(url);
      resolve(d);
    };
    v.onloadedmetadata = () => done(Number.isFinite(v.duration) ? v.duration : null);
    v.onerror = () => done(null);
    v.src = url;
  });
}
const HEX = /^#[0-9a-fA-F]{6}$/;

export function defaultVideoOutro(): VideoOutro {
  return {
    enabled: false,
    mode: "preset",
    preset: "fade",
    duration_seconds: 3,
    background_color: "#111111",
    clip_path: null,
  };
}

/** Normalises a possibly-missing / legacy saved value into a full outro. */
export function normalizeVideoOutro(raw: Partial<VideoOutro> | null | undefined): VideoOutro {
  const d = defaultVideoOutro();
  if (!raw) return d;
  const dur = Number(raw.duration_seconds);
  return {
    enabled: !!raw.enabled,
    mode: raw.mode === "upload" ? "upload" : "preset",
    preset: raw.preset === "zoom" || raw.preset === "slide" ? raw.preset : "fade",
    duration_seconds: Number.isFinite(dur)
      ? Math.min(OUTRO_MAX_SECONDS, Math.max(OUTRO_MIN_SECONDS, Math.round(dur)))
      : d.duration_seconds,
    background_color:
      typeof raw.background_color === "string" && HEX.test(raw.background_color)
        ? raw.background_color
        : d.background_color,
    clip_path: raw.clip_path ?? null,
  };
}

/** Returns a blocking error message, or null when the outro can be saved. */
export function videoOutroError(outro: VideoOutro, logoUrl: string | null): string | null {
  if (!outro.enabled) return null;
  if (!HEX.test(outro.background_color)) return "Background color must be a hex value like #1A2B3C.";
  if (outro.mode === "preset" && !logoUrl)
    return "This brand has no primary logo. Upload a PNG, JPEG or WebP logo (up to 5 MB) to use a preset outro.";
  if (outro.mode === "preset" && logoUrl && !logoUrl.startsWith("/api/storage") && !LOGO_EXT.test(logoUrl))
    return "Preset outros need a PNG, JPEG or WebP primary logo. Upload one in that format, or use your own clip.";
  if (outro.mode === "upload" && !outro.clip_path)
    return "Upload an outro clip, or switch to a preset animation.";
  return null;
}

const PRESETS: { value: OutroPreset; label: string; hint: string }[] = [
  { value: "fade", label: "Fade", hint: "Soft dissolve in" },
  { value: "zoom", label: "Zoom", hint: "Scales up to rest" },
  { value: "slide", label: "Slide", hint: "Glides in from below" },
];

const KEYFRAMES = `
@keyframes outro-fade { 0% { opacity: 0 } 45%,100% { opacity: 1 } }
@keyframes outro-zoom { 0% { opacity: 0; transform: scale(.55) } 50%,100% { opacity: 1; transform: scale(1) } }
@keyframes outro-slide { 0% { opacity: 0; transform: translateY(60%) } 50%,100% { opacity: 1; transform: translateY(0) } }
`;

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(
    () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!mq) return;
    const on = () => setReduced(mq.matches);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return reduced;
}

export function BrandOutroSection({
  value,
  logoUrl,
  onChange,
  onUploadLogo,
  logoUploading,
  probeDuration = probeVideoDuration,
}: {
  value: VideoOutro;
  logoUrl: string | null;
  onChange: (next: VideoOutro) => void;
  onUploadLogo: () => void;
  logoUploading?: boolean;
  probeDuration?: (file: File) => Promise<number | null>;
}) {
  const requestUploadUrl = useRequestUploadUrl();
  const fileRef = useRef<HTMLInputElement>(null);
  const [replayKey, setReplayKey] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [hexText, setHexText] = useState(value.background_color);
  const reduced = usePrefersReducedMotion();
  const disposed = useRef(false);
  useEffect(() => () => void (disposed.current = true), []);
  useEffect(() => setHexText(value.background_color), [value.background_color]);

  const set = (patch: Partial<VideoOutro>) => onChange({ ...value, ...patch });
  const error = videoOutroError(value, logoUrl);

  const handleFile = async (file: File) => {
    setUploadError(null);
    if (!OUTRO_CLIP_TYPES.includes(file.type)) {
      setUploadError("Outro clips must be MP4 or WebM video.");
      return;
    }
    if (file.size >= OUTRO_MAX_BYTES) {
      setUploadError("Outro clips must be under 40 MB.");
      return;
    }
    setUploading(true);
    try {
      const dur = await probeDuration(file);
      if (disposed.current) return;
      if (dur == null) {
        setUploadError("We couldn't read this clip's length. Try re-exporting it as MP4 or WebM.");
        return;
      }
      if (dur < OUTRO_CLIP_MIN_SECONDS || dur > OUTRO_CLIP_MAX_SECONDS) {
        setUploadError(`Outro clips must be 1 to 10 seconds long. This one is ${dur.toFixed(1)}s.`);
        return;
      }
      const { uploadURL, objectPath } = await requestUploadUrl.mutateAsync({
        data: { name: file.name, size: file.size, contentType: file.type },
      });
      const put = await fetch(uploadURL, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": file.type },
      });
      if (!put.ok) throw new Error(`Upload failed (${put.status})`);
      if (!disposed.current) onChange({ ...value, mode: "upload", clip_path: objectPath });
    } catch (err) {
      if (!disposed.current) setUploadError(apiErrorMessage(err, "Could not upload the outro clip."));
    } finally {
      if (!disposed.current) setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const secs = value.duration_seconds;

  return (
    <section
      className="rounded-xl border bg-muted/30 overflow-hidden"
      data-testid="section-video-outro"
    >
      <style>{KEYFRAMES}</style>
      <header className="flex items-start justify-between gap-4 p-4 border-b bg-background/60">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Film className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold tracking-tight">Logo outro</h3>
            <span
              className={`text-[10px] uppercase tracking-[0.14em] px-1.5 py-0.5 rounded ${value.enabled ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"}`}
              data-testid="status-outro"
            >
              {value.enabled ? "On" : "Off"}
            </span>
          </div>
          <p className="text-xs text-muted-foreground max-w-md">
            When on, every <strong>new</strong> video made with this kit ends with{" "}
            {value.mode === "upload"
              ? "your full uploaded clip, added after your content (video length grows by the clip's length)."
              : `a ${secs}-second logo animation, added after your content (video length grows by ${secs}s).`}{" "}
            Existing videos are not changed.
          </p>
        </div>
        <Switch
          checked={value.enabled}
          onCheckedChange={(enabled) => set({ enabled })}
          aria-label="Enable logo outro"
          data-testid="switch-outro-enabled"
        />
      </header>

      {value.enabled && (
        <div className="grid md:grid-cols-[1fr_220px] gap-5 p-4">
          <div className="space-y-4">
            <div className="inline-flex rounded-lg border p-0.5 bg-background" role="radiogroup" aria-label="Outro source">
              {(["preset", "upload"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={value.mode === m}
                  onClick={() => set({ mode: m })}
                  className={`px-3 py-1.5 text-xs rounded-md transition-colors ${value.mode === m ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
                  data-testid={`button-outro-mode-${m}`}
                >
                  {m === "preset" ? "Animate my logo" : "Upload my own clip"}
                </button>
              ))}
            </div>

            {value.mode === "preset" ? (
              <>
                <div className="grid grid-cols-3 gap-2">
                  {PRESETS.map((p) => (
                    <button
                      key={p.value}
                      type="button"
                      onClick={() => {
                        set({ preset: p.value });
                        setReplayKey((k) => k + 1);
                      }}
                      className={`text-left rounded-lg border p-2.5 transition-colors ${value.preset === p.value ? "border-primary bg-primary/5" : "hover:border-foreground/30"}`}
                      aria-pressed={value.preset === p.value}
                      data-testid={`button-outro-preset-${p.value}`}
                    >
                      <div className="text-sm font-medium">{p.label}</div>
                      <div className="text-[11px] text-muted-foreground">{p.hint}</div>
                    </button>
                  ))}
                </div>
                <div className="flex flex-wrap items-end gap-4">
                  <div className="space-y-1.5">
                    <label htmlFor="outro-bg" className="text-xs font-medium">Background</label>
                    <div className="flex items-center gap-2">
                      <input
                        id="outro-bg"
                        type="color"
                        value={HEX.test(value.background_color) ? value.background_color : "#111111"}
                        onChange={(e) => set({ background_color: e.target.value })}
                        className="h-9 w-9 rounded border cursor-pointer bg-transparent"
                        data-testid="input-outro-bg-picker"
                      />
                      <Input
                        value={hexText}
                        onChange={(e) => {
                          setHexText(e.target.value);
                          if (HEX.test(e.target.value)) set({ background_color: e.target.value });
                        }}
                        onBlur={() => setHexText(value.background_color)}
                        className="w-28 font-mono text-xs"
                        aria-label="Background hex color"
                        data-testid="input-outro-bg-hex"
                      />
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <div className="space-y-2">
                <input
                  ref={fileRef}
                  type="file"
                  accept="video/mp4,video/webm"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void handleFile(f);
                  }}
                  data-testid="input-outro-file"
                />
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => fileRef.current?.click()}
                    disabled={uploading}
                    data-testid="button-outro-upload"
                  >
                    <Upload className="h-3.5 w-3.5 mr-1.5" />
                    {uploading ? "Uploading…" : value.clip_path ? "Change clip" : "Upload clip"}
                  </Button>
                  {value.clip_path && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => set({ clip_path: null })}
                      disabled={uploading}
                      data-testid="button-outro-remove"
                    >
                      <X className="h-3.5 w-3.5 mr-1.5" /> Remove
                    </Button>
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  MP4 or WebM, under 40 MB, 1 to 10 seconds long. The whole clip plays at the end of each new video.
                </p>
                {uploadError && (
                  <p className="text-xs text-destructive" role="alert" data-testid="text-outro-upload-error">
                    {uploadError}
                  </p>
                )}
              </div>
            )}

            {value.mode === "preset" && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <label htmlFor="outro-duration" className="font-medium">Duration</label>
                <span className="font-mono tabular-nums" data-testid="text-outro-duration">{secs}s</span>
              </div>
              <input
                id="outro-duration"
                type="range"
                min={OUTRO_MIN_SECONDS}
                max={OUTRO_MAX_SECONDS}
                step={1}
                value={secs}
                onChange={(e) => set({ duration_seconds: Number(e.target.value) })}
                className="w-full accent-[hsl(var(--primary))]"
                data-testid="input-outro-duration"
              />
            </div>
            )}

            {error && (
              <div
                className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-2.5 text-xs text-destructive"
                role="alert"
                data-testid="text-outro-error"
              >
                <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <div className="space-y-1.5">
                  <p>{error}</p>
                  {value.mode === "preset" && !logoUrl && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={onUploadLogo}
                      disabled={logoUploading}
                      data-testid="button-outro-upload-logo"
                    >
                      <Upload className="h-3.5 w-3.5 mr-1.5" />
                      {logoUploading ? "Uploading…" : "Upload logo"}
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="space-y-2">
            <div
              className="relative aspect-[9/16] rounded-lg overflow-hidden border grid place-items-center"
              style={{ backgroundColor: value.mode === "preset" ? value.background_color : "#0d0d0d" }}
              data-testid="preview-outro"
            >
              {value.mode === "upload" ? (
                value.clip_path ? (
                  <video
                    key={value.clip_path}
                    src={`/api/storage${value.clip_path}`}
                    className="absolute inset-0 h-full w-full object-contain"
                    controls
                    muted
                    playsInline
                    data-testid="video-outro-preview"
                  />
                ) : (
                  <span className="text-[11px] text-white/50">No clip yet</span>
                )
              ) : logoUrl ? (
                <img
                  key={`${value.preset}-${replayKey}`}
                  src={logoUrl}
                  alt="Logo outro preview"
                  className="w-3/5 max-h-[40%] object-contain"
                  style={
                    reduced
                      ? undefined
                      : { animation: `outro-${value.preset} ${secs}s cubic-bezier(.2,.7,.2,1) both` }
                  }
                  data-testid="img-outro-preview"
                  data-animated={reduced ? "false" : "true"}
                />
              ) : (
                <span className="text-[11px] text-white/60 px-4 text-center">
                  <Sparkles className="h-4 w-4 mx-auto mb-1" />
                  Add a primary logo to preview
                </span>
              )}
            </div>
            {value.mode === "preset" && logoUrl && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="w-full"
                onClick={() => setReplayKey((k) => k + 1)}
                data-testid="button-outro-replay"
              >
                <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
                {reduced ? "Reduced motion: static preview" : "Replay"}
              </Button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
