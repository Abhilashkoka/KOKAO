import { db, appCredentialsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { decryptJson, encryptJson } from "./secretCrypto";
import { boundedProviderFetch, errorDetail } from "./aiProviderFetch";
import { assertPublicHost } from "./webFetch";
import {
  isExactPerSecondVideoModelPriced,
  isImageModelPriced,
  isTextModelPriced,
} from "./aiCost";
import {
  findNvidiaModelContract,
  normalizeNvidiaNimImageBaseUrl,
  normalizeNvidiaNimVideoBaseUrl,
} from "./nvidia";

export const NVIDIA_CREDENTIAL_PROVIDER = "nvidia_core";
export const NVIDIA_ENV_KEY = "NVIDIA_API_KEY";
export const NVIDIA_HOSTED_BASE_URL = "https://integrate.api.nvidia.com/v1";
export const NVIDIA_TIMEOUT_MS = 60_000;

export type NvidiaCoreCapability = "text" | "multimodal" | "image" | "video" | "asr" | "tts";
export type NvidiaCoreProtocol =
  | "openai-chat"
  | "nvidia-image-v1"
  | "nvidia-video-v1"
  | "openai-audio-transcriptions"
  | "openai-audio-speech";

export interface NvidiaCoreModelContract {
  id: string;
  capabilities: readonly NvidiaCoreCapability[];
  protocol: NvidiaCoreProtocol;
  authoritativePricePaise: null;
}

/** Verified adapters only. Discovery never extends this allowlist. */
export const NVIDIA_CORE_HOSTED_MODELS: readonly NvidiaCoreModelContract[] = [
  {
    id: "meta/llama-3.1-70b-instruct",
    capabilities: ["text"],
    protocol: "openai-chat",
    authoritativePricePaise: null,
  },
  {
    id: "nvidia/llama-3.1-nemotron-nano-vl-8b-v1",
    capabilities: ["text", "multimodal"],
    protocol: "openai-chat",
    authoritativePricePaise: null,
  },
] as const;

/** Self-hosted NIM models whose live protocol/output contract KOKAO has verified. */
export const NVIDIA_CORE_SELF_HOSTED_MODELS: readonly NvidiaCoreModelContract[] = [
  ...NVIDIA_CORE_HOSTED_MODELS,
  {
    id: "nvidia/parakeet-ctc-1.1b-asr",
    capabilities: ["asr"],
    protocol: "openai-audio-transcriptions",
    authoritativePricePaise: null,
  },
  {
    id: "nvidia/magpie-tts",
    capabilities: ["tts"],
    protocol: "openai-audio-speech",
    authoritativePricePaise: null,
  },
] as const;

export function hasVerifiedNvidiaCoreModelContract(args: {
  kind: "hosted" | "self-hosted";
  capability: NvidiaCoreCapability;
  protocol: NvidiaCoreProtocol;
  model: string;
}): boolean {
  if (args.capability === "image" || args.capability === "video") {
    return args.kind === "self-hosted" && findNvidiaModelContract(args.capability, args.model) !== null;
  }
  const contracts =
    args.kind === "hosted" ? NVIDIA_CORE_HOSTED_MODELS : NVIDIA_CORE_SELF_HOSTED_MODELS;
  const contract = contracts.find((candidate) => candidate.id === args.model.trim());
  return Boolean(
    contract &&
      contract.capabilities.includes(args.capability) &&
      contract.protocol === args.protocol,
  );
}

export interface NvidiaCoreDeployment {
  capability: NvidiaCoreCapability;
  kind: "hosted" | "self-hosted";
  protocol: NvidiaCoreProtocol;
  model: string;
  baseUrl: string;
  apiKey?: string;
  /** Explicit admin confirmation that this self-hosted speech endpoint has no external provider charge. */
  adminPriceUsd?: 0;
  enabled?: boolean;
  lastTestStatus?: "ok" | "error";
  lastTestedAt?: string;
  lastTestError?: string;
}

interface StoredNvidiaCoreConfig {
  hostedApiKey?: string;
  hostedLastTestStatus?: "ok" | "error";
  hostedLastTestedAt?: string;
  hostedLastTestError?: string;
  deployments: Partial<Record<NvidiaCoreCapability, NvidiaCoreDeployment>>;
}

function expectedProtocol(capability: NvidiaCoreCapability): NvidiaCoreProtocol {
  if (capability === "text" || capability === "multimodal") return "openai-chat";
  if (capability === "image") return "nvidia-image-v1";
  if (capability === "video") return "nvidia-video-v1";
  if (capability === "asr") return "openai-audio-transcriptions";
  return "openai-audio-speech";
}

async function readConfig(): Promise<StoredNvidiaCoreConfig> {
  const [row] = await db
    .select()
    .from(appCredentialsTable)
    .where(eq(appCredentialsTable.provider, NVIDIA_CREDENTIAL_PROVIDER))
    .limit(1);
  if (!row) return { deployments: {} };
  try {
    const parsed = decryptJson<StoredNvidiaCoreConfig>(row.encryptedCredentials);
    return {
      hostedApiKey: parsed.hostedApiKey,
      hostedLastTestStatus: parsed.hostedLastTestStatus,
      hostedLastTestedAt: parsed.hostedLastTestedAt,
      hostedLastTestError: parsed.hostedLastTestError,
      deployments: parsed.deployments ?? {},
    };
  } catch {
    return { deployments: {} };
  }
}

async function writeConfig(config: StoredNvidiaCoreConfig): Promise<void> {
  const encryptedCredentials = encryptJson(config);
  await db
    .insert(appCredentialsTable)
    .values({ provider: NVIDIA_CREDENTIAL_PROVIDER, encryptedCredentials })
    .onConflictDoUpdate({
      target: appCredentialsTable.provider,
      set: { encryptedCredentials, updatedAt: new Date() },
    });
}

export async function setNvidiaHostedApiKey(apiKey: string): Promise<void> {
  const trimmed = apiKey.trim();
  if (!trimmed) throw new Error("NVIDIA API key cannot be empty");
  const config = await readConfig();
  config.hostedApiKey = trimmed;
  invalidateNvidiaHostedTests(config);
  await writeConfig(config);
}

export async function clearNvidiaHostedApiKey(): Promise<void> {
  const config = await readConfig();
  delete config.hostedApiKey;
  invalidateNvidiaHostedTests(config);
  await writeConfig(config);
}

function invalidateNvidiaHostedTests(config: StoredNvidiaCoreConfig): void {
  delete config.hostedLastTestStatus;
  delete config.hostedLastTestedAt;
  delete config.hostedLastTestError;
  for (const capability of ["text", "multimodal"] as const) {
    const deployment = config.deployments[capability];
    if (deployment?.kind !== "hosted") continue;
    delete deployment.lastTestStatus;
    delete deployment.lastTestedAt;
    delete deployment.lastTestError;
  }
}

export async function resolveNvidiaHostedApiKey(): Promise<string | null> {
  return (await readConfig()).hostedApiKey ?? process.env[NVIDIA_ENV_KEY] ?? null;
}

export async function validateNvidiaNimBaseUrl(raw: string): Promise<string> {
  const value = raw.trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("NVIDIA NIM base URL is not a valid URL");
  }
  if (url.protocol !== "https:") throw new Error("NVIDIA NIM base URL must use https");
  if (url.username || url.password) throw new Error("NVIDIA NIM base URL must not contain credentials");
  await assertPublicHost(url.hostname).catch(() => {
    throw new Error("NVIDIA NIM base URL points to a blocked or private host");
  });
  return value;
}

function normalizeNvidiaSpeechBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.search || url.hash) {
    throw new Error("NVIDIA Speech NIM endpoint must not contain a query string or fragment");
  }
  const path = url.pathname.replace(/\/+$/, "");
  if (path && path !== "/v1") {
    throw new Error("NVIDIA Speech NIM endpoint must be its service origin or /v1 API root");
  }
  url.pathname = "/v1";
  return url.toString().replace(/\/+$/, "");
}

export async function setNvidiaCoreDeployment(
  input: Omit<NvidiaCoreDeployment, "lastTestStatus" | "lastTestedAt" | "lastTestError" | "adminPriceUsd"> & {
    adminPriceUsd?: number | null;
  },
): Promise<void> {
  const model = input.model.trim();
  if (!model) throw new Error("NVIDIA deployment model is required");
  if (input.protocol !== expectedProtocol(input.capability)) {
    throw new Error(`NVIDIA ${input.capability} requires protocol ${expectedProtocol(input.capability)}`);
  }
  if (input.capability === "video" && input.kind !== "self-hosted") {
    throw new Error("NVIDIA video is supported only through a self-hosted Visual GenAI NIM");
  }
  if (input.capability === "image" && input.kind === "hosted") {
    throw new Error(
      "NVIDIA hosted image cannot be saved: no verified non-billable independent test exists; configure a self-hosted NIM",
    );
  }
  if (
    input.kind === "hosted" &&
    (input.capability === "asr" || input.capability === "tts")
  ) {
    throw new Error("NVIDIA hosted speech has no verified HTTP contract; configure a self-hosted NIM");
  }
  if (
    (input.capability === "asr" || input.capability === "tts") &&
    input.adminPriceUsd !== undefined &&
    input.adminPriceUsd !== null &&
    input.adminPriceUsd !== 0
  ) {
    throw new Error(
      "NVIDIA speech can only use an explicit USD 0 self-hosted external provider cost; paid audio has no accounting unit",
    );
  }
  let baseUrl =
    input.kind === "hosted"
      ? input.capability === "image"
        ? "https://ai.api.nvidia.com"
        : NVIDIA_HOSTED_BASE_URL
      : await validateNvidiaNimBaseUrl(input.baseUrl);
  if (input.kind === "self-hosted" && input.capability === "image") {
    baseUrl = normalizeNvidiaNimImageBaseUrl(baseUrl);
  }
  if (
    input.kind === "self-hosted" &&
    (input.capability === "asr" || input.capability === "tts")
  ) {
    baseUrl = normalizeNvidiaSpeechBaseUrl(baseUrl);
  }
  if (input.kind === "self-hosted" && input.capability === "video") {
    baseUrl = normalizeNvidiaNimVideoBaseUrl(baseUrl);
  }
  if (
    !hasVerifiedNvidiaCoreModelContract({
      kind: input.kind,
      capability: input.capability,
      protocol: input.protocol,
      model,
    })
  ) {
    throw new Error(
      input.kind === "self-hosted" &&
        (input.capability === "image" || input.capability === "video")
        ? `NVIDIA self-hosted ${input.capability} model does not have a verified NIM adapter`
        : `NVIDIA ${input.kind} ${input.capability} model does not have a verified adapter for KOKAO`,
    );
  }
  const config = await readConfig();
  const previous = config.deployments[input.capability];
  const next = {
    ...input,
    model,
    baseUrl,
    // Omitted key means retain it; an explicit blank key removes it.
    apiKey:
      input.kind === "hosted"
        ? undefined
        : input.apiKey === undefined
          ? previous?.apiKey
          : input.apiKey.trim() || undefined,
    enabled: input.enabled ?? previous?.enabled ?? false,
    adminPriceUsd:
      input.capability === "asr" || input.capability === "tts"
        ? input.adminPriceUsd === 0
          ? 0 as const
          : undefined
        : undefined,
  };
  // Toggling the explicit activation switch must not erase a successful
  // connection test when the endpoint, protocol, model, and credential did
  // not change. Any material change still requires a fresh test.
  const unchangedConnection =
    previous?.kind === next.kind &&
    previous.baseUrl === next.baseUrl &&
    previous.model === next.model &&
    previous.protocol === next.protocol &&
    previous.apiKey === next.apiKey;
  config.deployments[input.capability] = unchangedConnection
    ? {
        ...next,
        lastTestStatus: previous.lastTestStatus,
        lastTestedAt: previous.lastTestedAt,
        lastTestError: previous.lastTestError,
      }
    : next;
  await writeConfig(config);
}

