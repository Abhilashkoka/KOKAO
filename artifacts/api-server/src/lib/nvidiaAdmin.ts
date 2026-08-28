import { maskSecret } from "./secretCrypto";
import {
  clearNvidiaCoreDeployment,
  clearNvidiaHostedApiKey,
  getNvidiaCoreConfigView,
  hasVerifiedNvidiaCoreModelContract,
  NVIDIA_HOSTED_BASE_URL,
  isNvidiaCoreDeploymentActivatable,
  resolveNvidiaHostedApiKey,
  resolveNvidiaCoreDeployment,
  setNvidiaCoreDeployment,
  setNvidiaHostedApiKey,
  testNvidiaHostedCatalog,
  testNvidiaCoreDeployment,
  type NvidiaCoreCapability,
  type NvidiaCoreProtocol,
} from "./nvidiaCore";
import { findNvidiaModelContract } from "./nvidia";
import { deleteExactModelPrices, findModelPrice, upsertModelPrice } from "./aiCost";

export const NVIDIA_CAPABILITIES = [
  "text",
  "multimodal",
  "image",
  "video",
  "asr",
  "tts",
] as const;
export type NvidiaCapability = (typeof NVIDIA_CAPABILITIES)[number];

export const NVIDIA_PROTOCOLS = [
  "openai-chat",
  "nvidia-image-v1",
  "nvidia-video-v1",
  "openai-audio-transcriptions",
  "openai-audio-speech",
] as const;
export type NvidiaProtocol = (typeof NVIDIA_PROTOCOLS)[number];

const HOSTED_BASE_URL = NVIDIA_HOSTED_BASE_URL;

export interface NvidiaTestResult {
  ok: boolean;
  message: string;
  testedAt: string;
}

function expectedProtocol(capability: NvidiaCapability): NvidiaProtocol {
  if (capability === "text" || capability === "multimodal") return "openai-chat";
  if (capability === "image") return "nvidia-image-v1";
  if (capability === "video") return "nvidia-video-v1";
  if (capability === "asr") return "openai-audio-transcriptions";
  return "openai-audio-speech";
}

export async function getNvidiaAdminSettings() {
  const core = await getNvidiaCoreConfigView();
  const hostedKey = await resolveNvidiaHostedApiKey();
  return {
    hosted: {
      configured: Boolean(hostedKey),
      keyMasked: maskSecret(hostedKey),
      baseUrl: HOSTED_BASE_URL,
      lastTestStatus: core.hostedLastTestStatus,
      lastTestedAt: core.hostedLastTestedAt,
      lastTestError: core.hostedLastTestError,
    },
    deployments: await Promise.all(
      NVIDIA_CAPABILITIES.map(async (capability) => {
        const coreValue = core.deployments[capability];
        const price =
          coreValue && (capability === "text" || capability === "multimodal" || capability === "image" || capability === "video")
            ? await findModelPrice(
                capability === "image" ? "image" : capability === "video" ? "video" : "text",
                "nvidia",
                coreValue.model,
                { exactProviderOnly: true },
              )
            : null;
        const adminPriceUsd =
          capability === "asr" || capability === "tts"
            ? coreValue?.adminPriceUsd ?? null
            : capability === "image"
              ? price?.usdPerImage ?? null
              : capability === "video"
                ? price?.usdPerSecond ?? null
                : price?.inputUsdPerMtok !== null &&
                    price?.inputUsdPerMtok === price?.outputUsdPerMtok
                  ? price?.inputUsdPerMtok ?? null
                  : null;
        const value = coreValue
          ? {
              kind: coreValue.kind,
              baseUrl: coreValue.baseUrl,
              model: coreValue.model,
              protocol: coreValue.protocol as NvidiaProtocol,
              enabled: coreValue.enabled,
              adminPriceUsd,
            }
          : null;
        const status = coreValue
          ? {
              lastTestStatus: coreValue.lastTestStatus,
              lastTestedAt: coreValue.lastTestedAt,
              lastTestError: coreValue.lastTestError,
            }
          : { lastTestStatus: null, lastTestedAt: null, lastTestError: null };
        const protocolCompatible =
          Boolean(value?.baseUrl && value.model) &&
          value?.protocol === expectedProtocol(capability);
        const compatible =
          protocolCompatible &&
          (capability === "asr" || capability === "tts"
            ? value?.kind === "self-hosted"
            : capability === "video"
            ? value?.kind === "self-hosted" &&
              findNvidiaModelContract("video", value?.model ?? "") !== null
             : capability === "image"
               ? value?.kind === "self-hosted" &&
                 findNvidiaModelContract("image", value?.model ?? "") !== null
              : true);
        const priceKnown = adminPriceUsd !== null;
        return {
          capability,
          kind: value?.kind ?? "self-hosted",
          configured: Boolean(value?.baseUrl),
          baseUrl: value?.baseUrl ?? null,
          apiKeyMasked: coreValue?.hasEndpointKey ? "configured" : null,
          model: value?.model ?? null,
          protocol: value?.protocol ?? expectedProtocol(capability),
          compatible,
          enabled: Boolean(value?.enabled),
          adminPriceUsd: value?.adminPriceUsd ?? null,
          priceKnown,
          activationBlockedReason: !compatible
            ? capability === "video"
              ? "Use the verified wan-ai/wan2.2 model on a self-hosted Visual GenAI NIM."
              : capability === "asr" || capability === "tts"
                ? "NVIDIA speech is available only through a self-hosted Speech NIM."
              : "Configure a model with a verified adapter and the required protocol."
            : status.lastTestStatus !== "ok"
              ? "A successful connection test is required."
              : !priceKnown
                ? capability === "asr" || capability === "tts"
                  ? "Confirm USD 0 external provider cost for this self-hosted speech NIM. Paid audio cannot activate because accounting has no audio unit."
                  : "Set an explicit price in ai_model_prices before paid generation."
                : null,
          ...status,
        };
      }),
    ),
  };
}

