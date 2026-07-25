import { db, appCredentialsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  orderByHealth,
  recordProviderFailure,
  recordProviderSuccess,
} from "../../providerHealth";
import { logger } from "../../logger";
import { isFeatureEnabled } from "../../featureFlags";
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

export type StockSourceId = "pexels" | "pixabay" | "wikimedia";
/** "auto" = healthiest configured source, keyed libraries preferred. */
export type StockSourceChoice = StockSourceId | "auto";

export interface StockSourceDef {
  id: StockSourceId;
  label: string;
  /**
   * Secret name holding the API key, or null for a source that needs no
   * credential at all. Keyless sources are public, license-filtered archives:
   * always "configured", but only reachable as failover (see stockCandidates).
   */
  envKey: string | null;
}

export const STOCK_SOURCES: readonly StockSourceDef[] = [
  { id: "pexels", label: "Pexels", envKey: "PEXELS_API_KEY" },
  { id: "pixabay", label: "Pixabay", envKey: "PIXABAY_API_KEY" },
  { id: "wikimedia", label: "Wikimedia Commons", envKey: null },
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

export type StockKeySource = "database" | "env" | "builtin" | null;

/** Where the effective key comes from: admin-entered DB key wins, env is fallback. */
export async function getStockKeySource(def: StockSourceDef): Promise<StockKeySource> {
  if (def.envKey === null) return "builtin";
  if (await getStoredStockKey(def.id)) return "database";
  if (process.env[def.envKey]) return "env";
  return null;
}

/** The effective API key for a source (DB first, then env), or null.
 * A keyless source resolves to "" — configured, with nothing to send. */
export async function resolveStockApiKey(def: StockSourceDef): Promise<string | null> {
  if (def.envKey === null) return "";
  const stored = await getStoredStockKey(def.id);
  if (stored) return stored;
  return process.env[def.envKey] ?? null;
}

export async function isStockSourceConfigured(def: StockSourceDef): Promise<boolean> {
  return (await resolveStockApiKey(def)) !== null;
}

export function stockHealthKey(id: StockSourceId): string {
  return `stock:${id}`;
}

/**
 * Every source this choice may legitimately use, best first.
 *
 * For an explicit choice that is just the one source. For "auto" it is the
 * configured keyed libraries, healthiest first (a source whose circuit breaker
 * is open — recent consecutive 429/5xx — is deprioritized so jobs land on
 * whatever is actually up), and then the keyless public-domain archives as
 * failover behind them.
 *
 * The archives are deliberately NOT a substitute for a stock account: they are
 * appended only once at least one keyed library is configured. A deployment
 * with no stock key at all should hear "add a Pexels key", not quietly start
 * shipping museum footage. But when Pexels and Pixabay are both down mid-job,
 * Commons is a far better answer than a failed video.
 */
export async function stockCandidates(
  choice: StockSourceChoice,
): Promise<{ def: StockSourceDef; apiKey: string }[]> {
  // Platform kill switch for the keyless public-domain archives. Fail-open:
  // a flag-read hiccup must never take footage away from a running job.
  const archivalEnabled = await isFeatureEnabled("archivalFootage").catch(() => true);

  if (choice !== "auto") {
    const def = STOCK_SOURCES.find((s) => s.id === choice);
    if (!def) return [];
    if (def.envKey === null && !archivalEnabled) return [];
    const apiKey = await resolveStockApiKey(def);
    return apiKey === null ? [] : [{ def, apiKey }];
  }

  const keyed: { def: StockSourceDef; apiKey: string }[] = [];
  for (const def of STOCK_SOURCES) {
    if (def.envKey === null) continue;
    const apiKey = await resolveStockApiKey(def);
    if (apiKey !== null) keyed.push({ def, apiKey });
  }
  if (keyed.length === 0) return [];

  const keyless = archivalEnabled
    ? STOCK_SOURCES.filter((s) => s.envKey === null).map((def) => ({ def, apiKey: "" }))
    : [];
  // Health ordering spans both groups, so a healthy archive beats a broken
  // Pexels while a healthy Pexels still wins outright.
  return orderByHealth([...keyed, ...keyless], (c) => stockHealthKey(c.def.id));
}

/** What to tell the tenant when a choice has no usable source at all. */
export function stockNotConfiguredError(choice: StockSourceChoice): VideoGenNotConfiguredError {
  return new VideoGenNotConfiguredError(
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
  /** Preview frame for vision-based relevance ranking (null when the API
   * returned none — such candidates are simply skipped by the ranker). */
  thumbnailUrl: string | null;
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
      image?: string;
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
      thumbnailUrl: typeof v.image === "string" && v.image ? v.image : null,
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
      videos?: Record<
        string,
        { url: string; width: number; height: number; thumbnail?: string }
      >;
    }[];
  };
  const clips: StockClip[] = [];
  for (const v of data.hits ?? []) {
    if (!v.duration || v.duration < MIN_CLIP_DURATION_SEC) continue;
    const renditions = Object.values(v.videos ?? {});
    const rendition = pickRendition(renditions, aspect);
    if (!rendition) continue;
    const thumbnail = renditions.find((r) => typeof r.thumbnail === "string" && r.thumbnail);
    clips.push({
      url: rendition.url,
      durationSec: v.duration,
      width: rendition.width,
      height: rendition.height,
      provider: "pixabay",
      thumbnailUrl: thumbnail?.thumbnail ?? null,
    });
  }
  return clips;
}

