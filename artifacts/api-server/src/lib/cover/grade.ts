import sharp from "sharp";
/** Shared muted grade: reduced saturation, lifted blacks, warm bias, fine grain. */
export const EDITORIAL_GRADE = {
  saturation: 0.8,
  contrast: 0.9,
  lift: [13, 11, 9] as const,
  recomb: [[1.03, 0.0, -0.01], [0.0, 1.0, 0.0], [-0.01, 0.0, 0.97]] as
    [[number, number, number], [number, number, number], [number, number, number]],
  grain: 26,
} as const;
export const EDITORIAL_VIDEO_FILTER =
  "eq=contrast=0.92:saturation=0.8:brightness=0.01," +
  "colorchannelmixer=rr=1.03:rb=-0.01:bb=0.97:br=-0.01," +
  "noise=alls=5:allf=t";
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export async function grainPlate(width: number, height: number, amplitude: number, seed = 7): Promise<Buffer> {
  const w = Math.max(1, Math.ceil(width / 2));
  const h = Math.max(1, Math.ceil(height / 2));
  const rand = mulberry32(seed);
  const raw = Buffer.alloc(w * h);
  for (let i = 0; i < raw.length; i += 1) {
    const n = (rand() + rand() - 1) * amplitude;
    raw[i] = Math.max(0, Math.min(255, Math.round(128 + n)));
  }
  return sharp(raw, { raw: { width: w, height: h, channels: 1 } })
    .resize(width, height, { kernel: "cubic" }).toColourspace("srgb").png().toBuffer();
}
export async function applyEditorialGrade(input: Buffer): Promise<Buffer> {
  const g = EDITORIAL_GRADE;
  const meta = await sharp(input).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) throw new Error("Cannot grade an image with unknown dimensions");
  const graded = await sharp(input).flatten({ background: "#808080" }).removeAlpha()
    .modulate({ saturation: g.saturation }).linear([g.contrast, g.contrast, g.contrast], [...g.lift])
    .recomb(g.recomb).png().toBuffer();
  const grain = await grainPlate(width, height, g.grain);
  return sharp(graded).composite([{ input: grain, blend: "soft-light" }]).removeAlpha().png().toBuffer();
}