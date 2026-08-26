import type { VideoPriceCriteria } from "@workspace/db";

/**
 * The attributes of the request that reaches a video provider.  Keep absent
 * optional controls absent: inventing a default quality/audio value would make
 * a conditional catalog row look applicable when it is not.
 */
export function videoPriceCriteria(args: {
  resolution?: string | null;
  quality?: string | null;
  generateAudio?: boolean | null;
  /** Only a source clip (not an image/end frame) is priced as video input. */
  hasReferenceVideo?: boolean;
}): VideoPriceCriteria {
  return {
    inputMode: args.hasReferenceVideo ? "video" : "non_video",
    ...(args.resolution ? { resolution: args.resolution } : {}),
    ...(args.quality ? { quality: args.quality } : {}),
    ...(args.generateAudio !== null && args.generateAudio !== undefined
      ? { generateAudio: args.generateAudio }
      : {}),
  };
}