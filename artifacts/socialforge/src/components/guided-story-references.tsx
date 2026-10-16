import { useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetGuidedStoryDraftQueryKey,
  getListGuidedStoryVoicesQueryKey,
  useCloneBrandVoice,
  useInspectGuidedStoryReference,
  useRequestUploadUrl,
  useTranscribeGuidedStoryReference,
  useUpdateGuidedStoryDraft,
  type GuidedStoryAudioPlacement,
  type GuidedStoryDraft,
  type GuidedStoryReferenceUse,
  type GuidedStoryRequirementCheck,
  type GuidedStoryUploadInput,
} from "@workspace/api-client-react";
import { apiErrorMessage } from "@/lib/apiErrorMessage";
import { refreshCreditBalanceSafely } from "@/lib/refresh-credit-balance";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AtSign, Check, FileText, Loader2, Music, Sparkles, Trash2, Upload, Video, X } from "lucide-react";

/** Story genres. Any product or service fits any genre: it sets the tone only. */
export const GUIDED_STORY_GENRE_OPTIONS = [
  ["slice_of_life", "Slice of Life", "An ordinary, recognisable day told with warmth."],
  ["problem_solution", "Problem → Solution", "A relatable pain, the discovery, visible relief."],
  ["customer_story", "Customer Story", "A fictional customer's before-and-after."],
  ["heartwarming", "Heartwarming / Family", "Emotional, festive or family moments."],
  ["inspirational", "Inspirational", "A sincere journey to a meaningful goal."],
  ["explainer", "Explainer", "Teach one useful idea in simple steps."],
  ["comedy", "Comedy", "A character-led setup with a satisfying turn."],
  ["drama", "Drama", "Human choices, emotional stakes, and consequence."],
  ["romance", "Romance", "Connection, vulnerability, and a hopeful beat."],
  ["action_adventure", "Action / Adventure", "High stakes, motion, and a daring goal."],
  ["thriller_mystery", "Thriller / Mystery", "Clues, tension, and a reveal."],
  ["fantasy", "Fantasy", "An original world with wonder and rules."],
  ["science_fiction", "Science Fiction", "A future-facing idea grounded in people."],
  ["mythological_period", "Mythological / Period", "A respectful retelling for festive campaigns."],
  ["satire_parody", "Satire / Parody", "Playful, shareable exaggeration."],
  ["custom", "Custom tone", "Describe the tone in your own words."],
] as const;

export type GuidedStoryCategory = "general" | "medical" | "chartered_accountant";

export const GUIDED_REFERENCE_USE_LABELS: Record<GuidedStoryReferenceUse, string> = {
  character: "Character",
  outfit: "Outfit",
  product: "Product",
  backdrop: "Backdrop / location",
  prop: "Prop",
  style: "Style / look",
  logo: "Logo",
  opening_shot: "Opening shot",
  closing_shot: "Closing shot",
  other_image: "Other",
  motion: "Motion / camera reference",
  footage: "Footage insert",
  voice: "Voice for a character",
  music: "Background music",
  voiceover: "Voiceover",
  sfx: "Sound effect",
  brief: "Brief",
};

const USES_BY_MEDIA: Record<UploadMedia, GuidedStoryReferenceUse[]> = {
  image: ["character", "outfit", "product", "backdrop", "prop", "style", "logo", "opening_shot", "closing_shot", "other_image"],
  video: ["motion", "footage"],
  audio: ["voice", "music", "voiceover", "sfx"],
  document: ["brief"],
};

const RIGHTS_USES: GuidedStoryReferenceUse[] = ["voice", "voiceover", "music", "footage"];

const GUIDED_UPLOAD_TYPES_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".aac": "audio/aac",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
};

/** File pickers can omit MIME types or use generic/legacy aliases. The
 * server still validates the uploaded bytes before accepting a reference. */
export function guidedUploadContentType(file: Pick<File, "name" | "type">): string {
  const type = file.type.trim().toLowerCase().split(";")[0]!;
  const extension = file.name.toLowerCase().match(/\.[^.]+$/)?.[0] ?? "";
  const inferred = GUIDED_UPLOAD_TYPES_BY_EXTENSION[extension];
  if (!type || type === "application/octet-stream" || type === "binary/octet-stream") {
    return inferred ?? "application/octet-stream";
  }
  if (type === "image/jpg" || type === "image/pjpeg") return "image/jpeg";
  if (type === "audio/mp3" || type === "audio/x-mp3") return "audio/mpeg";
  if (type === "audio/x-m4a") return "audio/mp4";
  if (type === "audio/x-wav") return "audio/wav";
  return type;
}

export const GUIDED_UPLOAD_ACCEPT = [
  "image/png", "image/jpeg", "image/webp",
  "video/mp4", "video/quicktime", "video/webm",
  "audio/mpeg", "audio/mp4", "audio/x-m4a", "audio/wav", "audio/x-wav", "audio/ogg", "audio/webm", "audio/aac",
  "application/pdf", "text/plain", "text/markdown",
  ...Object.keys(GUIDED_UPLOAD_TYPES_BY_EXTENSION),
].join(",");

type UploadMedia = "image" | "video" | "audio" | "document";

/** Only locally authored upload messages may bypass the API error sanitizer. */
class GuidedUploadError extends Error {}

/** One upload as the setup form holds it. */
export interface GuidedUploadDraft extends GuidedStoryUploadInput {
  key: string;
  media: UploadMedia | null;
  durationSeconds: number | null;
  suggestedUse: GuidedStoryReferenceUse | null;
  status: "uploading" | "inspecting" | "ready" | "failed";
  error: string | null;
  aiError: string | null;
  /** The server id (`r1`…) once saved; null for new uploads. */
  savedId: string | null;
}

export const MAX_GUIDED_UPLOADS = 50;
export const MAX_GUIDED_SCENE_UPLOADS = 50;

export function normalizeHandle(raw: string): string {
  return raw
    .trim()
    .replace(/^@+/, "")
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
}

