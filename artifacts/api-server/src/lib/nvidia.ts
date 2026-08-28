/**
 * NVIDIA contracts verified against the NVIDIA API Catalog/NIM request and
 * response schema. This list is intentionally an allowlist, not discovery:
 * catalog presence alone does not prove that KOKAO can consume a model.
 */
export type NvidiaCapability = "image" | "video";

export interface NvidiaModelContract {
  model: string;
  capability: NvidiaCapability;
  protocol: "nvidia-image-v1" | "nvidia-video-v1";
  /** API Catalog route. It is never used for a self-hosted NIM. */
  hostedEndpointPath: string;
  /** NIM's SDXL generation route, relative to the NIM service origin. */
  nimEndpointPath: string;
  supportsImageInput: boolean;
}

export const NVIDIA_HOSTED_API_ROOT = "https://ai.api.nvidia.com";
export const NVIDIA_SDXL_MODEL = "stabilityai/stable-diffusion-xl";
export const NVIDIA_WAN_2_2_VIDEO_MODEL = "wan-ai/wan2.2";

export const NVIDIA_MODEL_CONTRACTS: readonly NvidiaModelContract[] = [
  {
    model: NVIDIA_SDXL_MODEL,
    capability: "image",
    protocol: "nvidia-image-v1",
    hostedEndpointPath: `/v1/genai/${NVIDIA_SDXL_MODEL}`,
    nimEndpointPath: `/v1/generation/${NVIDIA_SDXL_MODEL}`,
    supportsImageInput: false,
  },
  {
    model: NVIDIA_WAN_2_2_VIDEO_MODEL,
    capability: "video",
    protocol: "nvidia-video-v1",
    // Visual GenAI NIM video generation is verified only for self-hosted NIM.
    // Keep hosted empty so this contract can never be composed into a Catalog
    // URL by mistake.
    hostedEndpointPath: "",
    nimEndpointPath: "/v1/videos/generations",
    supportsImageInput: true,
  },
] as const;

export function findNvidiaModelContract(
  capability: NvidiaCapability,
  model: string,
): NvidiaModelContract | null {
  return (
    NVIDIA_MODEL_CONTRACTS.find(
      (contract) => contract.capability === capability && contract.model === model.trim(),
    ) ?? null
  );
}

function endpointUrl(rawRoot: string, endpointPath: string, label: string): URL {
  let root: URL;
  try {
    root = new URL(rawRoot.trim());
  } catch {
    throw new Error(`The ${label} is not a valid URL.`);
  }
  if (!["http:", "https:"].includes(root.protocol) || root.username || root.password) {
    throw new Error(`The ${label} must be an HTTP(S) URL without embedded credentials.`);
  }
  if (root.search || root.hash) {
    throw new Error(`The ${label} must not contain query parameters or a fragment.`);
  }
  root.pathname = endpointPath;
  return root;
}

/** The API Catalog SDXL route is fixed and does not use a deployment base URL. */
export function nvidiaHostedImageEndpoint(contract: NvidiaModelContract): string {
  return endpointUrl(
    NVIDIA_HOSTED_API_ROOT,
    contract.hostedEndpointPath,
    "NVIDIA hosted API root",
  ).toString();
}

/**
 * A self-hosted image base URL identifies the NIM service only: either its
 * origin or that origin's `/v1` API root. It is normalized to `/v1`, then the
 * verified NIM route is composed. Catalog `/v1/genai/...` routes are never
 * valid against a self-hosted NIM.
 */
export function normalizeNvidiaNimImageBaseUrl(nimBaseUrl: string): string {
  let root: URL;
  try {
    root = new URL(nimBaseUrl.trim());
  } catch {
    throw new Error("The NVIDIA NIM image base URL is not a valid URL.");
  }
  if (!["http:", "https:"].includes(root.protocol) || root.username || root.password) {
    throw new Error("The NVIDIA NIM image base URL must be an HTTP(S) URL without embedded credentials.");
  }
  if (root.search || root.hash) {
    throw new Error("The NVIDIA NIM image base URL must not contain query parameters or a fragment.");
  }
  const configuredPath = root.pathname.replace(/\/+$/, "") || "/";
  if (configuredPath !== "/" && configuredPath !== "/v1") {
    throw new Error("The NVIDIA NIM image base URL must be the service origin or its /v1 API root.");
  }
  return `${root.origin}/v1`;
}

export function nvidiaNimImageEndpoint(contract: NvidiaModelContract, nimBaseUrl: string): string {
  const normalizedBaseUrl = normalizeNvidiaNimImageBaseUrl(nimBaseUrl);
  return endpointUrl(
    normalizedBaseUrl,
    contract.nimEndpointPath,
    "NVIDIA NIM image base URL",
  ).toString();
}

/**
 * Visual GenAI 1.6 exposes the OpenAI-compatible models and synchronous video
 * routes below /v1. Accept only a service origin or its /v1 root so an admin
 * cannot accidentally save the generation resource itself as a base URL.
 */
export function normalizeNvidiaNimVideoBaseUrl(nimBaseUrl: string): string {
  let root: URL;
  try {
    root = new URL(nimBaseUrl.trim());
  } catch {
    throw new Error("The NVIDIA NIM video base URL is not a valid URL.");
  }
  if (!["http:", "https:"].includes(root.protocol) || root.username || root.password) {
    throw new Error("The NVIDIA NIM video base URL must be an HTTP(S) URL without embedded credentials.");
  }
  if (root.search || root.hash) {
    throw new Error("The NVIDIA NIM video base URL must not contain query parameters or a fragment.");
  }
  const configuredPath = root.pathname.replace(/\/+$/, "") || "/";
  if (configuredPath !== "/" && configuredPath !== "/v1") {
    throw new Error("The NVIDIA NIM video base URL must be the service origin or its /v1 API root.");
  }
  return `${root.origin}/v1`;
}

export function nvidiaNimVideoEndpoint(nimBaseUrl: string): string {
  return `${normalizeNvidiaNimVideoBaseUrl(nimBaseUrl)}/videos/generations`;
}