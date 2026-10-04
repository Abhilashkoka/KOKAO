import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import type { videoPublishesTable } from "@workspace/db";
import { encryptJson, decryptJson } from "./secretCrypto";
import { ObjectStorageService } from "./objectStorage";
import { GRAPH_BASE } from "./metaApi";
import { platformFetch } from "./platformFetch";
import { stageVideo } from "./videoPublishMedia";

export type VideoUpload = typeof videoPublishesTable.$inferSelect;
export type SaveUpload = (patch: Partial<VideoUpload>) => Promise<void>;
export class VideoPermissionError extends Error {}
export class VideoDefinitiveError extends Error {}
export class VideoAmbiguousError extends Error {}

/** Support probes are GET-only. Never call a driver here: drivers can commit uploads. */
export async function inspectVideoUpload(row: VideoUpload, token: string): Promise<"published" | "failed" | "unresolved"> {
  const id = row.externalId ?? (row.platform === "instagram" ? row.containerId : null);
  if (!id) return "unresolved";
  const headers = { Authorization: `Bearer ${token}` };
  if (row.platform === "youtube") {
    const data = await json(await platformFetch(`https://www.googleapis.com/youtube/v3/videos?part=status,processingDetails&id=${encodeURIComponent(id)}`, { headers, redirect: "error" }));
    const video = data.items?.find((item: any) => item.id === id);
    if (!video) return "unresolved";
    if (["failed", "terminated"].includes(video.processingDetails?.processingStatus) || ["failed", "rejected", "deleted"].includes(video.status?.uploadStatus)) return "failed";
    return video.processingDetails?.processingStatus === "succeeded" || video.status?.uploadStatus === "processed" ? "published" : "unresolved";
  }
  const fields = row.platform === "facebook" ? "status" : row.externalId ? "id" : "status_code";
  const data = await json(await platformFetch(`${GRAPH_BASE}/${encodeURIComponent(id)}?fields=${fields}`, { headers, redirect: "error" }));
  if (row.platform === "instagram") {
    if (row.externalId ? data.id === id : data.status_code === "PUBLISHED") return "published";
    return ["ERROR", "EXPIRED"].includes(data.status_code) ? "failed" : "unresolved";
  }
  const status = data.status;
  if (status?.publishing_phase?.status === "completed" || status?.publishing_phase?.publish_status === "published") return "published";
  return ["error", "expired", "upload_failed"].includes(status?.video_status) || [status?.processing_phase, status?.publishing_phase, status?.uploading_phase].some(p => p?.status === "error") ? "failed" : "unresolved";
}

async function json(response: Response, permissionRejected?: () => Promise<void>): Promise<any> {
  const body: any = await response.json().catch(() => ({}));
  const code = Number(body.error?.code);
  if (response.status === 401 || response.status === 403 || code === 190 || code === 10 || (code >= 200 && code <= 299)) {
    // This response proves this write was rejected, unlike a transport timeout.
    // Only the dispatching call supplies a rollback checkpoint.
    if (permissionRejected) await permissionRejected();
    throw new VideoPermissionError("The platform rejected publishing access. Reconnect on Accounts and grant publishing permissions.");
  }
  if (!response.ok || body.error) {
    if (response.status >= 500 || response.status === 429) throw new Error("The platform is temporarily unavailable. The existing upload will be checked again.");
    throw new VideoDefinitiveError("The platform rejected the upload or media settings. Check video requirements and account restrictions before retrying.");
  }
  return body;
}

/** Never send credentials to an arbitrary Location or provider-returned upload host. */
export function validateYoutubeSession(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "www.googleapis.com" || url.port || url.username || url.password || url.pathname !== "/upload/youtube/v3/videos") throw new VideoDefinitiveError("YouTube returned an unsupported upload destination.");
  return url.toString();
}

export function youtubeResumeOffset(response: Response, size: number): number {
  const range = response.headers.get("range");
  if (!range) return 0;
  const match = /^bytes=0-(\d+)$/.exec(range);
  const offset = match ? Number(match[1]) + 1 : NaN;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > size) throw new VideoDefinitiveError("YouTube returned an invalid upload offset.");
  return offset;
}

