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
import { isTtsProviderConfigured, orderedTtsProviders, ttsHealthKey, TTS_PROVIDERS } from "./videoGen/topicVideo/tts";
import { validateNvidiaTextActivation } from "./nvidiaAdmin";
import {
  isNvidiaCoreDeploymentActivatable,
  resolveNvidiaCoreDeployment,
} from "./nvidiaCore";
import { applyManualOrder, getAiFallbackOrders } from "./aiFallbackSettings";

type PricedKind = "text" | "image" | "video";
export const FALLBACK_REPORT_VIDEO_DURATION_SEC = 5;
export interface AdminAiFallbackCandidate {
  provider: string; label: string; model: string | null; role: "primary" | "alternate" | "cross-provider" | "selectable";
  configured: boolean; healthy: boolean; eligible: boolean; skipReason: string | null;
  priceLabel: string; customerEstimatePaise: number | null; estimateDurationSec: number | null;
}
export interface AdminAiFallbackAvailableCandidate {
  id: string; provider: string; model: string | null; label: string;
}
function availableCandidates(family: string): AdminAiFallbackAvailableCandidate[] {
  if (family === "image") return IMAGE_GEN_PROVIDERS.map((p) => ({ id: p.id, provider: p.id, model: p.defaultModel, label: p.label }));
  if (family === "asr") return ASR_PROVIDERS.map((p) => ({ id: p.id, provider: p.id, model: p.model, label: p.label }));
  if (family === "tts") return TTS_PROVIDERS.map((p) => ({ id: p.id, provider: p.id, model: null, label: p.label }));
  if (family === "text") return [{ id: "builtin", provider: "builtin", model: null, label: "Built-in OpenAI" }];
  if (family === "text-to-video" || family === "image-to-video") {
    const mode = family === "text-to-video" ? "text" : "image";
    return VIDEO_GEN_PROVIDERS.flatMap((p) => [...new Set([
      mode === "text" ? p.defaultTextToVideoModel : p.defaultImageToVideoModel,
      ...((mode === "text" ? p.textModelOptions : p.imageModelOptions) ?? []).map((option) => option.value),
    ])].map((model) => ({ id: `${p.id}::${model}`, provider: p.id, model, label: `${p.label} (${model})` })));
  }
  return [];
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
export function deriveFallbackEligibility(args: {
  configured: boolean;
  healthy: boolean;
  hasPrice: boolean;
  priceRequired: boolean;
  dependencyReady?: boolean;
  dependencySkipReason?: string;
}) {
  if (!args.configured) return { eligible: false, skipReason: "Provider is not configured." };
  if (!args.healthy) return { eligible: false, skipReason: "Provider circuit breaker is open." };
  if (args.dependencyReady === false) {
    return {
      eligible: false,
      skipReason: args.dependencySkipReason ?? "A required capability is not active.",
    };
  }
  if (args.priceRequired && !args.hasPrice) return { eligible: false, skipReason: "Missing price: video runtime will not attempt this model." };
  return { eligible: true, skipReason: null };
}
async function makeCandidate(args: {
  kind?: PricedKind; provider: string; label: string; model: string | null; role: AdminAiFallbackCandidate["role"];
  configured: boolean; healthy: boolean; priceRequired?: boolean;
  dependencyReady?: boolean; dependencySkipReason?: string;
}): Promise<AdminAiFallbackCandidate> {
  const price = args.kind && args.model ? await findModelPrice(args.kind, args.provider, args.model) : null;
  const fields = args.kind ? priceFields(price) : { label: "Price not tracked", estimate: null };
  const [cost, spend] = await Promise.all([getAiCostConfig(), getAiSpendConfig()]);
  // Flat image/video units have a useful one-unit customer estimate. Token
  // prices intentionally remain a unit rate; request tokens are unknown here.
  const usd = price?.usdPerImage ?? price?.usdPerVideo ?? price?.usdPerSecond ?? null;
  const videoCost = args.kind === "video" && args.model ? await computeVideoCostPaise({ provider: args.provider, model: args.model, durationSec: FALLBACK_REPORT_VIDEO_DURATION_SEC }) : null;
  const estimate = args.kind === "video" ? (videoCost === null ? null : withFee(videoCost, spend.feePercent)) : usd !== null && cost.usdToInrPaise > 0 ? withFee(Math.round(usd * cost.usdToInrPaise), spend.feePercent) : null;
  const eligibility = deriveFallbackEligibility({
    configured: args.configured,
    healthy: args.healthy,
    hasPrice: args.kind === "video" ? videoCost !== null : !!price,
    priceRequired: !!args.priceRequired,
    dependencyReady: args.dependencyReady,
    dependencySkipReason: args.dependencySkipReason,
  });
  // Dependency metadata explains server-side eligibility but is not part of
  // the established candidate response shape.
  const {
    dependencyReady: _dependencyReady,
    dependencySkipReason: _dependencySkipReason,
    ...candidateArgs
  } = args;
  return {
    ...candidateArgs,
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

async function isTextProviderConfigured(provider: string, model: string | null): Promise<boolean> {
  if (provider === "builtin") return true;
  if (provider === "openrouter") return (await resolveOpenRouterKey()) !== null;
  if (provider === "replicate") return (await resolveReplicateTextKey()) !== null;
  // NVIDIA configuration is deployment/model activation state, not a
  // standalone text-provider key. This preserves the exact deployment-model
  // match, test, activation, shared-key and price checks used on save.
  if (provider === "nvidia") {
    return model !== null && (await validateNvidiaTextActivation([model])) === null;
  }
  if (parseCustomProviderId(provider) !== null) {
    const custom = await resolveCustomProvider(provider);
    return Boolean(custom?.textEnabled);
  }
  return false;
}

async function videoGroup(mode: "text" | "image", selectedProvider: string, selectedModel: string | null, manualOrder?: string[]) {
  const selected = VIDEO_GEN_PROVIDERS.find((p) => p.id === selectedProvider);
  const primaryModel = selected
    ? selectedModel ??
      (mode === "text"
        ? selected.defaultTextToVideoModel
        : selected.defaultImageToVideoModel)
    : null;
  const selectedConfigured = selected ? await isVideoGenProviderConfigured(selected) : false;
  const primary = primaryModel
    ? [
        await makeCandidate({
          kind: "video",
          provider: selectedProvider,
          label: selected?.label ?? selectedProvider,
          model: primaryModel,
          role: "primary",
          configured: selectedConfigured,
          healthy: healthy(videoGenHealthKey(selectedProvider)),
          priceRequired: true,
        }),
      ]
    : [];
  const catalog = (
    await Promise.all(
      VIDEO_GEN_PROVIDERS.flatMap((provider) => {
        const models = [
          mode === "text"
            ? provider.defaultTextToVideoModel
            : provider.defaultImageToVideoModel,
          ...(
            (mode === "text"
              ? provider.textModelOptions
              : provider.imageModelOptions) ?? []
          ).map((option) => option.value),
        ].filter(
          (model, index, all): model is string =>
            Boolean(model) && all.indexOf(model) === index,
        );
        return models.map(async (model) => ({
          id: `${provider.id}::${model}`,
          candidate: await makeCandidate({
            kind: "video",
            provider: provider.id,
            label: provider.label,
            model,
            role:
              provider.id === selectedProvider ? "alternate" : "cross-provider",
            configured: await isVideoGenProviderConfigured(provider),
            healthy: healthy(videoGenHealthKey(provider.id)),
            priceRequired: true,
          }),
        }));
      }),
    )
  ).filter(({ id }) => id !== `${selectedProvider}::${primaryModel ?? ""}`);
  const historical = [
    ...catalog.filter(
      ({ candidate }) => candidate.provider === selectedProvider,
    ).slice(0, 2),
    ...catalog.filter(
      ({ candidate }) => candidate.provider !== selectedProvider,
    ),
  ];
  const fallbacks =
    manualOrder === undefined
      ? historical.map(({ candidate }) => candidate)
      : applyManualOrder(catalog, manualOrder, ({ id }) => id).map(
          ({ candidate }) => candidate,
        );
  const candidates = [...primary, ...fallbacks];
  return { family: mode === "text" ? "text-to-video" : "image-to-video", selected: selectedProvider, candidates,
    noUsableFallback: hasNoUsableFallback(candidates), note: `Selected provider models are attempted first; up to two catalog alternates precede cross-provider defaults. Price eligibility and estimate use a representative ${FALLBACK_REPORT_VIDEO_DURATION_SEC}s clip.` };
}
export async function buildAdminAiFallbackReport() {
  const [text, image, video, asr, sarvam] = await Promise.all([getTextGenSelection(), getImageGenSelection(), getVideoGenSelection(), getSelectedAsrProviderId(), isSarvamConfigured()]);
  const [rankedImages, manualOrders] = await Promise.all([rankImageGenProviders(undefined, false), getAiFallbackOrders()]);
  const rankedImageDefs = rankedImages
    .map((rank) => IMAGE_GEN_PROVIDERS.find((p) => p.id === rank.id)!)
    .filter(Boolean);
  const imageDefs = image.provider === "auto"
    ? rankedImageDefs.slice(0, 3)
    : (() => {
      const selected = IMAGE_GEN_PROVIDERS.find((p) => p.id === image.provider) ?? IMAGE_GEN_PROVIDERS[0]!;
      return [selected, ...rankedImageDefs.filter((p) => p.id !== selected.id).slice(0, 2)];
    })();
  const manualImageCatalog =
    image.provider === "auto"
      ? IMAGE_GEN_PROVIDERS
      : IMAGE_GEN_PROVIDERS.filter((provider) => provider.id !== image.provider);
  const reportImageDefs =
    manualOrders.image === undefined
      ? imageDefs
      : image.provider === "auto"
        ? applyManualOrder(
            manualImageCatalog,
            manualOrders.image,
            (provider) => provider.id,
          )
        : [
            imageDefs[0]!,
            ...applyManualOrder(
              manualImageCatalog,
              manualOrders.image,
              (provider) => provider.id,
            ),
          ];
  const imageCandidates = await Promise.all(reportImageDefs.map(async (p, index) => makeCandidate({
    kind: "image", provider: p.id, label: p.label, model: p.id === image.provider ? effectiveModel(p, image.model) : p.defaultModel,
    role: index === 0 ? "primary" : "alternate", configured: await isImageGenProviderConfigured(p), healthy: healthy(imageGenHealthKey(p.id)),
  })));
  const textRows = [{ provider: text.provider, model: text.defaultModel, role: "primary" as const },
    ...(text.provider === "builtin" ? [] : [{
      provider: "builtin",
      model: resolveAiModel(text.defaultModel ?? ""),
      role: "alternate" as const,
    }])];
  const reportTextRows =
    manualOrders.text === undefined
      ? textRows
      : [
          textRows[0]!,
          ...applyManualOrder(
            textRows.slice(1),
            manualOrders.text,
            (candidate) => candidate.provider,
          ),
        ];
  const textCandidates = await Promise.all(reportTextRows.map(async (p) => makeCandidate({
    kind: "text", provider: p.provider, label: p.provider === "builtin" ? "Built-in OpenAI" : p.provider, model: p.model,
    role: p.role, configured: await isTextProviderConfigured(p.provider, p.model), healthy: healthy(textGenHealthKey(p.provider, "text")),
    priceRequired: p.role === "alternate",
  })));
  // NVIDIA routes image_url content parts through a separate deployment from
  // ordinary text. Report that independently tested activation explicitly so
  // a healthy text deployment cannot imply that vision-dependent callers are
  // ready. Other text providers do not have this split deployment contract.
  const nvidiaMultimodalDeployment =
    text.provider === "nvidia" ? await resolveNvidiaCoreDeployment("multimodal") : null;
  const nvidiaMultimodalCandidate =
    text.provider === "nvidia"
      ? await makeCandidate({
          kind: "text",
          provider: "nvidia",
          label: "NVIDIA multimodal (image_url)",
          model: nvidiaMultimodalDeployment?.model ?? null,
          role: "primary",
          configured: nvidiaMultimodalDeployment !== null,
          healthy: healthy(textGenHealthKey("nvidia", "multimodal")),
          dependencyReady: await isNvidiaCoreDeploymentActivatable("multimodal"),
          dependencySkipReason:
            "The NVIDIA multimodal deployment must be enabled, independently tested, credentialed, and exactly priced before image_url calls are eligible.",
        })
      : null;
  const selectedAsr = ASR_PROVIDERS.find((p) => p.id === asr)!;
  const asrAlternates = ASR_PROVIDERS.filter((provider) => provider.id !== asr);
  const orderedAsrAlternates = applyManualOrder(asrAlternates, manualOrders.asr, (p) => p.id);
  const reportAsrAlternates =
    manualOrders.asr === undefined
      ? rankProviders(
          orderedAsrAlternates.map((p) => ({ id: p.id, key: asrHealthKey(p.id) })),
          { latencyReferenceMs: 20_000 },
        )
          .slice(0, 2)
          .map((r) => orderedAsrAlternates.find((p) => p.id === r.id)!)
      : orderedAsrAlternates;
  const asrOrder = [selectedAsr, ...reportAsrAlternates];
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
  const reportTtsProviders =
    manualOrders.tts === undefined
      ? await orderedTtsProviders()
      : applyManualOrder(TTS_PROVIDERS, manualOrders.tts, (provider) => provider.id);
  const ttsCandidates = await Promise.all(
    reportTtsProviders.map(async (provider, index) =>
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
    { family: "text", selected: text.provider, candidates: textCandidates, noUsableFallback: hasNoUsableFallback(textCandidates), editable: true, manualOrder: manualOrders.text ?? [], note: "The selected text provider remains primary. The only safe cross-provider text fallback is built-in OpenAI, subject to health and pricing; its position is retained for compatibility." },
    ...(nvidiaMultimodalCandidate
      ? [{
          family: "multimodal",
          selected: "nvidia",
          candidates: [nvidiaMultimodalCandidate],
          noUsableFallback: !nvidiaMultimodalCandidate.eligible,
          editable: false,
          manualOrder: [],
          note: "NVIDIA image_url paths require their separate multimodal deployment to be enabled and independently tested; text activation alone is insufficient.",
        }]
      : []),
    { family: "image", selected: image.provider, candidates: imageCandidates, noUsableFallback: hasNoUsableFallback(imageCandidates), editable: true, manualOrder: manualOrders.image ?? [], note: image.provider === "auto" ? "Manual order overrides scorer order when saved; capability locks for Guided Story image edits still filter incapable providers." : "Selected provider is first; manual alternatives run only after transient failures." },
    { ...(await videoGroup("text", video.provider, video.textToVideoModel, manualOrders["text-to-video"])), editable: true, manualOrder: manualOrders["text-to-video"] ?? [] },
    { ...(await videoGroup("image", video.provider, video.imageToVideoModel, manualOrders["image-to-video"])), editable: true, manualOrder: manualOrders["image-to-video"] ?? [] },
    { family: "tts", selected: ttsCandidates[0]?.provider ?? "none", candidates: ttsCandidates, noUsableFallback: hasNoUsableFallback(ttsCandidates), editable: true, manualOrder: manualOrders.tts ?? [], note: "Manual order is honored within the health order; an open circuit remains skipped." },
    { family: "localized-tts", selected: "job snapshot", candidates: [
      await makeCandidate({ provider: "openai", label: "OpenAI localized narration", model: "gpt-audio", role: "selectable", configured: true, healthy: healthy(ttsHealthKey("openai")) }),
      await makeCandidate({ provider: "sarvam", label: "Sarvam localized narration", model: SARVAM_TTS_MODEL, role: "selectable", configured: sarvam, healthy: healthy(sarvamTtsHealthKey()) }),
    ], noUsableFallback: true, editable: false, manualOrder: [], note: "Read-only: each localized job snapshots either OpenAI gpt-audio or Sarvam bulbul:v3; these are selectable routes, not a fallback chain." },
    { family: "asr", selected: asr, candidates: asrCandidates, noUsableFallback: hasNoUsableFallback(asrCandidates), editable: true, manualOrder: manualOrders.asr ?? [], note: "Selected ASR remains primary; manual alternatives run only after transient failures." },
    { family: "lip-sync-standard", selected: "replicate", candidates: [await makeCandidate({ kind: "video", provider: "replicate", label: "LatentSync standard", model: "bytedance/latentsync", role: "primary", configured: replicate ? await isVideoGenProviderConfigured(replicate) : false, healthy: healthy(videoGenHealthKey("replicate")), priceRequired: true })], noUsableFallback: true, editable: false, manualOrder: [], note: "Read-only: standard video lip-sync has no alternate provider." },
    { family: "lip-sync-high-quality", selected: "replicate", candidates: lipSyncCandidates, noUsableFallback: true, editable: false, manualOrder: [], note: "Read-only: High Quality video lip-sync uses sync/lipsync-2; no alternate provider." },
    { family: "lip-sync-portrait", selected: video.lipSyncPortraitModel ?? "none", candidates: video.lipSyncPortraitModel ? [await makeCandidate({ kind: "video", provider: "replicate", label: "Admin-configured portrait lip-sync", model: video.lipSyncPortraitModel, role: "primary", configured: replicate ? await isVideoGenProviderConfigured(replicate) : false, healthy: healthy(videoGenHealthKey("replicate")), priceRequired: true })] : [], noUsableFallback: true, editable: false, manualOrder: [], note: "Read-only: portrait lip-sync has no alternate provider." },
  ];
  return {
    generatedAt: new Date().toISOString(),
    families: groups.map((group) => ({
      ...group,
      manualOrderConfigured:
        group.editable === true &&
        Object.prototype.hasOwnProperty.call(manualOrders, group.family),
      availableCandidates: group.editable === true ? availableCandidates(group.family) : [],
    })),
  };
}