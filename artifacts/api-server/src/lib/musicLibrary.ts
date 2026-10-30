import { assertPublicHost } from "./webFetch";

/**
 * Built-in background-music library: searches Openverse
 * (https://api.openverse.org — the Creative-Commons aggregator over
 * Jamendo, Freesound, Wikimedia and more), filtered to commercially-usable
 * licenses so tracks are safe in customers' published marketing posts. No
 * API key needed; the license and attribution travel with every result.
 */

const OPENVERSE_AUDIO_URL = "https://api.openverse.org/v1/audio/";
const SEARCH_TIMEOUT_MS = 20_000;
/** Results per query are reused for this long (the moods are a fixed list). */
const SEARCH_CACHE_MS = 6 * 60 * 60 * 1000;
const searchCache = new Map<string, { at: number; tracks: LibraryTrack[] }>();
const PAGE_SIZE = 12;
/** Track downloads: same ceiling as uploaded music. */
export const MAX_LIBRARY_TRACK_BYTES = 15 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const DOWNLOAD_TIMEOUT_MS = 60_000;

export class MusicLibraryError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "MusicLibraryError";
  }
}

export interface LibraryTrack {
  id: string;
  title: string;
  creator: string | null;
  /** SPDX-ish license slug, e.g. "by", "by-sa", "cc0". */
  license: string;
  licenseUrl: string | null;
  durationSec: number | null;
  /** Direct audio file URL (validated again server-side before download). */
  audioUrl: string;
}

async function libraryFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new MusicLibraryError("Music search timed out. Please try again.");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Search commercially-licensed music. Returns [] on no results.
 *
 * Cached per query for 6 hours, retried once, and on failure an older cached
 * answer is served rather than an error. Openverse's own dead-link check is
 * not requested: it is the slow part and made searches time out; a dead link
 * is still caught when the track is imported.
 */
export async function searchLibraryMusic(query: string): Promise<LibraryTrack[]> {
  const key = query.trim().toLowerCase();
  const cached = searchCache.get(key);
  if (cached && Date.now() - cached.at < SEARCH_CACHE_MS) return cached.tracks;
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const tracks = await searchOpenverse(query);
      searchCache.set(key, { at: Date.now(), tracks });
      return tracks;
    } catch (err) {
      lastError = err;
    }
  }
  if (cached) return cached.tracks;
  throw lastError;
}

/** Test hook. */
export function __clearMusicSearchCache(): void {
  searchCache.clear();
}

async function searchOpenverse(query: string): Promise<LibraryTrack[]> {
  const params = new URLSearchParams({
    q: query,
    license_type: "commercial",
    category: "music",
    page_size: String(PAGE_SIZE),
  });
  const res = await libraryFetch(`${OPENVERSE_AUDIO_URL}?${params}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new MusicLibraryError(
      `Music search failed (${res.status}). Please try again in a moment.`,
      res.status,
    );
  }
  const data = (await res.json()) as {
    results?: {
      id?: unknown;
      title?: unknown;
      creator?: unknown;
      license?: unknown;
      license_url?: unknown;
      duration?: unknown; // milliseconds
      url?: unknown;
    }[];
  };
  const tracks: LibraryTrack[] = [];
  for (const item of data.results ?? []) {
    if (typeof item.id !== "string" || typeof item.url !== "string") continue;
    let audioUrl: URL;
    try {
      audioUrl = new URL(item.url);
    } catch {
      continue;
    }
    if (audioUrl.protocol !== "https:") continue;
    tracks.push({
      id: item.id,
      title: typeof item.title === "string" && item.title ? item.title : "Untitled track",
      creator: typeof item.creator === "string" && item.creator ? item.creator : null,
      license: typeof item.license === "string" ? item.license : "cc",
      licenseUrl: typeof item.license_url === "string" ? item.license_url : null,
      durationSec:
        typeof item.duration === "number" && item.duration > 0
          ? Math.round(item.duration / 1000)
          : null,
      audioUrl: audioUrl.toString(),
    });
  }
  return tracks;
}

/** SSRF guard: https + public host, re-checked on every redirect hop. */
async function assertSafeTrackUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new MusicLibraryError("That track URL is not valid.");
  }
  if (url.protocol !== "https:") {
    throw new MusicLibraryError("Track downloads must use https.");
  }
  try {
    await assertPublicHost(url.hostname);
  } catch {
    throw new MusicLibraryError("That track URL points at a blocked or private host.");
  }
  return url;
}

/** Download a library track server-side (bounded size, validated hops). */
export async function downloadLibraryTrack(rawUrl: string): Promise<Buffer> {
  let url = await assertSafeTrackUrl(rawUrl);
  let res: Response | null = null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      res = await fetch(url.toString(), { redirect: "manual", signal: controller.signal });
      if (res.status < 300 || res.status >= 400) break;
      const location = res.headers.get("location");
      if (!location) throw new MusicLibraryError("Track download redirect had no destination.");
      if (hop === MAX_REDIRECTS) {
        throw new MusicLibraryError("Track download followed too many redirects.");
      }
      url = await assertSafeTrackUrl(new URL(location, url).toString());
    }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new MusicLibraryError("Track download timed out. Please try another track.");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (!res || !res.ok) {
    throw new MusicLibraryError(`Track download failed (${res?.status ?? "network"}).`);
  }
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_LIBRARY_TRACK_BYTES) {
    throw new MusicLibraryError("That track is too large (max 15 MB).");
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_LIBRARY_TRACK_BYTES) {
    throw new MusicLibraryError("That track is too large (max 15 MB).");
  }
  if (buffer.length === 0) {
    throw new MusicLibraryError("The track file was empty. Please try another track.");
  }
  return buffer;
}