export async function setNvidiaHostedKey(apiKey: string) {
  await setNvidiaHostedApiKey(apiKey);
  return getNvidiaAdminSettings();
}

export async function clearNvidiaHostedKey() {
  await clearNvidiaHostedApiKey();
  return getNvidiaAdminSettings();
}

/** Source of the single shared hosted key used by NVIDIA chat deployments. */
export async function getNvidiaHostedKeySource(): Promise<"database" | "env" | null> {
  return (await getNvidiaCoreConfigView()).hostedKeySource;
}

export async function setNvidiaDeployment(
  capability: NvidiaCapability,
  input: {
    baseUrl?: string;
    apiKey?: string;
    model: string;
    protocol: NvidiaProtocol;
    kind: "hosted" | "self-hosted";
    enabled?: boolean;
    adminPriceUsd?: number | null;
  },
) {
  if (input.protocol !== expectedProtocol(capability)) {
    throw new Error(`${capability} requires the ${expectedProtocol(capability)} protocol`);
  }
  if (input.kind === "self-hosted" && !input.baseUrl?.trim()) {
    throw new Error("A self-hosted NVIDIA NIM endpoint is required");
  }
  if (
    input.adminPriceUsd !== null &&
    input.adminPriceUsd !== undefined &&
    (!Number.isFinite(input.adminPriceUsd) || input.adminPriceUsd < 0)
  ) {
    throw new Error("NVIDIA price must be a non-negative USD number");
  }
  if ((capability === "asr" || capability === "tts") && input.kind !== "self-hosted") {
    throw new Error("NVIDIA hosted speech is unavailable because its official hosted HTTP contract is not verified");
  }
  if (capability === "image" && input.kind === "hosted") {
    throw new Error(
      "NVIDIA hosted image cannot be saved because no verified non-billable independent test exists",
    );
  }
  if (
    (capability === "asr" || capability === "tts") &&
    input.adminPriceUsd !== null &&
    input.adminPriceUsd !== undefined &&
    input.adminPriceUsd !== 0
  ) {
    throw new Error(
      `NVIDIA ${capability} may only be activated with an explicit USD 0 self-hosted external provider cost; paid audio has no accounting unit`,
    );
  }
  await setNvidiaCoreDeployment({
    capability: capability as NvidiaCoreCapability,
    kind: input.kind,
    protocol: input.protocol as NvidiaCoreProtocol,
    model: input.model,
    baseUrl: input.baseUrl ?? HOSTED_BASE_URL,
    apiKey: input.apiKey,
    enabled: input.enabled,
    adminPriceUsd: input.adminPriceUsd,
  });
  if (capability !== "asr" && capability !== "tts") {
    const priceKind =
      capability === "image" ? "image" : capability === "video" ? "video" : "text";
    if (input.adminPriceUsd === null) {
      // Explicit null revokes this deployment's price. Omission intentionally
      // leaves it untouched for partial-update callers.
      await deleteExactModelPrices({
        kind: priceKind,
        provider: "nvidia",
        model: input.model,
      });
    } else if (input.adminPriceUsd !== undefined) {
      await upsertModelPrice({
        kind: priceKind,
        provider: "nvidia",
        model: input.model,
        inputUsdPerMtok:
          capability === "image" || capability === "video" ? null : input.adminPriceUsd,
        outputUsdPerMtok:
          capability === "image" || capability === "video" ? null : input.adminPriceUsd,
        usdPerImage: capability === "image" ? input.adminPriceUsd : null,
        usdPerSecond: capability === "video" ? input.adminPriceUsd : null,
        usdPerVideo: null,
      });
    }
  }
  return getNvidiaAdminSettings();
}

