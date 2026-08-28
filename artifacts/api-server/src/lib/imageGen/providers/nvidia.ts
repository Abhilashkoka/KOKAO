import {
  NVIDIA_SDXL_MODEL,
  findNvidiaModelContract,
  nvidiaNimImageEndpoint,
} from "../../nvidia";
import {
  isNvidiaCoreDeploymentActivatable,
  resolveNvidiaCoreDeployment,
} from "../../nvidiaCore";
import {
  imageGenFetch,
  errorDetail,
  ImageGenNotConfiguredError,
  ImageGenProviderError,
  type ImageGenInput,
  type ImageGenResult,
} from "../types";

export { NVIDIA_SDXL_MODEL };

interface NvidiaImageResponse {
  artifacts?: Array<{
    base64?: string;
    finishReason?: string;
  }>;
}

const DIMENSIONS: Record<ImageGenInput["size"], { width: number; height: number }> = {
  "1024x1024": { width: 1024, height: 1024 },
  "1536x1024": { width: 1536, height: 1024 },
  "1024x1536": { width: 1024, height: 1536 },
};

function decodedImage(value: string): Buffer | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) return null;
  const buffer = Buffer.from(value, "base64");
  const png = buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
  const jpeg = buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const webp =
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP";
  return png || jpeg || webp ? buffer : null;
}

/** Self-hosted NVIDIA image-generation NIM v1 adapter for verified SDXL. */
export async function generateWithNvidia(
  input: ImageGenInput,
  _apiKey: string | null,
): Promise<ImageGenResult> {
  const deployment = await resolveNvidiaCoreDeployment("image");
  if (!deployment) {
    throw new ImageGenNotConfiguredError(
      "NVIDIA image deployment is not configured.",
    );
  }
  if (!(await isNvidiaCoreDeploymentActivatable("image"))) {
    throw new ImageGenNotConfiguredError(
      "NVIDIA image deployment must be enabled, tested, and explicitly priced before use.",
    );
  }
  // Hosted Catalog image is deliberately not configurable: its only available
  // probe would generate a billable image rather than independently test it.
  if (deployment.kind === "hosted") {
    throw new ImageGenNotConfiguredError(
      "NVIDIA hosted image generation is unavailable until a non-billable independent test is verified.",
    );
  }
  const contract = findNvidiaModelContract("image", input.model);
  if (!contract) {
    throw new ImageGenNotConfiguredError(
      `NVIDIA image model ${input.model || "(empty)"} has no verified KOKAO adapter.`,
    );
  }

  let endpoint: string;
  try {
    endpoint = nvidiaNimImageEndpoint(contract, deployment.baseUrl);
  } catch (error) {
    throw new ImageGenNotConfiguredError(
      error instanceof Error ? error.message : "The NVIDIA image API root is invalid.",
    );
  }

  const res = await imageGenFetch(endpoint, {
    method: "POST",
    headers: {
      ...(deployment.resolvedApiKey
        ? { Authorization: `Bearer ${deployment.resolvedApiKey}` }
        : {}),
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text_prompts: [{ text: input.prompt, weight: 1 }],
      ...DIMENSIONS[input.size],
      cfg_scale: 5,
      sampler: "K_DPM_2_ANCESTRAL",
      steps: 25,
      seed: 0,
    }),
  });
  if (!res.ok) {
    throw new ImageGenProviderError(
      `NVIDIA image generation failed (${res.status}): ${await errorDetail(res)}`,
      res.status,
    );
  }

  const data = (await res.json()) as NvidiaImageResponse;
  const artifact = data.artifacts?.find((candidate) => typeof candidate.base64 === "string");
  if (!artifact?.base64) {
    throw new ImageGenProviderError("NVIDIA returned no image artifact.");
  }
  if (artifact.finishReason && artifact.finishReason !== "SUCCESS") {
    throw new ImageGenProviderError(
      `NVIDIA did not complete image generation (${artifact.finishReason}).`,
    );
  }
  const buffer = decodedImage(artifact.base64);
  if (!buffer) {
    throw new ImageGenProviderError("NVIDIA returned an invalid or unsupported image artifact.");
  }
  return { buffer, provider: "nvidia", model: contract.model };
}