import { lookupOpenRouterPricing, lookupOpenRouterVideoPricing } from "./openrouterCatalog";
import { lookupReplicateTokenPricing, lookupReplicateUnitPricing } from "./replicateCatalog";

export type ModelPriceKind = "text" | "image" | "video";
export type ModelPriceProvider = "replicate" | "openrouter";

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
    throw new Error("Provide an official HTTPS Replicate or OpenRouter model-page URL.");
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
  const provider =
    url.hostname.toLowerCase() === "replicate.com"
      ? "replicate"
      : url.hostname.toLowerCase() === "openrouter.ai"
        ? "openrouter"
        : null;
  if (!provider) {
    throw new Error("Only official Replicate and OpenRouter model-page URLs are supported.");
  }
  const segments = url.pathname.split("/").filter(Boolean);
  const segmentRe = provider === "replicate" ? REPLICATE_SEGMENT_RE : OPENROUTER_SEGMENT_RE;
  if (segments.length !== 2 || !segments.every((segment) => segmentRe.test(segment))) {
    throw new Error("The URL must use the official provider model-page shape: https://host/owner/model.");
  }
  return { provider, model: segments.join("/") };
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
  } else if (kind === "text") {
    const [pricing] = await lookupReplicateTokenPricing([model]);
    proposed.inputUsdPerMtok = pricing?.inputPerMTokens ?? null;
    proposed.outputUsdPerMtok = pricing?.outputPerMTokens ?? null;
  } else {
    const [pricing] = await lookupReplicateUnitPricing([model]);
    proposed.usdPerImage = kind === "image" ? (pricing?.usdPerImage ?? null) : null;
    proposed.usdPerSecond = kind === "video" ? (pricing?.usdPerSecond ?? null) : null;
    proposed.usdPerVideo = kind === "video" ? (pricing?.usdPerVideo ?? null) : null;
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