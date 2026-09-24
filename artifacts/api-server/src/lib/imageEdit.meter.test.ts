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

import { decodeMask, performImageEdit } from "./imageEdit";
import { buildImageCostMeta } from "./aiCost";

describe("performImageEdit metering", () => {
  beforeEach(() => {
    state.edit.mockReset();
    state.meter.mockReset();
    state.edit.mockResolvedValue({
      data: [{ b64_json: Buffer.from("edited").toString("base64") }],
      usage: {
        input_tokens: 30, output_tokens: 23,
        input_tokens_details: { text_tokens: 10, image_tokens: 20 },
      },
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
    expect(state.edit.mock.calls[0][0]).toMatchObject({ model: "gpt-image-2", output_format: "png" });
    expect(buildImageCostMeta).toHaveBeenCalledWith(expect.objectContaining({
      model: "gpt-image-2",
      usage: { inputTokens: 30, outputTokens: 23, inputTokenDetails: { text_tokens: 10, image_tokens: 20 } },
    }));
  });

  it("rejects masks at the official 4 MB boundary before dispatch", () => {
    const mask = Buffer.alloc(4 * 1024 * 1024);
    Buffer.from([0x89, 0x50, 0x4e, 0x47]).copy(mask);
    expect(() => decodeMask(mask.toString("base64"))).toThrow("under 4 MB");
    expect(state.edit).not.toHaveBeenCalled();
  });
});