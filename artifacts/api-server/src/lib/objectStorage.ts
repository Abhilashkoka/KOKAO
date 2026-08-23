import { Storage, File } from "@google-cloud/storage";
import { Readable } from "stream";
import { randomUUID } from "crypto";

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";

export const objectStorageClient = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
    type: "external_account",
    credential_source: {
      url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
      format: {
        type: "json",
        subject_token_field_name: "access_token",
      },
    },
    universe_domain: "googleapis.com",
  },
  projectId: "",
});

export class ObjectNotFoundError extends Error {
  constructor() {
    super("Object not found");
    this.name = "ObjectNotFoundError";
    Object.setPrototypeOf(this, ObjectNotFoundError.prototype);
  }
}

export class ObjectStorageService {
  constructor() {}

  getPublicObjectSearchPaths(): Array<string> {
    const pathsStr = process.env.PUBLIC_OBJECT_SEARCH_PATHS || "";
    const paths = Array.from(
      new Set(
        pathsStr
          .split(",")
          .map((path) => path.trim())
          .filter((path) => path.length > 0)
      )
    );
    if (paths.length === 0) {
      throw new Error(
        "PUBLIC_OBJECT_SEARCH_PATHS not set. Create a bucket in 'Object Storage' " +
          "tool and set PUBLIC_OBJECT_SEARCH_PATHS env var (comma-separated paths)."
      );
    }
    return paths;
  }

  getPrivateObjectDir(): string {
    const dir = process.env.PRIVATE_OBJECT_DIR || "";
    if (!dir) {
      throw new Error(
        "PRIVATE_OBJECT_DIR not set. Create a bucket in 'Object Storage' " +
          "tool and set PRIVATE_OBJECT_DIR env var."
      );
    }
    return dir;
  }

  async searchPublicObject(filePath: string): Promise<File | null> {
    // Guard against path traversal: the caller-supplied path must resolve
    // WITHIN a configured public prefix and never climb out with "." / "..".
    const normalized = filePath.replace(/^\/+/, "");
    if (
      normalized.includes("\0") ||
      normalized.split("/").some((seg) => seg === "." || seg === "..")
    ) {
      return null;
    }
    for (const searchPath of this.getPublicObjectSearchPaths()) {
      const fullPath = `${searchPath}/${normalized}`;

      const { bucketName, objectName } = parseObjectPath(fullPath);
      const bucket = objectStorageClient.bucket(bucketName);
      const file = bucket.file(objectName);

      const [exists] = await file.exists();
      if (exists) {
        return file;
      }
    }

    return null;
  }

  async downloadObject(
    file: File,
    { isPublic = false, cacheTtlSec = 3600 }: { isPublic?: boolean; cacheTtlSec?: number } = {},
  ): Promise<Response> {
    const [metadata] = await file.getMetadata();

    const nodeStream = file.createReadStream();
    const webStream = Readable.toWeb(nodeStream) as ReadableStream;

    const headers: Record<string, string> = {
      "Content-Type": (metadata.contentType as string) || "application/octet-stream",
      "Cache-Control": `${isPublic ? "public" : "private"}, max-age=${cacheTtlSec}`,
    };
    if (metadata.size) {
      headers["Content-Length"] = String(metadata.size);
    }

    return new Response(webStream, { headers });
  }

  private async getObjectEntityUploadURLInFolder(
    tenantId: number,
    folder: string,
  ): Promise<string> {
    const privateObjectDir = this.getPrivateObjectDir();
    if (!privateObjectDir) {
      throw new Error(
        "PRIVATE_OBJECT_DIR not set. Create a bucket in 'Object Storage' " +
          "tool and set PRIVATE_OBJECT_DIR env var."
      );
    }

    const objectId = randomUUID();
    // Namespace every object under its owning tenant so a stored/guessed path is
    // self-authenticating: reads assert the requested path starts with the
    // caller's own `/objects/<tenantId>/` prefix (see getObjectEntityFile).
    const fullPath = `${privateObjectDir}/${tenantId}/${folder}/${objectId}`;

    const { bucketName, objectName } = parseObjectPath(fullPath);

    return signObjectURL({
      bucketName,
      objectName,
      method: "PUT",
      ttlSec: 900,
    });
  }

