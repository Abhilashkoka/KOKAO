import { useEffect, useRef, useState } from "react";
import { ImagePlus, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { VideoReferenceImage as ApiVideoReferenceImage } from "@workspace/api-client-react";

export type VideoReferenceImage = ApiVideoReferenceImage & {
  previewUrl?: string;
};

type DraftReference = VideoReferenceImage & {
  sceneText: string;
  file?: File;
  status: "ready" | "uploading" | "failed";
  error?: string;
};

const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/webp"];
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_REFERENCES = 6;

function parseScenes(value: string): { scenes?: number[]; error?: string } {
  const trimmed = value.trim();
  if (!trimmed) return {};
  const parts = trimmed.split(",").map((part) => part.trim());
  if (
    parts.some(
      (part) =>
        !/^\d+$/.test(part) ||
        Number(part) < 1 ||
        Number(part) > 80 ||
        !Number.isSafeInteger(Number(part)),
    )
  ) {
    return { error: "Use comma-separated whole scene numbers from 1 to 80." };
  }
  const scenes = [...new Set(parts.map(Number))];
  return scenes.length > 80
    ? { error: "Assign at most 80 scenes." }
    : { scenes };
}

function uploadErrorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const candidate = error as { message?: unknown; data?: { error?: unknown } };
    if (typeof candidate.data?.error === "string") return candidate.data.error;
    if (typeof candidate.message === "string") return candidate.message;
  }
  return "The image could not be uploaded. Try again or remove it.";
}

