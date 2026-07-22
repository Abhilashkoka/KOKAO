import { db, appCredentialsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { encryptJson, decryptJson } from "../../secretCrypto";
import { assertPublicHost } from "../../webFetch";
import {
  VideoGenNotConfiguredError,
  VideoGenProviderError,
  videoGenFetch,
  errorDetail,
  ASPECT_DIMENSIONS,
  type VideoAspect,
} from "../types";

/**
 * Stock-footage sources for the Topic to Video engine. Mirrors the videoGen
 * provider-key pattern: an admin-entered key (AES-encrypted in
 * app_credentials under `stock_<id>`) wins over the env secret fallback.
 *
 * Search + selection logic is ported from MoneyPrinterTurbo (MIT,
 * app/services/material.py), adapted to native fetch and cover-crop
 * composition: any rendition that covers ~720p is usable because the
 * compositor scales and center-crops to the target aspect.
 */

export type StockSourceId = "pexels" | "pixabay";
/** "auto" = first configured source, Pexels preferred. */
export type StockSourceChoice = StockSourceId | "auto";

export interface StockSourceDef {
  id: StockSourceId;
  label: string;
  envKey: string;
}

export const STOCK_SOURCES: readonly StockSourceDef[] = [
  { id: "pexels", label: "Pexels", envKey: "PEXELS_API_KEY" },
  { id: "pixabay", label: "Pixabay", envKey: "PIXABAY_API_KEY" },
] as const;

export function getStockSourceDef(id: string): StockSourceDef | undefined {
  return STOCK_SOURCES.find((s) => s.id === id);
}

/** app_credentials row name for a source's stored key. */
function stockCredentialProvider(sourceId: string): string {
  return `stock_${sourceId}`;
}

interface StoredStockKey {
  apiKey: string;
}

/** The API key saved by a superadmin (encrypted at rest), or null. */
export async function getStoredStockKey(sourceId: string): Promise<string | null> {
  const row = (
    await db
      .select()
      .from(appCredentialsTable)
      .where(eq(appCredentialsTable.provider, stockCredentialProvider(sourceId)))
      .limit(1)
  )[0];
  if (!row) return null;
  try {
    const creds = decryptJson<StoredStockKey>(row.encryptedCredentials);
    return creds.apiKey || null;
  } catch {
    return null;
  }
}

/** Save (encrypted) or overwrite the admin-entered key for a source. */
export async function setStoredStockKey(sourceId: string, apiKey: string): Promise<void> {
  const encrypted = encryptJson({ apiKey } satisfies StoredStockKey);
  await db
    .insert(appCredentialsTable)
    .values({ provider: stockCredentialProvider(sourceId), encryptedCredentials: encrypted })
    .onConflictDoUpdate({
      target: appCredentialsTable.provider,
      set: { encryptedCredentials: encrypted, updatedAt: new Date() },
    });
}

/** Remove the admin-entered key (env secret, if any, becomes the fallback). */
export async function clearStoredStockKey(sourceId: string): Promise<void> {
  await db
    .delete(appCredentialsTable)
    .where(eq(appCredentialsTable.provider, stockCredentialProvider(sourceId)));
}

export type StockKeySource = "database" | "env" | null;

/** Where the effective key comes from: admin-entered DB key wins, env is fallback. */
export async function getStockKeySource(def: StockSourceDef): Promise<StockKeySource> {
  if (await getStoredStockKey(def.id)) return "database";
  if (process.env[def.envKey]) return "env";
  return null;
}

/** The effective API key for a source (DB first, then env), or null. */
export async function resolveStockApiKey(def: StockSourceDef): Promise<string | null> {
  const stored = await getStoredStockKey(def.id);
  if (stored) return stored;
  return process.env[def.envKey] ?? null;
}

export async function isStockSourceConfigured(def: StockSourceDef): Promise<boolean> {
  return (await resolveStockApiKey(def)) !== null;
}

/** Resolve "auto" to the first configured source; validate explicit choices. */
export async function resolveStockSource(
  choice: StockSourceChoice,
): Promise<{ def: StockSourceDef; apiKey: string }> {
  const candidates =
    choice === "auto" ? STOCK_SOURCES : STOCK_SOURCES.filter((s) => s.id === choice);
  for (const def of candidates) {
    const apiKey = await resolveStockApiKey(def);
    if (apiKey) return { def, apiKey };
  }
  throw new VideoGenNotConfiguredError(
    choice === "auto"
      ? "No stock footage source is configured. Add a Pexels or Pixabay API key " +
        "(free at pexels.com/api or pixabay.com/api/docs) in the admin settings, " +
        "or set the PEXELS_API_KEY / PIXABAY_API_KEY secret."
      : `The ${choice} stock source is not configured. Add its API key in the admin ` +
        "settings or set the corresponding secret.",
  );
}

/** One usable stock clip candidate. */
export interface StockClip {
  url: string;
  /** Full source video duration in seconds (as reported by the API). */
  durationSec: number;
  width: number;
  height: number;
  provider: StockSourceId;
}

/** Renditions must cover roughly 720p after cover-cropping. */
const MIN_RENDITION_AREA = 921_600; // 1280x720
/** Source clips shorter than this are too choppy to reuse. */
const MIN_CLIP_DURATION_SEC = 3;

function pexelsOrientation(aspect: VideoAspect): string {
  if (aspect === "9:16") return "portrait";
  if (aspect === "1:1") return "square";
  return "landscape";
}

/**
 * Pick the rendition closest to the target pixel area from above — big enough
 * to look sharp after the cover-crop, small enough to keep downloads fast.
 */
function pickRendition<T extends { width: number; height: number }>(
  files: T[],
  aspect: VideoAspect,
): T | null {
  const target = ASPECT_DIMENSIONS[aspect];
  const targetArea = target.width * target.height;
  const usable = files.filter((f) => f.width * f.height >= MIN_RENDITION_AREA);
  if (usable.length === 0) return null;
  usable.sort(
    (a, b) =>
      Math.abs(a.width * a.height - targetArea) - Math.abs(b.width * b.height - targetArea),
  );
  return usable[0]!;
}

async function searchPexels(
  term: string,
  aspect: VideoAspect,
  apiKey: string,
): Promise<StockClip[]> {
  const params = new URLSearchParams({
    query: term,
    per_page: "15",
    orientation: pexelsOrientation(aspect),
  });
  const res = await videoGenFetch(`https://api.pexels.com/videos/search?${params}`, {
    headers: { Authorization: apiKey },
  });
  if (!res.ok) {
    throw new VideoGenProviderError(
      `Pexels search failed (${res.status}): ${await errorDetail(res)}`,
      res.status,
    );
  }
  const data = (await res.json()) as {
    videos?: {
      duration: number;
      video_files?: { link: string; width: number; height: number }[];
    }[];
  };
  const clips: StockClip[] = [];
  for (const v of data.videos ?? []) {
    if (!v.duration || v.duration < MIN_CLIP_DURATION_SEC) continue;
    const rendition = pickRendition(v.video_files ?? [], aspect);
    if (!rendition) continue;
    clips.push({
      url: rendition.link,
      durationSec: v.duration,
      width: rendition.width,
      height: rendition.height,
      provider: "pexels",
    });
  }
  return clips;
}

async function searchPixabay(
  term: string,
  aspect: VideoAspect,
  apiKey: string,
): Promise<StockClip[]> {
  const params = new URLSearchParams({
    q: term,
    video_type: "film",
    per_page: "25",
    key: apiKey,
  });
  const res = await videoGenFetch(`https://pixabay.com/api/videos/?${params}`, {});
  if (!res.ok) {
    throw new VideoGenProviderError(
      `Pixabay search failed (${res.status}): ${await errorDetail(res)}`,
      res.status,
    );
  }
  const data = (await res.json()) as {
    hits?: {
      duration: number;
      videos?: Record<string, { url: string; width: number; height: number }>;
    }[];
  };
  const clips: StockClip[] = [];
  for (const v of data.hits ?? []) {
    if (!v.duration || v.duration < MIN_CLIP_DURATION_SEC) continue;
    const rendition = pickRendition(Object.values(v.videos ?? {}), aspect);
    if (!rendition) continue;
    clips.push({
      url: rendition.url,
      durationSec: v.duration,
      width: rendition.width,
      height: rendition.height,
      provider: "pixabay",
    });
  }
  return clips;
}

export async function searchStockClips(
  def: StockSourceDef,
  apiKey: string,
  term: string,
  aspect: VideoAspect,
): Promise<StockClip[]> {
  return def.id === "pexels"
    ? searchPexels(term, aspect, apiKey)
    : searchPixabay(term, aspect, apiKey);
}

/** Cap per-clip downloads so one giant source file can't blow the job. */
export const MAX_STOCK_CLIP_BYTES = 60 * 1024 * 1024;

/**
 * SSRF guard for stock clip URLs: the URL comes from a third-party API
 * response, so treat it as untrusted — require https and a public host
 * before fetching it server-side.
 */
async function assertSafeClipUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new VideoGenProviderError("Stock source returned an invalid clip URL.");
  }
  if (url.protocol !== "https:") {
    throw new VideoGenProviderError("Stock source returned a non-https clip URL.");
  }
  try {
    await assertPublicHost(url.hostname);
  } catch {
    throw new VideoGenProviderError(
      "Stock source returned a clip URL on a blocked or private host.",
    );
  }
  return url;
}

