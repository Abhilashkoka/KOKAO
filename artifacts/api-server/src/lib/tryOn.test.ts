import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { buildTryOnReference, tryOnInstruction } from "./tryOn";

async function png(width: number, height: number, color: string) {
  return {
    buffer: await sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer(),
    mimeType: "image/png",
  };
}

describe("try-on reference", () => {
  it("sends the outfit photo unchanged when there is no model photo", async () => {
    const outfit = await png(300, 400, "#00aa88");
    expect(await buildTryOnReference(outfit, null)).toBe(outfit);
  });

  it("places the model on the left and the outfit on the right of one sheet", async () => {
    const model = await png(512, 1024, "#ff0000");
    const outfit = await png(512, 512, "#0000ff");
    const sheet = await buildTryOnReference(outfit, model);
    const meta = await sharp(sheet.buffer).metadata();
    expect(meta.height).toBe(1024);
    expect(meta.width).toBe(512 + 24 + 1024);
    const { data, info } = await sharp(sheet.buffer).raw().toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number) => {
      const i = (y * info.width + x) * info.channels;
      return [data[i], data[i + 1], data[i + 2]];
    };
    expect(pixel(10, 500)).toEqual([255, 0, 0]);
    expect(pixel(meta.width! - 10, 500)).toEqual([0, 0, 255]);
  });

  it("says which half is the person and forbids copying text", () => {
    expect(tryOnInstruction(true, "sways")).toContain("SAME person from the left");
    expect(tryOnInstruction(false, "")).not.toContain("left");
    expect(tryOnInstruction(false, "")).toContain("Do not copy any text");
  });
});
