import { describe, expect, it } from "vitest";
import {
  NVIDIA_SDXL_MODEL,
  NVIDIA_WAN_2_2_VIDEO_MODEL,
  findNvidiaModelContract,
  nvidiaHostedImageEndpoint,
  nvidiaNimImageEndpoint,
  nvidiaNimVideoEndpoint,
} from "./nvidia";

describe("NVIDIA compatible-contract registry", () => {
  it("activates only a model with a verified image adapter", () => {
    const contract = findNvidiaModelContract("image", NVIDIA_SDXL_MODEL);
    expect(contract?.protocol).toBe("nvidia-image-v1");
    expect(nvidiaHostedImageEndpoint(contract!)).toBe(
      "https://ai.api.nvidia.com/v1/genai/stabilityai/stable-diffusion-xl",
    );
  });

  it("composes the verified self-hosted NIM route exactly once", () => {
    const contract = findNvidiaModelContract("image", NVIDIA_SDXL_MODEL)!;
    expect(nvidiaNimImageEndpoint(contract, "https://nim.example.com")).toBe(
      "https://nim.example.com/v1/generation/stabilityai/stable-diffusion-xl",
    );
    expect(nvidiaNimImageEndpoint(contract, "https://nim.example.com/v1/")).toBe(
      "https://nim.example.com/v1/generation/stabilityai/stable-diffusion-xl",
    );
  });

  it("does not activate video catalog entries without a verified KOKAO contract", () => {
    expect(findNvidiaModelContract("video", "nvidia/cosmos-predict")).toBeNull();
    expect(findNvidiaModelContract("video", NVIDIA_WAN_2_2_VIDEO_MODEL)?.protocol).toBe(
      "nvidia-video-v1",
    );
    expect(nvidiaNimVideoEndpoint("https://nim.example.com")).toBe(
      "https://nim.example.com/v1/videos/generations",
    );
  });

  it("rejects unsafe or ambiguous self-hosted NIM roots", () => {
    const contract = findNvidiaModelContract("image", NVIDIA_SDXL_MODEL)!;
    expect(() => nvidiaNimImageEndpoint(contract, "https://key@example.com")).toThrow(
      "without embedded credentials",
    );
    expect(() => nvidiaNimImageEndpoint(contract, "https://nim.example.com/v1/genai")).toThrow(
      "service origin or its /v1 API root",
    );
  });
});