export async function driveYoutube(row: VideoUpload, token: string, save: SaveUpload) {
  const headers = { Authorization: `Bearer ${token}` };
  if (row.externalId) {
    const data = await json(await platformFetch(`https://www.googleapis.com/youtube/v3/videos?part=status,processingDetails&id=${encodeURIComponent(row.externalId)}`, { headers }));
    const video = data.items?.[0];
    if (!video) throw new VideoPermissionError("The uploaded YouTube video is no longer accessible. Check YouTube Studio and reconnect if needed.");
    if (["failed", "terminated"].includes(video.processingDetails?.processingStatus) || ["failed", "rejected", "deleted"].includes(video.status?.uploadStatus)) throw new VideoDefinitiveError("YouTube could not process this video. Review rejection details in YouTube Studio.");
    if (video.processingDetails?.processingStatus === "succeeded" || video.status?.uploadStatus === "processed") {
      await save({ state: "published", permalink: `https://www.youtube.com/watch?v=${encodeURIComponent(row.externalId)}`, error: video.status?.privacyStatus !== row.metadata.privacy ? `YouTube applied ${video.status?.privacyStatus ?? "different"} visibility. Check API-project audit restrictions in YouTube Studio.` : null });
    } else await save({ state: "processing" });
    return;
  }
  if (row.state === "creating" && !row.encryptedSession) throw new VideoAmbiguousError("Upload initialization was interrupted. Check YouTube Studio before creating a new Library item; automatic resubmission is blocked.");
  const media = await stageVideo(row.videoPath, row.tenantId, "youtube");
  try {
    let session: string;
    if (!row.encryptedSession) {
      await save({ state: "creating" });
      const response = await platformFetch("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", {
        method: "POST", redirect: "error",
        headers: { ...headers, "Content-Type": "application/json", "X-Upload-Content-Length": String(media.size), "X-Upload-Content-Type": "video/mp4" },
        body: JSON.stringify({ snippet: { title: row.metadata.title, description: row.metadata.description, categoryId: "22" }, status: { privacyStatus: row.metadata.privacy, selfDeclaredMadeForKids: row.metadata.madeForKids, containsSyntheticMedia: true } }),
      });
      if (!response.ok) await json(response, () => save({ state: "queued" }));
      const location = response.headers.get("location");
      if (!location) throw new VideoAmbiguousError("YouTube accepted initialization without an upload URL. Check YouTube Studio; automatic resubmission is blocked.");
      session = validateYoutubeSession(location);
      await save({ state: "uploading", encryptedSession: encryptJson({ url: session, size: media.size }) });
    } else {
      const stored = decryptJson<{ url: string; size: number }>(row.encryptedSession);
      if (stored.size !== media.size) throw new VideoDefinitiveError("The source video changed. This upload cannot be resumed.");
      session = validateYoutubeSession(stored.url);
    }
    // Always ask the server for its committed byte offset, including after a lost final response.
    let response = await platformFetch(session, { method: "PUT", redirect: "manual", headers: { ...headers, "Content-Length": "0", "Content-Range": `bytes */${media.size}` } });
    if (response.status === 404 || response.status === 410) throw new VideoAmbiguousError("The resumable upload expired. Check YouTube Studio for an existing video before creating a new Library item.");
    for (let chunk = 0; response.status === 308 && chunk < 8; chunk++) {
      const start = youtubeResumeOffset(response, media.size);
      if (start === media.size) return;
      const end = Math.min(start + 4 * 1024 * 1024, media.size);
      const file = await open(media.localPath, "r");
      const buffer = Buffer.alloc(end - start);
      try { await file.read(buffer, 0, buffer.length, start); } finally { await file.close(); }
      response = await platformFetch(session, { method: "PUT", redirect: "manual", headers: { ...headers, "Content-Type": "video/mp4", "Content-Length": String(buffer.length), "Content-Range": `bytes ${start}-${end - 1}/${media.size}` }, body: new Uint8Array(buffer) }, 60_000);
      await save({ state: "uploading" });
    }
    if (response.status === 308) return;
    const result = await json(response);
    if (!result.id) throw new VideoAmbiguousError("YouTube completed the upload without a video ID. Check YouTube Studio before submitting again.");
    await save({ externalId: result.id, state: "processing" });
  } finally { await media.cleanup(); }
}

