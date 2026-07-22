import { ObjectStorageService } from "./objectStorage";

const objectStorageService = new ObjectStorageService();

/**
 * PUT a server-generated buffer into the tenant's workspace storage and
 * return its /objects/<tenantId>/uploads/<uuid> path. Same shape as the
 * inline helpers in routes/ai.ts and videoGen/jobRunner.ts, shared so new
 * server-side producers (characters, keyframes) don't grow more copies.
 */
export async function uploadBufferToStorage(
  tenantId: number,
  bytes: Buffer,
  contentType: string,
): Promise<string> {
  const uploadURL = await objectStorageService.getObjectEntityUploadURL(tenantId);
  const putRes = await fetch(uploadURL, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: new Uint8Array(bytes),
    signal: AbortSignal.timeout(60_000),
  });
  if (!putRes.ok) {
    throw new Error(`Storage upload failed with status ${putRes.status}`);
  }
  return objectStorageService.normalizeObjectEntityPath(uploadURL);
}