function createDraft(file: File): DraftReference {
  const stem = file.name.replace(/\.[^.]+$/, "").trim();
  return {
    id: `reference-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    label: stem || "Reference image",
    objectPath: "",
    instructions: "",
    mode: "visual_reference",
    previewUrl: URL.createObjectURL(file),
    sceneText: "",
    file,
    status: "uploading",
  };
}

export function VideoReferenceImages({
  value,
  onChange,
  uploadFile,
  onBlockedChange,
}: {
  value: VideoReferenceImage[];
  onChange: (references: VideoReferenceImage[]) => void;
  uploadFile: (file: File) => Promise<string>;
  onBlockedChange: (blocked: boolean) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const valueIdentity = value
    .map((reference) => `${reference.id}:${reference.objectPath}`)
    .join("|");
  const syncedIdentity = useRef(valueIdentity);
  const [drafts, setDrafts] = useState<DraftReference[]>(() =>
    value.map((reference) => ({
      ...reference,
      previewUrl: reference.previewUrl ?? `/api/storage${reference.objectPath}`,
      sceneText: reference.sceneNumbers?.join(", ") ?? "",
      status: "ready",
    })),
  );

  useEffect(() => {
    if (syncedIdentity.current === valueIdentity) return;
    syncedIdentity.current = valueIdentity;
    setDrafts(
      value.map((reference) => ({
        ...reference,
        previewUrl: reference.previewUrl ?? `/api/storage${reference.objectPath}`,
        sceneText: reference.sceneNumbers?.join(", ") ?? "",
        status: "ready",
      })),
    );
  }, [value, valueIdentity]);

  const invalid = drafts.some(
    (draft) =>
      draft.status !== "ready" ||
      !draft.label.trim() ||
      draft.label.trim().length > 120 ||
      draft.instructions.length > 2000 ||
      Boolean(parseScenes(draft.sceneText).error),
  );
  useEffect(() => {
    onBlockedChange(invalid);
  }, [invalid, onBlockedChange]);

  const publish = (next: DraftReference[]) => {
    setDrafts(next);
    onChange(
      next
        .filter((draft) => draft.status === "ready")
        .map(({ sceneText, file: _file, status: _status, error: _error, ...draft }) => ({
          ...draft,
          label: draft.label,
          instructions: draft.instructions,
          sceneNumbers: parseScenes(sceneText).scenes,
        })),
    );
  };

  const runUpload = async (id: string, file: File) => {
    try {
      const objectPath = await uploadFile(file);
      setDrafts((current) => {
        const next = current.map((draft) =>
          draft.id === id
            ? { ...draft, objectPath, status: "ready" as const, error: undefined }
            : draft,
        );
        onChange(
          next
            .filter((draft) => draft.status === "ready")
            .map(({ sceneText, file: _file, status: _status, error: _error, ...draft }) => ({
              ...draft,
              sceneNumbers: parseScenes(sceneText).scenes,
            })),
        );
        return next;
      });
    } catch (error) {
      setDrafts((current) =>
        current.map((draft) =>
          draft.id === id
            ? { ...draft, status: "failed", error: uploadErrorMessage(error) }
            : draft,
        ),
      );
    }
  };

  const chooseFiles = (files: FileList | null) => {
    if (!files?.length) return;
    const selected = [...files];
    if (drafts.length + selected.length > MAX_REFERENCES) {
      const message = `You can add up to ${MAX_REFERENCES} reference images. Remove one before adding more.`;
      setDrafts((current) => [
        ...current,
        ...selected.map((file) => ({
          ...createDraft(file),
          status: "failed" as const,
          error: message,
        })),
      ]);
      if (inputRef.current) inputRef.current.value = "";
      return;
    }
    const additions = selected.map((file) => {
      const draft = createDraft(file);
      if (!ACCEPTED_TYPES.includes(file.type)) {
        return {
          ...draft,
          status: "failed" as const,
          error: "Use a PNG, JPEG, or WebP image.",
        };
      }
      if (file.size > MAX_BYTES) {
        return {
          ...draft,
          status: "failed" as const,
          error: "Reference images must be 10 MB or smaller.",
        };
      }
      return draft;
    });
    setDrafts((current) => [...current, ...additions]);
    additions
      .filter((draft) => draft.status === "uploading")
      .forEach((draft) => void runUpload(draft.id, draft.file!));
    if (inputRef.current) inputRef.current.value = "";
  };

  const update = (id: string, patch: Partial<DraftReference>) =>
    publish(drafts.map((draft) => (draft.id === id ? { ...draft, ...patch } : draft)));

  const remove = (id: string) => {
    const removed = drafts.find((draft) => draft.id === id);
    if (removed?.previewUrl?.startsWith("blob:")) URL.revokeObjectURL(removed.previewUrl);
    publish(drafts.filter((draft) => draft.id !== id));
  };

  return (
    <section
      className="rounded-xl border border-border bg-muted/20 p-4 space-y-4"
      data-testid="reference-images-section"
    >
      <div className="space-y-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Label className="text-base">Reference images (optional)</Label>
          <span className="text-xs text-muted-foreground">{drafts.length}/{MAX_REFERENCES}</span>
        </div>
        <p className="text-sm text-muted-foreground">
          Add product, location, prop, or composition references. Compatibility depends on the
          selected video model and mode; an unsupported combination will be reported before work
          starts.
        </p>
      </div>

      {drafts.map((draft, index) => {
        const sceneError = parseScenes(draft.sceneText).error;
        return (
          <div
            key={draft.id}
            className="grid gap-3 rounded-lg border border-border bg-background p-3 sm:grid-cols-[7rem_1fr]"
            data-testid={`reference-image-card-${index}`}
          >
            <div className="space-y-2">
              <img
                src={draft.previewUrl}
                alt={draft.label || `Reference ${index + 1}`}
                className="h-28 w-28 rounded-md border bg-muted object-contain"
                data-testid={`img-reference-${index}`}
              />
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="w-full text-destructive"
                onClick={() => remove(draft.id)}
                data-testid={`button-remove-reference-${index}`}
              >
                <Trash2 className="mr-1.5 h-3.5 w-3.5" /> Remove
              </Button>
            </div>
            <div className="space-y-3">
              {draft.status === "uploading" && (
                <p className="text-sm text-muted-foreground" data-testid={`status-reference-${index}`}>
                  Uploading…
                </p>
              )}
              {draft.status === "failed" && (
                <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2">
                  <p className="text-sm text-destructive" data-testid={`error-reference-${index}`}>
                    {draft.error}
                  </p>
                  {draft.file && ACCEPTED_TYPES.includes(draft.file.type) && draft.file.size <= MAX_BYTES && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="mt-2"
                      onClick={() => {
                        update(draft.id, { status: "uploading", error: undefined });
                        void runUpload(draft.id, draft.file!);
                      }}
                      data-testid={`button-retry-reference-${index}`}
                    >
                      <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Retry upload
                    </Button>
                  )}
                </div>
              )}
              <div className="space-y-1">
                <Label htmlFor={`reference-label-${draft.id}`}>Label</Label>
                <Input
                  id={`reference-label-${draft.id}`}
                  value={draft.label}
                  maxLength={120}
                  onChange={(event) => update(draft.id, { label: event.target.value })}
                  placeholder="e.g. Blue bottle"
                  data-testid={`input-reference-label-${index}`}
                />
                {!draft.label.trim() && <p className="text-xs text-destructive">Add a label.</p>}
              </div>
              <div className="space-y-1">
                <Label htmlFor={`reference-instructions-${draft.id}`}>How should it be used?</Label>
                <Textarea
                  id={`reference-instructions-${draft.id}`}
                  value={draft.instructions}
                  maxLength={2000}
                  onChange={(event) => update(draft.id, { instructions: event.target.value })}
                  placeholder="e.g. Keep the bottle shape and logo visible"
                  rows={2}
                  data-testid={`input-reference-instructions-${index}`}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`reference-mode-${draft.id}`}>Mode</Label>
                <select
                  id={`reference-mode-${draft.id}`}
                  value={draft.mode}
                  onChange={(event) =>
                    update(draft.id, {
                      mode: event.target.value as VideoReferenceImage["mode"],
                    })
                  }
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  data-testid={`select-reference-mode-${index}`}
                >
                  <option value="visual_reference">Visual reference — AI may change details</option>
                  <option value="exact_insert">
                    Exact insert — original as a fitted, uncropped full-frame scene
                  </option>
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor={`reference-scenes-${draft.id}`}>Scene numbers (optional)</Label>
                <Input
                  id={`reference-scenes-${draft.id}`}
                  value={draft.sceneText}
                  onChange={(event) => update(draft.id, { sceneText: event.target.value })}
                  placeholder="e.g. 1, 3"
                  aria-invalid={Boolean(sceneError)}
                  data-testid={`input-reference-scenes-${index}`}
                />
                <p className={`text-xs ${sceneError ? "text-destructive" : "text-muted-foreground"}`}>
                  {sceneError ?? "Leave empty to let KOKAO map it to suitable scenes."}
                </p>
              </div>
            </div>
          </div>
        );
      })}

      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={drafts.length >= MAX_REFERENCES}
        onClick={() => inputRef.current?.click()}
        data-testid="button-upload-reference-images"
      >
        <ImagePlus className="mr-1.5 h-4 w-4" /> Add reference images
      </Button>
      <input
        ref={inputRef}
        className="hidden"
        type="file"
        accept={ACCEPTED_TYPES.join(",")}
        multiple
        onChange={(event) => chooseFiles(event.target.files)}
        data-testid="input-reference-images"
      />
      <p className="text-xs text-muted-foreground">PNG, JPEG, or WebP. Up to 10 MB each.</p>
    </section>
  );
}

export function StoryboardReferenceAssignments({
  references,
  scenes,
}: {
  references: VideoReferenceImage[];
  scenes: Array<{ id: string; referenceImageIds?: string[] }>;
}) {
  if (!references.length || !scenes.some((scene) => scene.referenceImageIds?.length)) return null;
  const byId = new Map(references.map((reference) => [reference.id, reference]));
  return (
    <section className="space-y-2" data-testid="storyboard-reference-assignments">
      <p className="text-sm font-medium">References mapped to the storyboard</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {scenes.map((scene, index) => {
          const assigned = (scene.referenceImageIds ?? [])
            .map((id) => byId.get(id))
            .filter((reference): reference is VideoReferenceImage => Boolean(reference));
          if (!assigned.length) return null;
          return (
            <div key={scene.id} className="rounded-lg border p-2" data-testid={`scene-references-${index + 1}`}>
              <p className="mb-2 text-xs font-medium">Scene {index + 1}</p>
              <div className="flex flex-wrap gap-2">
                {assigned.map((reference) => (
                  <div key={reference.id} className="flex items-center gap-2 rounded-md bg-muted px-2 py-1">
                    <img
                      src={reference.previewUrl ?? `/api/storage${reference.objectPath}`}
                      alt={`${reference.label} reference`}
                      className="h-8 w-8 rounded object-contain"
                    />
                    <span className="text-xs">{reference.label}</span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}