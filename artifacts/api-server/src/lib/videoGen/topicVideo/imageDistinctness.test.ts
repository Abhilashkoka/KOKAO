import sharp from "sharp";
import { describe, expect, it } from "vitest";

import {
  imageFingerprint,
  imageFingerprintDifference,
  matchesPriorImage,
} from "./imageDistinctness";

async function solid(color: string): Promise<Buffer> {
  return sharp({
    create: {
      width: 64,
      height: 64,
      channels: 3,
      background: color,
    },
  })
    .png()
    .toBuffer();
}

describe("storyboard image distinctness", () => {
  it("detects the same generated image even when passed as separate buffers", async () => {
    const image = await solid("#cc4433");
    const first = await imageFingerprint(image);
    const copy = await imageFingerprint(Buffer.from(image));
    expect(imageFingerprintDifference(first, copy)).toBe(0);
    expect(matchesPriorImage(copy, [first])).toBe(true);
  });

  it("treats a tiny visual variation as a near-duplicate", async () => {
    const first = await imageFingerprint(await solid("#cc4433"));
    const tinyVariation = await imageFingerprint(await solid("#ce4534"));
    expect(matchesPriorImage(tinyVariation, [first])).toBe(true);
  });

  it("allows clearly different frames of the same storyboard", async () => {
    const first = await imageFingerprint(await solid("#cc4433"));
    const different = await imageFingerprint(await solid("#2255cc"));
    expect(matchesPriorImage(different, [first])).toBe(false);
  });
});