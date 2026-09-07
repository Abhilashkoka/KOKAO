import { db, appCredentialsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { decryptJson } from "../secretCrypto";
import { boundedProviderFetch } from "../aiProviderFetch";

const CREDENTIAL_PROVIDER = "videogen_atlascloud";
/** Official Atlas Asset Library API (separate from the model API host). */
const ASSETS_URL = "https://console.atlascloud.ai/api/v1/sd/assets";
const TIMEOUT_MS = 30_000;

interface StoredKey { apiKey: string }
interface AtlasAsset { id?: unknown; status?: unknown; error?: unknown; error_message?: unknown }

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

async function call(path: string, init: RequestInit, apiKey: string): Promise<AtlasAsset> {
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
  try {
    return JSON.parse(text) as AtlasAsset;
  } catch {
    throw new AtlasAssetsError("Atlas Cloud asset response was not valid JSON.", 502);
  }
}

/** Register an already-stored fictional image by short-lived signed URL. */
export async function createAtlasAsset(url: string, apiKey: string): Promise<string> {
  const asset = await call("", {
    method: "POST",
    body: JSON.stringify({ type: "Image", url }),
  }, apiKey);
  const id = safeId(asset.id);
  if (!id) throw new AtlasAssetsError("Atlas Cloud returned no valid asset id.", 502);
  return id;
}

export async function getAtlasAsset(
  id: string,
  apiKey: string,
): Promise<{ status: AtlasAssetStatus; error: string | null }> {
  const asset = await call(`/${encodeURIComponent(id)}`, { method: "GET" }, apiKey);
  const status = String(asset.status ?? "").toLowerCase();
  if (status === "active") return { status: "Active", error: null };
  if (status === "failed" || status === "rejected") {
    const error = asset.error_message ?? asset.error;
    return {
      status: "Failed",
      error: typeof error === "string" ? error.slice(0, 500) : "Atlas Cloud rejected this asset.",
    };
  }
  return { status: "Processing", error: null };
}

export async function waitForAtlasAsset(
  id: string,
  apiKey: string,
  timeoutMs = 10 * 60_000,
): Promise<{ status: AtlasAssetStatus; error: string | null }> {
  const deadline = Date.now() + timeoutMs;
  do {
    const result = await getAtlasAsset(id, apiKey);
    if (result.status !== "Processing") return result;
    await new Promise((resolve) => setTimeout(resolve, Math.min(5_000, deadline - Date.now())));
  } while (Date.now() < deadline);
  return { status: "Processing", error: "Atlas Cloud asset activation timed out." };
}