const MAX_CLIP_REDIRECTS = 3;

export async function downloadStockClip(clip: StockClip): Promise<Buffer> {
  let url = await assertSafeClipUrl(clip.url);
  let res: Response | null = null;
  // Follow redirects manually so every hop is re-validated against the guard.
  for (let hop = 0; hop <= MAX_CLIP_REDIRECTS; hop++) {
    res = await videoGenFetch(url.toString(), { redirect: "manual" });
    if (res.status < 300 || res.status >= 400) break;
    const location = res.headers.get("location");
    if (!location) {
      throw new VideoGenProviderError("Stock clip download redirect had no destination.");
    }
    if (hop === MAX_CLIP_REDIRECTS) {
      throw new VideoGenProviderError("Stock clip download followed too many redirects.");
    }
    url = await assertSafeClipUrl(new URL(location, url).toString());
  }
  if (!res) {
    throw new VideoGenProviderError("Stock clip download failed.");
  }
  if (!res.ok) {
    throw new VideoGenProviderError(
      `Stock clip download failed (${res.status}): ${await errorDetail(res)}`,
      res.status,
    );
  }
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_STOCK_CLIP_BYTES) {
    throw new VideoGenProviderError("Stock clip is too large to download.");
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_STOCK_CLIP_BYTES) {
    throw new VideoGenProviderError("Stock clip is too large to download.");
  }
  return buffer;
}