export async function clearNvidiaDeployment(capability: NvidiaCapability) {
  await clearNvidiaCoreDeployment(capability as NvidiaCoreCapability);
  return getNvidiaAdminSettings();
}

export async function testNvidiaHosted(): Promise<NvidiaTestResult> {
  try {
    await testNvidiaHostedCatalog();
    const status = await getNvidiaCoreConfigView();
    return {
      ok: true,
      message: "Hosted chat catalog connection succeeded",
      testedAt: status.hostedLastTestedAt ?? new Date().toISOString(),
    };
  } catch (error) {
    const status = await getNvidiaCoreConfigView();
    return {
      ok: false,
      message: status.hostedLastTestError ?? "Connection failed",
      testedAt: status.hostedLastTestedAt ?? new Date().toISOString(),
    };
  }
}

export async function testNvidiaDeployment(
  capability: NvidiaCapability,
): Promise<NvidiaTestResult> {
  const testedAt = new Date().toISOString();
  try {
    await testNvidiaCoreDeployment(capability as NvidiaCoreCapability);
    return { ok: true, message: "Connection and model discovery succeeded", testedAt };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Connection failed",
      testedAt,
    };
  }
}

/**
 * NVIDIA chat activation is intentionally separate from the generic text
 * provider gate. NVIDIA has no catalog scraper: each selected model must be
 * the exact model on the configured text deployment. That deployment's own
 * activation gate verifies its successful test, enabled switch, hosted shared
 * key (where applicable), and NVIDIA-only price row. Multimodal deployments
 * are selected only by image-part callers and must not activate ordinary text.
 */
export async function validateNvidiaTextActivation(models: string[]): Promise<string | null> {
  const deployment = await resolveNvidiaCoreDeployment("text");

  for (const model of models) {
    if (deployment?.model !== model) {
      return `NVIDIA model "${model}" must exactly match the model on the configured NVIDIA text deployment.`;
    }
    if (!(await isNvidiaCoreDeploymentActivatable("text"))) {
      return `NVIDIA model "${model}" must use an enabled deployment that has passed its connection test, has its required shared NVIDIA hosted key, and has an exact NVIDIA provider price.`;
    }
  }
  return null;
}

export async function discoverNvidiaModels(capability?: NvidiaCapability) {
  const deployment = capability
    ? await resolveNvidiaCoreDeployment(capability as NvidiaCoreCapability)
    : null;
  const baseUrl = capability ? deployment?.baseUrl : HOSTED_BASE_URL;
  if (!baseUrl) throw new Error("This NVIDIA deployment is not configured");
  const apiKey =
    deployment?.resolvedApiKey ?? (await resolveNvidiaHostedApiKey()) ?? undefined;
  if (capability === "image" && deployment?.kind === "hosted") {
    throw new Error("NVIDIA hosted image does not expose a verified model-discovery endpoint");
  }
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Endpoint returned HTTP ${response.status}`);
  const body = (await response.json()) as { data?: Array<{ id?: string }> };
  if (!Array.isArray(body.data)) throw new Error("Protocol mismatch: expected a models list");
  const models = body.data.flatMap((item) => (typeof item.id === "string" ? [item.id] : []));
  return models.map((id) => {
    const unsupported = /embed|rerank|retriev/i.test(id);
    const verifiedForCapability =
      Boolean(capability && deployment) &&
      hasVerifiedNvidiaCoreModelContract({
        kind: deployment!.kind,
        capability: capability as NvidiaCoreCapability,
        protocol: deployment!.protocol,
        model: id,
      });
    const compatible =
      Boolean(capability) &&
      !unsupported &&
      verifiedForCapability &&
      !(capability === "video" && deployment?.kind !== "self-hosted");
    return {
      id,
      source: capability ? deployment?.kind ?? "self-hosted" : "hosted",
      capability: unsupported ? "unsupported" : capability ?? "unknown",
      compatible,
      selectable: false,
      reason: unsupported
        ? "KOKAO does not consume embeddings or reranking."
        : capability && compatible
          ? capability === "asr" || capability === "tts"
            ? "Save and test this self-hosted model, then explicitly confirm USD 0 external provider cost before activation."
            : "Save, test, and price this model before activation."
          : capability
            ? "This model does not have a verified KOKAO adapter for the deployment."
          : "Hosted catalog entries require a verified KOKAO capability adapter.",
    };
  });
}