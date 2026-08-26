/** Read-only explanation of the runtime AI attempt order; never resolves keys. */
import { computeVideoCostPaise, findModelPrice, getAiCostConfig } from "./aiCost";
import { getAiSpendConfig, withFee } from "./aiSpend";
import { getProviderHealth } from "./providerHealth";
import { rankProviders } from "./providerScore";
import {
  getTextGenSelection,
  resolveOpenRouterKey,
  resolveReplicateTextKey,
} from "./textGen";
import { parseCustomProviderId, resolveCustomProvider } from "./customAiProviders";
import { resolveAiModel } from "./aiModels";
import { textGenHealthKey } from "./textGenFailover";
import { IMAGE_GEN_PROVIDERS, effectiveModel, getImageGenSelection, imageGenHealthKey, isImageGenProviderConfigured, rankImageGenProviders } from "./imageGen";
import { VIDEO_GEN_PROVIDERS, getVideoGenSelection, isVideoGenProviderConfigured, videoGenHealthKey } from "./videoGen";
import { ASR_PROVIDERS, asrHealthKey, getSelectedAsrProviderId, isProviderConfigured } from "./asr";
import { SARVAM_TTS_MODEL, isSarvamConfigured, sarvamTtsHealthKey } from "./sarvamTts";
import { isTtsProviderConfigured, orderedTtsProviders, ttsHealthKey } from "./videoGen/topicVideo/tts";

type PricedKind = "text" | "image" | "video";
export const FALLBACK_REPORT_VIDEO_DURATION_SEC = 5;
export interface AdminAiFallbackCandidate {
  provider: string; label: string; model: string | null; role: "primary" | "alternate" | "cross-provider" | "selectable";
  configured: boolean; healthy: boolean; eligible: boolean; skipReason: string | null;
  priceLabel: string; customerEstimatePaise: number | null; estimateDurationSec: number | null;
}
function healthy(key: string) {
  const breaker = getProviderHealth(key);
  return !breaker?.openUntil || breaker.openUntil <= Date.now();
}
function priceFields(row: Awaited<ReturnType<typeof findModelPrice>>) {
  if (!row) return { label: "Missing price", estimate: null };
  const pairs: [number | null, string][] = [
    [row.usdPerImage, "image"], [row.usdPerSecond, "second"], [row.usdPerVideo, "video"],
    [row.inputUsdPerMtok, "input 1M tokens"], [row.outputUsdPerMtok, "output 1M tokens"],
  ];
  const values = pairs.filter((p): p is [number, string] => p[0] !== null);
  return { label: values.length ? values.map(([v, unit]) => `$${v}/${unit}`).join(" · ") : "Missing price", estimate: null as number | null };
}
/** Kept pure so the pricing-gate contract is tested without credentials or DB. */
export function deriveFallbackEligibility(args: { configured: boolean; healthy: boolean; hasPrice: boolean; priceRequired: boolean }) {
  if (!args.configured) return { eligible: false, skipReason: "Provider is not configured." };
  if (!args.healthy) return { eligible: false, skipReason: "Provider circuit breaker is open." };
  if (args.priceRequired && !args.hasPrice) return { eligible: false, skipReason: "Missing price: video runtime will not attempt this model." };
  return { eligible: true, skipReason: null };
}
async function makeCandidate(args: {
  kind?: PricedKind; provider: string; label: string; model: string | null; role: AdminAiFallbackCandidate["role"];
  configured: boolean; healthy: boolean; priceRequired?: boolean;
}): Promise<AdminAiFallbackCandidate> {
  const price = args.kind && args.model ? await findModelPrice(args.kind, args.provider, args.model) : null;
  const fields = args.kind ? priceFields(price) : { label: "Price not tracked", estimate: null };
  const [cost, spend] = await Promise.all([getAiCostConfig(), getAiSpendConfig()]);
  // Flat image/video units have a useful one-unit customer estimate. Token
  // prices intentionally remain a unit rate; request tokens are unknown here.
  const usd = price?.usdPerImage ?? price?.usdPerVideo ?? price?.usdPerSecond ?? null;
  const videoCost = args.kind === "video" && args.model ? await computeVideoCostPaise({ provider: args.provider, model: args.model, durationSec: FALLBACK_REPORT_VIDEO_DURATION_SEC }) : null;
  const estimate = args.kind === "video" ? (videoCost === null ? null : withFee(videoCost, spend.feePercent)) : usd !== null && cost.usdToInrPaise > 0 ? withFee(Math.round(usd * cost.usdToInrPaise), spend.feePercent) : null;
  const eligibility = deriveFallbackEligibility({ configured: args.configured, healthy: args.healthy, hasPrice: args.kind === "video" ? videoCost !== null : !!price, priceRequired: !!args.priceRequired });
  return {
    ...args,
    ...eligibility,
    priceLabel: args.kind === "video" && price && videoCost === null ? "Unusable price (rate/FX)" : fields.label,
    customerEstimatePaise: estimate,
    estimateDurationSec: args.kind === "video" && estimate !== null ? FALLBACK_REPORT_VIDEO_DURATION_SEC : null,
  };
}
function ordered<T>(items: T[], selected: string, id: (item: T) => string) {
  return [...items].sort((a, b) => Number(id(b) === selected) - Number(id(a) === selected));
}

