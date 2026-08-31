import { platformFetch } from "./platformFetch";
import type { VideoPriceCriteria } from "@workspace/db";

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
  /** Published price variants, including conditions used to select each rate. */
  entries: PriceEntry[];
}

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

interface CacheEntry {
  entries: PriceEntry[];
  fetchedAt: number;
}

let cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<PriceEntry[]>>();

/** Test hook. */
export function resetReplicateCatalogCache(): void {
  cache = new Map();
  inflight.clear();
}

/** Only fetch well-formed public slugs; anything else can't be a model page. */
const SLUG_RE = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/i;

export type ReplicatePriceCriteria = VideoPriceCriteria;

export interface PriceEntry {
  price: string;
  title: string;
  /**
   * Provider conditions normalized for runtime matching. Known Seedance
   * conditions use `resolution` and `inputMode`; other provider conditions are
   * retained under a normalized camelCase key for review rather than dropped.
   */
  criteria: ReplicatePriceCriteria;
}

function normalizedKey(value: string): string {
  const words = value
    .trim()
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return words.map((word, index) => (index === 0 ? word : `${word[0].toUpperCase()}${word.slice(1)}`)).join("");
}

function normalizedValue(value: unknown): string | null {
  if (typeof value === "string") return value.trim().toLowerCase();
  if (typeof value === "number" || typeof value === "boolean") return String(value).toLowerCase();
  return null;
}

function addCriterion(criteria: ReplicatePriceCriteria, rawKey: string, rawValue: unknown): void {
  const value = normalizedValue(rawValue);
  if (!value) return;
  const key = normalizedKey(rawKey);
  if (!key) return;
  // Veo pages publish audio pricing as an unlabelled condition value
  // (`with_audio` / `without_audio`). Normalize it to the runtime request
  // field so variant-aware activation and cost lookup can select the row.
  if (value === "with_audio" || value === "without_audio") {
    criteria.generateAudio = value === "with_audio";
    return;
  }
  // Replicate uses both `input_type` and `input` in its page data.
  if (key === "input" || key === "inputType" || key === "inputMode") {
    if (value === "video_in" || value === "video" || value === "video input") {
      criteria.inputMode = "video";
      return;
    }
    if (value === "non_video_in" || value === "non-video_in" || value === "non video input") {
      criteria.inputMode = "non_video";
      return;
    }
  }
  criteria[key] = value;
  // Some pages publish resolution as an unlabelled condition value.
  if (!criteria.resolution && /^\d{3,4}p$/.test(value)) criteria.resolution = value;
  if (!criteria.inputMode && (value === "video_in" || value === "non_video_in")) {
    criteria.inputMode = value === "video_in" ? "video" : "non_video";
  }
}

function criteriaFrom(source: unknown, inherited: ReplicatePriceCriteria = {}): ReplicatePriceCriteria {
  const criteria = { ...inherited };
  if (!source || typeof source !== "object" || Array.isArray(source)) return criteria;
  const record = source as Record<string, unknown>;
  for (const field of ["criteria", "conditions", "condition"] as const) {
    const value = record[field];
    const items = Array.isArray(value) ? value : value ? [value] : [];
    for (const item of items) {
      if (typeof item === "string") {
        addCriterion(criteria, "condition", item);
      } else if (item && typeof item === "object" && !Array.isArray(item)) {
        const condition = item as Record<string, unknown>;
        const name = condition.field ?? condition.key ?? condition.name ?? condition.type;
        const value = condition.value ?? condition.values;
        if (typeof name === "string") addCriterion(criteria, name, value);
        else if (value !== undefined) addCriterion(criteria, "condition", value);
        else {
          // `criteria` is sometimes a direct object, not condition records.
          // Keep every scalar field so a newly introduced provider dimension
          // remains visible to admins even before runtime support is added.
          for (const [key, unknownValue] of Object.entries(condition)) {
            addCriterion(criteria, key, unknownValue);
          }
        }
      }
    }
  }
  // A few page payloads put dimensions directly on the variant.
  for (const [key, value] of Object.entries(record)) {
    if (["criteria", "conditions", "condition", "prices", "price", "title"].includes(key)) continue;
    if (["resolution", "input", "input_type", "inputType", "input_mode", "inputMode"].includes(key)) {
      addCriterion(criteria, key, value);
    }
  }
  return criteria;
}

