import { openai } from "@workspace/integrations-openai-ai-server";
import type { BrandKitPayload, BrandColor } from "@workspace/db";
import { buildDefaultPayload } from "./defaults";
import {
  safeFetch,
  readCappedText,
  htmlToText,
  ALLOWED_CONTENT_TYPES,
  MAX_FETCH_BYTES,
} from "../webFetch";

export interface DraftInput {
  url?: string | null;
  notes?: string | null;
  brandName?: string | null;
  industry?: string | null;
}

export interface DraftOutput {
  payload: BrandKitPayload;
  sourceNotes: string;
}

const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : [];

const asString = (v: unknown, fallback = ""): string =>
  typeof v === "string" ? v : fallback;

function asColorArray(v: unknown): BrandColor[] {
  if (!Array.isArray(v)) return [];
  const out: BrandColor[] = [];
  for (const item of v) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const hex = asString(o.hex).trim();
    if (!hex) continue;
    out.push({
      name: asString(o.name) || hex,
      hex,
      usage: asString(o.usage),
    });
  }
  return out;
}

/**
 * Deep-merge AI-produced brand fields over a complete default payload. Only
 * known keys are copied and every value is coerced to its expected type, so a
 * malformed/partial AI response can never produce an invalid payload.
 */
function mergeDraft(base: BrandKitPayload, ai: Record<string, unknown>): BrandKitPayload {
  const identity = (ai.identity ?? {}) as Record<string, unknown>;
  const colors = (ai.colors ?? {}) as Record<string, unknown>;
  const typography = (ai.typography ?? {}) as Record<string, unknown>;
  const voice = (ai.voice ?? {}) as Record<string, unknown>;
  const visual = (ai.visual_style ?? {}) as Record<string, unknown>;

  return {
    ...base,
    identity: {
      ...base.identity,
      brand_name: asString(identity.brand_name, base.identity.brand_name),
      tagline: asString(identity.tagline, base.identity.tagline),
      description: asString(identity.description, base.identity.description),
      industry: asString(identity.industry, base.identity.industry),
      audience: asStringArray(identity.audience).length
        ? asStringArray(identity.audience)
        : base.identity.audience,
    },
    // Fall back to the base group when the AI omits it, so deterministically
    // extracted website colors survive a weak AI response.
    colors: {
      primary: asColorArray(colors.primary).length
        ? asColorArray(colors.primary)
        : base.colors.primary,
      secondary: asColorArray(colors.secondary).length
        ? asColorArray(colors.secondary)
        : base.colors.secondary,
      neutral: asColorArray(colors.neutral).length
        ? asColorArray(colors.neutral)
        : base.colors.neutral,
      semantic: asColorArray(colors.semantic).length
        ? asColorArray(colors.semantic)
        : base.colors.semantic,
    },
    typography: {
      ...base.typography,
      heading_font: asString(typography.heading_font, base.typography.heading_font),
      body_font: asString(typography.body_font, base.typography.body_font),
      fallback_fonts: asStringArray(typography.fallback_fonts).length
        ? asStringArray(typography.fallback_fonts)
        : base.typography.fallback_fonts,
    },
    voice: {
      ...base.voice,
      traits: asStringArray(voice.traits),
      dos: asStringArray(voice.dos),
      donts: asStringArray(voice.donts),
      caption_style: asString(voice.caption_style, base.voice.caption_style),
      cta_style: asString(voice.cta_style, base.voice.cta_style),
    },
    visual_style: {
      ...base.visual_style,
      imagery_style: asStringArray(visual.imagery_style),
      icon_style: asString(visual.icon_style, base.visual_style.icon_style),
      illustration_style: asString(
        visual.illustration_style,
        base.visual_style.illustration_style,
      ),
      motion_style: asString(visual.motion_style, base.visual_style.motion_style),
    },
  };
}

/** Decode the handful of HTML entities that commonly appear in attribute values. */
export function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&#x0*27;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#0*38;|&#x0*26;/gi, "&");
}

/**
 * Best-effort logo discovery from a fetched page: prefers apple-touch-icon
 * (usually a clean logo mark), then any rel="icon" link. og:image is skipped
 * on purpose — it is typically a wide social banner, not a logo. Relative
 * hrefs are resolved against the page URL; non-http(s) results are dropped.
 */
