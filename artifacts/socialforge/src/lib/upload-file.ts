import { apiErrorMessage } from "./apiErrorMessage";

/** Thrown for the browser → storage step, so the message can be shown as is. */
export class UploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadError";
  }
}

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

type RequestUrl = (vars: {
  data: { name: string; size: number; contentType: string };
}) => Promise<{ uploadURL: string; objectPath: string }>;

/**
 * Upload a file in two steps: ask the API for a signed storage URL, then PUT
 * the file there. The PUT is retried once with a fresh URL, which covers a
 * dropped connection or an expired link.
 */
export async function uploadToStorage(
  requestUrl: RequestUrl,
  file: File,
): Promise<{ objectPath: string }> {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new UploadError(
      `This file is ${(file.size / 1024 / 1024).toFixed(0)} MB. Please use one under 25 MB.`,
    );
  }
  const contentType = file.type || "application/octet-stream";
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    // Step 1 errors (API) are not retried: they carry their own message.
    const { uploadURL, objectPath } = await requestUrl({
      data: { name: file.name, size: file.size, contentType },
    });
    try {
      const put = await fetch(uploadURL, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": contentType },
      });
      if (put.ok) return { objectPath };
      lastError = new UploadError(
        put.status === 403
          ? "File storage refused the upload (403). Please try again in a moment."
          : `File storage returned an error (${put.status}). Please try again.`,
      );
    } catch {
      lastError = new UploadError(
        "The upload was interrupted. Check your internet connection and try again.",
      );
    }
  }
  throw lastError;
}

/** The message to show for a failed upload: ours as is, the API's otherwise. */
export function uploadErrorMessage(error: unknown): string {
  if (error instanceof UploadError) return error.message;
  const fromApi = apiErrorMessage(error, "");
  if (fromApi) return fromApi;
  const status = (error as { status?: number } | null)?.status;
  if (status === 401) return "Your session ended. Please refresh the page and sign in again.";
  if (error instanceof Error && error.message) return error.message;
  return "Please try again.";
}
