/**
 * Fetch inside the authenticated app, not through the browser's native media
 * downloader (which can lose the iframe's session-cookie context).
 */
export async function downloadVideo(
  objectPath: string,
  filename: string,
  token: string | null,
): Promise<void> {
  const segments = objectPath.split("/");
  if (
    !objectPath.startsWith("/objects/") ||
    segments.slice(2).some((part) => !part || part === "." || part === ".." || /[\\%?#\u0000-\u001f]/.test(part))
  ) {
    throw new Error("This video has an invalid storage path. Please contact support.");
  }
  const response = await fetch(`/api/storage${segments.map(encodeURIComponent).join("/")}`, {
    credentials: "include",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) {
    if (response.status === 401) throw new Error("Your session has expired. Sign in again, then retry the download.");
    if (response.status === 403) throw new Error("You do not have permission to download this video.");
    if (response.status === 404) throw new Error("This video file is no longer available. Please contact support.");
    throw new Error(`Video download failed (${response.status}). Please try again.`);
  }
  const contentType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (!contentType || (!contentType.startsWith("video/") && contentType !== "application/octet-stream")) {
    throw new Error("The server did not return a video file. Please sign in again and retry.");
  }
  const blob = await response.blob();
  if (!blob.size) throw new Error("The video file is empty. Please contact support.");
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename.replace(/[^\w.-]/g, "_").slice(0, 120) || "kokao-video.mp4";
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
    // Give the browser time to consume the Blob; never fall back to a private
    // storage URL or an asynchronous popup that can silently fail again.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}