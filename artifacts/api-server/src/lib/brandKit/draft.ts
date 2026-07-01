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
    colors: {
      primary: asColorArray(colors.primary),
      secondary: asColorArray(colors.secondary),
      neutral: asColorArray(colors.neutral),
      semantic: asColorArray(colors.semantic),
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
