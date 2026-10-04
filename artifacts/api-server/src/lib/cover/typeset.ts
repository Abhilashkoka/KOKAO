import sharp from "sharp";
import { fontPath, type CoverFont } from "./fonts";
export interface RenderedText { buffer: Buffer; width: number; height: number; }
export function escapePango(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
export interface TextSpec {
  text: string; font: CoverFont; maxWidth: number; maxHeight: number; color: string;
  letterSpacing?: number; align?: "left" | "centre" | "right";
}
/** Pango autofits to a box, then the transparent result is trimmed to actual ink. */
export async function renderText(spec: TextSpec): Promise<RenderedText | null> {
  const text = spec.text.trim();
  if (!text) return null;
  const tracking = spec.letterSpacing ? ` letter_spacing="${Math.round(spec.letterSpacing)}"` : "";
  const markup = `<span foreground="${spec.color}"${tracking}>${escapePango(text)}</span>`;
  const raw = await sharp({
    text: {
      text: markup, font: spec.font.family, fontfile: fontPath(spec.font),
      width: Math.max(1, Math.round(spec.maxWidth)), height: Math.max(1, Math.round(spec.maxHeight)),
      rgba: true, align: spec.align ?? "centre", wrap: "word",
    },
  }).png().toBuffer();
  let trimmed = raw;
  try { trimmed = await sharp(raw).trim({ threshold: 1 }).png().toBuffer(); } catch { trimmed = raw; }
  const meta = await sharp(trimmed).metadata();
  return { buffer: trimmed, width: meta.width ?? 0, height: meta.height ?? 0 };
}
export async function renderSparkle(size: number, color: string): Promise<RenderedText> {
  const s = Math.max(8, Math.round(size));
  const c = s / 2;
  const k = s * 0.12;
  const path = `M ${c} 0 Q ${c + k} ${c - k} ${s} ${c} Q ${c + k} ${c + k} ${c} ${s} Q ${c - k} ${c + k} 0 ${c} Q ${c - k} ${c - k} ${c} 0 Z`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}"><path d="${path}" fill="${color}"/></svg>`;
  const buffer = await sharp(Buffer.from(svg)).png().toBuffer();
  return { buffer, width: s, height: s };
}
export async function renderArrow(width: number, height: number, color: string, flip: boolean): Promise<RenderedText> {
  const w = Math.max(16, Math.round(width));
  const h = Math.max(16, Math.round(height));
  const stroke = Math.max(2, Math.round(w * 0.035));
  const x0 = w * 0.12, y0 = h * 0.08, x1 = w * 0.78, y1 = h * 0.86, head = w * 0.16;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <g fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"${flip ? ` transform="translate(${w} 0) scale(-1 1)"` : ""}>
    <path d="M ${x0} ${y0} C ${w * 0.7} ${h * 0.05}, ${w * 0.95} ${h * 0.45}, ${x1} ${y1}"/>
    <path d="M ${x1 - head} ${y1 - head * 0.35} L ${x1} ${y1} L ${x1 + head * 0.15} ${y1 - head}"/>
  </g></svg>`;
  const buffer = await sharp(Buffer.from(svg)).png().toBuffer();
  return { buffer, width: w, height: h };
}