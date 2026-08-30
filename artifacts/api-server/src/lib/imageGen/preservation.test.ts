import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";

const imagesEdit = vi.fn();
vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: {
    images: {
      edit: (...args: unknown[]) => imagesEdit(...args),
      generate: vi.fn(),
    },
  },
  toFile: async (buffer: Buffer, name: string, options: { type: string }) => ({
    buffer,
    name,
    type: options.type,
  }),
}));

import { restoreProtectedImagePixels } from "./index";
import { generateWithOpenAIBuiltin } from "./providers/openaiBuiltin";
import { ImagePreservationError } from "./types";

async function solid(
  width: number,
  height: number,
  background: { r: number; g: number; b: number; alpha: number },
): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background } }).png().toBuffer();
}

describe("exact masked image preservation", () => {
  it("sends the explicit mask as a multipart OpenAI edit field", async () => {
    const image = await solid(4, 6, { r: 10, g: 20, b: 30, alpha: 1 });
    const mask = await solid(4, 6, { r: 0, g: 0, b: 0, alpha: 0 });
    imagesEdit.mockResolvedValueOnce({ data: [{ b64_json: image.toString("base64") }] });

    await generateWithOpenAIBuiltin(
      {
        prompt: "change clothing",
        size: "1024x1536",
        model: "gpt-image-1",
        referenceImage: { buffer: image, mimeType: "image/png" },
        editMask: { buffer: mask, mimeType: "image/png" },
      },
      null,
    );

    expect(imagesEdit).toHaveBeenCalledTimes(1);
    expect(imagesEdit.mock.calls[0][0].mask).toMatchObject({
      buffer: mask,
      name: "mask.png",
      type: "image/png",
    });
  });

  it("restores exact canonical RGBA pixels inside the protected rectangle", async () => {
    const canonical = await solid(1024, 1536, { r: 240, g: 10, b: 20, alpha: 1 });
    const generated = await solid(512, 768, { r: 5, g: 200, b: 30, alpha: 1 });
    const output = await restoreProtectedImagePixels(generated, canonical, {
      x: 0.25,
      y: 0.25,
      width: 0.5,
      height: 0.25,
    });
    const raw = await sharp(output).ensureAlpha().raw().toBuffer();
    const protectedOffset = (384 * 1024 + 256) * 4;
    const outsideOffset = 0;
    expect([...raw.subarray(protectedOffset, protectedOffset + 4)]).toEqual([240, 10, 20, 255]);
    expect([...raw.subarray(outsideOffset, outsideOffset + 4)]).toEqual([5, 200, 30, 255]);
    expect(await sharp(output).metadata()).toMatchObject({ width: 1024, height: 1536 });
  });

  it("fails deterministically instead of cropping a provider result", async () => {
    const canonical = await solid(1024, 1536, { r: 1, g: 2, b: 3, alpha: 1 });
    const square = await solid(1024, 1024, { r: 4, g: 5, b: 6, alpha: 1 });
    await expect(
      restoreProtectedImagePixels(square, canonical, {
        x: 0,
        y: 0,
        width: 0.25,
        height: 0.25,
      }),
    ).rejects.toBeInstanceOf(ImagePreservationError);
  });
});