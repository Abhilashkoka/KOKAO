import sharp from "sharp";
import { applyEditorialGrade } from "./grade";
import { COVER_FONTS } from "./fonts";
import { renderArrow, renderSparkle, renderText, type RenderedText } from "./typeset";
import { COVER_HEIGHT, COVER_WIDTH, MAX_HEADLINE_OCCLUSION, type CoverCopy, type CoverLayout, type CoverOptions } from "./types";
const W = COVER_WIDTH, H = COVER_HEIGHT;
export const DARK_INK = "#16161A";
export const LIGHT_INK = "#FFFFFF";
export interface PreparedCanvas { base: Buffer; subject: Buffer | null; }
export interface CoverBlock {
  id: "headline" | "subject" | "kicker" | "subline" | "accent";
  name: string; buffer: Buffer; x: number; y: number; width: number; height: number;
}
export interface TypesetCover {
  base: Buffer; blocks: CoverBlock[]; flat: Buffer; layout: CoverLayout; textColor: string; notice: string | null;
}
interface Box { left: number; top: number; width: number; height: number; }
async function matteBox(matte: Buffer): Promise<Box | null> {
  try {
    const { info } = await sharp(matte).greyscale().threshold(128)
      .trim({ background: "#000000", threshold: 10 }).png().toBuffer({ resolveWithObject: true });
    return { left: -(info.trimOffsetLeft ?? 0), top: -(info.trimOffsetTop ?? 0), width: info.width, height: info.height };
  } catch { return null; }
}
async function matteCoverage(matte: Buffer): Promise<number> {
  const stats = await sharp(matte).greyscale().stats();
  return (stats.channels[0]?.mean ?? 0) / 255;
}
function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }
/** Crop and grade once, then reuse these buffers for free typography changes. */
export async function prepareCoverCanvas(input: {
  source: Buffer; matte: Buffer | null; options: Pick<CoverOptions, "grade" | "position">;
}): Promise<PreparedCanvas> {
  const oriented = await sharp(input.source).rotate().removeAlpha().png().toBuffer();
  const meta = await sharp(oriented).metadata();
  const sw = meta.width ?? 0, sh = meta.height ?? 0;
  if (!sw || !sh) throw new Error("Could not read the source image dimensions.");
  let matte: Buffer | null = null;
  if (input.matte) {
    const fitted = await sharp(input.matte).greyscale().resize(sw, sh, { fit: "fill" }).png().toBuffer();
    const coverage = await matteCoverage(fitted);
    if (coverage > 0.02 && coverage < 0.92) matte = fitted;
  }
  const scale = Math.max(W / sw, H / sh);
  const SW = Math.max(W, Math.round(sw * scale)), SH = Math.max(H, Math.round(sh * scale));
  let left = Math.round((SW - W) / 2), top = Math.round((SH - H) / 2);
  const box = matte ? await matteBox(matte) : null;
  if (box) {
    const cx = (box.left + box.width / 2) * scale;
    left = Math.round(clamp(cx - W / 2, 0, SW - W));
    if (input.options.position === "top") {
      top = Math.round(clamp(box.top * scale - H * 0.17, 0, SH - H));
    } else {
      top = Math.round(clamp((box.top + box.height / 2) * scale - H / 2, 0, SH - H));
    }
  }
  const rgb = box
    ? await sharp(oriented).resize(SW, SH, { fit: "fill" }).extract({ left, top, width: W, height: H }).png().toBuffer()
    : await sharp(oriented).resize(W, H, { fit: "cover", position: sharp.strategy.attention }).png().toBuffer();
  const base = input.options.grade === "editorial" ? await applyEditorialGrade(rgb) : rgb;
  let subject: Buffer | null = null;
  if (matte && box) {
    const alpha = await sharp(matte).resize(SW, SH, { fit: "fill" }).extract({ left, top, width: W, height: H })
      .blur(0.8).toColourspace("b-w").png().toBuffer();
    subject = await sharp(base).joinChannel(alpha).png().toBuffer();
  }
  return { base, subject };
}
interface Zone { top: number; bottom: number; }
function zoneFor(position: CoverOptions["position"]): Zone {
  return position === "top" ? { top: Math.round(H * 0.055), bottom: Math.round(H * 0.3) }
    : { top: Math.round(H * 0.66), bottom: Math.round(H * 0.95) };
}
async function bandLuminance(image: Buffer, zone: Zone): Promise<number> {
  const stats = await sharp(image).extract({ left: 0, top: zone.top, width: W, height: Math.max(1, zone.bottom - zone.top) })
    .removeAlpha().stats();
  const [r, g, b] = stats.channels.map((c) => c.mean / 255);
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}
async function scrim(zone: Zone, position: CoverOptions["position"], strength: number): Promise<Buffer> {
  const pad = Math.round(H * 0.1);
  const y0 = position === "top" ? 0 : zone.top - pad;
  const y1 = position === "top" ? zone.bottom + pad : H;
  const from = position === "top" ? strength : 0, to = position === "top" ? 0 : strength;
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#000" stop-opacity="${from}"/>
    <stop offset="1" stop-color="#000" stop-opacity="${to}"/>
  </linearGradient></defs><rect x="0" y="${y0}" width="${W}" height="${y1 - y0}" fill="url(#g)"/></svg>`)).png().toBuffer();
}
async function occlusion(headline: CoverBlock, subject: Buffer): Promise<number> {
  const left = clamp(headline.x, 0, W - 1), top = clamp(headline.y, 0, H - 1);
  const width = Math.min(headline.width, W - left), height = Math.min(headline.height, H - top);
  if (width <= 0 || height <= 0) return 0;
  const subjectAlpha = await sharp(subject).extract({ left, top, width, height }).extractChannel(3).raw().toBuffer();
  const inkAlpha = await sharp(headline.buffer)
    .extract({ left: left - headline.x, top: top - headline.y, width, height }).ensureAlpha().extractChannel(3).raw().toBuffer();
  let ink = 0, hidden = 0;
  for (let i = 0; i < inkAlpha.length; i += 1) {
    const a = inkAlpha[i]!;
    if (a === 0) continue;
    ink += a;
    hidden += Math.min(a, subjectAlpha[i] ?? 0);
  }
  return ink === 0 ? 0 : hidden / ink;
}
function block(id: CoverBlock["id"], name: string, r: RenderedText, x: number, y: number): CoverBlock {
  return { id, name, buffer: r.buffer, width: r.width, height: r.height,
    x: Math.round(clamp(x, 0, W - r.width)), y: Math.round(clamp(y, 0, H - r.height)) };
}
export async function typesetCover(input: { canvas: PreparedCanvas; copy: CoverCopy; options: CoverOptions }): Promise<TypesetCover> {
  const { canvas, copy, options } = input;
  const zone = zoneFor(options.position);
  let notice: string | null = null;
  const lum = await bandLuminance(canvas.base, zone);
  const lightText = options.theme === "light" || (options.theme === "auto" && lum < 0.6);
  const textColor = lightText ? LIGHT_INK : DARK_INK, accentColor = options.accentColor ?? textColor;
  let base = canvas.base;
  if (lightText && lum > 0.38) {
    const strength = clamp(0.25 + (lum - 0.38) * 0.9, 0.25, 0.5);
    base = await sharp(base).composite([{ input: await scrim(zone, options.position, strength) }]).removeAlpha().png().toBuffer();
  }
  const condensed = options.headlineStyle === "condensed";
  const headlineR = await renderText({
    text: condensed ? copy.headline.toUpperCase() : copy.headline,
    font: condensed ? COVER_FONTS.condensed : COVER_FONTS.grotesk,
    maxWidth: W * 0.88, maxHeight: H * (condensed ? 0.19 : 0.13), color: textColor, letterSpacing: condensed ? 0 : -1200,
  });
  if (!headlineR) throw new Error("A cover needs a headline.");
  const headlineY = options.position === "top" ? zone.top + H * 0.03 : zone.bottom - headlineR.height - H * 0.045;
  const headline = block("headline", "Headline", headlineR, (W - headlineR.width) / 2, headlineY);
  const blocksAbove: CoverBlock[] = [];
  const kickerR = await renderText({
    text: copy.kicker, font: COVER_FONTS.kicker, maxWidth: W * 0.5, maxHeight: H * 0.05, color: textColor, align: "left",
  });
  if (kickerR) {
    const tuck = condensed ? -0.06 : 0.15;
    blocksAbove.push(block("kicker", "Kicker", kickerR, headline.x + W * 0.015, headline.y - kickerR.height * (1 - tuck)));
  }
  const sublineR = await renderText({
    text: copy.subline, font: COVER_FONTS.subline, maxWidth: W * 0.6, maxHeight: H * 0.028, color: textColor, align: "right",
  });
  if (sublineR) {
    blocksAbove.push(block("subline", "Subline", sublineR,
      headline.x + headline.width - sublineR.width, headline.y + headline.height + H * 0.012));
  }
  if (options.accent === "sparkle") {
    const s = await renderSparkle(W * 0.042, accentColor);
    blocksAbove.push(block("accent", "Sparkle", s, headline.x + headline.width + W * 0.004, headline.y - s.height * 0.55));
  } else if (options.accent === "arrow") {
    const a = await renderArrow(W * 0.15, W * 0.13, accentColor, false);
    if (options.position === "top") {
      blocksAbove.push(block("accent", "Arrow", a, headline.x + W * 0.04, headline.y + headline.height + H * 0.015));
    } else {
      const flipped = await sharp(a.buffer).rotate(180).png().toBuffer();
      blocksAbove.push(block("accent", "Arrow", { ...a, buffer: flipped },
        headline.x + headline.width - a.width - W * 0.04, headline.y - a.height - H * 0.015));
    }
  }
  let layout: CoverLayout = options.layout;
  if (layout === "behind" && !canvas.subject) {
    layout = "over";
    notice = "Couldn't separate the person from the background, so the headline sits on top of the photo.";
  }
  if (layout === "behind" && canvas.subject && await occlusion(headline, canvas.subject) > MAX_HEADLINE_OCCLUSION) {
    layout = "over";
    notice = "The person would hide too much of the headline, so it sits on top. Try a shorter headline or a photo with more space above the head.";
  }
  const blocks: CoverBlock[] = [headline];
  if (layout === "behind" && canvas.subject) {
    blocks.push({ id: "subject", name: "Subject", buffer: canvas.subject, x: 0, y: 0, width: W, height: H });
  }
  blocks.push(...blocksAbove);
  const flat = await sharp(base).composite(blocks.map((b) => ({ input: b.buffer, left: b.x, top: b.y }))).removeAlpha().png().toBuffer();
  return { base, blocks, flat, layout, textColor, notice };
}