  async getObjectEntityUploadURL(tenantId: number): Promise<string> {
    return this.getObjectEntityUploadURLInFolder(tenantId, "uploads");
  }

  /**
   * Mint a private upload URL for a temporary brand-voice sample. The dedicated
   * namespace lets the warning-dismiss cleanup route delete only samples that
   * have not been sent to the clone flow, never an arbitrary tenant upload.
   */
  async getBrandVoiceSampleUploadURL(tenantId: number): Promise<string> {
    return this.getObjectEntityUploadURLInFolder(tenantId, "voice-samples");
  }

  /**
   * Mint a private upload URL reserved for temporary audio extracted from one
   * Brand Kit. The distinct path lets the cleanup route reject ordinary tenant
   * uploads and samples retained by a successful clone.
   */
  async getBrandVoiceExtractionUploadURL(
    tenantId: number,
    brandKitId: number,
  ): Promise<string> {
    return this.getObjectEntityUploadURLInFolder(
      tenantId,
      `voice-extracts/${brandKitId}`,
    );
  }

  /**
   * Mint a presigned PUT URL for a PUBLIC brand asset (logo/favicon). Public
   * because these are shown pre-authentication (landing/auth/favicon). The
   * object lands under the first configured public search path as
   * `brand/<uuid>`, so it is served by the public route
   * `/storage/public-objects/brand/<uuid>`. Returns the upload URL plus the
   * browser-facing served path (through the `/api` proxy).
   */
  async getPublicBrandUploadURL(): Promise<{ uploadURL: string; servedPath: string }> {
    const searchPaths = this.getPublicObjectSearchPaths();
    const objectId = randomUUID();
    const key = `brand/${objectId}`;
    const fullPath = `${searchPaths[0]}/${key}`;

    const { bucketName, objectName } = parseObjectPath(fullPath);
    const uploadURL = await signObjectURL({
      bucketName,
      objectName,
      method: "PUT",
      ttlSec: 900,
    });

    return { uploadURL, servedPath: `/api/storage/public-objects/${key}` };
  }

  /**
   * Best-effort delete of a previously uploaded PUBLIC brand asset, given its
   * stored served path (`/api/storage/public-objects/brand/<uuid>`). Only
   * paths under the `brand/` namespace are eligible — anything else (absolute
   * URLs, tenant objects, traversal attempts) is silently ignored so a
   * malformed stored value can never delete unrelated objects.
   */
  async deletePublicBrandObject(servedPath: string): Promise<void> {
    const match = servedPath.match(/^\/api\/storage\/public-objects\/(brand\/[^/]+)$/);
    if (!match) return;
    const file = await this.searchPublicObject(match[1]);
    if (file) await file.delete();
  }

  /**
   * Resolve a `/objects/...` path to its backing file, enforcing that it belongs
   * to `tenantId`. Because `imagePath` is stored free-form and is thus
   * attacker-influenceable, every read/publish path funnels through here so a
   * leaked or crafted path cannot cross tenant boundaries. A mismatch is
   * reported as "not found" so the endpoint never confirms another tenant's
   * object exists.
   */
  async getObjectEntityFile(objectPath: string, tenantId: number): Promise<File> {
    if (!objectPath.startsWith("/objects/")) {
      throw new ObjectNotFoundError();
    }

    if (!objectPath.startsWith(`/objects/${tenantId}/`)) {
      throw new ObjectNotFoundError();
    }

    const parts = objectPath.slice(1).split("/");
    if (parts.length < 2) {
      throw new ObjectNotFoundError();
    }

    const entityId = parts.slice(1).join("/");
    let entityDir = this.getPrivateObjectDir();
    if (!entityDir.endsWith("/")) {
      entityDir = `${entityDir}/`;
    }
    const objectEntityPath = `${entityDir}${entityId}`;
    const { bucketName, objectName } = parseObjectPath(objectEntityPath);
    const bucket = objectStorageClient.bucket(bucketName);
    const objectFile = bucket.file(objectName);
    const [exists] = await objectFile.exists();
    if (!exists) {
      throw new ObjectNotFoundError();
    }
    return objectFile;
  }

