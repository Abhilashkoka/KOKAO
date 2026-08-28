import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateWithNvidia } from "./nvidia";

const { resolveDeployment, isActivatable } = vi.hoisted(() => ({
  resolveDeployment: vi.fn(),
  isActivatable: vi.fn(),
}));

vi.mock("../../nvidiaCore", () => ({
  resolveNvidiaCoreDeployment: resolveDeployment,
  isNvidiaCoreDeploymentActivatable: isActivatable,
}));

const realFetch = globalThis.fetch;
const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");

beforeEach(() => {
  globalThis.fetch = realFetch;
  isActivatable.mockResolvedValue(true);
  resolveDeployment.mockResolvedValue({
    capability: "image",
    kind: "self-hosted",
    protocol: "nvidia-image-v1",
    model: "stabilityai/stable-diffusion-xl",
    baseUrl: "https://nim.example/v1",
    resolvedApiKey: null,
  });
});

describe("NVIDIA self-hosted image NIM adapter", () => {
  it("generates through a tested keyless NIM without an Authorization header", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ artifacts: [{ base64: png, finishReason: "SUCCESS" }] }),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await generateWithNvidia(
      { prompt: "A paper kite", size: "1024x1024", model: "stabilityai/stable-diffusion-xl" },
      null,
    );

    expect(result).toMatchObject({ provider: "nvidia", model: "stabilityai/stable-diffusion-xl" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://nim.example/v1/generation/stabilityai/stable-diffusion-xl",
      expect.objectContaining({
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
      }),
    );
  });

  it("rejects a legacy hosted image deployment before generating", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;
    resolveDeployment.mockResolvedValue({
      capability: "image",
      kind: "hosted",
      protocol: "nvidia-image-v1",
      model: "stabilityai/stable-diffusion-xl",
      baseUrl: "https://ai.api.nvidia.com",
      resolvedApiKey: "shared-hosted-key",
    });

    await expect(
      generateWithNvidia(
        { prompt: "A paper kite", size: "1024x1024", model: "stabilityai/stable-diffusion-xl" },
        null,
      ),
    ).rejects.toThrow("non-billable independent test");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});