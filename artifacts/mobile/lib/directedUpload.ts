/**
 * Picking and uploading directed-video assets. Native modules are imported
 * lazily so screens (and their tests) never load them until the user taps
 * "Add file".
 */
import { Platform } from "react-native";
import { directedMimeFromName } from "@/lib/directedVideo";

export type PickedDirectedFile = {
  uri: string;
  name: string;
  type: string;
  size: number;
  /** Web only: the browser File, uploaded directly. */
  file?: Blob;
};

export const DIRECTED_PICKER_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "video/mp4",
  "video/webm",
];

export async function pickDirectedFiles(limit: number): Promise<PickedDirectedFile[]> {
  if (limit <= 0) return [];
  const DocumentPicker = await import("expo-document-picker");
  const result = await DocumentPicker.getDocumentAsync({
    type: DIRECTED_PICKER_TYPES,
    multiple: limit > 1,
    copyToCacheDirectory: true,
  });
  if (result.canceled) return [];
  return result.assets.slice(0, limit).map((a) => {
    const name = a.name ?? `asset-${Date.now()}`;
    return {
      uri: a.uri,
      name,
      type: a.mimeType || directedMimeFromName(name),
      size: a.size ?? 0,
      file: (a as { file?: Blob }).file,
    };
  });
}

const UPLOAD_TIMEOUT_MS = 120_000;

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let id: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    id = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (id) clearTimeout(id);
  });
}

/**
 * Uploads to a presigned URL from the generated requestUploadUrl mutation and
 * returns the /objects/... path.
 */
export async function uploadDirectedFile(
  file: PickedDirectedFile,
  requestUpload: (body: {
    name: string;
    size: number;
    contentType: string;
  }) => Promise<{ uploadURL: string; objectPath: string }>,
): Promise<string> {
  const prepared = await withTimeout(
    requestUpload({ name: file.name, size: file.size, contentType: file.type }),
    30_000,
    "Preparing the upload timed out. Retry when you have a connection.",
  );
  if (Platform.OS === "web") {
    const body = file.file ?? (await (await fetch(file.uri)).blob());
    const res = await withTimeout(
      fetch(prepared.uploadURL, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body,
      }),
      UPLOAD_TIMEOUT_MS,
      "Upload timed out. Retry when you have a connection.",
    );
    if (!res.ok) throw new Error("Upload failed. Retry or remove it.");
    return prepared.objectPath;
  }
  const FileSystem = await import("expo-file-system/legacy");
  const uploaded = await withTimeout(
    FileSystem.uploadAsync(prepared.uploadURL, file.uri, {
      httpMethod: "PUT",
      uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
      headers: { "Content-Type": file.type },
    }),
    UPLOAD_TIMEOUT_MS,
    "Upload timed out. Retry when you have a connection.",
  );
  if (uploaded.status < 200 || uploaded.status >= 300)
    throw new Error("Upload failed. Retry or remove it.");
  return prepared.objectPath;
}
