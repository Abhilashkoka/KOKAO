import { logger } from "./logger";
import { platformFetch } from "./platformFetch";

export interface GeminiModelPricing {
  model: string;
  inputPerMTokens: number | null;
  outputPerMTokens: number | null;
  usdPerImage: number | null;
}

const PRICING_URL = "https://ai.google.dev/gemini-api/docs/pricing?hl=en";
const CACHE_TTL_MS = 60 * 60 * 1000;

let cache: { fetchedAt: number; prices: Map<string, GeminiModelPricing> } | null = null;
let inflight: Promise<Map<string, GeminiModelPricing>> | null = null;

function firstDollars(value: string): number | null {
  const raw = /\$([\d,]+(?:\.\d+)?)/.exec(value)?.[1];
  if (!raw) return null;
  const parsed = Number(raw.replace(/,/g, ""));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Google publishes the paid API price beside each model's exact API identifier
 * in one canonical public page. The parser keeps only the standard (first)
 * paid rate for each model; it does not derive a rate from free-tier text,
 * batches, or usage tiers.
 */
function fromPriceLines(
  model: string,
  inputLine: string | undefined,
  outputLine: string | undefined,
): GeminiModelPricing {
  const output = outputLine ? firstDollars(outputLine) : null;
  const isPerImage = outputLine ? /per image/i.test(outputLine) : false;
  return {
    model,
    inputPerMTokens: inputLine ? firstDollars(inputLine) : null,
    outputPerMTokens: isPerImage ? null : output,
    usdPerImage: isPerImage ? output : null,
  };
}

function stripHtml(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function extractGeminiHtmlPricing(html: string): Map<string, GeminiModelPricing> {
  const prices = new Map<string, GeminiModelPricing>();
  const headingRe = /<h2[^>]*id="([a-z0-9._-]+)"[^>]*>[\s\S]*?<\/h2>/gi;
  const headings = [...html.matchAll(headingRe)];
  for (let index = 0; index < headings.length; index += 1) {
    const start = headings[index].index ?? 0;
    const end = headings[index + 1]?.index ?? html.length;
    const section = html.slice(start, end);
    const model =
      /<code[^>]*>\s*([a-z0-9][a-z0-9._-]*)\s*<\/code>/i.exec(section)?.[1] ??
      headings[index][1];
    const standardTable =
      /<h3[^>]*id="standard[^"]*"[^>]*>[\s\S]*?<\/h3>\s*<table[^>]*>([\s\S]*?)<\/table>/i.exec(
        section,
      )?.[1];
    if (!standardTable) continue;
    const rows = [...standardTable.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) =>
      [...match[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) =>
        stripHtml(cell[1]),
      ),
    );
    const input = rows.find((row) => /^input price$/i.test(row[0] ?? ""));
    const output = rows.find((row) => /^output price\b/i.test(row[0] ?? ""));
    if (!input && !output) continue;
    prices.set(model, fromPriceLines(model, input?.at(-1), output?.at(-1)));
  }
  return prices;
}

export function extractGeminiPricing(document: string): Map<string, GeminiModelPricing> {
  if (/<h2\b/i.test(document)) return extractGeminiHtmlPricing(document);
  const prices = new Map<string, GeminiModelPricing>();
  const sections = document.split(/\n(?=## )/);
  for (const section of sections) {
    const model = /`([a-z0-9][a-z0-9._-]*)`/i.exec(section)?.[1];
    if (!model) continue;
    const inputLine = section
      .split(/\r?\n/)
      .find((line) => /^\|\s*Input price\s*\|/i.test(line));
    const outputLine = section
      .split(/\r?\n/)
      .find((line) => /^\|\s*Output price\b/i.test(line));
    if (!inputLine && !outputLine) continue;
    prices.set(
      model,
      fromPriceLines(
        model,
        inputLine?.split("|").at(-2),
        outputLine?.split("|").at(-2),
      ),
    );
  }
  return prices;
}

async function loadCatalog(): Promise<Map<string, GeminiModelPricing>> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.prices;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const response = await platformFetch(PRICING_URL, {
        headers: { Accept: "text/html", "Accept-Language": "en-US,en;q=0.9" },
      });
      if (!response.ok) throw new Error(`Gemini pricing catalog responded ${response.status}`);
      const prices = extractGeminiPricing(await response.text());
      cache = { fetchedAt: Date.now(), prices };
      return prices;
    } catch (err) {
      logger.warn({ err }, "Gemini pricing catalog fetch failed; pricing unavailable");
      return cache?.prices ?? new Map();
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export async function lookupGeminiPricing(models: string[]): Promise<GeminiModelPricing[]> {
  const catalog = await loadCatalog();
  return models.map(
    (model) =>
      catalog.get(model) ?? {
        model,
        inputPerMTokens: null,
        outputPerMTokens: null,
        usdPerImage: null,
      },
  );
}

/** Test hook. */
export function resetGeminiCatalogCache(): void {
  cache = null;
  inflight = null;
}