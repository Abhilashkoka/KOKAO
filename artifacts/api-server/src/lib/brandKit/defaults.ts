import type { BrandKitPayload } from "@workspace/db";

export const BRAND_CHANNELS = [
  "instagram",
  "facebook",
  "youtube",
  "x",
  "linkedin",
] as const;

export const BRAND_USE_CASES = [
  "social_post",
  "reel",
  "short",
  "ad_creative",
  "landing_page",
  "email",
] as const;

/**
 * Turn a brand name into a URL/slug-safe identifier. Falls back to "brand"
 * when the input has no usable characters.
 */
export function slugify(input: string): string {
  const s = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return s || "brand";
}

function defaultChannelRules(): BrandKitPayload["channel_rules"] {
  const rules: BrandKitPayload["channel_rules"] = {};
  for (const channel of BRAND_CHANNELS) {
    rules[channel] = { formats: [], notes: [] };
  }
  return rules;
}

/**
 * Build a complete, schema-valid BrandKitPayload with sensible empty defaults.
 * Any provided partial (from onboarding / AI draft) is shallow-merged per
 * section so callers can supply only the fields they know.
 */
export function buildDefaultPayload(input?: {
  brandName?: string;
  brandSlug?: string;
  industry?: string;
}): BrandKitPayload {
  const brandName = input?.brandName?.trim() || "Untitled Brand";
  const brandSlug = input?.brandSlug?.trim() || slugify(brandName);
  return {
    identity: {
      brand_name: brandName,
      brand_slug: brandSlug,
      tagline: "",
      description: "",
      industry: input?.industry?.trim() || "",
      audience: [],
    },
    logos: {
      primary: null,
      secondary: null,
      icon_mark: null,
      favicon: null,
      usage_rules: [],
    },
    colors: {
      primary: [],
      secondary: [],
      neutral: [],
      semantic: [],
    },
    typography: {
      heading_font: "",
      body_font: "",
      fallback_fonts: [],
      scale: {
        h1: "",
        h2: "",
        h3: "",
        h4: "",
        body: "",
        small: "",
        caption: "",
      },
      weights: { regular: 400, medium: 500, semibold: 600, bold: 700 },
    },
    voice: {
      traits: [],
      dos: [],
      donts: [],
      caption_style: "",
      cta_style: "",
    },
    visual_style: {
      imagery_style: [],
      icon_style: "",
      illustration_style: "",
      motion_style: "",
    },
    layout_tokens: {
      base_unit: "8px",
      radius: { sm: "4px", md: "8px", lg: "16px" },
      shadow: { sm: "", md: "", lg: "" },
    },
    channel_rules: defaultChannelRules(),
    brand_controls: {
      approved: false,
      approval_status: "draft",
      allowed_use_cases: [...BRAND_USE_CASES],
      restricted_terms: [],
    },
  };
}