function entriesFromPayload(payload: unknown, inherited: ReplicatePriceCriteria = {}): PriceEntry[] {
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload)) return payload.flatMap((item) => entriesFromPayload(item, inherited));
  const record = payload as Record<string, unknown>;
  const criteria = criteriaFrom(record, inherited);
  const out: PriceEntry[] = [];
  if (typeof record.price === "string" && typeof record.title === "string") {
    out.push({ price: record.price, title: record.title, criteria });
  }
  for (const [key, value] of Object.entries(record)) {
    if (key === "criteria" || key === "conditions" || key === "condition") continue;
    if (key === "prices" && Array.isArray(value)) {
      for (const price of value) {
        if (price && typeof price === "object") {
          const priceRecord = price as Record<string, unknown>;
          if (typeof priceRecord.price === "string" && typeof priceRecord.title === "string") {
            out.push({
              price: priceRecord.price,
              title: priceRecord.title,
              criteria: criteriaFrom(priceRecord, criteria),
            });
          }
        }
      }
      continue;
    }
    if (value && typeof value === "object") out.push(...entriesFromPayload(value, criteria));
  }
  return out;
}

/** Parse JSON objects embedded in scripts, attributes, or page data. */
function embeddedJsonEntries(html: string): PriceEntry[] {
  const out: PriceEntry[] = [];
  const objectStarts = [...html.matchAll(/\{/g)].map((match) => match.index!);
  for (const start of objectStarts) {
    let depth = 0;
    let quote = "";
    let escaped = false;
    for (let end = start; end < html.length; end += 1) {
      const char = html[end];
      if (quote) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === quote) quote = "";
        continue;
      }
      if (char === "\"" || char === "'") {
        quote = char;
      } else if (char === "{") {
        depth += 1;
      } else if (char === "}" && --depth === 0) {
        const candidate = html.slice(start, end + 1);
        if (!candidate.includes('"prices"')) break;
        try {
          out.push(...entriesFromPayload(JSON.parse(candidate)));
        } catch {
          // Most braces are HTML/CSS or a partial outer document object.
        }
        break;
      }
    }
  }
  return dedupePriceEntries(out);
}

function dedupePriceEntries(entries: PriceEntry[]): PriceEntry[] {
  return [
    ...new Map(
      entries.map((entry) => [
        `${entry.price}\u0000${entry.title}\u0000${JSON.stringify(
          Object.fromEntries(Object.entries(entry.criteria).sort(([a], [b]) => a.localeCompare(b))),
        )}`,
        entry,
      ]),
    ).values(),
  ];
}

function markdownPriceEntries(html: string): PriceEntry[] {
  // Replicate's server-rendered pricing section can be a markdown table rather
  // than the hydration payload. Preserve cell boundaries when reducing HTML.
  const text = html
    .replace(/<\/?(?:tr|p|li|br|h[1-6])[^>]*>/gi, "\n")
    .replace(/<\/?(?:td|th)[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&");
  const out: PriceEntry[] = [];
  for (const row of text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
    const resolution = /\b(\d{3,4}p)\b/i.exec(row)?.[1];
    const input = /\b(non[_ -]?video[_ -]?in|video[_ -]?in)\b/i.exec(row)?.[1];
    const price = /\$[0-9]+(?:\.[0-9]+)?/.exec(row)?.[0];
    const title = /(per\s+(?:second(?:\s+of\s+output\s+video)?|(?:output\s+)?video|run))/i.exec(row)?.[1];
    if (!price || !title) continue;
    const criteria: ReplicatePriceCriteria = {};
    if (resolution) addCriterion(criteria, "resolution", resolution);
    if (input) addCriterion(criteria, "input_type", input);
    out.push({ price, title: title.toLowerCase(), criteria });
  }
  return out;
}

/**
 * Pull price entries from Replicate's embedded structured data. The pricing
 * table is also rendered in page markdown/HTML, so accept simple table rows
 * when structured data is unavailable.
 */
export function extractPriceEntries(html: string): PriceEntry[] {
  const out = embeddedJsonEntries(html);
  if (out.length > 0) return out;

  // Some community models are billed by hardware time and publish only an
  // approximate per-run figure in page prose instead of the structured prices
  // array. A successful video-model run yields one video, so this is the flat
  // per-video input the wallet model needs. Keep the provider's "per run"
  // wording visible rather than pretending it is an exact fixed tariff.
  const approximateRun = [
    /(?:each|a)\s+run\s+costs\s+(?:approximately|about|around)\s+\$([0-9]+(?:\.[0-9]+)?)/i,
    /(?:approximately|about|around)\s+\$([0-9]+(?:\.[0-9]+)?)\s+per\s+run/i,
    /costs\s+(?:approximately|about|around)\s+\$([0-9]+(?:\.[0-9]+)?)\s+to\s+run/i,
  ].map((pattern) => pattern.exec(html)).find(Boolean);
  if (approximateRun) {
    return [{ price: `$${approximateRun[1]}`, title: "per run (approximately)", criteria: {} }];
  }
  const markdown = markdownPriceEntries(html);
  return markdown.length > 0 ? markdown : out;
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

async function fetchModelEntries(slug: string): Promise<PriceEntry[]> {
  const res = await platformFetch(`https://replicate.com/${slug}`, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; KOKAO admin pricing)" },
  });
  if (!res.ok) return [];
  return extractPriceEntries(await res.text());
}

async function getModelEntries(slug: string): Promise<PriceEntry[]> {
  const cached = cache.get(slug);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.entries;
  const existing = inflight.get(slug);
  if (existing) return existing;
  const promise = fetchModelEntries(slug)
    .then((entries) => {
      cache.set(slug, { entries, fetchedAt: Date.now() });
      return entries;
    })
    .catch(() => {
      // Fail-soft: keep any stale entry, otherwise report unknown.
      return cached ? cached.entries : [];
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
      price: SLUG_RE.test(model) ? formatPriceEntries(await getModelEntries(model)) : null,
      entries: SLUG_RE.test(model) ? await getModelEntries(model) : [],
    })),
  );
}