export function extractLogos(
  html: string,
  pageUrl: URL,
): { iconMark: string | null; favicon: string | null } {
  const resolve = (href: string): string | null => {
    try {
      const u = new URL(decodeHtmlEntities(href.trim()), pageUrl);
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      return u.toString();
    } catch {
      return null;
    }
  };

  const linkTags = html.match(/<link\b[^>]*>/gi) ?? [];
  let appleIcon: string | null = null;
  let anyIcon: string | null = null;
  for (const tag of linkTags) {
    const relMatch = /rel\s*=\s*["']([^"']+)["']/i.exec(tag);
    const hrefMatch = /href\s*=\s*["']([^"']+)["']/i.exec(tag);
    if (!relMatch || !hrefMatch) continue;
    const rel = relMatch[1]!.toLowerCase();
    const href = resolve(hrefMatch[1]!);
    if (!href) continue;
    if (rel.includes("apple-touch-icon") && !appleIcon) appleIcon = href;
    else if (rel.split(/\s+/).includes("icon") && !anyIcon) anyIcon = href;
  }

  return {
    iconMark: appleIcon ?? anyIcon,
    favicon: anyIcon ?? appleIcon,
  };
}

/** Expand #abc to #aabbcc and lowercase. Returns null for non-hex input. */
export function normalizeHex(input: string): string | null {
  const v = input.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  if (/^#[0-9a-f]{3}$/.test(v)) {
    return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  }
  return null;
}

/**
 * Classify a hex color as a "brand" color (saturated, mid-lightness) or a
 * "neutral" (grays, near-white, near-black) using HSL saturation/lightness.
 */
export function classifyHex(hex: string): "brand" | "neutral" {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (s >= 0.2 && l >= 0.12 && l <= 0.92) return "brand";
  return "neutral";
}

/**
 * Pull hex color candidates out of raw HTML/CSS text, ranked by frequency.
 * `boosted` colors (e.g. theme-color meta) are placed first. Returns
 * normalized 6-digit lowercase hexes, deduplicated.
 */
export function extractColorCandidates(
  texts: string[],
  boosted: string[] = [],
): string[] {
  const counts = new Map<string, number>();
  for (const text of texts) {
    const matches = text.match(/#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g) ?? [];
    for (const m of matches) {
      const hex = normalizeHex(m);
      if (!hex) continue;
      counts.set(hex, (counts.get(hex) ?? 0) + 1);
    }
  }
  const ranked = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([hex]) => hex);
  const front = boosted
    .map((b) => normalizeHex(b))
    .filter((h): h is string => h !== null);
  return [...new Set([...front, ...ranked])];
}

