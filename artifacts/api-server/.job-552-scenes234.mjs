// ../../../../../tmp/generate-job-552-scenes234.ts
import { writeFile } from "node:fs/promises";
import pg from "pg";

// src/lib/secretCrypto.ts
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
var VERSION_PREFIX = "v1:";
var MISSING_KEY_MESSAGE = "CREDENTIALS_ENCRYPTION_KEY or SESSION_SECRET is required to encrypt or decrypt secrets";
function candidateSecrets() {
  const secrets = [];
  const dedicated = process.env.CREDENTIALS_ENCRYPTION_KEY;
  const session = process.env.SESSION_SECRET;
  if (dedicated) secrets.push(dedicated);
  if (session && session !== dedicated) secrets.push(session);
  return secrets;
}
function deriveKey(secret) {
  return createHash("sha256").update(secret, "utf8").digest();
}
function decryptSecret(payload) {
  const body = payload.startsWith(VERSION_PREFIX) ? payload.slice(VERSION_PREFIX.length) : payload;
  const parts = body.split(":");
  if (parts.length !== 3) {
    throw new Error("Malformed encrypted payload");
  }
  const [ivB64, tagB64, dataB64] = parts;
  const secrets = candidateSecrets();
  if (secrets.length === 0) {
    throw new Error(MISSING_KEY_MESSAGE);
  }
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const data = Buffer.from(dataB64, "base64");
  let lastError;
  for (const secret of secrets) {
    try {
      const decipher = createDecipheriv("aes-256-gcm", deriveKey(secret), iv);
      decipher.setAuthTag(tag);
      const decrypted = Buffer.concat([
        decipher.update(data),
        decipher.final()
      ]);
      return decrypted.toString("utf8");
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Failed to decrypt payload");
}
function decryptJson(payload) {
  return JSON.parse(decryptSecret(payload));
}

// src/lib/objectStorage.ts
import { Storage } from "@google-cloud/storage";
import { Readable } from "stream";
import { randomUUID } from "crypto";
var REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";
var objectStorageClient = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
    type: "external_account",
    credential_source: {
      url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
      format: {
        type: "json",
        subject_token_field_name: "access_token"
      }
    },
    universe_domain: "googleapis.com"
  },
  projectId: ""
});
var ObjectNotFoundError = class _ObjectNotFoundError extends Error {
  constructor() {
    super("Object not found");
    this.name = "ObjectNotFoundError";
    Object.setPrototypeOf(this, _ObjectNotFoundError.prototype);
  }
};
var ObjectStorageService = class {
  constructor() {
  }
  getPublicObjectSearchPaths() {
    const pathsStr = process.env.PUBLIC_OBJECT_SEARCH_PATHS || "";
    const paths = Array.from(
      new Set(
        pathsStr.split(",").map((path) => path.trim()).filter((path) => path.length > 0)
      )
    );
    if (paths.length === 0) {
      throw new Error(
        "PUBLIC_OBJECT_SEARCH_PATHS not set. Create a bucket in 'Object Storage' tool and set PUBLIC_OBJECT_SEARCH_PATHS env var (comma-separated paths)."
      );
    }
    return paths;
  }
  getPrivateObjectDir() {
    const dir = process.env.PRIVATE_OBJECT_DIR || "";
    if (!dir) {
      throw new Error(
        "PRIVATE_OBJECT_DIR not set. Create a bucket in 'Object Storage' tool and set PRIVATE_OBJECT_DIR env var."
      );
    }
    return dir;
  }
  async searchPublicObject(filePath) {
    const normalized = filePath.replace(/^\/+/, "");
    if (normalized.includes("\0") || normalized.split("/").some((seg) => seg === "." || seg === "..")) {
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
  async downloadObject(file, { isPublic = false, cacheTtlSec = 3600 } = {}) {
    const [metadata2] = await file.getMetadata();
    const nodeStream = file.createReadStream();
    const webStream = Readable.toWeb(nodeStream);
    const headers = {
      "Content-Type": metadata2.contentType || "application/octet-stream",
      "Cache-Control": `${isPublic ? "public" : "private"}, max-age=${cacheTtlSec}`
    };
    if (metadata2.size) {
      headers["Content-Length"] = String(metadata2.size);
    }
    return new Response(webStream, { headers });
  }
  async getObjectEntityUploadURLInFolder(tenantId, folder) {
    const privateObjectDir = this.getPrivateObjectDir();
    if (!privateObjectDir) {
      throw new Error(
        "PRIVATE_OBJECT_DIR not set. Create a bucket in 'Object Storage' tool and set PRIVATE_OBJECT_DIR env var."
      );
    }
    const objectId = randomUUID();
    const fullPath = `${privateObjectDir}/${tenantId}/${folder}/${objectId}`;
    const { bucketName, objectName } = parseObjectPath(fullPath);
    return signObjectURL({
      bucketName,
      objectName,
      method: "PUT",
      ttlSec: 900
    });
  }
  async getObjectEntityUploadURL(tenantId) {
    return this.getObjectEntityUploadURLInFolder(tenantId, "uploads");
  }
  /**
   * Mint a private upload URL for a temporary brand-voice sample. The dedicated
   * namespace lets the warning-dismiss cleanup route delete only samples that
   * have not been sent to the clone flow, never an arbitrary tenant upload.
   */
  async getBrandVoiceSampleUploadURL(tenantId) {
    return this.getObjectEntityUploadURLInFolder(tenantId, "voice-samples");
  }
  /**
   * Mint a private upload URL reserved for temporary audio extracted from one
   * Brand Kit. The distinct path lets the cleanup route reject ordinary tenant
   * uploads and samples retained by a successful clone.
   */
  async getBrandVoiceExtractionUploadURL(tenantId, brandKitId) {
    return this.getObjectEntityUploadURLInFolder(
      tenantId,
      `voice-extracts/${brandKitId}`
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
  async getPublicBrandUploadURL() {
    const searchPaths = this.getPublicObjectSearchPaths();
    const objectId = randomUUID();
    const key = `brand/${objectId}`;
    const fullPath = `${searchPaths[0]}/${key}`;
    const { bucketName, objectName } = parseObjectPath(fullPath);
    const uploadURL = await signObjectURL({
      bucketName,
      objectName,
      method: "PUT",
      ttlSec: 900
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
  async deletePublicBrandObject(servedPath) {
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
  async getObjectEntityFile(objectPath, tenantId) {
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
  async getSignedDownloadURL(objectPath, tenantId, ttlSec = 900) {
    const file = await this.getObjectEntityFile(objectPath, tenantId);
    return signObjectURL({
      bucketName: file.bucket.name,
      objectName: file.name,
      method: "GET",
      ttlSec
    });
  }
  /**
   * Delete a private tenant object, treating an already-absent object as
   * success while surfacing storage failures so durable cleanup trackers can
   * retry them later.
   */
  async deleteObjectEntity(objectPath, tenantId) {
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
  async deleteObjectEntityQuietly(objectPath, tenantId) {
    try {
      await this.deleteObjectEntity(objectPath, tenantId);
    } catch {
    }
  }
  normalizeObjectEntityPath(rawPath) {
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
};
function parseObjectPath(path) {
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
    objectName
  };
}
async function signObjectURL({
  bucketName,
  objectName,
  method,
  ttlSec
}) {
  const request = {
    bucket_name: bucketName,
    object_name: objectName,
    method,
    expires_at: new Date(Date.now() + ttlSec * 1e3).toISOString()
  };
  const response = await fetch(
    `${REPLIT_SIDECAR_ENDPOINT}/object-storage/signed-object-url`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(3e4)
    }
  );
  if (!response.ok) {
    throw new Error(
      `Failed to sign object URL, errorcode: ${response.status}, make sure you're running on Replit`
    );
  }
  const { signed_url: signedURL } = await response.json();
  return signedURL;
}

// ../../../../../tmp/generate-job-552-scenes234.ts
var prompts = [
  ["2", "app testing. Scene 2: close-up frontal framing, face unobstructed, subtle natural head motion; silent source plate with the person visibly talking naturally from the first second and throughout, natural but unmistakable speech-like motion, clear varied mouth shapes, regular open-and-close lip motion, visibly open vowel shapes, closed consonant shapes, and a relaxed moving jaw; no audible dialogue; exactly one unobstructed front-facing face remains large in frame throughout"],
  ["3", "app testing. Scene 3: medium close-up, direct frontal pose, stable lighting, attentive expression; silent source plate with the person visibly talking naturally from the first second and throughout, natural but unmistakable speech-like motion, clear varied mouth shapes, regular open-and-close lip motion, visibly open vowel shapes, closed consonant shapes, and a relaxed moving jaw; no audible dialogue; exactly one unobstructed front-facing face remains large in frame throughout"],
  ["4", "app testing. Scene 4: close-up centered one-face composition, locked camera, relaxed shoulders; silent source plate with the person visibly talking naturally from the first second and throughout, natural but unmistakable speech-like motion, clear varied mouth shapes, regular open-and-close lip motion, visibly open vowel shapes, closed consonant shapes, and a relaxed moving jaw; no audible dialogue; exactly one unobstructed front-facing face remains large in frame throughout"]
];
var pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
var result = await pool.query("SELECT encrypted_credentials FROM app_credentials WHERE provider = $1 LIMIT 1", ["imagegen_openrouter"]);
await pool.end();
var credentials = decryptJson(result.rows[0].encrypted_credentials);
var storage = new ObjectStorageService();
var refFile = await storage.getObjectEntityFile("/objects/10/uploads/125a71cf-aba9-41b4-9714-b3bca1ba2e9a", 10);
var [[metadata], [referenceBuffer]] = await Promise.all([refFile.getMetadata(), refFile.download()]);
var referenceUrl = `data:${String(metadata.contentType || "image/png")};base64,${referenceBuffer.toString("base64")}`;
await Promise.all(prompts.map(async ([scene, savedPrompt]) => {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${credentials.apiKey}` },
    body: JSON.stringify({
      model: "google/gemini-3-pro-image-preview",
      messages: [{ role: "user", content: [
        { type: "image_url", image_url: { url: referenceUrl } },
        { type: "text", text: `${savedPrompt}

Generate a portrait (2:3) image.` }
      ] }],
      modalities: ["image", "text"],
      max_tokens: 8192
    }),
    signal: AbortSignal.timeout(18e4)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`Scene ${scene} failed (${response.status}): ${JSON.stringify(data).slice(0, 1e3)}`);
  const message = data?.choices?.[0]?.message;
  const candidates = [];
  for (const image of message?.images || []) if (image?.image_url?.url) candidates.push(image.image_url.url);
  if (Array.isArray(message?.content)) for (const part of message.content) {
    const url2 = part?.image_url?.url || part?.image_url;
    if (typeof url2 === "string") candidates.push(url2);
  }
  const url = candidates.find((value) => /^data:image\/[^;,]+;base64,/.test(value));
  if (!url) throw new Error(`Scene ${scene} returned no image payload`);
  const encoded = /^data:image\/[^;,]+;base64,(.+)$/.exec(url)[1];
  await writeFile(`/home/runner/workspace/attached_assets/generated_images/job-552-nano-banana-pro/scene-${scene}.png`, Buffer.from(encoded, "base64"));
  console.log(`Generated Scene ${scene} with openrouter/google/gemini-3-pro-image-preview`);
}));
