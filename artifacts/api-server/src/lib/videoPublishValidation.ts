import type { VideoPublishMetadata } from "@workspace/db";

export const VIDEO_DESTINATIONS = ["instagram", "facebook", "youtube"] as const;
export function validateVideoMetadata(platform: string, metadata: VideoPublishMetadata | null | undefined): string | null {
  if (!(VIDEO_DESTINATIONS as readonly string[]).includes(platform)) return "Videos can only be published to Instagram Reels, Facebook Reels or YouTube. No caption-only or thumbnail-only fallback is allowed.";
  if (!metadata || metadata.destination !== platform) return "Review and save video publishing settings for this destination in the Library first.";
  if (!metadata.title.trim() || metadata.title.length > (platform === "youtube" ? 100 : 200)) return "Enter a title within the destination's limit (YouTube: 100 characters; Meta: 200).";
  if (metadata.description.length > (platform === "instagram" ? 2200 : 5000)) return "Shorten the reviewed description (Instagram: 2,200 characters; Facebook/YouTube: 5,000).";
  if (platform === "youtube") {
    if (Buffer.byteLength(metadata.description, "utf8") > 5000) return "YouTube descriptions must be within 5,000 UTF-8 bytes; emoji and non-Latin characters can use multiple bytes.";
    if (metadata.format !== "video" || !["private", "unlisted", "public"].includes(metadata.privacy) || typeof metadata.madeForKids !== "boolean") return "Choose YouTube video privacy and whether it is made for kids.";
    if (/[<>]/.test(metadata.title + metadata.description)) return "YouTube titles and descriptions cannot contain angle brackets.";
  } else if (metadata.format !== "reel" || metadata.privacy !== "public") return "Meta video publishing supports public Reels only. Select Reel and review its public audience.";
  return null;
}