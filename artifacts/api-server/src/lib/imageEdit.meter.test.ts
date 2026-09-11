import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  edit: vi.fn(),
  meter: vi.fn(),
}));

vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: { images: { edit: state.edit } },
  toFile: vi.fn(async () => ({})),
}));
vi.mock("./meter", () => ({ meter: state.meter }));
vi.mock("./imageGen", () => ({
  ImageGenProviderError: class ImageGenProviderError extends Error {},
}));
vi.mock("./referenceGuide", () => ({
  loadReferenceImage: vi.fn(),
  ReferenceImageError: class ReferenceImageError extends Error {},
}));
vi.mock("./plans", () => ({ getPlan: vi.fn(async () => ({ watermark: false })) }));
vi.mock("./featureFlags", () => ({ isFeatureEnabled: vi.fn(async () => true) }));
vi.mock("./watermark", () => ({ applyMadeWithWatermark: vi.fn() }));
vi.mock("./storageUpload", () => ({
  uploadBufferToStorage: vi.fn(async () => "/objects/7/edit.png"),
}));
vi.mock("./aiCost", () => ({ buildImageCostMeta: vi.fn(async () => ({})) }));

import { performImageEdit } from "./imageEdit";

describe("performImageEdit metering", () => {
  beforeEach(() => {
    state.edit.mockReset();
    state.meter.mockReset();
    state.edit.mockResolvedValue({
      data: [{ b64_json: Buffer.from("edited").toString("base64") }],
      usage: { output_tokens: 23 },
    });
    state.meter.mockImplementation(async (_ctx, _key, _quantity, fn) => fn());
  });

  it("wraps the OpenAI edit boundary with image-edit attribution", async () => {
    const mask = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      Buffer.from("mask"),
    ]).toString("base64");

    await performImageEdit({
      tenantId: 7,
      tenant: { plan: "free" } as never,
      sourceBuffer: Buffer.from("source"),
      sourceMimeType: "image/png",
      maskB64: mask,
      prompt: "replace the sky",
      meterContext: {
        tenantId: 7,
        refKind: "content",
        refId: "88",
        operationKey: "edit:88",
      },
    });

    expect(state.meter).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 7,
        provider: "openai",
        model: expect.any(String),
        operationKey: "edit:88",
      }),
      "image_edit",
      1,
      expect.any(Function),
      expect.any(Function),
    );
    expect(state.edit).toHaveBeenCalledTimes(1);
  });
});