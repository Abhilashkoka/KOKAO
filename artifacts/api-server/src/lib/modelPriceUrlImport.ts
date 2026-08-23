import { lookupGeminiPricing } from "./geminiCatalog";
import { lookupOpenAiPricing } from "./openaiCatalog";
import { lookupOpenRouterPricing, lookupOpenRouterVideoPricing } from "./openrouterCatalog";
import { lookupReplicateTokenPricing, lookupReplicateUnitPricing } from "./replicateCatalog";

export type ModelPriceKind = "text" | "image" | "video";
export type ModelPriceProvider = "replicate" | "openrouter" | "openai" | "gemini";

export interface ImportedModelPrice {
  sourceUrl: string;
  provider: ModelPriceProvider;
  model: string;
  kind: ModelPriceKind;
  inputUsdPerMtok: number | null;
  outputUsdPerMtok: number | null;
  usdPerImage: number | null;
  usdPerSecond: number | null;
  usdPerVideo: number | null;
  warnings: string[];
}

const REPLICATE_SEGMENT_RE = /^[a-z0-9][a-z0-9._-]*$/i;
const OPENROUTER_SEGMENT_RE = /^[a-z0-9][a-z0-9._:-]*$/i;
const OFFICIAL_MODEL_SEGMENT_RE = /^[a-z0-9][a-z0-9._-]*$/i;

/**
 * Accept only canonical public model-page URLs. This deliberately does not
 * fetch the submitted URL: callers use the parsed slug with fixed-host public
 * catalog clients instead, avoiding redirects and arbitrary outbound hosts.
 */
export function parseOfficialModelPriceUrl(sourceUrl: string): {
  provider: ModelPriceProvider;
  model: string;
} {
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    throw new Error("Provide an official HTTPS Replicate, OpenRouter, OpenAI, or Google Gemini model URL.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  ) {
    throw new Error("Model price URLs must be a plain official HTTPS model-page URL.");
  }
  const segments = url.pathname.split("/").filter(Boolean);
  const host = url.hostname.toLowerCase();
  if (
    host === "replicate.com" &&
    segments.length === 2 &&
    segments.every((segment) => REPLICATE_SEGMENT_RE.test(segment))
  ) {
    return { provider: "replicate", model: segments.join("/") };
  }
  if (
    host === "openrouter.ai" &&
    segments.length === 2 &&
    segments.every((segment) => OPENROUTER_SEGMENT_RE.test(segment))
  ) {
    return { provider: "openrouter", model: segments.join("/") };
  }
  if (
    host === "developers.openai.com" &&
    segments.length === 4 &&
    segments[0] === "api" &&
    segments[1] === "docs" &&
    segments[2] === "models" &&
    OFFICIAL_MODEL_SEGMENT_RE.test(segments[3])
  ) {
    return { provider: "openai", model: segments[3] };
  }
  if (
    host === "ai.google.dev" &&
    segments.length === 4 &&
    segments[0] === "gemini-api" &&
    segments[1] === "docs" &&
    segments[2] === "models" &&
    OFFICIAL_MODEL_SEGMENT_RE.test(segments[3])
  ) {
    return { provider: "gemini", model: segments[3] };
  }
  if (!["replicate.com", "openrouter.ai", "developers.openai.com", "ai.google.dev"].includes(host)) {
    throw new Error("Only official Replicate, OpenRouter, OpenAI, and Google Gemini model URLs are supported.");
  }
  throw new Error("The URL must use the exact official provider model-page shape.");
}

function empty(
  sourceUrl: string,
  provider: ModelPriceProvider,
  model: string,
  kind: ModelPriceKind,
): Omit<ImportedModelPrice, "warnings"> {
  return {
    sourceUrl,
    provider,
    model,
    kind,
    inputUsdPerMtok: null,
    outputUsdPerMtok: null,
    usdPerImage: null,
    usdPerSecond: null,
    usdPerVideo: null,
  };
}

export async function previewModelPriceImport(
  sourceUrl: string,
  kind: ModelPriceKind,
): Promise<ImportedModelPrice> {
  const { provider, model } = parseOfficialModelPriceUrl(sourceUrl);
  const proposed = empty(sourceUrl, provider, model, kind);
  if (provider === "openrouter") {
    if (kind === "video") {
      const [pricing] = await lookupOpenRouterVideoPricing([model]);
      proposed.usdPerSecond = pricing?.usdPerSecond ?? null;
    } else {
      const [pricing] = await lookupOpenRouterPricing([model]);
      proposed.inputUsdPerMtok = pricing?.inputPerMTokens ?? null;
      proposed.outputUsdPerMtok =
        kind === "image"
          ? (pricing?.imageOutputPerMTokens ?? pricing?.outputPerMTokens ?? null)
          : (pricing?.outputPerMTokens ?? null);
    }
  } else if (provider === "replicate" && kind === "text") {
    const [pricing] = await lookupReplicateTokenPricing([model]);
    proposed.inputUsdPerMtok = pricing?.inputPerMTokens ?? null;
    proposed.outputUsdPerMtok = pricing?.outputPerMTokens ?? null;
  } else if (provider === "replicate") {
    const [pricing] = await lookupReplicateUnitPricing([model]);
    proposed.usdPerImage = kind === "image" ? (pricing?.usdPerImage ?? null) : null;
    proposed.usdPerSecond = kind === "video" ? (pricing?.usdPerSecond ?? null) : null;
    proposed.usdPerVideo = kind === "video" ? (pricing?.usdPerVideo ?? null) : null;
  } else if (provider === "openai" && kind !== "video") {
    const [pricing] = await lookupOpenAiPricing([model]);
    proposed.inputUsdPerMtok = pricing?.inputPerMTokens ?? null;
    proposed.outputUsdPerMtok = pricing?.outputPerMTokens ?? null;
  } else if (provider === "gemini" && kind !== "video") {
    const [pricing] = await lookupGeminiPricing([model]);
    proposed.inputUsdPerMtok = pricing?.inputPerMTokens ?? null;
    proposed.outputUsdPerMtok = pricing?.outputPerMTokens ?? null;
    proposed.usdPerImage = kind === "image" ? (pricing?.usdPerImage ?? null) : null;
  }

  const hasTokenPair =
    proposed.inputUsdPerMtok !== null && proposed.outputUsdPerMtok !== null;
  const isImportable =
    kind === "text"
      ? hasTokenPair
      : kind === "image"
        ? proposed.usdPerImage !== null || hasTokenPair
        : proposed.usdPerSecond !== null || proposed.usdPerVideo !== null;
  return {
    ...proposed,
    warnings: isImportable
      ? []
      : ["The official catalog did not publish a complete supported price for this model and kind."],
  };
}