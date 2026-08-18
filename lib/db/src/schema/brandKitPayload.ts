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

/**
 * The kit's audio identity for video narration.
 *
 * - "preset": one of the built-in stock narration voices, optionally with a
 *   delivery-style note.
 * - "cloned": a voice cloned from a tenant-uploaded sample at the configured
 *   cloud voice-cloning provider; narration is synthesized in that voice and
 *   falls back to the stock voices when the provider is down or the feature
 *   is disabled.
 *
 * Optional on the payload: kits created before Brand Voice existed simply
 * have no section, which reads as "no brand voice".
 */
export interface BrandVoiceSettings {
  mode: "preset" | "cloned";
  /** Stock narration voice used in "preset" mode (and as the fallback voice
   * in "cloned" mode). One of the built-in narration voice ids. */
  preset_voice: string;
  /** Free-text delivery note ("warm, upbeat, slow") shown to the script
   * writer; presentation guidance only. */
  delivery_style: string;
  /** "cloned" mode: the provider that owns the cloned voice (e.g. "elevenlabs"). */
  provider: string | null;
  /** "cloned" mode: the provider's id for the cloned voice. */
  provider_voice_id: string | null;
  /** "cloned" mode: tenant-storage path of the uploaded reference sample. */
  sample_asset_path: string | null;
  /** Human label for the cloned voice ("Founder's voice"). */
  cloned_label: string | null;
  /** ISO timestamp of when the clone was created. */
  cloned_at: string | null;
  /**
   * Saved cloned voices — the kit's voice library. The flat fields above
   * remain the ACTIVE voice (everything that synthesizes narration reads
   * them), so kits saved before the library existed keep working unchanged;
   * routes synthesize a one-entry library from those fields when this is
   * absent.
   */
  voices?: BrandVoiceEntry[] | null;
}

/** One saved cloned voice in the kit's voice library. */
export interface BrandVoiceEntry {
  /** Stable server-generated id for the entry. */
  id: string;
  /** User-chosen name ("Founder's voice"). */
  label: string;
  /** Provider that owns the clone (e.g. "elevenlabs"). */
  provider: string;
  /** The provider's id for the cloned voice. */
  provider_voice_id: string;
  /** Tenant-storage path of the uploaded reference sample. */
  sample_asset_path: string | null;
  /** ISO timestamp of when the clone was created. */
  cloned_at: string;
}

/**
 * A reusable pre-recorded base video for lip-sync, stored on the kit with a
 * default narration voice. The studio pre-selects the mapped voice but the
 * user may override it per generation.
 */
export interface BrandBaseVideo {
  /** Stable client-generated id for the entry. */
  id: string;
  label: string;
  /** Tenant-storage /objects/... path of the uploaded video. */
  video_path: string;
  /** Default voice when this video is used: the kit's cloned voice or a stock voice. */
  voice_mode: "cloned" | "preset";
  /** Stock narration voice used when voice_mode is "preset". */
  preset_voice: string | null;
}

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
  /** Audio identity for video narration; absent/null = no brand voice. */
  brand_voice?: BrandVoiceSettings | null;
  /** Reusable pre-recorded base videos for lip-sync; absent/null = none saved. */
  base_videos?: BrandBaseVideo[] | null;
  brand_controls: {
    approved: boolean;
    approval_status: BrandApprovalStatus;
    allowed_use_cases: string[];
    restricted_terms: string[];
  };
}
