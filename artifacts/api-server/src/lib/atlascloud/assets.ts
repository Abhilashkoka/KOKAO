import { db, appCredentialsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { decryptJson } from "../secretCrypto";
import { boundedProviderFetch } from "../aiProviderFetch";
import { isAtlasGenerationReferenceId } from "./assetId";

const CREDENTIAL_PROVIDER = "videogen_atlascloud";
/** Official Atlas Asset Library API (separate from the model API host). */
const ASSETS_URL = "https://console.atlascloud.ai/api/v1/sd/assets";
const TIMEOUT_MS = 30_000;

interface StoredKey { apiKey: string }
interface AtlasAsset {
  id?: unknown;
  atlas_asset_id?: unknown;
  ark_asset_id?: unknown;
  status?: unknown;
  error?: unknown;
  error_message?: unknown;
}
interface AtlasEnvelope { code?: unknown; message?: unknown; data?: unknown }

export interface AtlasAssetIdentity {
  /** Asset Library database record id. Required for GET /assets/{id}. */
  libraryRecordId: number;
  /** Atlas console identity. It is metadata only, not a GET or generation id. */
  atlasAssetId: string;
  /** Seedance identity used as asset://<generationReferenceId>. */
  generationReferenceId: string;
}

export type AtlasAssetStatus = "Processing" | "Active" | "Failed";

export class AtlasAssetsError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "AtlasAssetsError";
  }
}

export async function resolveAtlasAssetsKey(): Promise<string | null> {
  const [row] = await db.select().from(appCredentialsTable)
    .where(eq(appCredentialsTable.provider, CREDENTIAL_PROVIDER)).limit(1);
  if (row) {
    try {
      const stored = decryptJson<StoredKey>(row.encryptedCredentials);
      if (stored.apiKey?.trim()) return stored.apiKey.trim();
    } catch {
      // The environment key remains a valid fallback for corrupt legacy rows.
    }
  }
  return process.env.ATLASCLOUD_API_KEY?.trim() || null;
}

function safeId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{3,127}$/.test(id) ? id : null;
}

function safeRecordId(value: unknown): number | null {
  const id = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/.test(value.trim())
      ? Number(value)
      : NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function applicationCode(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value);
  return null;
}

async function call(path: string, init: RequestInit, apiKey: string): Promise<unknown> {
  const response = await boundedProviderFetch(
    `${ASSETS_URL}${path}`,
    {
      ...init,
      redirect: "error",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
    },
    TIMEOUT_MS,
    () => new AtlasAssetsError("Atlas Cloud asset request timed out."),
  );
  const text = await response.text();
  if (!response.ok) {
    throw new AtlasAssetsError(
      `Atlas Cloud asset request failed (${response.status}): ${text.slice(0, 300) || "no detail"}`,
      response.status,
    );
  }
  if (response.status === 204 && !text) return {};
  let envelope: AtlasEnvelope;
  try {
    envelope = JSON.parse(text) as AtlasEnvelope;
  } catch {
    throw new AtlasAssetsError("Atlas Cloud asset response was not valid JSON.", 502);
  }
  {
    const code = applicationCode(envelope?.code);
    if (code !== 200) {
      const message = typeof envelope?.message === "string"
        ? envelope.message.slice(0, 300)
        : "no detail";
      throw new AtlasAssetsError(
        `Atlas Cloud asset request failed (application code ${code ?? "missing"}): ${message}`,
        502,
      );
    }
    if (envelope.data === null || typeof envelope.data !== "object") {
      throw new AtlasAssetsError("Atlas Cloud asset response contained no valid data.", 502);
    }
    return envelope.data;
  }
}

function identity(asset: AtlasAsset): AtlasAssetIdentity {
  const libraryRecordId = safeRecordId(asset.id);
  const atlasAssetId = safeId(asset.atlas_asset_id);
  const generationReferenceId = isAtlasGenerationReferenceId(asset.ark_asset_id)
    ? asset.ark_asset_id
    : null;
  if (!libraryRecordId || !atlasAssetId || !generationReferenceId) {
    throw new AtlasAssetsError(
      "Atlas Cloud asset response did not contain valid id, atlas_asset_id, and ark_asset_id values.",
      502,
    );
  }
  return { libraryRecordId, atlasAssetId, generationReferenceId };
}

