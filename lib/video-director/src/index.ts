/**
 * Client-side director rules shared by web and native clients.
 * No platform APIs or runtime API-client imports. These are UX checks only:
 * ownership, consent, approvals and provider capability remain server-authoritative.
 */
import type {
  BrandKitDetail,
  DirectedVideoInput,
  DirectedVideoInputBrandImage,
  DirectedVideoInputEnding,
} from "@workspace/api-client-react";

/** Only the Atlas Wan 3.0 Standard/Prime pair can be directed. */
export const DIRECTED_MODEL_IDS = {
  text: [
    "atlascloud-wan-3.0-text-to-video",
    "atlascloud-wan-3.0-prime-text-to-video",
  ],
  reference: [
    "atlascloud-wan-3.0-reference",
    "atlascloud-wan-3.0-prime-reference",
  ],
} as const;

export function isDirectedCompatibleModel(id: string, hasSelectedCast: boolean): boolean {
  return (DIRECTED_MODEL_IDS[hasSelectedCast ? "reference" : "text"] as readonly string[]).includes(id);
}

/** Compatible catalog entries, in catalog order. */
export function directedCompatibleModels<T extends { id: string }>(
  models: readonly T[] | null | undefined,
  hasSelectedCast: boolean,
): T[] {
  return (models ?? []).filter((m) => isDirectedCompatibleModel(m.id, hasSelectedCast));
}

/** Keep a supported duration; otherwise pick the nearest (first wins ties). */
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
  character: { identityId?: number | null; provenanceStatus?: string | null } | null | undefined,
): string | null {
  if (character?.identityId != null)
    return "KOKAO direction does not support verified-identity characters yet. Pick a fictional or preset character, or turn direction off.";
  return null;
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

/** Structural file metadata works with browser File and native picker results. */
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

export function directedBrandOptions(kit: BrandKitDetail | null | undefined): DirectedBrandOptions {
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

/** Builds the existing API contract; selected cast suppresses fictional prose. */
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