import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { applyMadeWithWatermark, renderWatermarkPill } from "./watermark";

async function solidPng(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 40, g: 90, b: 200 } },
  })
    .png()
    .toBuffer();
}

describe("applyMadeWithWatermark", () => {
  it("stamps the watermark and returns a valid PNG of the same size", async () => {
    const input = await solidPng(1024, 1024);
    const out = await applyMadeWithWatermark(input);
    expect(out.equals(input)).toBe(false);
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(1024);
    expect(meta.height).toBe(1024);
    // Bottom-right corner region should differ from the solid base color.
    const raw = await sharp(out)
      .extract({ left: 1024 - 60, top: 1024 - 40, width: 20, height: 20 })
      .raw()
      .toBuffer();
    let changed = false;
    for (let i = 0; i < raw.length; i += 3) {
      if (raw[i] !== 40 || raw[i + 1] !== 90 || raw[i + 2] !== 200) {
        changed = true;
        break;
      }
    }
    expect(changed).toBe(true);
  });

  it("returns the original image when the pill would not fit", async () => {
    const input = await solidPng(40, 40);
    const out = await applyMadeWithWatermark(input);
    expect(out.equals(input)).toBe(true);
  });

  it("fails soft on a non-image buffer", async () => {
    const junk = Buffer.from("definitely not an image");
    const out = await applyMadeWithWatermark(junk);
    expect(out.equals(junk)).toBe(true);
  });
});

describe("renderWatermarkPill", () => {
  it("renders a standalone PNG pill sized for the frame", async () => {
    const pill = await renderWatermarkPill(1080, 1920);
    expect(pill).not.toBeNull();
    const meta = await sharp(pill!.png).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(pill!.width);
    expect(meta.height).toBe(pill!.height);
    expect(pill!.width + pill!.margin).toBeLessThanOrEqual(1080);
  });

  it("returns null when the pill would not fit the frame", async () => {
    expect(await renderWatermarkPill(40, 40)).toBeNull();
  });
});