export function mentionedHandles(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/(^|[^\w@.])@([a-z0-9][a-z0-9_]{1,31})\b/gi)) {
    const handle = match[2]!.toLowerCase();
    if (!found.includes(handle)) found.push(handle);
  }
  return found;
}

function uniqueHandle(base: string, taken: string[]): string {
  const root = normalizeHandle(base).slice(0, 28) || "upload";
  const seed = root.length >= 2 ? root : `${root}_file`;
  if (!taken.includes(seed)) return seed;
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${seed}_${index}`;
    if (!taken.includes(candidate)) return candidate;
  }
  return `${seed}_${Date.now() % 1000}`;
}

function mediaForFile(file: File): UploadMedia | null {
  const type = guidedUploadContentType(file);
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  if (type === "application/pdf" || type.startsWith("text/")) return "document";
  return null;
}

/** Server library → editable form rows. */
export function uploadDraftsFromDraft(draft: GuidedStoryDraft | undefined | null): GuidedUploadDraft[] {
  return (draft?.setup?.references?.items ?? []).map((item) => ({
    key: item.id,
    savedId: item.id,
    path: item.path,
    handle: item.handle,
    label: item.label,
    use: item.use,
    notes: item.notes,
    aiDescription: item.aiDescription,
    transcript: item.transcript,
    voiceFor: item.voiceFor,
    rightsConfirmed: item.rightsConfirmed,
    media: item.media,
    durationSeconds: item.durationSeconds,
    suggestedUse: null,
    status: "ready",
    error: null,
    aiError: null,
  }));
}

/** Form rows → setup.uploads. Only finished rows are sent. */
export function uploadInputsFromDrafts(rows: GuidedUploadDraft[]): GuidedStoryUploadInput[] {
  return rows
    .filter((row) => row.status === "ready")
    .map((row) => ({
      path: row.path,
      handle: normalizeHandle(row.handle),
      label: row.label ?? null,
      use: row.use,
      notes: row.notes?.trim() || null,
      aiDescription: row.aiDescription?.trim() || null,
      transcript: row.transcript?.trim() || null,
      voiceFor: row.use === "voice" ? (row.voiceFor ? normalizeHandle(row.voiceFor) : null) : null,
      rightsConfirmed: RIGHTS_USES.includes(row.use) ? row.rightsConfirmed === true : null,
    }));
}

/** Keep logo assignment atomic when concurrent inspections finish. Automatic
 * suggestions preserve the chosen logo; an explicit choice replaces it. */
export function patchGuidedUpload(
  rows: GuidedUploadDraft[],
  key: string,
  next: Partial<GuidedUploadDraft>,
  replaceLogo = false,
): GuidedUploadDraft[] {
  if (!rows.some((row) => row.key === key)) return rows;
  const anotherLogo = rows.some((row) => row.key !== key && row.use === "logo");
  const applied: Partial<GuidedUploadDraft> =
    next.use === "logo" && anotherLogo && !replaceLogo
      ? { ...next, use: "other_image" }
      : next;
  return rows.map((row) => {
    if (row.key === key) return { ...row, ...applied };
    if (replaceLogo && next.use === "logo" && row.use === "logo") {
      return { ...row, use: "other_image" };
    }
    return row;
  });
}

/** A blocking problem with the uploads list, or null when it can be saved. */
export function uploadsProblem(rows: GuidedUploadDraft[]): string | null {
  if (rows.some((row) => row.status === "uploading" || row.status === "inspecting")) {
    return "Wait for your uploads to finish.";
  }
  if (rows.filter((row) => row.use === "logo").length > 1) {
    return "Choose one Logo upload. Change the other logo uploads to Other or another use.";
  }
  const handles = new Set<string>();
  for (const row of rows) {
    if (row.status === "failed") return `Remove or retry ${row.label ?? "the failed upload"}.`;
    const handle = normalizeHandle(row.handle);
    if (handle.length < 2) return `Give ${row.label ?? "each upload"} an @name of at least 2 letters.`;
    if (handles.has(handle)) return `Two uploads are named @${handle}.`;
    handles.add(handle);
    if (RIGHTS_USES.includes(row.use) && row.rightsConfirmed !== true) {
      return row.use === "voice" || row.use === "voiceover"
        ? `Confirm you have the speaker's permission for @${handle}.`
        : `Confirm you own or licensed @${handle}.`;
    }
    if (row.use === "voice" && !row.voiceFor) return `Choose who @${handle} is the voice of.`;
  }
  return null;
}