export interface ReplicateTokenPricing {
  model: string;
  inputPerMTokens: number | null;
  outputPerMTokens: number | null;
}

function dollars(price: string): number | null {
  const n = Number(price.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * Per-million-token pricing for Replicate-hosted LANGUAGE models, matching the
 * ModelPricingView shape used for OpenRouter. Language model pages carry
 * entries titled "per million input tokens" / "per million output tokens";
 * models without such entries (e.g. video models) come back null/null.
 */
export interface ReplicateUnitPricing {
  model: string;
  /** Highest advertised $/output image, when the page lists one. */
  usdPerImage: number | null;
  /** Highest advertised $/second of output video, when listed. */
  usdPerSecond: number | null;
  /** Highest advertised flat $/video, when listed. */
  usdPerVideo: number | null;
  /** Every published rate; consumers needing accurate variants must use this. */
  entries: PriceEntry[];
}

/** Pick the highest matching entry (conservative when variants differ). */
function maxDollars(entries: PriceEntry[], titleRe: RegExp): number | null {
  const nums = entries
    .filter((e) => titleRe.test(e.title))
    .map((e) => dollars(e.price))
    .filter((n): n is number => n !== null);
  return nums.length > 0 ? Math.max(...nums) : null;
}

/**
 * Structured per-unit pricing for Replicate-hosted IMAGE and VIDEO models,
 * parsed from the same model-page price entries the display lookup uses.
 * Models without matching entries come back all-null.
 */
export async function lookupReplicateUnitPricing(
  models: string[],
): Promise<ReplicateUnitPricing[]> {
  return Promise.all(
    models.map(async (model) => {
      const entries = SLUG_RE.test(model) ? await getModelEntries(model) : [];
      return {
        model,
        usdPerImage: maxDollars(entries, /per (output )?image/i),
        usdPerSecond: maxDollars(entries, /per second/i),
        usdPerVideo: maxDollars(entries, /per (?:output )?video(?! second)|per run/i),
        entries,
      };
    }),
  );
}

export async function lookupReplicateTokenPricing(
  models: string[],
): Promise<ReplicateTokenPricing[]> {
  return Promise.all(
    models.map(async (model) => {
      const entries = SLUG_RE.test(model) ? await getModelEntries(model) : [];
      const input = entries.find((e) => /per million input tokens/i.test(e.title));
      const output = entries.find((e) => /per million output tokens/i.test(e.title));
      return {
        model,
        inputPerMTokens: input ? dollars(input.price) : null,
        outputPerMTokens: output ? dollars(output.price) : null,
      };
    }),
  );
}