/**
 * Wikimedia Commons — a keyless, license-filtered archive.
 *
 * Commons is the deepest free source of regional footage (Indian streets,
 * festivals, wildlife, archival film) where Pexels is thin. It is also a mixed
 * licence pool, so the filter below is the whole point of this integration:
 * only PUBLIC DOMAIN and CC0 files are accepted.
 *
 * CC BY and CC BY-SA are excluded on purpose. BY needs a credit KOKAO has
 * nowhere to put inside a tenant's published post, and SA would arguably
 * push its share-alike terms onto the finished video — a licence obligation
 * we must not hand a paying customer by accident. Public domain and CC0 carry
 * neither, so an accepted clip is unconditionally safe to composite.
 *
 * lessismore: no per-clip licence field on StockClip — the filter IS the audit
 * trail. Nothing that reaches a video needs attribution, so there is nothing
 * per-clip to record.
 */
const WIKIMEDIA_API = "https://commons.wikimedia.org/w/api.php";

/** Commons asks every API client to identify itself; anonymous UAs are blocked. */
const WIKIMEDIA_USER_AGENT =
  "KOKAO/1.0 (social marketing video generator; https://github.com/Abhilashkoka/KOKAO)";

/** Transcoded renditions come from `derivatives`, which only TimedMediaHandler
 * serves. If this wiki rejects the prop we retry without it and fall back to
 * the original file. */
const WIKIMEDIA_VIPROPS = "url|size|dimensions|mime|extmetadata|derivatives";
const WIKIMEDIA_VIPROPS_BASIC = "url|size|dimensions|mime|extmetadata";

/**
 * Licence codes that impose no condition on the finished video. Commons
 * reports codes like "cc0", "pd", "pd-old-70", "pdm-owner"; anything else
 * ("cc-by-4.0", "cc-by-sa-3.0", "attribution", "fair use") is rejected.
 */
const UNCONDITIONAL_LICENCES = ["cc0", "cc-zero", "pd", "pdm"];

function isUnconditionalLicence(extmetadata: WikimediaExtMetadata | undefined): boolean {
  const code = extmetadata?.License?.value?.toLowerCase().trim();
  if (code) {
    return UNCONDITIONAL_LICENCES.some((ok) => code === ok || code.startsWith(`${ok}-`));
  }
  // No machine-readable code: accept only an unambiguous human-readable one.
  const short = extmetadata?.LicenseShortName?.value?.toLowerCase() ?? "";
  return short.includes("public domain") || short.startsWith("cc0");
}

interface WikimediaExtMetadata {
  License?: { value?: string };
  LicenseShortName?: { value?: string };
}

interface WikimediaVideoInfo {
  url?: string;
  width?: number;
  height?: number;
  duration?: number;
  mime?: string;
  thumburl?: string;
  extmetadata?: WikimediaExtMetadata;
  derivatives?: { src?: string; width?: number; height?: number; type?: string }[];
}

interface WikimediaResponse {
  error?: { code?: string; info?: string };
  query?: { pages?: { title?: string; videoinfo?: WikimediaVideoInfo[] }[] };
}

