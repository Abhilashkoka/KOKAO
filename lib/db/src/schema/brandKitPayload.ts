/**
 * Machine-readable brand kit payload. This is the SOURCE OF TRUTH for a brand:
 * it is stored (immutably, per version) in `brand_kit_versions.json_payload` and
 * is what every content-generation / downstream service should read.
 *
 * The shape mirrors the agreed system spec's `required_json_schema` (identity,
 * logos, colors, typography, voice, visual_style, layout_tokens, channel_rules,
 * brand_controls). Keep this in lockstep with the `BrandKitPayload` OpenAPI
 * schema so generated client types and server zod validation agree.
 */

export interface BrandColor {
  name: string;
  hex: string;
  usage: string;
}

export interface BrandLogoRef {
  url: string;
  type: string;
}

export interface BrandChannelRule {
  formats: string[];
  notes: string[];
}

export type BrandApprovalStatus = "draft" | "approved" | "archived";

export interface BrandKitPayload {
  identity: {
    brand_name: string;
    brand_slug: string;
    tagline: string;
    description: string;
    industry: string;
    audience: string[];
  };
  logos: {
    primary: BrandLogoRef | null;
    secondary: BrandLogoRef | null;
    icon_mark: BrandLogoRef | null;
    favicon: BrandLogoRef | null;
    usage_rules: string[];
  };
  colors: {
    primary: BrandColor[];
    secondary: BrandColor[];
    neutral: BrandColor[];
    semantic: BrandColor[];
  };
  typography: {
    heading_font: string;
    body_font: string;
    fallback_fonts: string[];
    scale: {
      h1: string;
      h2: string;
      h3: string;
      h4: string;
      body: string;
      small: string;
      caption: string;
    };
    weights: {
      regular: number;
      medium: number;
      semibold: number;
      bold: number;
    };
  };
  voice: {
    traits: string[];
    dos: string[];
    donts: string[];
    caption_style: string;
    cta_style: string;
  };
  visual_style: {
    imagery_style: string[];
    icon_style: string;
    illustration_style: string;
    motion_style: string;
  };
  layout_tokens: {
    base_unit: string;
    radius: { sm: string; md: string; lg: string };
    shadow: { sm: string; md: string; lg: string };
  };
  /** Keyed by channel: instagram | facebook | youtube | x | linkedin */
  channel_rules: Record<string, BrandChannelRule>;
  brand_controls: {
    approved: boolean;
    approval_status: BrandApprovalStatus;
    allowed_use_cases: string[];
    restricted_terms: string[];
  };
}
