import { platformFetch } from "./platformFetch";

/**
 * Live pricing for Replicate-hosted video models.
 *
 * Replicate's REST API does not expose model pricing, but each public model
 * page (https://replicate.com/{owner}/{name}) embeds a structured JSON blob
 * with per-unit price entries like:
 *   "prices": [{"price": "$0.40", "title": "per second of output video", ...}]
 * We fetch the page and extract those entries. Fail-soft: any fetch/parse
 * problem yields a null price for that model, never an error.
 */

export interface ReplicateModelPricing {
  model: string;
  /** Human-readable price line, e.g. "$0.20–$0.40 per second of output video". */
  price: string | null;
}

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

interface CacheEntry {
  price: string | null;
  fetchedAt: number;
}

let cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<string | null>>();

/** Test hook. */
export function resetReplicateCatalogCache(): void {
  cache = new Map();
  inflight.clear();
}

/** Only fetch well-formed public slugs; anything else can't be a model page. */
const SLUG_RE = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i;

interface PriceEntry {
  price: string;
  title: string;
}

/** Pull {price,title} pairs out of every `"prices": [...]` array in the page HTML. */
export function extractPriceEntries(html: string): PriceEntry[] {
  const out: PriceEntry[] = [];
  const arrayRe = /"prices":\s*\[(.*?)\]/gs;
  let arr: RegExpExecArray | null;
  while ((arr = arrayRe.exec(html)) !== null) {
    const objRe = /\{[^{}]*\}/g;
    let obj: RegExpExecArray | null;
    while ((obj = objRe.exec(arr[1])) !== null) {
      const price = /"price":\s*"([^"]+)"/.exec(obj[0])?.[1];
      const title = /"title":\s*"([^"]+)"/.exec(obj[0])?.[1];
      if (price && title) out.push({ price, title });
    }
  }
  return out;
}

/** Collapse variant entries into one display line. */
export function formatPriceEntries(entries: PriceEntry[]): string | null {
  if (entries.length === 0) return null;
  // Dedupe identical price+title pairs (pages repeat the blob several times).
  const unique = [...new Map(entries.map((e) => [`${e.price}|${e.title}`, e])).values()];
  const titles = [...new Set(unique.map((e) => e.title))];
  if (titles.length === 1) {
    const numbered = unique
      .map((e) => ({ entry: e, num: Number(e.price.replace(/[^0-9.]/g, "")) }))
      .filter((x) => Number.isFinite(x.num));
    if (unique.length > 1 && numbered.length === unique.length) {
      const min = numbered.reduce((a, b) => (b.num < a.num ? b : a));
      const max = numbered.reduce((a, b) => (b.num > a.num ? b : a));
      // Keep the provider's own formatting ("$0.20", not "$0.2").
      if (min.num !== max.num) return `${min.entry.price}–${max.entry.price} ${titles[0]}`;
    }
    return `${unique[0].price} ${titles[0]}`;
  }
  return unique.map((e) => `${e.price} ${e.title}`).join(" · ");
}

async function fetchModelPrice(slug: string): Promise<string | null> {
  const res = await platformFetch(`https://replicate.com/${slug}`, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; KOKAO admin pricing)" },
  });
  if (!res.ok) return null;
  return formatPriceEntries(extractPriceEntries(await res.text()));
}

async function getModelPrice(slug: string): Promise<string | null> {
  const cached = cache.get(slug);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.price;
  const existing = inflight.get(slug);
  if (existing) return existing;
  const promise = fetchModelPrice(slug)
    .then((price) => {
      cache.set(slug, { price, fetchedAt: Date.now() });
      return price;
    })
    .catch(() => {
      // Fail-soft: keep any stale entry, otherwise report unknown.
      return cached ? cached.price : null;
    })
    .finally(() => {
      inflight.delete(slug);
    });
  inflight.set(slug, promise);
  return promise;
}

/** Look up display pricing for a list of Replicate model slugs. Never throws. */
export async function lookupReplicatePricing(models: string[]): Promise<ReplicateModelPricing[]> {
  return Promise.all(
    models.map(async (model) => ({
      model,
      price: SLUG_RE.test(model) ? await getModelPrice(model) : null,
    })),
  );
}
