import { logger } from "./logger";
import { platformFetch } from "./platformFetch";

export interface OpenAiModelPricing {
  model: string;
  inputPerMTokens: number | null;
  outputPerMTokens: number | null;
}

const PRICING_URL = "https://developers.openai.com/api/docs/pricing.md";
const CACHE_TTL_MS = 60 * 60 * 1000;

let cache: { fetchedAt: number; prices: Map<string, OpenAiModelPricing> } | null = null;
let inflight: Promise<Map<string, OpenAiModelPricing>> | null = null;

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isDivider(line: string): boolean {
  return /^\s*\|?[\s:|-]+\|/.test(line);
}

function pricingTier(line: string): "standard" | "other" | null {
  const normalized = line
    .replace(/^\\?#{1,6}\s*/, "")
    .replace(/[*_]/g, "")
    .trim()
    .toLowerCase();
  if (/^standard(?:\s+.*)?$/.test(normalized)) return "standard";
  if (/^(?:batch|flex|fast mode|priority)(?:\s+.*)?$/.test(normalized)) return "other";
  return null;
}

function dollars(value: string): number | null {
  const raw = /\$([\d,]+(?:\.\d+)?)/.exec(value)?.[1];
  if (!raw) return null;
  const parsed = Number(raw.replace(/,/g, ""));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * OpenAI publishes its entire public API price catalog as server-rendered
 * Markdown. Read only that fixed document: submitted model documentation URLs
 * are parsed for identity, never fetched.
 */
export function extractOpenAiPricing(markdown: string): Map<string, OpenAiModelPricing> {
  const lines = markdown.split(/\r?\n/);
  const prices = new Map<string, OpenAiModelPricing>();
  let currentTier: "standard" | "other" | null = null;
  for (let index = 0; index + 2 < lines.length; index += 1) {
    currentTier = pricingTier(lines[index]) ?? currentTier;
    if (!lines[index].includes("|") || !isDivider(lines[index + 1])) continue;
    // Batch, Flex, Fast, and Priority prices are opt-in discounts/uplifts, not
    // the default amount KOKAO must reserve for an ordinary provider request.
    if (currentTier !== "standard") continue;
    const header = cells(lines[index]).map((cell) => cell.toLowerCase());
    const modelIndex = header.findIndex((cell) => cell === "model");
    const modalityIndex = header.findIndex((cell) => cell === "modality");
    const inputIndex = header.findIndex((cell) => cell.includes("input") && !cell.includes("cached"));
    const outputIndex = header.findIndex((cell) => cell === "output" || cell.endsWith(" output"));
    if (modelIndex < 0 || inputIndex < 0 || outputIndex < 0) continue;

    for (let rowIndex = index + 2; rowIndex < lines.length && lines[rowIndex].includes("|"); rowIndex += 1) {
      const row = cells(lines[rowIndex]);
      const rawModel = row[modelIndex]?.replace(/[`*_]/g, "").trim();
      if (!rawModel || rawModel === "Text" || rawModel === "Image") continue;
      const model = rawModel.replace(/\s*\(.+\)$/, "").trim();
      if (!/^[a-z0-9][a-z0-9._-]*$/i.test(model)) continue;
      const input = dollars(row[inputIndex] ?? "");
      const output = dollars(row[outputIndex] ?? "");
      if (input === null && output === null) continue;
      const existing = prices.get(model);
      // Within the Standard tier, prefer the image-modality row for image
      // models; otherwise retain the first standard-price row.
      const isImageModality =
        modalityIndex >= 0 && row[modalityIndex]?.trim().toLowerCase() === "image";
      if (!existing || isImageModality) {
        prices.set(model, { model, inputPerMTokens: input, outputPerMTokens: output });
      }
    }
  }
  return prices;
}

async function loadCatalog(): Promise<Map<string, OpenAiModelPricing>> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.prices;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const response = await platformFetch(PRICING_URL, { headers: { Accept: "text/markdown" } });
      if (!response.ok) throw new Error(`OpenAI pricing catalog responded ${response.status}`);
      const prices = extractOpenAiPricing(await response.text());
      cache = { fetchedAt: Date.now(), prices };
      return prices;
    } catch (err) {
      logger.warn({ err }, "OpenAI pricing catalog fetch failed; pricing unavailable");
      return cache?.prices ?? new Map();
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export async function lookupOpenAiPricing(models: string[]): Promise<OpenAiModelPricing[]> {
  const catalog = await loadCatalog();
  return models.map(
    (model) =>
      catalog.get(model) ?? { model, inputPerMTokens: null, outputPerMTokens: null },
  );
}

/** Test hook. */
export function resetOpenAiCatalogCache(): void {
  cache = null;
  inflight = null;
}