/** Register an already-stored fictional image by short-lived signed URL. */
export async function createAtlasAsset(url: string, apiKey: string): Promise<AtlasAssetIdentity> {
  const asset = await call("", {
    method: "POST",
    body: JSON.stringify({ type: "Image", url }),
  }, apiKey) as AtlasAsset;
  return identity(asset);
}

export async function getAtlasAsset(
  libraryRecordId: number,
  apiKey: string,
): Promise<AtlasAssetIdentity & { status: AtlasAssetStatus; error: string | null }> {
  if (!safeRecordId(libraryRecordId)) {
    throw new AtlasAssetsError("Atlas Cloud Asset Library status requires a numeric record id.", 400);
  }
  const asset = await call(`/${libraryRecordId}`, { method: "GET" }, apiKey) as AtlasAsset;
  const ids = identity(asset);
  const status = String(asset.status ?? "").toLowerCase();
  if (status === "active") return { ...ids, status: "Active", error: null };
  if (status === "failed" || status === "rejected") {
    const error = asset.error_message ?? asset.error;
    return {
      ...ids, status: "Failed",
      error: typeof error === "string" ? error.slice(0, 500) : "Atlas Cloud rejected this asset.",
    };
  }
  return { ...ids, status: "Processing", error: null };
}

/** Delete a known numeric Asset Library record (used only for race compensation). */
export async function deleteAtlasAsset(
  libraryRecordId: number,
  apiKey: string,
): Promise<void> {
  if (!safeRecordId(libraryRecordId)) {
    throw new AtlasAssetsError("Atlas Cloud asset deletion requires a numeric record id.", 400);
  }
  await call(`/${libraryRecordId}`, { method: "DELETE" }, apiKey);
}

export async function waitForAtlasAsset(
  libraryRecordId: number,
  apiKey: string,
  timeoutMs = 10 * 60_000,
): Promise<AtlasAssetIdentity & { status: AtlasAssetStatus; error: string | null }> {
  const deadline = Date.now() + timeoutMs;
  let lastResult: Awaited<ReturnType<typeof getAtlasAsset>>;
  do {
    const result = await getAtlasAsset(libraryRecordId, apiKey);
    lastResult = result;
    if (result.status !== "Processing") return result;
    await new Promise((resolve) => setTimeout(resolve, Math.min(5_000, deadline - Date.now())));
  } while (Date.now() < deadline);
  return { ...lastResult!, status: "Processing", error: "Atlas Cloud asset activation timed out." };
}

/** Parse the live list envelope while preserving the three distinct identities. */
export async function listAtlasAssets(apiKey: string): Promise<Array<AtlasAssetIdentity & {
  status: AtlasAssetStatus;
}>> {
  const data = await call("", { method: "GET" }, apiKey);
  const collection = data && typeof data === "object"
    ? data as { list?: unknown; assets?: unknown; items?: unknown; data?: unknown }
    : null;
  const records = Array.isArray(data) ? data :
    Array.isArray(collection?.list) ? collection.list :
    Array.isArray(collection?.assets) ? collection.assets :
    Array.isArray(collection?.items) ? collection.items :
    Array.isArray(collection?.data) ? collection.data :
    null;
  if (!records) throw new AtlasAssetsError("Atlas Cloud asset list response contained no valid list.", 502);
  return records.map((asset) => {
    const ids = identity(asset);
    const rawStatus = String(asset.status ?? "").toLowerCase();
    const status: AtlasAssetStatus =
      rawStatus === "active" ? "Active" :
      rawStatus === "failed" || rawStatus === "rejected" ? "Failed" :
      "Processing";
    return { ...ids, status };
  });
}