/** Find the theme-color meta value, if present. */
export function extractThemeColor(html: string): string | null {
  const metas = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of metas) {
    if (!/name\s*=\s*["']theme-color["']/i.test(tag)) continue;
    const content = /content\s*=\s*["']([^"']+)["']/i.exec(tag);
    if (content) return normalizeHex(content[1]!);
  }
  return null;
}

/** Collect up to `limit` same-page stylesheet URLs (http/https only). */
export function extractStylesheetUrls(
  html: string,
  pageUrl: URL,
  limit = 2,
): string[] {
  const out: string[] = [];
  const linkTags = html.match(/<link\b[^>]*>/gi) ?? [];
  for (const tag of linkTags) {
    if (out.length >= limit) break;
    const relMatch = /rel\s*=\s*["']([^"']+)["']/i.exec(tag);
    const hrefMatch = /href\s*=\s*["']([^"']+)["']/i.exec(tag);
    if (!relMatch || !hrefMatch) continue;
    if (!relMatch[1]!.toLowerCase().split(/\s+/).includes("stylesheet")) continue;
    try {
      const u = new URL(decodeHtmlEntities(hrefMatch[1]!.trim()), pageUrl);
      if (u.protocol !== "http:" && u.protocol !== "https:") continue;
      out.push(u.toString());
    } catch {
      // ignore malformed hrefs
    }
  }
  return out;
}

const MAX_CSS_BYTES = 256 * 1024;

/**
 * Best-effort AI brand draft. Optionally reads a public web page (SSRF-guarded)
 * for context, asks the model to infer brand attributes, and returns a complete
 * (default-backed) payload. Never throws on a weak AI response — it degrades to
 * the default payload with whatever could be inferred.
 */
export async function draftBrandKit(
  aiModel: string,
  input: DraftInput,
): Promise<DraftOutput> {
  const base = buildDefaultPayload({
    brandName: input.brandName ?? undefined,
    industry: input.industry ?? undefined,
  });

  const contextParts: string[] = [];
  const sourceNotes: string[] = [];

  if (input.brandName) contextParts.push(`Brand name: ${input.brandName}.`);
  if (input.industry) contextParts.push(`Industry: ${input.industry}.`);
  if (input.notes) contextParts.push(`User notes: ${input.notes}`);

  if (input.url) {
    let parsedUrl: URL | null = null;
    try {
      parsedUrl = new URL(input.url);
      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
        parsedUrl = null;
      }
    } catch {
      parsedUrl = null;
    }
    if (parsedUrl) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);
      try {
        const res = await safeFetch(parsedUrl.toString(), controller.signal);
        const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
        if (
          res.ok &&
          (!contentType || ALLOWED_CONTENT_TYPES.some((t) => contentType.includes(t)))
        ) {
          const html = await readCappedText(res, MAX_FETCH_BYTES);
          const logos = extractLogos(html, parsedUrl);
          if (logos.iconMark) {
            base.logos.icon_mark = { url: logos.iconMark, type: "external" };
            base.logos.primary = { url: logos.iconMark, type: "external" };
          }
          if (logos.favicon) {
            base.logos.favicon = { url: logos.favicon, type: "external" };
          }

          // Pull the real palette from the page's HTML and (up to two)
          // stylesheets, so colors come from the actual site, not AI guesses.
          const cssTexts: string[] = [];
          for (const cssUrl of extractStylesheetUrls(html, parsedUrl)) {
            try {
              const cssRes = await safeFetch(cssUrl, controller.signal);
              if (cssRes.ok) {
                cssTexts.push(await readCappedText(cssRes, MAX_CSS_BYTES));
              }
            } catch {
              // stylesheet fetch is best-effort
            }
          }
          const themeColor = extractThemeColor(html);
          const candidates = extractColorCandidates(
            [html, ...cssTexts],
            themeColor ? [themeColor] : [],
          );
          const brandColors = candidates
            .filter((c) => classifyHex(c) === "brand")
            .slice(0, 6);
          const neutrals = candidates
            .filter((c) => classifyHex(c) === "neutral")
            .slice(0, 4);
          if (brandColors.length > 0 || neutrals.length > 0) {
            const toColor = (hex: string): BrandColor => ({
              name: hex,
              hex,
              usage: "Observed on website",
            });
            base.colors = {
              primary: brandColors.slice(0, 2).map(toColor),
              secondary: brandColors.slice(2, 5).map(toColor),
              neutral: neutrals.slice(0, 3).map(toColor),
              semantic: [],
            };
            contextParts.push(
              `Colors observed in the website's HTML/CSS (most used first). ` +
                `Brand colors: ${brandColors.join(", ") || "none"}. ` +
                `Neutrals: ${neutrals.join(", ") || "none"}. ` +
                `Build the palette from these ACTUAL hex values — assign each a short ` +
                `descriptive name and a usage note, and group them into ` +
                `primary/secondary/neutral. Do not invent hex codes that are not listed ` +
                `unless the user notes explicitly specify others.`,
            );
            sourceNotes.push(
              `Detected ${brandColors.length + neutrals.length} colors from the website.`,
            );
          }

          if (logos.iconMark || logos.favicon) {
            sourceNotes.push("Captured the site logo.");
          }

          const text = htmlToText(html).slice(0, 10000);
          if (text.length > 80) {
            contextParts.push(`Website content:\n${text}`);
            sourceNotes.push(`Drafted from ${parsedUrl.origin}${parsedUrl.pathname}`);
          }
        }
      } catch {
        sourceNotes.push("Website could not be read; drafted from provided details only.");
      } finally {
        clearTimeout(timeout);
      }
    }
  }

  if (contextParts.length === 0) {
    return {
      payload: base,
      sourceNotes: "No source provided; returned an empty brand template.",
    };
  }

  const system =
    "You are a senior brand strategist. From the provided context, infer a brand's " +
    "identity, color palette, typography, voice, and visual style. Only assert details " +
    "the context supports; leave unknown fields empty. Colors must be objects " +
    '{"name","hex","usage"} with valid #hex values. Respond ONLY with strict JSON of the form ' +
    '{"identity":{"brand_name","tagline","description","industry","audience":[]},' +
    '"colors":{"primary":[],"secondary":[],"neutral":[],"semantic":[]},' +
    '"typography":{"heading_font","body_font","fallback_fonts":[]},' +
    '"voice":{"traits":[],"dos":[],"donts":[],"caption_style","cta_style"},' +
    '"visual_style":{"imagery_style":[],"icon_style","illustration_style","motion_style"}}.';

  try {
    const completion = await openai.chat.completions.create({
      model: aiModel,
      messages: [
        { role: "system", content: system },
        { role: "user", content: contextParts.join("\n\n") },
      ],
      max_completion_tokens: 4096,
      response_format: { type: "json_object" },
    });
    const raw = completion.choices[0]?.message?.content ?? "{}";
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const payload = mergeDraft(base, obj);
    return {
      payload,
      sourceNotes:
        sourceNotes.join(" ") || "Drafted from the details you provided.",
    };
  } catch {
    return {
      payload: base,
      sourceNotes:
        (sourceNotes.join(" ") || "") +
        " AI draft was unavailable; returned a template you can fill in.",
    };
  }
}