  /**
   * Produce a short-lived, publicly reachable signed GET URL for a private
   * object. Used when an external service (e.g. the Instagram Graph API) must
   * fetch the image directly and cannot present our session cookie.
   */
  async getSignedDownloadURL(
    objectPath: string,
    tenantId: number,
    ttlSec = 900,
  ): Promise<string> {
    const file = await this.getObjectEntityFile(objectPath, tenantId);
    return signObjectURL({
      bucketName: file.bucket.name,
      objectName: file.name,
      method: "GET",
      ttlSec,
    });
  }

  /**
   * Delete a private tenant object, treating an already-absent object as
   * success while surfacing storage failures so durable cleanup trackers can
   * retry them later.
   */
  async deleteObjectEntity(objectPath: string, tenantId: number): Promise<void> {
    try {
      const file = await this.getObjectEntityFile(objectPath, tenantId);
      await file.delete();
    } catch (error) {
      if (error instanceof ObjectNotFoundError) return;
      throw error;
    }
  }

  /**
   * Best-effort delete of a private tenant object identified by its
   * `/objects/<tenantId>/...` path. The tenant ownership check is enforced
   * before the delete so a crafted path can never delete another tenant's
   * object. Errors are swallowed — this is intentionally fire-and-forget so
   * callers can use it in cleanup paths without disrupting the primary error
   * response.
   */
  async deleteObjectEntityQuietly(objectPath: string, tenantId: number): Promise<void> {
    try {
      await this.deleteObjectEntity(objectPath, tenantId);
    } catch {
      // Best-effort — ignore errors (file may already be gone or path invalid).
    }
  }

  normalizeObjectEntityPath(rawPath: string): string {
    if (!rawPath.startsWith("https://storage.googleapis.com/")) {
      return rawPath;
    }

    const url = new URL(rawPath);
    const rawObjectPath = url.pathname;

    let objectEntityDir = this.getPrivateObjectDir();
    if (!objectEntityDir.endsWith("/")) {
      objectEntityDir = `${objectEntityDir}/`;
    }

    if (!rawObjectPath.startsWith(objectEntityDir)) {
      return rawObjectPath;
    }

    const entityId = rawObjectPath.slice(objectEntityDir.length);
    return `/objects/${entityId}`;
  }
}

function parseObjectPath(path: string): {
  bucketName: string;
  objectName: string;
} {
  if (!path.startsWith("/")) {
    path = `/${path}`;
  }
  const pathParts = path.split("/");
  if (pathParts.length < 3) {
    throw new Error("Invalid path: must contain at least a bucket name");
  }

  const bucketName = pathParts[1];
  const objectName = pathParts.slice(2).join("/");

  return {
    bucketName,
    objectName,
  };
}

async function signObjectURL({
  bucketName,
  objectName,
  method,
  ttlSec,
}: {
  bucketName: string;
  objectName: string;
  method: "GET" | "PUT" | "DELETE" | "HEAD";
  ttlSec: number;
}): Promise<string> {
  const request = {
    bucket_name: bucketName,
    object_name: objectName,
    method,
    expires_at: new Date(Date.now() + ttlSec * 1000).toISOString(),
  };
  const response = await fetch(
    `${REPLIT_SIDECAR_ENDPOINT}/object-storage/signed-object-url`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(30_000),
    }
  );
  if (!response.ok) {
    throw new Error(
      `Failed to sign object URL, errorcode: ${response.status}, ` +
        `make sure you're running on Replit`
    );
  }

  const { signed_url: signedURL } = (await response.json()) as {
    signed_url: string;
  };
  return signedURL;
}
