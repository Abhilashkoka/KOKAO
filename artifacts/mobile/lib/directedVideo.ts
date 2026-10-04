/**
 * Mobile mirror of artifacts/socialforge/src/components/directed-video.ts.
 * Pure helpers only (no React Native or native module imports) so they can be
 * unit-tested directly. Export names intentionally match the web module.
 */
import type {
  BrandKitDetail,
  DirectedVideoInput,
  DirectedVideoInputBrandImage,
  DirectedVideoInputEnding,
  VideoGenerateRequest,
} from "@workspace/api-client-react";

/** First release: only the Atlas Wan 3.0 Standard/Prime pair can be directed. */
export const DIRECTED_MODEL_IDS = {
  text: [
    "atlascloud-wan-3.0-text-to-video",
    "atlascloud-wan-3.0-prime-text-to-video",
  ],
  /** Saved/preset cast: approved sheet + outfit go straight in as references. */
  reference: [
    "atlascloud-wan-3.0-reference",
    "atlascloud-wan-3.0-prime-reference",
  ],
} as const;

export function isDirectedCompatibleModel(id: string, hasSelectedCast: boolean): boolean {
  return (
    DIRECTED_MODEL_IDS[hasSelectedCast ? "reference" : "text"] as readonly string[]
  ).includes(id);
}

/** Compatible catalog entries, in catalog order. */
export function directedCompatibleModels<T extends { id: string }>(
  models: readonly T[] | null | undefined,
  hasSelectedCast: boolean,
): T[] {
  return (models ?? []).filter((m) => isDirectedCompatibleModel(m.id, hasSelectedCast));
}

/**
 * Keeps the current duration when the model supports it; otherwise the
 * nearest supported one. Returns the current value when no model is chosen.
 */
export function directedDurationFor(
  durations: readonly number[] | null | undefined,
  current: number,
): number {
  if (!durations || durations.length === 0 || durations.includes(current)) return current;
  return durations.reduce((best, d) =>
    Math.abs(d - current) < Math.abs(best - current) ? d : best,
  );
}

/** Provider-verified identities cannot be transferred to a different provider. */
export function directedCastRestriction(
  character:
    | { identityId?: number | null; provenanceStatus?: string | null }
    | null
    | undefined,
): string | null {
  if (!character) return null;
  if (character.identityId != null)
    return "KOKAO direction does not support verified-identity characters yet. Pick a fictional or preset character, or turn direction off.";
  return null;
}

type SavedCastLike = {
  identityId?: number | null;
  referenceSheetStatus?: string | null;
  outfits?: readonly { id: number; status?: string | null; isDefault?: boolean; identityVerified?: boolean }[] | null;
};

/**
 * Consumes existing reference-sheet and outfit approval states (it never
 * edits them). Approval itself happens in the existing character flows.
 */
export function directedCastReadiness(character: SavedCastLike | null | undefined): string | null {
  if (!character) return null;
  const restriction = directedCastRestriction(character);
  if (restriction) return restriction;
  if (character.referenceSheetStatus !== "approved")
    return "This character's reference sheet is not approved yet. Approve it first, or pick another character.";
  if (!directedApprovedOutfitId(character))
    return "This character has no approved outfit yet. Approve one first, or pick another character.";
  return null;
}

/** Default approved outfit first, else the first approved one. */
export function directedApprovedOutfitId(character: SavedCastLike | null | undefined): number | null {
  const approved = (character?.outfits ?? []).filter((o) => o.status === "approved" && o.identityVerified === true);
  return (approved.find((o) => o.isDefault) ?? approved[0])?.id ?? null;
}

export const DIRECTED_MAX_ASSETS = 3;
export const DIRECTED_MAX_OVERLAYS = 5;
export const DIRECTED_OVERLAY_MAX_CHARS = 160;
export const DIRECTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
export const DIRECTED_VIDEO_TYPES = ["video/mp4", "video/webm"];
export const DIRECTED_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const DIRECTED_VIDEO_MAX_BYTES = 40 * 1024 * 1024;

export type DirectedAssetDraft = {
  key: string;
  name: string;
  kind: "image" | "video";
  status: "uploading" | "ready" | "failed";
  error?: string;
  objectPath: string | null;
  startSec: number;
  endSec: number;
  placement: "full_frame" | "corner";
};

