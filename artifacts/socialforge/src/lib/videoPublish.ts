import type { VideoPublishMetadata, VideoPublishResult } from "@workspace/api-client-react";

export type VideoDestination = VideoPublishMetadata["destination"];

export const VIDEO_DESTINATIONS: VideoDestination[] = ["instagram", "facebook", "youtube"];

export const VIDEO_DESTINATION_LABELS: Record<VideoDestination, string> = {
  instagram: "Instagram Reel",
  facebook: "Facebook Reel",
  youtube: "YouTube",
};

export const YOUTUBE_TITLE_MAX = 100;
export const YOUTUBE_DESCRIPTION_MAX = 5000;
export const META_CAPTION_MAX: Record<"instagram" | "facebook", number> = { instagram: 2200, facebook: 5000 };

/** Exact destination requirements, shown before anything is submitted. */
export const VIDEO_DESTINATION_SPECS: Record<VideoDestination, string[]> = {
  facebook: [
    "Public Reel only. Facebook video posts and private or unlisted Reels are not supported.",
    "Vertical 9:16, at least 540x960.",
    "3 to 90 seconds, 24 to 60 fps.",
  ],
  instagram: [
    "Reel, 3 to 900 seconds, 300 MB or smaller.",
    "H.264 or HEVC video with AAC audio, 23 to 60 fps.",
  ],
  youtube: [
    "Title up to 100 characters, description up to 5,000 bytes (UTF-8).",
    "You must choose the audience (made for kids or not) and the privacy.",
    "Altered or synthetic content is always disclosed to YouTube for AI-generated videos.",
    "Square or vertical videos up to 3 minutes may be eligible to appear as Shorts. Eligibility is decided by YouTube and is not guaranteed.",
    "Until this app passes Google's API audit, YouTube may lock uploads to Private regardless of the privacy you pick.",
  ],
};

export const VIDEO_PUBLISH_STATE_LABELS: Record<string, string> = {
  queued: "Queued",
  creating: "Creating",
  uploading: "Uploading",
  processing: "Processing",
  committing: "Finishing",
  published: "Published",
  failed: "Failed",
  attention: "Needs attention",
};

export const ACTIVE_VIDEO_STATES = new Set(["queued", "creating", "uploading", "processing", "committing"]);

export function isActiveVideoState(state: string) {
  return ACTIVE_VIDEO_STATES.has(state);
}

/**
 * Outcomes are immutable per item+platform once enqueued: published, active
 * and ambiguous ("attention") destinations can never be submitted again.
 * A definitive "failed" upload cannot be resubmitted either (the platform
 * rejects or expires the same IDs); the user must fix the media and create a
 * new Library item.
 */
export const VIDEO_FAILED_GUIDANCE =
  "This upload failed and cannot be resubmitted. Check the destination's requirements, correct the video, and save it as a new Library item to publish again.";

export function canSubmitVideoDestination(
  destination: string,
  publishes: VideoPublishResult[] | undefined,
): { allowed: boolean; reason?: string } {
  const existing = (publishes ?? []).find((p) => p.platform === destination);
  if (!existing) return { allowed: true };
  if (existing.state === "failed")
    return {
      allowed: false,
      reason: VIDEO_FAILED_GUIDANCE,
    };
  if (existing.state === "published") return { allowed: false, reason: "Already published to this destination." };
  if (existing.state === "attention")
    return {
      allowed: false,
      reason: "The outcome is unclear. Check the platform before doing anything. It will never be resubmitted automatically.",
    };
  if (existing.error)
    return {
      allowed: false,
      reason: `Paused: ${existing.error} It resumes automatically after you reconnect the account on the Accounts page.`,
    };
  return { allowed: false, reason: "Already in progress for this destination." };
}

export function defaultVideoMetadata(
  destination: VideoDestination,
  title: string,
  description: string,
): VideoPublishMetadata {
  return {
    destination,
    format: destination === "youtube" ? "video" : "reel",
    title: title.slice(0, destination === "youtube" ? YOUTUBE_TITLE_MAX : 200),
    description,
    privacy: destination === "youtube" ? "private" : "public",
    madeForKids: false,
  };
}

/** Normalizes a draft so it can only express what the destination supports. */
export function normalizeForDestination(meta: VideoPublishMetadata): VideoPublishMetadata {
  if (meta.destination === "facebook") return { ...meta, format: "reel", privacy: "public", madeForKids: false };
  if (meta.destination === "instagram") return { ...meta, format: "reel", privacy: "public", madeForKids: false };
  return meta;
}

export function utf8Bytes(text: string) {
  return new TextEncoder().encode(text).length;
}

/** Returns blocking validation errors; empty means the draft is reviewable. */
export function validateVideoMetadata(
  meta: VideoPublishMetadata,
  opts: { audienceChosen: boolean; privacyChosen: boolean },
): string[] {
  const errors: string[] = [];
  const title = meta.title.trim();
  if (!title) errors.push("Add a title.");
  if (meta.destination === "youtube") {
    if (title.length > YOUTUBE_TITLE_MAX) errors.push(`YouTube titles must be ${YOUTUBE_TITLE_MAX} characters or fewer.`);
    if (utf8Bytes(meta.description) > YOUTUBE_DESCRIPTION_MAX)
      errors.push(`YouTube descriptions must be ${YOUTUBE_DESCRIPTION_MAX.toLocaleString()} bytes or fewer (UTF-8; non-Latin characters and emoji count as several).`);
    if (/[<>]/.test(meta.title) || /[<>]/.test(meta.description)) errors.push("YouTube does not allow < or > in titles or descriptions.");
    if (!opts.audienceChosen) errors.push("Choose whether this video is made for kids.");
    if (!opts.privacyChosen) errors.push("Choose a privacy setting.");
    if (meta.format !== "video") errors.push("YouTube uploads use the video format.");
  } else {
    if (meta.format !== "reel") errors.push("Only Reels are supported for this destination.");
    if (meta.privacy !== "public") errors.push("Only public Reels are supported for this destination.");
    if (meta.description.length > META_CAPTION_MAX[meta.destination])
      errors.push(`Caption must be ${META_CAPTION_MAX[meta.destination].toLocaleString()} characters or fewer.`);
  }
  return errors;
}

export function sameVideoMetadata(a: VideoPublishMetadata | null | undefined, b: VideoPublishMetadata | null | undefined) {
  if (!a || !b) return false;
  return (
    a.destination === b.destination &&
    a.format === b.format &&
    a.title === b.title &&
    a.description === b.description &&
    a.privacy === b.privacy &&
    a.madeForKids === b.madeForKids
  );
}

/** Destinations a video can go to. Everything else is blocked for videos. */
export function isSupportedVideoDestination(platform: string | null | undefined): platform is VideoDestination {
  return !!platform && (VIDEO_DESTINATIONS as string[]).includes(platform);
}