export async function driveInstagram(row: VideoUpload, token: string, accountId: string, save: SaveUpload) {
  const headers = { Authorization: `Bearer ${token}` };
  if (!row.containerId) {
    if (row.state === "creating") throw new VideoAmbiguousError("Instagram upload initialization was interrupted. Automatic resubmission is blocked to prevent duplicates.");
    const media = await stageVideo(row.videoPath, row.tenantId, "instagram");
    await media.cleanup();
    const url = await new ObjectStorageService().getSignedDownloadURL(row.videoPath, row.tenantId, 3600);
    await save({ state: "creating" });
    const data = await json(await platformFetch(`${GRAPH_BASE}/${encodeURIComponent(accountId)}/media`, {
      method: "POST", headers, body: new URLSearchParams({ media_type: "REELS", video_url: url, caption: row.metadata.description, share_to_feed: "true" }),
    }), () => save({ state: "queued" }));
    if (!data.id) throw new VideoAmbiguousError("Instagram did not return a container ID. Check the account before resubmitting.");
    await save({ containerId: data.id, state: "processing" });
    return;
  }
  if (row.externalId) {
    const data = await json(await platformFetch(`${GRAPH_BASE}/${encodeURIComponent(row.externalId)}?fields=permalink`, { headers }));
    await save({ state: "published", permalink: data.permalink ?? null });
    return;
  }
  const status = await json(await platformFetch(`${GRAPH_BASE}/${encodeURIComponent(row.containerId)}?fields=status_code`, { headers }));
  if (status.status_code === "PUBLISHED") {
    // Exact container confirmation is authoritative even if the media ID response was lost.
    await save({ state: "published" });
    return;
  }
  if (["ERROR", "EXPIRED"].includes(status.status_code)) throw new VideoDefinitiveError("Instagram rejected or expired this Reel. Check the media requirements and account restrictions.");
  if (row.state === "committing") {
    // Do not blindly repeat a non-idempotent media_publish after an ambiguous response.
    if (Date.now() - row.updatedAt.getTime() > 10 * 60_000) throw new VideoAmbiguousError("Instagram publication could not be confirmed. Check your profile before creating another upload.");
    return;
  }
  if (status.status_code !== "FINISHED") return;
  await save({ state: "committing" });
  const published = await json(await platformFetch(`${GRAPH_BASE}/${encodeURIComponent(accountId)}/media_publish`, { method: "POST", headers, body: new URLSearchParams({ creation_id: row.containerId }) }), () => save({ state: "processing" }));
  if (!published.id) throw new VideoAmbiguousError("Instagram publication needs confirmation. Check your profile before resubmitting.");
  await save({ externalId: published.id, state: "processing" });
}

export async function driveFacebook(row: VideoUpload, token: string, accountId: string, save: SaveUpload) {
  const headers = { Authorization: `Bearer ${token}` };
  if (!row.externalId) {
    if (row.state === "creating") throw new VideoAmbiguousError("Facebook initialization was interrupted. Check your Page; automatic resubmission is blocked.");
    const media = await stageVideo(row.videoPath, row.tenantId, "facebook");
    await media.cleanup();
    await save({ state: "creating" });
    const data = await json(await platformFetch(`${GRAPH_BASE}/${encodeURIComponent(accountId)}/video_reels`, { method: "POST", headers, body: new URLSearchParams({ upload_phase: "start" }) }), () => save({ state: "queued" }));
    if (!data.video_id || !/^\d+$/.test(String(data.video_id))) throw new VideoAmbiguousError("Facebook did not return a valid video ID. Check your Page before resubmitting.");
    await save({ externalId: String(data.video_id), state: "uploading" });
    return;
  }
  const data = await json(await platformFetch(`${GRAPH_BASE}/${encodeURIComponent(row.externalId)}?fields=status`, { headers }));
  const status = data.status;
  if (!status) throw new Error("Facebook has not returned upload status yet.");
  if (status.publishing_phase?.status === "completed" || status.publishing_phase?.publish_status === "published") {
    await save({ state: "published", permalink: `https://www.facebook.com/reel/${encodeURIComponent(row.externalId)}` });
    return;
  }
  if (["error", "expired", "upload_failed"].includes(status.video_status) || [status.processing_phase, status.publishing_phase, status.uploading_phase].some(phase => phase?.status === "error")) throw new VideoDefinitiveError("Facebook could not process this Reel. Review the video requirements and Page restrictions.");
  if (row.state === "committing") {
    if (Date.now() - row.updatedAt.getTime() > 10 * 60_000) throw new VideoAmbiguousError("Facebook publication could not be confirmed. Check your Page before creating another upload.");
    return;
  }
  if (!["completed", "complete"].includes(status.uploading_phase?.status)) {
    const media = await stageVideo(row.videoPath, row.tenantId, "facebook");
    try {
      const offset = Number(status.uploading_phase?.bytes_transfered ?? 0);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > media.size) throw new VideoDefinitiveError("Facebook returned an invalid upload offset.");
      if (offset === media.size) return;
      // Fixed provider host; no credentials ever follow an arbitrary returned URL.
      const body = createReadStream(media.localPath, { start: offset });
      try {
        await json(await platformFetch(`https://rupload.facebook.com/video-upload/v21.0/${row.externalId}`, {
          method: "POST", redirect: "error", headers: { Authorization: `OAuth ${token}`, offset: String(offset), file_size: String(media.size), "Content-Type": "application/octet-stream" },
          body: body as unknown as RequestInit["body"], duplex: "half",
        } as RequestInit, 120_000));
      } finally { body.destroy(); }
      await save({ state: "processing" });
    } finally { await media.cleanup(); }
    return;
  }
  if (status.processing_phase?.status !== "completed" && status.video_status !== "ready") return;
  await save({ state: "committing" });
  await json(await platformFetch(`${GRAPH_BASE}/${encodeURIComponent(accountId)}/video_reels`, { method: "POST", headers, body: new URLSearchParams({ upload_phase: "finish", video_id: row.externalId, video_state: "PUBLISHED", title: row.metadata.title, description: row.metadata.description }) }), () => save({ state: "processing" }));
  // Keep committing until polling confirms actual publication.
}