export async function clearNvidiaCoreDeployment(capability: NvidiaCoreCapability): Promise<void> {
  const config = await readConfig();
  delete config.deployments[capability];
  await writeConfig(config);
}

export async function getNvidiaCoreDeployment(
  capability: NvidiaCoreCapability,
): Promise<NvidiaCoreDeployment | null> {
  return (await readConfig()).deployments[capability] ?? null;
}

export async function resolveNvidiaCoreDeployment(
  capability: NvidiaCoreCapability,
): Promise<(NvidiaCoreDeployment & { resolvedApiKey: string | null }) | null> {
  const deployment = await getNvidiaCoreDeployment(capability);
  if (!deployment) return null;
  return {
    ...deployment,
    resolvedApiKey:
      deployment.apiKey ??
      (deployment.kind === "hosted" ? await resolveNvidiaHostedApiKey() : null),
  };
}

export async function isNvidiaCoreDeploymentActivatable(
  capability: NvidiaCoreCapability,
): Promise<boolean> {
  const deployment = await resolveNvidiaCoreDeployment(capability);
  if (
    !deployment ||
    deployment.lastTestStatus !== "ok" ||
    deployment.enabled !== true ||
    (deployment.kind === "hosted" && !deployment.resolvedApiKey)
  ) {
    return false;
  }
  // Audio has no ai_model_prices unit. Self-hosted speech is therefore usable
  // only after the admin explicitly confirms there is no external provider
  // charge. A nonzero paid audio rate is never accepted without an accounting unit.
  if (capability === "asr" || capability === "tts") {
    return deployment.kind === "self-hosted" && deployment.adminPriceUsd === 0;
  }
  if (capability === "image") {
    return isImageModelPriced({ provider: "nvidia", model: deployment.model });
  }
  if (capability === "video") {
    return isExactPerSecondVideoModelPriced({ provider: "nvidia", model: deployment.model });
  }
  if (capability === "text" || capability === "multimodal") {
    return isTextModelPriced({ provider: "nvidia", model: deployment.model });
  }
  return false;
}

