/**
 * Native adapter: approval-state checks, picker metadata and generate-request
 * assembly stay here. Platform-neutral director rules have one shared owner.
 */
export * from "@workspace/video-director";
import {
  buildDirectedVideoPayload,
  directedCastRestriction,
  type DirectedBrandOptions,
  type DirectedDraft,
} from "@workspace/video-director";
import type { DirectedVideoInputEnding, VideoGenerateRequest } from "@workspace/api-client-react";

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