/** "Is this a medical or CA video?" — only those get NMC / ICAI rules and banned words. */
export function GuidedVideoCategoryQuestion({
  value,
  onChange,
  disabled,
}: {
  value: GuidedStoryCategory | null;
  onChange: (next: GuidedStoryCategory) => void;
  disabled?: boolean;
}) {
  const options: Array<[GuidedStoryCategory, string, string]> = [
    ["general", "No — product or service", "Any other business."],
    ["medical", "Yes — medical", "Doctor, clinic or hospital. Follows NMC rules."],
    ["chartered_accountant", "Yes — CA", "Chartered accountant. Follows ICAI rules."],
  ];
  return (
    <fieldset className="space-y-2" data-testid="section-guided-category">
      <legend className="text-sm font-medium">Is this video medical or CA-related?</legend>
      <div className="grid gap-2 sm:grid-cols-3">
        {options.map(([id, title, hint]) => (
          <button
            key={id}
            type="button"
            disabled={disabled}
            aria-pressed={value === id}
            onClick={() => onChange(id)}
            className={`rounded-lg border p-3 text-left text-sm transition-colors disabled:opacity-50 ${
              value === id ? "border-primary bg-primary/5" : "hover:bg-muted/60"
            }`}
            data-testid={`button-guided-category-${id}`}
          >
            <span className="block font-medium">{title}</span>
            <span className="block text-xs text-muted-foreground">{hint}</span>
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function ListField({
  label,
  hint,
  values,
  onChange,
  max,
  maxLength,
  placeholder,
  testId,
  suggestions = [],
}: {
  label: string;
  hint?: string;
  values: string[];
  onChange: (next: string[]) => void;
  max: number;
  maxLength: number;
  placeholder: string;
  testId: string;
  suggestions?: string[];
}) {
  const [draft, setDraft] = useState("");
  const add = (value: string) => {
    const item = value.trim().slice(0, maxLength);
    if (item.length < 2 || values.includes(item) || values.length >= max) return;
    onChange([...values, item]);
    setDraft("");
  };
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      <div className="flex flex-wrap gap-1.5">
        {values.map((value) => (
          <span key={value} className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs">
            {value}
            <button type="button" aria-label={`Remove ${value}`} onClick={() => onChange(values.filter((item) => item !== value))}>
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
      </div>
      {values.length < max && (
        <div className="flex gap-2">
          <Input
            value={draft}
            maxLength={maxLength}
            placeholder={placeholder}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                add(draft);
              }
            }}
            data-testid={`input-${testId}`}
          />
          <Button type="button" variant="outline" size="sm" onClick={() => add(draft)} data-testid={`button-add-${testId}`}>
            Add
          </Button>
        </div>
      )}
      {suggestions.filter((item) => !values.includes(item)).length > 0 && values.length < max && (
        <div className="flex flex-wrap gap-1">
          {suggestions.filter((item) => !values.includes(item)).map((item) => (
            <button key={item} type="button" className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted" onClick={() => add(item)}>
              + {item}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export interface GuidedRequirementsValue {
  mustShow: string[];
  mustSay: string[];
  callToAction: string;
  bannedWords: string[];
}

export const EMPTY_REQUIREMENTS: GuidedRequirementsValue = { mustShow: [], mustSay: [], callToAction: "", bannedWords: [] };

/** What the script must deliver. Banned words appear only for medical / CA videos. */
export function GuidedRequirementsEditor({
  value,
  onChange,
  category,
  handles,
}: {
  value: GuidedRequirementsValue;
  onChange: (next: GuidedRequirementsValue) => void;
  category: GuidedStoryCategory | null;
  handles: string[];
}) {
  const regulated = category === "medical" || category === "chartered_accountant";
  return (
    <details className="rounded-lg border p-3" open={value.mustShow.length + value.mustSay.length > 0 || !!value.callToAction} data-testid="section-guided-requirements">
      <summary className="cursor-pointer text-sm font-medium">Product requirements <span className="font-normal text-muted-foreground">(optional)</span></summary>
      <div className="mt-3 space-y-4">
        <ListField
          label="Must show"
          hint="Things that must appear on screen. Use @names for your uploads."
          values={value.mustShow}
          onChange={(mustShow) => onChange({ ...value, mustShow })}
          max={8}
          maxLength={120}
          placeholder="e.g. the bottle label, @serum"
          testId="guided-must-show"
          suggestions={handles.map((handle) => `@${handle}`)}
        />
        <ListField
          label="Must say"
          hint="Exact phrases that must be spoken."
          values={value.mustSay}
          onChange={(mustSay) => onChange({ ...value, mustSay })}
          max={6}
          maxLength={160}
          placeholder="e.g. Free delivery across Vijayawada"
          testId="guided-must-say"
        />
        <div className="space-y-1.5">
          <Label htmlFor="guided-cta">Call to action</Label>
          <Input
            id="guided-cta"
            maxLength={160}
            value={value.callToAction}
            onChange={(event) => onChange({ ...value, callToAction: event.target.value })}
            placeholder="e.g. Order now on kokao.in"
            data-testid="input-guided-cta"
          />
        </div>
        {regulated && (
          <ListField
            label="Never use these words"
            hint={`Added to the ${category === "medical" ? "NMC" : "ICAI"} rules for this video. Scripts that use them can't be approved.`}
            values={value.bannedWords}
            onChange={(bannedWords) => onChange({ ...value, bannedWords })}
            max={40}
            maxLength={60}
            placeholder={category === "medical" ? "e.g. guaranteed cure" : "e.g. best CA in town"}
            testId="guided-banned-words"
          />
        )}
      </div>
    </details>
  );
}

export function requirementsInput(value: GuidedRequirementsValue, category: GuidedStoryCategory | null) {
  const regulated = category === "medical" || category === "chartered_accountant";
  return {
    mustShow: value.mustShow,
    mustSay: value.mustSay,
    callToAction: value.callToAction.trim() || null,
    bannedWords: regulated ? value.bannedWords : [],
  };
}

export function requirementsFromDraft(draft: GuidedStoryDraft | undefined | null): GuidedRequirementsValue {
  const saved = draft?.setup?.requirements;
  return saved
    ? {
        mustShow: saved.mustShow ?? [],
        mustSay: saved.mustSay ?? [],
        callToAction: saved.callToAction ?? "",
        bannedWords: saved.bannedWords ?? [],
      }
    : EMPTY_REQUIREMENTS;
}

function MediaIcon({ media }: { media: UploadMedia | null }) {
  if (media === "video") return <Video className="h-5 w-5" />;
  if (media === "audio") return <Music className="h-5 w-5" />;
  return <FileText className="h-5 w-5" />;
}

/**
 * Upload images, videos, audio and briefs; name each with an @handle and map
 * it to what it is for. Audio uploads ask how they should be used.
 */
export function GuidedStoryUploads({
  rows,
  onChange,
  disabled,
  hasBrandKit,
}: {
  rows: GuidedUploadDraft[];
  onChange: (update: (current: GuidedUploadDraft[]) => GuidedUploadDraft[]) => void;
  disabled?: boolean;
  hasBrandKit: boolean;
}) {
  const queryClient = useQueryClient();
  const requestUploadUrl = useRequestUploadUrl();
  const inspect = useInspectGuidedStoryReference();
  const transcribe = useTranscribeGuidedStoryReference();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [audioQuestionKey, setAudioQuestionKey] = useState<string | null>(null);
  const [transcribingKey, setTranscribingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const characterHandles = rows.filter((row) => row.use === "character").map((row) => normalizeHandle(row.handle));
  const patch = (key: string, next: Partial<GuidedUploadDraft>, replaceLogo = false) =>
    onChange((current) => patchGuidedUpload(current, key, next, replaceLogo));

  const addFiles = async (files: FileList | null) => {
    setError(null);
    if (!files?.length) return;
    const room = MAX_GUIDED_UPLOADS - rows.length;
    if (room <= 0) {
      setError(`Upload at most ${MAX_GUIDED_UPLOADS} files for one story.`);
      return;
    }
    const chosen = Array.from(files).slice(0, room);
    const taken = rows.map((row) => normalizeHandle(row.handle));
    for (const file of chosen) {
      const media = mediaForFile(file);
      const key = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const handle = uniqueHandle(file.name.replace(/\.[^.]+$/, ""), taken);
      taken.push(handle);
      if (!media) {
        setError(`${file.name} isn't an image, video, audio file or brief.`);
        continue;
      }
      const row: GuidedUploadDraft = {
        key,
        savedId: null,
        path: "",
        handle,
        label: file.name.slice(0, 120),
        use: USES_BY_MEDIA[media][0]!,
        notes: "",
        aiDescription: null,
        transcript: null,
        voiceFor: null,
        rightsConfirmed: false,
        media,
        durationSeconds: null,
        suggestedUse: null,
        status: "uploading",
        error: null,
        aiError: null,
      };
      onChange((current) => [...current, row]);
      void (async () => {
        try {
          const contentType = guidedUploadContentType(file);
          const { uploadURL, objectPath } = await requestUploadUrl.mutateAsync({
            data: { name: file.name, size: file.size, contentType },
          });
          let put: Response;
          try {
            put = await fetch(uploadURL, {
              method: "PUT",
              body: file,
              headers: { "Content-Type": contentType },
              signal: AbortSignal.timeout(120_000),
            });
          } catch (cause) {
            if (cause && typeof cause === "object" && "name" in cause &&
              (cause.name === "TimeoutError" || cause.name === "AbortError")) {
              throw new GuidedUploadError("The upload timed out. Remove this file and add it again.");
            }
            throw new GuidedUploadError("The browser could not send this file to storage. Check your connection or content blocker, then remove the file and add it again.");
          }
          if (!put.ok) throw new GuidedUploadError(`Upload failed (${put.status}). Remove this file and add it again.`);
          patch(key, { path: objectPath, status: "inspecting" });
          const facts = await inspect.mutateAsync({ data: { path: objectPath, label: file.name } });
          const suggested = facts.suggestedUse ?? null;
          patch(key, {
            status: "ready",
            media: facts.media,
            durationSeconds: facts.durationSeconds,
            aiDescription: facts.aiDescription,
            aiError: facts.aiError,
            suggestedUse: suggested,
            use: suggested && facts.allowedUses.includes(suggested) ? suggested : USES_BY_MEDIA[facts.media][0]!,
          });
          if (facts.media === "audio") setAudioQuestionKey(key);
        } catch (cause) {
          patch(key, {
            status: "failed",
            error: apiErrorMessage(cause, cause instanceof GuidedUploadError ? cause.message : "Could not upload this file."),
          });
        } finally {
          refreshCreditBalanceSafely(queryClient);
        }
      })();
    }
    if (fileRef.current) fileRef.current.value = "";
  };

  const audioRow = rows.find((row) => row.key === audioQuestionKey) ?? null;
  const runTranscript = async (row: GuidedUploadDraft) => {
    setTranscribingKey(row.key);
    try {
      const result = await transcribe.mutateAsync({ data: { path: row.path } });
      patch(row.key, { transcript: result.transcript });
    } catch (cause) {
      patch(row.key, { aiError: apiErrorMessage(cause, "Transcription failed. Type the words into the notes instead.") });
    } finally {
      setTranscribingKey(null);
      refreshCreditBalanceSafely(queryClient);
    }
  };

  return (
    <div className="space-y-3 rounded-lg border p-3" data-testid="section-guided-uploads">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="flex items-center gap-1.5 text-sm font-medium"><AtSign className="h-4 w-4" /> Your uploads <span className="font-normal text-muted-foreground">(optional)</span></p>
          <p className="text-xs text-muted-foreground">
            Up to 50 photos, videos, audio files or briefs. Name each one and mention it in the topic as @name.
          </p>
        </div>
        <input
          ref={fileRef}
          type="file"
          multiple
          className="hidden"
          disabled={disabled || rows.length >= MAX_GUIDED_UPLOADS}
          accept={GUIDED_UPLOAD_ACCEPT}
          onChange={(event) => void addFiles(event.target.files)}
          data-testid="input-guided-upload-files"
        />
        <Button type="button" variant="outline" size="sm" disabled={disabled || rows.length >= MAX_GUIDED_UPLOADS} onClick={() => fileRef.current?.click()} data-testid="button-guided-add-uploads">
          <Upload className="mr-2 h-4 w-4" /> Add files
        </Button>
      </div>
      {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
      {rows.some((row) => row.media === "image") && (
        <p className="text-xs text-muted-foreground">
          One logo per story. Choosing another logo changes the previous one to Other; no files are removed.
        </p>
      )}
      {rows.length > 0 && (
        <ul className="space-y-2">
          {rows.map((row) => {
            const handle = normalizeHandle(row.handle);
            const uses = row.media ? USES_BY_MEDIA[row.media] : [];
            return (
              <li key={row.key} className="grid gap-3 rounded-md bg-muted/30 p-3 sm:grid-cols-[64px_1fr]" data-testid={`row-guided-upload-${handle || row.key}`}>
                <div className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-md border bg-background text-muted-foreground">
                  {row.media === "image" && row.path ? (
                    <img src={`/api/storage${row.path}`} alt="" className="h-full w-full object-cover" />
                  ) : row.status === "uploading" || row.status === "inspecting" ? (
                    <Loader2 className="h-5 w-5 animate-spin" />
                  ) : (
                    <MediaIcon media={row.media} />
                  )}
                </div>
                <div className="min-w-0 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="flex items-center rounded-md border bg-background pl-2">
                      <span className="text-sm text-muted-foreground">@</span>
                      <Input
                        aria-label={`Name for ${row.label}`}
                        className="h-8 w-40 border-0 pl-0.5 shadow-none focus-visible:ring-0"
                        value={row.handle}
                        maxLength={32}
                        disabled={disabled}
                        onChange={(event) => patch(row.key, { handle: event.target.value })}
                        onBlur={(event) => patch(row.key, { handle: normalizeHandle(event.target.value) })}
                        data-testid={`input-guided-upload-handle-${row.key}`}
                      />
                    </div>
                    {row.status === "ready" && uses.length > 1 && (
                      <Select value={row.use} onValueChange={(value) => patch(row.key, { use: value as GuidedStoryReferenceUse }, true)} disabled={disabled}>
                        <SelectTrigger className="h-8 w-52" data-testid={`select-guided-upload-use-${row.key}`}><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {uses.map((use) => <SelectItem key={use} value={use}>{GUIDED_REFERENCE_USE_LABELS[use]}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    )}
                    {row.status === "ready" && uses.length === 1 && <span className="text-xs text-muted-foreground">{GUIDED_REFERENCE_USE_LABELS[row.use]}</span>}
                    {row.status === "uploading" && <span className="text-xs text-muted-foreground">Uploading…</span>}
                    {row.status === "inspecting" && <span className="text-xs text-muted-foreground">Reading the file…</span>}
                    <span className="truncate text-xs text-muted-foreground">{row.label}{row.durationSeconds ? ` · ${Math.round(row.durationSeconds)}s` : ""}</span>
                    <Button type="button" size="icon" variant="ghost" className="ml-auto h-7 w-7" aria-label={`Remove @${handle}`} disabled={disabled} onClick={() => onChange((current) => current.filter((item) => item.key !== row.key))} data-testid={`button-guided-upload-remove-${row.key}`}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  {row.status === "failed" && <p className="text-xs text-destructive" role="alert">{row.error}</p>}
                  {row.status === "ready" && row.suggestedUse && row.suggestedUse !== row.use && (
                    <button type="button" className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs" onClick={() => patch(row.key, { use: row.suggestedUse! })}>
                      <Sparkles className="h-3 w-3" /> AI thinks this is a {GUIDED_REFERENCE_USE_LABELS[row.suggestedUse].toLowerCase()} — use that
                    </button>
                  )}
                  {row.status === "ready" && row.use === "product" && (
                    <p className="text-xs text-muted-foreground">Tip: for a fixed label card on screen, also add this photo to a Brand Kit's Products.</p>
                  )}
                  {row.status === "ready" && row.media === "audio" && (
                    <button type="button" className="text-xs underline underline-offset-2" onClick={() => setAudioQuestionKey(row.key)} data-testid={`button-guided-upload-audio-${row.key}`}>
                      {GUIDED_REFERENCE_USE_LABELS[row.use]}{row.use === "voice" && row.voiceFor ? ` of @${row.voiceFor}` : ""} — change
                    </button>
                  )}
                  {row.status === "ready" && (
                    <Textarea
                      rows={1}
                      maxLength={400}
                      value={row.notes ?? ""}
                      disabled={disabled}
                      placeholder={row.media === "document" ? "What should the script take from this brief?" : "Notes for the AI (optional)"}
                      onChange={(event) => patch(row.key, { notes: event.target.value })}
                      data-testid={`input-guided-upload-notes-${row.key}`}
                    />
                  )}
                  {row.aiDescription && <p className="text-xs text-muted-foreground"><Sparkles className="mr-1 inline h-3 w-3" />{row.aiDescription}</p>}
                  {row.transcript && <p className="text-xs text-muted-foreground">“{row.transcript.slice(0, 240)}{row.transcript.length > 240 ? "…" : ""}”</p>}
                  {row.aiError && <p className="text-xs text-amber-700 dark:text-amber-300">{row.aiError}</p>}
                  {row.status === "ready" && RIGHTS_USES.includes(row.use) && (
                    <label className="flex items-start gap-2 text-xs">
                      <Checkbox checked={row.rightsConfirmed === true} onCheckedChange={(checked) => patch(row.key, { rightsConfirmed: checked === true })} data-testid={`checkbox-guided-upload-rights-${row.key}`} />
                      <span>{row.use === "voice" || row.use === "voiceover" ? "This is my voice, or I have the speaker's permission to use it." : "I own this or have a licence to use it in ads."}</span>
                    </label>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <Dialog open={audioRow !== null} onOpenChange={(open) => !open && setAudioQuestionKey(null)}>
        <DialogContent data-testid="dialog-guided-audio-use">
          <DialogHeader>
            <DialogTitle>How should we use @{audioRow ? normalizeHandle(audioRow.handle) : ""}?</DialogTitle>
            <DialogDescription>Pick one. You can change it later.</DialogDescription>
          </DialogHeader>
          {audioRow && (
            <div className="space-y-3">
              <div className="grid gap-2">
                {(["voice", "music", "voiceover", "sfx"] as const).map((use) => (
                  <button
                    key={use}
                    type="button"
                    aria-pressed={audioRow.use === use}
                    onClick={() => patch(audioRow.key, { use })}
                    className={`rounded-lg border p-3 text-left text-sm ${audioRow.use === use ? "border-primary bg-primary/5" : "hover:bg-muted/60"}`}
                    data-testid={`button-guided-audio-use-${use}`}
                  >
                    <span className="font-medium">{GUIDED_REFERENCE_USE_LABELS[use]}</span>
                    <span className="block text-xs text-muted-foreground">
                      {use === "voice" && "Clone it so a character speaks with this voice."}
                      {use === "music" && "Play under the video, dipping when people speak."}
                      {use === "voiceover" && "Play this recording as the narration."}
                      {use === "sfx" && "Play at a moment you choose."}
                    </span>
                  </button>
                ))}
              </div>
              {audioRow.use === "voice" && (
                <div className="space-y-1.5">
                  <Label>Voice of</Label>
                  {characterHandles.length ? (
                    <Select value={audioRow.voiceFor ?? ""} onValueChange={(value) => patch(audioRow.key, { voiceFor: value })}>
                      <SelectTrigger data-testid="select-guided-audio-voice-for"><SelectValue placeholder="Choose a character upload" /></SelectTrigger>
                      <SelectContent>{characterHandles.map((handle) => <SelectItem key={handle} value={handle}>@{handle}</SelectItem>)}</SelectContent>
                    </Select>
                  ) : (
                    <Input
                      placeholder="Character name, e.g. maya"
                      value={audioRow.voiceFor ?? ""}
                      onChange={(event) => patch(audioRow.key, { voiceFor: normalizeHandle(event.target.value) })}
                      data-testid="input-guided-audio-voice-for"
                    />
                  )}
                  <p className="text-xs text-muted-foreground">{hasBrandKit ? "You'll clone it into the Brand Kit's voices at the casting step." : "Pick a Brand Kit above to clone voices."}</p>
                </div>
              )}
              {audioRow.use === "voiceover" && (
                <Button type="button" variant="outline" size="sm" disabled={transcribingKey === audioRow.key} onClick={() => void runTranscript(audioRow)} data-testid="button-guided-audio-transcribe">
                  {transcribingKey === audioRow.key ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Transcribing…</> : audioRow.transcript ? "Transcribe again" : "Transcribe so the script matches it"}
                </Button>
              )}
              {RIGHTS_USES.includes(audioRow.use) && (
                <label className="flex items-start gap-2 text-sm">
                  <Checkbox checked={audioRow.rightsConfirmed === true} onCheckedChange={(checked) => patch(audioRow.key, { rightsConfirmed: checked === true })} data-testid="checkbox-guided-audio-rights" />
                  <span>{audioRow.use === "music" ? "I own this music or have a licence to use it in ads." : "This is my voice, or I have the speaker's permission to use it."}</span>
                </label>
              )}
              <div className="flex justify-end">
                <Button type="button" onClick={() => setAudioQuestionKey(null)} data-testid="button-guided-audio-done">Done</Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Insert chips for @names and a warning for unknown mentions. */
export function TopicMentionHelper({
  topic,
  handles,
  onInsert,
}: {
  topic: string;
  handles: string[];
  onInsert: (handle: string) => void;
}) {
  const unknown = mentionedHandles(topic).filter((handle) => !handles.includes(handle));
  if (!handles.length && !unknown.length) return null;
  return (
    <div className="space-y-1" data-testid="guided-topic-mentions">
      {handles.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">Mention:</span>
          {handles.map((handle) => (
            <button key={handle} type="button" className="rounded-full border px-2 py-0.5 text-xs hover:bg-muted" onClick={() => onInsert(handle)} data-testid={`button-guided-mention-${handle}`}>
              @{handle}
            </button>
          ))}
        </div>
      )}
      {unknown.length > 0 && (
        <p className="text-xs text-amber-700 dark:text-amber-300" role="status" data-testid="warning-guided-unknown-mentions">
          No upload is named {unknown.map((handle) => `@${handle}`).join(", ")}.
        </p>
      )}
    </div>
  );
}

const SCENE_TAG_USES: GuidedStoryReferenceUse[] = ["product", "backdrop", "prop", "style", "opening_shot", "closing_shot", "other_image", "motion", "footage"];

/** Script review: which uploads a scene uses. */
export function SceneReferenceToggles({
  draft,
  referenceIds,
  onChange,
  sceneLabel,
  disabled,
}: {
  draft: GuidedStoryDraft;
  referenceIds: string[];
  onChange: (next: string[]) => void;
  sceneLabel: string;
  disabled?: boolean;
}) {
  const items = (draft.setup?.references?.items ?? []).filter((item) => SCENE_TAG_USES.includes(item.use));
  if (!items.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid={`scene-uploads-${sceneLabel}`}>
      <span className="text-xs font-medium text-muted-foreground">Uses ({referenceIds.length}/{MAX_GUIDED_SCENE_UPLOADS}):</span>
      <span className="text-xs text-muted-foreground">
        Assignment limit: 50. Actual AI attachments depend on the selected model; Wan accepts 10 images and Seedance 2.5 accepts 30 images.
      </span>
      {items.map((item) => {
        const active = referenceIds.includes(item.id);
        const full = !active && referenceIds.length >= MAX_GUIDED_SCENE_UPLOADS;
        return (
          <button
            key={item.id}
            type="button"
            disabled={disabled || full}
            aria-pressed={active}
            title={full ? `A scene can use at most ${MAX_GUIDED_SCENE_UPLOADS} uploads.` : GUIDED_REFERENCE_USE_LABELS[item.use]}
            onClick={() => onChange(active ? referenceIds.filter((id) => id !== item.id) : [...referenceIds, item.id])}
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors disabled:opacity-50 ${active ? "border-primary bg-primary/10" : "text-muted-foreground hover:bg-muted"}`}
            data-testid={`toggle-scene-upload-${sceneLabel}-${item.id}`}
          >
            {item.media === "image" && <img src={`/api/storage${item.path}`} alt="" className="h-4 w-4 rounded-sm object-cover" />}
            @{item.handle}
          </button>
        );
      })}
    </div>
  );
}

/** Script review: the requirement checklist. Never blocks approval. */
export function GuidedRequirementChecklist({ checks }: { checks: GuidedStoryRequirementCheck[] | undefined }) {
  if (!checks?.length) return null;
  const missing = checks.filter((check) => !check.met).length;
  return (
    <div className={`rounded-md border p-3 text-sm ${missing ? "border-amber-500/50 bg-amber-50/60 dark:bg-amber-950/20" : "bg-muted/30"}`} data-testid="section-guided-requirement-checks">
      <p className="font-medium">{missing ? `${missing} requirement${missing === 1 ? "" : "s"} not met yet` : "All requirements met"}</p>
      <ul className="mt-1 space-y-0.5">
        {checks.map((check) => (
          <li key={`${check.kind}:${check.text}`} className="flex items-start gap-1.5">
            {check.met ? <Check className="mt-0.5 h-3.5 w-3.5 text-emerald-600" /> : <X className="mt-0.5 h-3.5 w-3.5 text-amber-600" />}
            <span>
              {check.kind === "must_say" ? `Says “${check.text}”` : check.kind === "must_show" ? `Shows ${check.text}` : check.kind === "call_to_action" ? `Ends with “${check.text}”` : check.text}
            </span>
          </li>
        ))}
      </ul>
      {missing > 0 && <p className="mt-1 text-xs text-muted-foreground">Edit the scenes below or regenerate the script.</p>}
    </div>
  );
}

/**
 * Casting shortcuts for a role mapped to uploads: fill the generated
 * character's look from a character / outfit upload, use the photo itself, or
 * clone a voice upload into the Brand Kit.
 */
export function RoleUploadShortcuts({
  draft,
  roleId,
  roleName,
  onFillLook,
  onUsePhoto,
  onVoiceReady,
}: {
  draft: GuidedStoryDraft;
  roleId: string;
  roleName: string;
  onFillLook?: (look: { description?: string; wardrobe?: string }) => void;
  onUsePhoto?: (path: string) => void;
  onVoiceReady?: (voiceId: string) => void;
}) {
  const queryClient = useQueryClient();
  const clone = useCloneBrandVoice();
  const [cloneError, setCloneError] = useState<string | null>(null);
  const [cloned, setCloned] = useState(false);
  const items = draft.setup?.references?.items ?? [];
  const role = draft.script?.roles.find((candidate) => candidate.id === roleId);
  const character = role?.referenceId ? items.find((item) => item.id === role.referenceId) : undefined;
  const outfits = items.filter((item) => item.use === "outfit");
  const voice = items.find((item) => item.use === "voice" && (item.voiceFor === roleId || (character && item.voiceFor === character.handle)));
  if (!character && !outfits.length && !voice) return null;
  const brandKitId = draft.setup?.brandKitId ?? null;
  const describe = (item: (typeof items)[number]) => [item.aiDescription, item.notes].filter(Boolean).join(" ").slice(0, 900);
  const cloneVoice = () => {
    if (!voice || brandKitId === null) return;
    setCloneError(null);
    clone.mutate(
      { id: brandKitId, data: { sampleAssetPath: voice.path, label: `@${voice.handle}` } },
      {
        onSuccess: async () => {
          setCloned(true);
          await queryClient.invalidateQueries({ queryKey: getListGuidedStoryVoicesQueryKey() });
          const catalog = queryClient.getQueryData<{ voices?: Array<{ id: string; label: string }> }>(getListGuidedStoryVoicesQueryKey());
          const match = catalog?.voices?.find((entry) => entry.label === `@${voice.handle}`);
          if (match) onVoiceReady?.(match.id);
        },
        onError: (cause) => setCloneError(apiErrorMessage(cause, "Could not clone this voice.")),
        onSettled: () => refreshCreditBalanceSafely(queryClient),
      },
    );
  };
  return (
    <div className="space-y-1.5 rounded-md bg-muted/40 p-2 text-xs" data-testid={`guided-role-uploads-${roleId}`}>
      <p className="font-medium">Your uploads for {roleName}</p>
      <div className="flex flex-wrap gap-1.5">
        {character && onFillLook && (
          <Button type="button" size="sm" variant="outline" className="h-7 text-xs" onClick={() => onFillLook({ description: describe(character) })} data-testid={`button-guided-fill-look-${roleId}`}>
            Fill look from @{character.handle}
          </Button>
        )}
        {character && onUsePhoto && (
          <Button type="button" size="sm" variant="outline" className="h-7 text-xs" onClick={() => onUsePhoto(character.path)} data-testid={`button-guided-use-photo-${roleId}`}>
            Use @{character.handle} photo
          </Button>
        )}
        {onFillLook && outfits.map((outfit) => (
          <Button key={outfit.id} type="button" size="sm" variant="outline" className="h-7 text-xs" onClick={() => onFillLook({ wardrobe: describe(outfit) })}>
            Wardrobe from @{outfit.handle}
          </Button>
        ))}
        {voice && (
          <Button type="button" size="sm" variant="outline" className="h-7 text-xs" disabled={brandKitId === null || clone.isPending || cloned} onClick={cloneVoice} data-testid={`button-guided-clone-voice-${roleId}`}>
            {clone.isPending ? "Cloning…" : cloned ? `Voice @${voice.handle} cloned` : `Clone voice @${voice.handle}`}
          </Button>
        )}
      </div>
      {voice && brandKitId === null && <p className="text-muted-foreground">Pick a Brand Kit in setup to clone voices.</p>}
      {character && onUsePhoto && <p className="text-muted-foreground">A real person's photo needs their consent, and some video models only accept generated faces.</p>}
      {cloneError && <p className="text-destructive" role="alert">{cloneError}</p>}
    </div>
  );
}

/** Backdrop step: use an uploaded backdrop as the plate. */
export function BackdropUploadShortcuts({
  draft,
  sceneId,
  onUse,
  disabled,
}: {
  draft: GuidedStoryDraft;
  sceneId: string | null;
  onUse: (reference: { prompt: string; imagePath: string }) => void;
  disabled?: boolean;
}) {
  const scene = sceneId ? draft.script?.scenes.find((candidate) => candidate.id === sceneId) : undefined;
  const all = (draft.setup?.references?.items ?? []).filter((item) => item.use === "backdrop");
  const items = scene
    ? [...all.filter((item) => scene.referenceIds?.includes(item.id)), ...all.filter((item) => !scene.referenceIds?.includes(item.id))]
    : all;
  if (!items.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid={`guided-backdrop-uploads-${sceneId ?? "default"}`}>
      <span className="text-xs text-muted-foreground">Your uploads:</span>
      {items.map((item) => (
        <Button
          key={item.id}
          type="button"
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 text-xs"
          disabled={disabled}
          onClick={() => onUse({
            prompt: (item.notes || item.aiDescription || `Location from upload @${item.handle}`).slice(0, 1000),
            imagePath: item.path,
          })}
          data-testid={`button-guided-use-backdrop-${sceneId ?? "default"}-${item.id}`}
        >
          <img src={`/api/storage${item.path}`} alt="" className="h-4 w-4 rounded-sm object-cover" /> Use @{item.handle}
        </Button>
      ))}
    </div>
  );
}

type PlacementForm = GuidedStoryAudioPlacement;

/** Ready step: where music, voiceover and sound effects play. Never resets approvals. */
export function GuidedAudioPlacementEditor({ draft, disabled }: { draft: GuidedStoryDraft; disabled?: boolean }) {
  const queryClient = useQueryClient();
  const update = useUpdateGuidedStoryDraft();
  const audio = (draft.setup?.references?.items ?? []).filter((item) => item.use === "music" || item.use === "voiceover" || item.use === "sfx");
  const scenes = draft.script?.scenes ?? [];
  const saved = draft.audioChoices?.items ?? [];
  const initial = useMemo<PlacementForm[]>(
    () =>
      audio.map((item) =>
        saved.find((placement) => placement.referenceId === item.id) ?? {
          referenceId: item.id,
          sceneId: item.use === "sfx" ? scenes[0]?.id ?? null : null,
          startSeconds: 0,
          endSeconds: null,
          volume: item.use === "music" ? 0.3 : 1,
          duckUnderSpeech: item.use === "music",
          replaceGeneratedAudio: item.use === "voiceover",
        },
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [draft.id, draft.revision],
  );
  const [rows, setRows] = useState<PlacementForm[]>(initial);
  const [error, setError] = useState<string | null>(null);
  const [savedOk, setSavedOk] = useState(false);
  if (!audio.length) return null;
  const set = (referenceId: string, next: Partial<PlacementForm>) => {
    setSavedOk(false);
    setRows((current) => current.map((row) => (row.referenceId === referenceId ? { ...row, ...next } : row)));
  };
  const save = () => {
    setError(null);
    update.mutate(
      { draftId: draft.id, data: { revision: draft.revision, audioChoices: { version: 1, items: rows } } },
      {
        onSuccess: (next) => {
          queryClient.setQueryData(getGetGuidedStoryDraftQueryKey(next.id), next);
          setSavedOk(true);
        },
        onError: (cause) => setError(apiErrorMessage(cause, "Could not save the audio placement.")),
      },
    );
  };
  return (
    <section className="space-y-3 rounded-lg border p-3" data-testid="section-guided-audio-placement">
      <div>
        <h3 className="text-sm font-semibold">Your audio</h3>
        <p className="text-xs text-muted-foreground">Mixed into the finished video. Times are seconds from the start of the chosen scene.</p>
      </div>
      {audio.map((item) => {
        const row = rows.find((candidate) => candidate.referenceId === item.id);
        if (!row) return null;
        return (
          <div key={item.id} className="grid gap-2 rounded-md bg-muted/30 p-2 text-xs sm:grid-cols-[1fr_auto_auto_auto]" data-testid={`row-guided-audio-${item.id}`}>
            <div className="space-y-1">
              <p className="font-medium">@{item.handle} · {GUIDED_REFERENCE_USE_LABELS[item.use]}</p>
              <Select value={row.sceneId ?? "start"} onValueChange={(value) => set(item.id, { sceneId: value === "start" ? null : value })} disabled={disabled}>
                <SelectTrigger className="h-8" data-testid={`select-guided-audio-scene-${item.id}`}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="start">From the start of the video</SelectItem>
                  {scenes.map((scene, index) => <SelectItem key={scene.id} value={scene.id}>Scene {index + 1}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <label className="space-y-1">
              <span className="block text-muted-foreground">Start</span>
              <Input type="number" min={0} max={600} step={0.5} className="h-8 w-20" value={row.startSeconds} onChange={(event) => set(item.id, { startSeconds: Number(event.target.value) || 0 })} disabled={disabled} />
            </label>
            <label className="space-y-1">
              <span className="block text-muted-foreground">End</span>
              <Input type="number" min={0} max={600} step={0.5} className="h-8 w-20" placeholder="auto" value={row.endSeconds ?? ""} onChange={(event) => set(item.id, { endSeconds: event.target.value === "" ? null : Number(event.target.value) })} disabled={disabled} />
            </label>
            <label className="space-y-1">
              <span className="block text-muted-foreground">Volume</span>
              <Input type="range" min={0} max={1.5} step={0.05} className="h-8 w-24 px-0" value={row.volume} onChange={(event) => set(item.id, { volume: Number(event.target.value) })} disabled={disabled} />
            </label>
            {item.use === "music" && (
              <label className="flex items-center gap-2 sm:col-span-4">
                <Checkbox checked={row.duckUnderSpeech} onCheckedChange={(checked) => set(item.id, { duckUnderSpeech: checked === true })} disabled={disabled} />
                Lower the music when people speak
              </label>
            )}
            {item.use === "voiceover" && (
              <label className="flex items-center gap-2 sm:col-span-4">
                <Checkbox checked={row.replaceGeneratedAudio} onCheckedChange={(checked) => set(item.id, { replaceGeneratedAudio: checked === true })} disabled={disabled} />
                Mute the generated sound while the voiceover plays
              </label>
            )}
          </div>
        );
      })}
      {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
      <div className="flex items-center gap-2">
        <Button type="button" size="sm" variant="outline" disabled={disabled || update.isPending} onClick={save} data-testid="button-guided-save-audio">
          {update.isPending ? "Saving…" : "Save audio"}
        </Button>
        {savedOk && <span className="text-xs text-muted-foreground" role="status">Saved</span>}
      </div>
    </section>
  );
}