/** Mask-safe view: neither hosted nor endpoint API keys are returned. */
export async function getNvidiaCoreConfigView() {
  const config = await readConfig();
  return {
    hostedKeySource: config.hostedApiKey
      ? ("database" as const)
      : process.env[NVIDIA_ENV_KEY]
        ? ("env" as const)
        : null,
    hostedLastTestStatus: config.hostedLastTestStatus ?? null,
    hostedLastTestedAt: config.hostedLastTestedAt ?? null,
    hostedLastTestError: config.hostedLastTestError ?? null,
    deployments: Object.fromEntries(
      Object.entries(config.deployments).map(([capability, item]) => [
        capability,
        {
          capability: item.capability,
          kind: item.kind,
          protocol: item.protocol,
          model: item.model,
          baseUrl: item.baseUrl,
          hasEndpointKey: Boolean(item.apiKey),
          enabled: item.enabled === true,
          adminPriceUsd: item.adminPriceUsd ?? null,
          lastTestStatus: item.lastTestStatus ?? null,
          lastTestedAt: item.lastTestedAt ?? null,
          lastTestError: item.lastTestError ?? null,
        },
      ]),
    ),
  };
}

export class NvidiaCoreProviderError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "NvidiaCoreProviderError";
  }
}

async function requestNvidiaModels(baseUrl: string, apiKey?: string): Promise<string[]> {
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await boundedProviderFetch(
    `${baseUrl.replace(/\/+$/, "")}/models`,
    { headers, redirect: "error" },
    NVIDIA_TIMEOUT_MS,
    () => new NvidiaCoreProviderError("NVIDIA deployment test timed out"),
  );
  if (!res.ok) {
    throw new NvidiaCoreProviderError(
      `NVIDIA deployment test failed (${res.status}): ${await errorDetail(res)}`,
      res.status,
    );
  }
  const body = (await res.json().catch(() => null)) as { data?: Array<{ id?: string }> } | null;
  if (!body || !Array.isArray(body.data)) {
    throw new NvidiaCoreProviderError("NVIDIA deployment returned incompatible model metadata");
  }
  return body.data.flatMap((candidate) => (typeof candidate.id === "string" ? [candidate.id] : []));
}