function hasNoUsableFallback(candidates: AdminAiFallbackCandidate[]): boolean {
  return !candidates.slice(1).some((candidate) => candidate.eligible);
}

async function isTextProviderConfigured(provider: string): Promise<boolean> {
  if (provider === "builtin") return true;
  if (provider === "openrouter") return (await resolveOpenRouterKey()) !== null;
  if (provider === "replicate") return (await resolveReplicateTextKey()) !== null;
  if (parseCustomProviderId(provider) !== null) {
    const custom = await resolveCustomProvider(provider);
    return Boolean(custom?.textEnabled);
  }
  return false;
}

async function videoGroup(mode: "text" | "image", selectedProvider: string, selectedModel: string | null) {
  const selected = VIDEO_GEN_PROVIDERS.find((p) => p.id === selectedProvider);
  const models = selected
    ? [selectedModel ?? (mode === "text" ? selected.defaultTextToVideoModel : selected.defaultImageToVideoModel),
      ...((mode === "text" ? selected.textModelOptions : selected.imageModelOptions) ?? []).map((m) => m.value)]
        .filter((m, i, all) => Boolean(m) && all.indexOf(m) === i).slice(0, 3)
    : [];
  const selectedConfigured = selected ? await isVideoGenProviderConfigured(selected) : false;
  const primary = await Promise.all(models.map((model, index) => makeCandidate({
    kind: "video", provider: selectedProvider, label: selected?.label ?? selectedProvider, model,
    role: index === 0 ? "primary" : "alternate", configured: selectedConfigured,
    healthy: healthy(videoGenHealthKey(selectedProvider)), priceRequired: true,
  })));
  const cross = await Promise.all(VIDEO_GEN_PROVIDERS.filter((p) => p.id !== selectedProvider).map(async (p) =>
    makeCandidate({ kind: "video", provider: p.id, label: p.label,
      model: mode === "text" ? p.defaultTextToVideoModel : p.defaultImageToVideoModel, role: "cross-provider",
      configured: await isVideoGenProviderConfigured(p), healthy: healthy(videoGenHealthKey(p.id)), priceRequired: true })));
  const candidates = [...primary, ...cross];
  return { family: mode === "text" ? "text-to-video" : "image-to-video", selected: selectedProvider, candidates,
    noUsableFallback: hasNoUsableFallback(candidates), note: `Selected provider models are attempted first; up to two catalog alternates precede cross-provider defaults. Price eligibility and estimate use a representative ${FALLBACK_REPORT_VIDEO_DURATION_SEC}s clip.` };
}
export async function buildAdminAiFallbackReport() {
  const [text, image, video, asr, sarvam] = await Promise.all([getTextGenSelection(), getImageGenSelection(), getVideoGenSelection(), getSelectedAsrProviderId(), isSarvamConfigured()]);
  const rankedImages = await rankImageGenProviders(undefined, false);
  const imageDefs = image.provider === "auto"
    ? rankedImages.map((rank) => IMAGE_GEN_PROVIDERS.find((p) => p.id === rank.id)!).filter(Boolean).slice(0, 3)
    : (() => {
      const selected = IMAGE_GEN_PROVIDERS.find((p) => p.id === image.provider) ?? IMAGE_GEN_PROVIDERS[0]!;
      return [selected, ...rankedImages.map((r) => IMAGE_GEN_PROVIDERS.find((p) => p.id === r.id)!).filter((p) => p && p.id !== selected.id).slice(0, 2)];
    })();
  const imageCandidates = await Promise.all(imageDefs.map(async (p, index) => makeCandidate({
    kind: "image", provider: p.id, label: p.label, model: p.id === image.provider ? effectiveModel(p, image.model) : p.defaultModel,
    role: index === 0 ? "primary" : "alternate", configured: await isImageGenProviderConfigured(p), healthy: healthy(imageGenHealthKey(p.id)),
  })));
  const textRows = [{ provider: text.provider, model: text.defaultModel, role: "primary" as const },
    ...(text.provider === "builtin" ? [] : [{
      provider: "builtin",
      model: resolveAiModel(text.defaultModel ?? ""),
      role: "alternate" as const,
    }])];
  const textCandidates = await Promise.all(textRows.map(async (p) => makeCandidate({
    kind: "text", provider: p.provider, label: p.provider === "builtin" ? "Built-in OpenAI" : p.provider, model: p.model,
    role: p.role, configured: await isTextProviderConfigured(p.provider), healthy: healthy(textGenHealthKey(p.provider)),
    priceRequired: p.role === "alternate",
  })));
  const selectedAsr = ASR_PROVIDERS.find((p) => p.id === asr)!;
  const asrAlternates = (await Promise.all(ASR_PROVIDERS.filter((p) => p.id !== asr).map(async (p) => ({ p, configured: await isProviderConfigured(p) })))).filter((x) => x.configured).map((x) => x.p);
  const asrOrder = [selectedAsr, ...rankProviders(asrAlternates.map((p) => ({ id: p.id, key: asrHealthKey(p.id) })), { latencyReferenceMs: 20_000 }).slice(0, 2).map((r) => asrAlternates.find((p) => p.id === r.id)!)];
  const asrCandidates = await Promise.all(asrOrder.map(async (p, index) => makeCandidate({
    provider: p.id, label: p.label, model: p.model, role: index === 0 ? "primary" : "alternate",
    configured: await isProviderConfigured(p), healthy: healthy(asrHealthKey(p.id)),
  })));
  const replicate = VIDEO_GEN_PROVIDERS.find((provider) => provider.id === "replicate");
  const lipSyncCandidates = [await makeCandidate({
    kind: "video",
    provider: "replicate",
    label: "Replicate LatentSync",
    model: "sync/lipsync-2",
    role: "primary",
    configured: replicate ? await isVideoGenProviderConfigured(replicate) : false,
    healthy: healthy(videoGenHealthKey("replicate")),
    priceRequired: true,
  })];
  const ttsCandidates = await Promise.all(
    (await orderedTtsProviders()).map(async (provider, index) =>
      makeCandidate({
        provider: provider.id,
        label: provider.label,
        model: null,
        role: index === 0 ? "primary" : "alternate",
        configured: await isTtsProviderConfigured(provider),
        healthy: healthy(ttsHealthKey(provider.id)),
      }),
    ),
  );
  const groups = [
    { family: "text", selected: text.provider, candidates: textCandidates, noUsableFallback: hasNoUsableFallback(textCandidates), note: "Runtime text failover is health-driven; pricing is informational for the selected model." },
    { family: "image", selected: image.provider, candidates: imageCandidates, noUsableFallback: hasNoUsableFallback(imageCandidates), note: image.provider === "auto" ? "Dynamic scorer order (health, speed, price and quality) for a prompt without reference/transparency constraints." : "Selected provider is first; runtime tries up to two configured alternatives after transient failures." },
    await videoGroup("text", video.provider, video.textToVideoModel),
    await videoGroup("image", video.provider, video.imageToVideoModel),
    { family: "tts", selected: ttsCandidates[0]?.provider ?? "none", candidates: ttsCandidates, noUsableFallback: hasNoUsableFallback(ttsCandidates), note: "Normal narration uses configured providers in health order; OpenAI leads unless its breaker is open. Prices are not tracked." },
    { family: "localized-tts", selected: "job snapshot", candidates: [
      await makeCandidate({ provider: "openai", label: "OpenAI localized narration", model: "gpt-audio", role: "selectable", configured: true, healthy: healthy(ttsHealthKey("openai")) }),
      await makeCandidate({ provider: "sarvam", label: "Sarvam localized narration", model: SARVAM_TTS_MODEL, role: "selectable", configured: sarvam, healthy: healthy(sarvamTtsHealthKey()) }),
    ], noUsableFallback: true, note: "Each localized job snapshots either OpenAI gpt-audio or Sarvam bulbul:v3; these are selectable routes, not a fallback chain." },
    { family: "asr", selected: asr, candidates: asrCandidates, noUsableFallback: hasNoUsableFallback(asrCandidates), note: "ASR prices are not tracked in ai_model_prices." },
    { family: "lip-sync-standard", selected: "replicate", candidates: [await makeCandidate({ kind: "video", provider: "replicate", label: "LatentSync standard", model: "bytedance/latentsync", role: "primary", configured: replicate ? await isVideoGenProviderConfigured(replicate) : false, healthy: healthy(videoGenHealthKey("replicate")), priceRequired: true })], noUsableFallback: true, note: "Standard video lip-sync route; no alternate provider." },
    { family: "lip-sync-high-quality", selected: "replicate", candidates: lipSyncCandidates, noUsableFallback: true, note: "High Quality video lip-sync uses sync/lipsync-2; no alternate provider." },
    { family: "lip-sync-portrait", selected: video.lipSyncPortraitModel ?? "none", candidates: video.lipSyncPortraitModel ? [await makeCandidate({ kind: "video", provider: "replicate", label: "Admin-configured portrait lip-sync", model: video.lipSyncPortraitModel, role: "primary", configured: replicate ? await isVideoGenProviderConfigured(replicate) : false, healthy: healthy(videoGenHealthKey("replicate")), priceRequired: true })] : [], noUsableFallback: true, note: "Portrait route is available only when an admin configures a portrait model; no alternate provider." },
  ];
  return { generatedAt: new Date().toISOString(), families: groups };
}