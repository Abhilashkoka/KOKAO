import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

const { generate, edit } = vi.hoisted(() => ({ generate: vi.fn(), edit: vi.fn() }));
vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: { images: { generate, edit } },
  toFile: async (buffer: Buffer, name: string, options: { type: string }) => ({
    buffer, name, type: options.type,
  }),
}));

import { generateWithOpenAIBuiltin, OPENAI_BUILTIN_MODEL } from "./openaiBuiltin";
import { effectiveModel, getImageGenProviderDef } from "../index";
import { ImageGenOutputValidationError } from "../types";

const input = { model: OPENAI_BUILTIN_MODEL, prompt: "A geometric blue square", size: "1024x1024" as const };
const usage = { input_tokens: 30, output_tokens: 100, input_tokens_details: { text_tokens: 10, image_tokens: 20 } };

beforeEach(() => {
  vi.clearAllMocks();
  generate.mockResolvedValue({ data: [{ b64_json: Buffer.from("image").toString("base64") }], usage });
  edit.mockResolvedValue({ data: [{ b64_json: Buffer.from("edited").toString("base64") }], usage });
});

describe("built-in GPT Image 2", () => {
  it("uses Image 2 for new selections but preserves consent-bound Image 1 selections", () => {
    const def = getImageGenProviderDef("openai")!;
    expect(def.defaultModel).toBe("gpt-image-2");
    expect(def.label).toBe("OpenAI (built in, no key needed)");
    expect(effectiveModel(def, null)).toBe("gpt-image-2");
    expect(effectiveModel(def, "gpt-image-1")).toBe("gpt-image-1");
    expect(def.supportsModelOverride).toBe(false);
    expect(def.supportsImageInput).toBe(true);
    expect(def.supportsExactMaskedEdits).toBe(true);
  });

  it("generates PNG and retains modality counts for correct pricing", async () => {
    const result = await generateWithOpenAIBuiltin(input, null);
    expect(generate).toHaveBeenCalledWith({
      model: "gpt-image-2", prompt: input.prompt, size: input.size, output_format: "png",
    });
    expect(result).toMatchObject({
      model: "gpt-image-2",
      usage: { inputTokens: 30, outputTokens: 100, inputTokenDetails: usage.input_tokens_details },
    });
  });

  it("edits references and passes masks without unsupported input_fidelity", async () => {
    const referenceImage = { buffer: Buffer.from("reference"), mimeType: "image/webp" };
    const editMask = { buffer: Buffer.from("mask"), mimeType: "image/png" };
    await generateWithOpenAIBuiltin({ ...input, referenceImage, editMask }, null);
    expect(edit.mock.calls[0][0]).toMatchObject({
      model: "gpt-image-2", image: { name: "reference.webp" }, mask: { name: "mask.png" },
      output_format: "png",
    });
    expect(edit.mock.calls[0][0]).not.toHaveProperty("input_fidelity");
    expect(generate).not.toHaveBeenCalled();
  });

  it("dispatches and reports the same legacy model for frozen jobs", async () => {
    const result = await generateWithOpenAIBuiltin({ ...input, model: "gpt-image-1" }, null);
    expect(generate.mock.calls[0][0].model).toBe("gpt-image-1");
    expect(result.model).toBe("gpt-image-1");
  });

  it("rejects unsupported model and mask-only requests before dispatch", async () => {
    await expect(generateWithOpenAIBuiltin({ ...input, model: "unknown" }, null)).rejects.toThrow("Unsupported");
    await expect(generateWithOpenAIBuiltin({
      ...input, editMask: { buffer: Buffer.from("mask"), mimeType: "image/png" },
    }, null)).rejects.toThrow("requires a reference");
    expect(generate).not.toHaveBeenCalled();
    expect(edit).not.toHaveBeenCalled();
  });

  it.each([false, true])("requests preview transparency for reference=%s and rejects opaque output", async (reference) => {
    const opaque = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
    const response = { data: [{ b64_json: opaque.toString("base64") }], usage };
    generate.mockResolvedValue(response);
    edit.mockResolvedValue(response);
    await expect(generateWithOpenAIBuiltin({
      ...input, transparent: true,
      ...(reference ? { referenceImage: { buffer: opaque, mimeType: "image/png" } } : {}),
    }, null)).rejects.toBeInstanceOf(ImageGenOutputValidationError);
    expect((reference ? edit : generate).mock.calls[0][0].background).toBe("transparent");
  });

  it("accepts actual transparent PNG output from the preview capability", async () => {
    const png = await sharp({
      create: { width: 2, height: 2, channels: 4, background: { r: 0, g: 0, b: 255, alpha: 0.5 } },
    }).png().toBuffer();
    generate.mockResolvedValue({ data: [{ b64_json: png.toString("base64") }], usage });
    const result = await generateWithOpenAIBuiltin({ ...input, transparent: true }, null);
    expect(result.buffer).toEqual(png);
  });
});