export type DirectedOverlayDraft = {
  key: string;
  text: string;
  startSec: number;
  endSec: number;
};

export type DirectedDraft = {
  enabled: boolean;
  brandingInstructions: string;
  fictionalCharacter: string;
  ending: DirectedVideoInputEnding;
  brandImage: DirectedVideoInputBrandImage;
  assets: DirectedAssetDraft[];
  overlays: DirectedOverlayDraft[];
};

export function emptyDirectedDraft(): DirectedDraft {
  return {
    enabled: false,
    brandingInstructions: "",
    fictionalCharacter: "",
    ending: "none",
    brandImage: "none",
    assets: [],
    overlays: [],
  };
}

/** Infers a MIME type from a filename when the picker gives none. */
export function directedMimeFromName(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    mp4: "video/mp4",
    webm: "video/webm",
  };
  return map[ext] ?? "";
}

/** Returns an error string for an unacceptable file, or the asset kind. */
export function classifyDirectedFile(
  file: { type: string; size: number },
): { kind: "image" | "video" } | { error: string } {
  if (DIRECTED_IMAGE_TYPES.includes(file.type)) {
    return file.size > DIRECTED_IMAGE_MAX_BYTES
      ? { error: "Images must be 10 MB or smaller." }
      : { kind: "image" };
  }
  if (DIRECTED_VIDEO_TYPES.includes(file.type)) {
    return file.size > DIRECTED_VIDEO_MAX_BYTES
      ? { error: "Recordings must be 40 MB or smaller." }
      : { kind: "video" };
  }
  return { error: "Use PNG, JPEG, WebP, MP4 or WebM." };
}

export type DirectedBrandOptions = {
  logos: { primary: boolean; secondary: boolean; icon_mark: boolean };
  animation: { available: boolean; durationSec: number | null };
};

export function directedBrandOptions(
  kit: BrandKitDetail | null | undefined,
): DirectedBrandOptions {
  const payload = kit?.activeVersion?.payload;
  const logos = payload?.logos;
  const outro = payload?.video_outro ?? null;
  return {
    logos: {
      primary: !!logos?.primary?.url,
      secondary: !!logos?.secondary?.url,
      icon_mark: !!logos?.icon_mark?.url,
    },
    animation: {
      available: !!outro?.enabled,
      durationSec: outro?.duration_seconds ?? null,
    },
  };
}

/** Disclosure copy for the appended ending, or null for "none". */
export function directedEndingDisclosure(
  ending: DirectedVideoInputEnding,
  brand: DirectedBrandOptions,
  durationSec: number,
): string | null {
  if (ending === "none") return null;
  const adds =
    ending === "animation" && brand.animation.durationSec
      ? `${brand.animation.durationSec} seconds`
      : "2 to 5 seconds";
  return `Appended after the clip; adds ${adds} to the ${durationSec}s video.`;
}

export const DIRECTED_RECORDING_AUDIO_NOTICE =
  "Uploaded recording audio is not used; short recordings hold their final frame.";

/** Parses a seconds text field; empty or invalid becomes NaN. */
export function parseDirectedSeconds(v: string): number {
  const t = v.trim().replace(",", ".");
  return t === "" ? Number.NaN : Number(t);
}

function windowError(label: string, start: number, end: number, durationSec: number): string | null {
  if (!Number.isFinite(start) || !Number.isFinite(end))
    return `${label}: enter start and end seconds.`;
  if (start < 0) return `${label}: start cannot be negative.`;
  if (end - start < 0.1) return `${label}: end must be after start.`;
  if (end > durationSec) return `${label}: end must be within the ${durationSec}s video.`;
  return null;
}

