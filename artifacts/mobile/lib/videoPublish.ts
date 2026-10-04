import type { ContentItem, VideoPublishMetadata, VideoPublishResult } from "@workspace/api-client-react";

export const destinations = ["instagram", "facebook", "youtube"] as const;
export const destinationLabels = { instagram: "Instagram Reel", facebook: "Facebook Reel", youtube: "YouTube" };
export const isVideoContent = (item: Pick<ContentItem, "videoPath" | "videoPublishMetadata" | "contentType">) =>
  !!(item.videoPath || item.videoPublishMetadata || item.contentType === "video" || item.contentType === "reel");
export const activeVideoStates = new Set(["queued", "creating", "uploading", "processing", "committing"]);

export function videoOutcome(row: VideoPublishResult): string {
  if (row.state === "published") return "Published — the platform confirmed this upload.";
  if (row.state === "attention") return "Needs attention — the outcome is unclear. Check the destination before doing anything. Do not upload again.";
  if (row.state === "failed") return "Failed — this upload cannot be resubmitted. Check the destination, correct the video, and save a new Library item.";
  if (row.error) return "Paused — reconnect the account in KOKAO on the web. The existing upload resumes automatically; do not create another.";
  if (activeVideoStates.has(row.state)) return `${row.state[0]!.toUpperCase()}${row.state.slice(1)} — not confirmed published yet.`;
  return "Status not confirmed. Refresh before taking another action.";
}

export function initialVideoMetadata(item: ContentItem): VideoPublishMetadata {
  const saved = item.videoPublishMetadata;
  const destination = saved?.destination ?? (destinations.includes(item.platform as typeof destinations[number]) ? item.platform as typeof destinations[number] : "instagram");
  return {
    destination, format: destination === "youtube" ? "video" : "reel",
    privacy: destination === "youtube" ? (saved?.privacy ?? "private") : "public",
    madeForKids: destination === "youtube" ? (saved?.madeForKids ?? false) : false,
    title: item.title, description: item.caption ?? "",
  };
}

// Count code points in native Hermes too; do not depend on TextEncoder.
export function utf8Length(value: string): number {
  return Array.from(value).reduce((n, ch) => {
    const point = ch.codePointAt(0)!;
    return n + (point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4);
  }, 0);
}

export function videoMetadataErrors(meta: VideoPublishMetadata, privacyChosen: boolean, audienceChosen: boolean): string[] {
  const errors: string[] = [];
  if (!meta.title.trim()) errors.push("Add a title.");
  if (meta.title.trim().length > (meta.destination === "youtube" ? 100 : 200)) errors.push("The title is too long for this destination.");
  if (meta.destination === "youtube") {
    if (!privacyChosen) errors.push("Choose a privacy setting.");
    if (!audienceChosen) errors.push("Choose whether this video is made for kids.");
    if (utf8Length(meta.description) > 5000) errors.push("YouTube descriptions must be 5,000 UTF-8 bytes or fewer.");
    if (/[<>]/.test(meta.title + meta.description)) errors.push("YouTube does not allow < or > in the copy.");
  } else if (meta.description.length > (meta.destination === "instagram" ? 2200 : 5000)) {
    errors.push("The caption is too long for this destination.");
  }
  return errors;
}