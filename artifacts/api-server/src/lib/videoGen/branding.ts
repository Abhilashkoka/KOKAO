import type { BrandKitPayload } from "@workspace/db";
import { loadActivePayload } from "../brandKit/service";

/**
 * Brand kit → video: everything the video pipeline needs from a brand kit,
 * resolved once per job. Branding is opt-in (only applied when the job
 * carries a brandKitId) and strictly fail-soft — a missing kit, color, or
 * logo just means that touch is skipped.
 */

export interface VideoBranding {
  /** Voice/audience/avoid-terms line for the script prompt, or null. */
  voiceHint: string | null;
  /** Caption accent as an ffmpeg color ("0xRRGGBB"), pre-darkened for use
   * as a stroke behind white text, or null. */
  accentColor: string | null;
  /** Tenant-storage path of the logo to watermark with, or null. */
  watermarkPath: string | null;
  brandName: string;
}

/** "#A1B2C3" / "A1B2C3" → {r,g,b}, or null for anything else. */
export function parseHexColor(hex: string): { r: number; g: number; b: number } | null {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!match) return null;
  const value = Number.parseInt(match[1]!, 16);
  return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff };
}

/**
 * Darken a brand color for use as the caption stroke: white text needs a
 * dark outline, so the hue is kept but luminance is pulled down.
 */
export function toCaptionStroke(hex: string): string | null {
  const rgb = parseHexColor(hex);
  if (!rgb) return null;
  const darken = (c: number) => Math.round(c * 0.45);
  const value = (darken(rgb.r) << 16) | (darken(rgb.g) << 8) | darken(rgb.b);
  return `0x${value.toString(16).padStart(6, "0").toUpperCase()}`;
}

function firstColorHex(payload: BrandKitPayload): string | null {
  const candidates = [...payload.colors.primary, ...payload.colors.secondary];
  for (const color of candidates) {
    if (parseHexColor(color.hex)) return color.hex;
  }
  return null;
}

/** The logo best suited to a small corner watermark (icon mark first). */
function watermarkLogoPath(payload: BrandKitPayload): string | null {
  const candidates = [payload.logos.icon_mark, payload.logos.primary, payload.logos.secondary];
  for (const logo of candidates) {
    // Only tenant-storage paths are loaded (external URLs would mean a
    // server-side fetch of an arbitrary host at render time).
    if (logo?.url?.startsWith("/objects/")) return logo.url;
  }
  return null;
}

/** One compact line steering the script writer toward the brand's voice. */
function buildVoiceHint(payload: BrandKitPayload): string | null {
  const parts: string[] = [];
  const traits = payload.voice.traits.filter(Boolean).slice(0, 5);
  if (traits.length > 0) parts.push(`Voice: ${traits.join(", ")}.`);
  const audience = payload.identity.audience.filter(Boolean).slice(0, 3);
  if (audience.length > 0) parts.push(`Audience: ${audience.join(", ")}.`);
  if (payload.voice.cta_style) parts.push(`CTA style: ${payload.voice.cta_style}.`);
  const restricted = payload.brand_controls.restricted_terms.filter(Boolean);
  if (restricted.length > 0) parts.push(`Never use these terms: ${restricted.join(", ")}.`);
  return parts.length > 0 ? parts.join(" ") : null;
}

/** Resolve a brand kit into video-ready branding, or null. Fail-soft. */
export async function loadVideoBranding(
  tenantId: number,
  brandKitId: number | null | undefined,
): Promise<VideoBranding | null> {
  if (!brandKitId) return null;
  const resolved = await loadActivePayload(tenantId, brandKitId);
  if (!resolved) return null;
  const payload = resolved.payload;
  const hex = firstColorHex(payload);
  return {
    voiceHint: buildVoiceHint(payload),
    accentColor: hex ? toCaptionStroke(hex) : null,
    watermarkPath: watermarkLogoPath(payload),
    brandName: payload.identity.brand_name,
  };
}