/** Why the directed request cannot be sent, or null when it is valid. */
export function directedBlockReason(
  draft: DirectedDraft,
  ctx: {
    durationSec: number;
    hasCompatibleModel: boolean;
    castRestriction?: string | null;
    modelSelected: boolean;
    brandKitId: number | null;
    brand: DirectedBrandOptions;
  },
): string | null {
  if (!draft.enabled) return null;
  if (ctx.castRestriction) return ctx.castRestriction;
  if (!ctx.hasCompatibleModel)
    return "KOKAO direction needs Atlas Wan 3.0 Standard or Prime (text-to-video without a cast, reference with a saved cast), which is not configured. Ask an admin to enable it, or turn direction off.";
  if (!ctx.modelSelected) return "Choose Wan 3.0 Standard or Prime for a directed video.";
  if (draft.assets.length > DIRECTED_MAX_ASSETS) return "Use at most 3 assets.";
  if (draft.overlays.length > DIRECTED_MAX_OVERLAYS) return "Use at most 5 text overlays.";
  if (draft.ending !== "none" || draft.brandImage !== "none") {
    if (ctx.brandKitId === null) return "Pick a brand kit to use its logo or ending.";
    if (draft.ending === "logo" && !ctx.brand.logos.primary)
      return "This brand kit has no primary logo for a logo ending.";
    if (draft.ending === "animation" && !ctx.brand.animation.available)
      return "This brand kit has no logo animation enabled.";
    if (draft.brandImage !== "none" && !ctx.brand.logos[draft.brandImage])
      return "The chosen brand image is not in this brand kit.";
  }
  for (const [i, a] of draft.assets.entries()) {
    const label = `Asset ${i + 1} (${a.name})`;
    if (a.status === "uploading") return `${label} is still uploading.`;
    if (a.status === "failed" || !a.objectPath)
      return `${label} failed to upload. Retry or remove it.`;
    const err = windowError(label, a.startSec, a.endSec, ctx.durationSec);
    if (err) return err;
  }
  for (const [i, o] of draft.overlays.entries()) {
    const label = `Text ${i + 1}`;
    if (!o.text.trim()) return `${label}: enter the exact text or remove it.`;
    if (o.text.trim().length > DIRECTED_OVERLAY_MAX_CHARS)
      return `${label}: keep it to ${DIRECTED_OVERLAY_MAX_CHARS} characters.`;
    const err = windowError(label, o.startSec, o.endSec, ctx.durationSec);
    if (err) return err;
  }
  return null;
}

/** Builds the request object. Saved cast means no fictional description. */
export function buildDirectedVideoPayload(
  draft: DirectedDraft,
  opts: { hasSelectedCast: boolean },
): DirectedVideoInput | null {
  if (!draft.enabled) return null;
  const out: DirectedVideoInput = {
    ending: draft.ending,
    brandImage: draft.brandImage,
    assets: draft.assets.map((a) => ({
      objectPath: a.objectPath ?? "",
      startSec: a.startSec,
      endSec: a.endSec,
      placement: a.placement,
    })),
    overlays: draft.overlays.map((o) => ({
      text: o.text.trim(),
      startSec: o.startSec,
      endSec: o.endSec,
    })),
  };
  const branding = draft.brandingInstructions.trim();
  if (branding) out.brandingInstructions = branding;
  const fictional = draft.fictionalCharacter.trim();
  if (!opts.hasSelectedCast && fictional) out.fictionalCharacter = fictional;
  return out;
}

export type DirectedCastSelection =
  | { kind: "none" }
  | { kind: "saved"; characterId: number; outfitId: number | null }
  | { kind: "preset"; presetCharacterId: string };

/**
 * Full generate request for a directed text-to-video job: one generation
 * (shotCount 1), no storyboard review, the pinned compatible model.
 */
export function buildDirectedGenerateRequest(opts: {
  prompt: string;
  draft: DirectedDraft;
  modelId: string;
  durationSec: number;
  cast: DirectedCastSelection;
  brandKitId: number | null;
  canGenerateAudio: boolean;
}): VideoGenerateRequest {
  const hasSelectedCast = opts.cast.kind !== "none";
  const req: VideoGenerateRequest = {
    engine: "text_to_video",
    prompt: opts.prompt.trim(),
    modelId: opts.modelId,
    durationSec: opts.durationSec,
    shotCount: 1,
    reviewStoryboard: false,
    characterId: opts.cast.kind === "saved" ? opts.cast.characterId : null,
    outfitId: opts.cast.kind === "saved" ? opts.cast.outfitId : null,
    presetCharacterId: opts.cast.kind === "preset" ? opts.cast.presetCharacterId : null,
    brandKitId: opts.brandKitId,
    generateAudio: opts.canGenerateAudio ? true : null,
  };
  const directed = buildDirectedVideoPayload(opts.draft, { hasSelectedCast });
  if (directed) req.directedVideo = directed;
  return req;
}