async function queryWikimedia(term: string, viprop: string): Promise<WikimediaResponse> {
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    formatversion: "2",
    generator: "search",
    gsrsearch: `filetype:video ${term}`,
    gsrnamespace: "6",
    gsrlimit: "20",
    prop: "videoinfo",
    viprop,
    viurlwidth: "640",
  });
  const res = await videoGenFetch(`${WIKIMEDIA_API}?${params}`, {
    headers: { "User-Agent": WIKIMEDIA_USER_AGENT, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new VideoGenProviderError(
      `Wikimedia Commons search failed (${res.status}): ${await errorDetail(res)}`,
      res.status,
    );
  }
  return (await res.json()) as WikimediaResponse;
}

async function searchWikimedia(term: string, aspect: VideoAspect): Promise<StockClip[]> {
  let data = await queryWikimedia(term, WIKIMEDIA_VIPROPS);
  if (data.error) {
    data = await queryWikimedia(term, WIKIMEDIA_VIPROPS_BASIC);
  }
  if (data.error) {
    throw new VideoGenProviderError(
      `Wikimedia Commons search failed: ${data.error.info ?? data.error.code ?? "unknown error"}`,
    );
  }

  const clips: StockClip[] = [];
  for (const page of data.query?.pages ?? []) {
    const info = page.videoinfo?.[0];
    if (!info?.url || !info.duration || info.duration < MIN_CLIP_DURATION_SEC) continue;
    if (!isUnconditionalLicence(info.extmetadata)) continue;

    // Transcodes when the wiki offers them, else the original upload.
    const renditions = (info.derivatives ?? [])
      .filter((d) => d.src && d.width && d.height)
      .map((d) => ({ url: d.src!, width: d.width!, height: d.height! }));
    if (renditions.length === 0 && info.width && info.height) {
      renditions.push({ url: info.url, width: info.width, height: info.height });
    }
    const rendition = pickRendition(renditions, aspect);
    if (!rendition) continue;

    clips.push({
      url: rendition.url,
      durationSec: info.duration,
      width: rendition.width,
      height: rendition.height,
      provider: "wikimedia",
      thumbnailUrl: typeof info.thumburl === "string" && info.thumburl ? info.thumburl : null,
    });
  }
  return clips;
}

/**
 * Search every term on each source in turn and stop at the first source that
 * actually has footage, returning its interleaved candidates (first hit of each
 * term, then second of each, ...) deduplicated by URL.
 *
 * A source contributes nothing either because it is down (every term threw) or
 * because it simply has no clips for this topic. From here those are the same
 * problem and the next source is the answer to both, so failover is on empty
 * results rather than on errors alone. An explicit source choice arrives here as
 * a one-element list, so it still fails loudly instead of quietly substituting a
 * different library.
 *
 * `onTick` runs before every search call — the caller uses it to enforce the
 * job's wall-clock deadline.
 */
export async function collectStockCandidates(
  sources: { def: StockSourceDef; apiKey: string }[],
  terms: string[],
  aspect: VideoAspect,
  onTick?: () => void,
): Promise<{ def: StockSourceDef; clips: StockClip[] }> {
  let lastDef = sources[0]!.def;
  for (const { def, apiKey } of sources) {
    lastDef = def;
    const perTerm: StockClip[][] = [];
    for (const term of terms) {
      onTick?.();
      try {
        perTerm.push(await searchStockClips(def, apiKey, term, aspect));
      } catch (err) {
        logger.warn({ err, term, source: def.id }, "stock search failed for term");
        perTerm.push([]);
      }
    }

    const seenUrls = new Set<string>();
    const clips: StockClip[] = [];
    const deepest = Math.max(0, ...perTerm.map((list) => list.length));
    for (let depth = 0; depth < deepest; depth++) {
      for (const list of perTerm) {
        const clip = list[depth];
        if (clip && !seenUrls.has(clip.url)) {
          seenUrls.add(clip.url);
          clips.push(clip);
        }
      }
    }
    if (clips.length > 0) return { def, clips };
    if (sources.length > 1) {
      logger.warn({ source: def.id }, "stock source returned no candidates; trying the next");
    }
  }
  return { def: lastDef, clips: [] };
}

export async function searchStockClips(
  def: StockSourceDef,
  apiKey: string,
  term: string,
  aspect: VideoAspect,
): Promise<StockClip[]> {
  const key = stockHealthKey(def.id);
  try {
    const clips =
      def.id === "pexels"
        ? await searchPexels(term, aspect, apiKey)
        : def.id === "pixabay"
          ? await searchPixabay(term, aspect, apiKey)
          : await searchWikimedia(term, aspect);
    recordProviderSuccess(key);
    return clips;
  } catch (error) {
    const status = error instanceof VideoGenProviderError ? error.status : undefined;
    const transient =
      status === undefined ||
      status === 429 ||
      status === 500 ||
      status === 502 ||
      status === 503 ||
      status === 504;
    if (transient) {
      recordProviderFailure(key, error instanceof Error ? error.message : undefined);
    }
    throw error;
  }
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