/** Auth/key health check for the hosted chat catalog (the base URL already includes /v1). */
export async function testNvidiaHostedCatalog(): Promise<void> {
  const key = await resolveNvidiaHostedApiKey();
  let status: "ok" | "error" = "ok";
  let message: string | undefined;
  try {
    if (!key) throw new NvidiaCoreProviderError("NVIDIA hosted API key is not configured", 401);
    await requestNvidiaModels(NVIDIA_HOSTED_BASE_URL, key);
  } catch (error) {
    status = "error";
    message = sanitizeNvidiaHostedTestError(error, key);
    throw error;
  } finally {
    const config = await readConfig();
    const currentKey = config.hostedApiKey ?? process.env[NVIDIA_ENV_KEY] ?? null;
    // Rotation-safe: a response for an old credential cannot bless or condemn
    // the newly configured hosted credential.
    if (currentKey === key) {
      config.hostedLastTestStatus = status;
      config.hostedLastTestedAt = new Date().toISOString();
      if (message) config.hostedLastTestError = message;
      else delete config.hostedLastTestError;
      await writeConfig(config);
    }
  }
}

function sanitizeNvidiaHostedTestError(error: unknown, key: string | null): string {
  let message = error instanceof Error ? error.message : String(error);
  if (key) message = message.split(key).join("[REDACTED]");
  return message.replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]").slice(0, 1000);
}

/** Independent, non-generating endpoint/model metadata health test. */
export async function testNvidiaCoreDeployment(capability: NvidiaCoreCapability): Promise<void> {
  const deployment = await resolveNvidiaCoreDeployment(capability);
  if (!deployment) throw new NvidiaCoreProviderError(`NVIDIA ${capability} deployment is not configured`);
  if (deployment.kind === "hosted" && !deployment.resolvedApiKey) {
    throw new NvidiaCoreProviderError("NVIDIA hosted API key is not configured", 401);
  }
  let status: "ok" | "error" = "ok";
  let message: string | undefined;
  try {
    if (deployment.kind === "hosted" && deployment.capability === "image") {
      throw new NvidiaCoreProviderError(
        "NVIDIA hosted image has no verified non-generating model-discovery endpoint; it cannot be activated.",
      );
    }
    const models = await requestNvidiaModels(deployment.baseUrl, deployment.resolvedApiKey ?? undefined);
    if (!models.includes(deployment.model)) {
      throw new NvidiaCoreProviderError(`NVIDIA deployment does not expose model ${deployment.model}`, 404);
    }
  } catch (error) {
    status = "error";
    message = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    const config = await readConfig();
    const current = config.deployments[capability];
    const currentResolvedApiKey =
      current?.apiKey ??
      (current?.kind === "hosted"
        ? config.hostedApiKey ?? process.env[NVIDIA_ENV_KEY] ?? null
        : null);
    // Rotation-safe: an old test cannot bless a newly saved deployment.
    if (
      current &&
      current.baseUrl === deployment.baseUrl &&
      current.model === deployment.model &&
      current.apiKey === deployment.apiKey &&
      currentResolvedApiKey === deployment.resolvedApiKey
    ) {
      config.deployments[capability] = {
        ...current,
        lastTestStatus: status,
        lastTestedAt: new Date().toISOString(),
        lastTestError: message?.slice(0, 1000),
      };
      await writeConfig(config);
    }
  }
}