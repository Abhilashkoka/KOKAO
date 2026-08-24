import type { VideoAspect } from "./types";

/**
 * The video models a tenant may pick per generation, and what each one can
 * actually do.
 *
 * Before this catalog, a superadmin chose ONE text-to-video model and ONE
 * image-to-video model for the whole platform, and the studio offered a
 * 3–30 second duration slider that the provider layer then silently clamped:
 * Kling snapped to 5 or 10, MiniMax ignored duration entirely, Veo received a
 * minimal payload. A 7-second request came back at 5 and the length pass
 * padded it by freezing the last frame. The user was never told.
 *
 * So capability lives here, in one place, and three things read it:
 *  - the studio, which renders only the controls a model supports;
 *  - preflight, which refuses an impossible request BEFORE funding;
 *  - the provider adapters, which stop sniffing model-name substrings.
 *
 * Deliberately curated. Every model is a price row, a QA surface, and a
 * support burden; a dozen that are known to work beats two hundred that
 * mostly rhyme. Adding one is a single entry plus a price row in the admin
 * cost catalog.
 */

/** Output resolutions a job can request. */
export type VideoResolution = "480p" | "720p" | "1080p";

export const VIDEO_RESOLUTIONS: readonly VideoResolution[] = ["480p", "720p", "1080p"];

/** Short edge in pixels per resolution; the long edge follows the aspect. */
export const RESOLUTION_SHORT_EDGE: Record<VideoResolution, number> = {
  "480p": 480,
  "720p": 720,
  "1080p": 1080,
};

/**
 * What a model costs relative to the platform default, in video units.
 *
 * Deliberately coarse. Real provider prices move weekly and span two orders
 * of magnitude; three buckets a user can reason about ("this one costs four")
 * beat a number that tracks a price sheet nobody reads. Wallet workspaces are
 * unaffected by the bucket — they reserve an estimate and settle at the real
 * provider cost from the admin price catalog, exactly as they always have.
 */
export type VideoModelTier = "draft" | "standard" | "premium";

export const TIER_UNIT_MULTIPLIER: Record<VideoModelTier, number> = {
  draft: 1,
  standard: 2,
  premium: 4,
};

export const TIER_LABELS: Record<VideoModelTier, string> = {
  draft: "Draft",
  standard: "Standard",
  premium: "Premium",
};

/** Which engine a model can serve. */
export type VideoModelMode = "text" | "image";

export interface VideoModelDef {
  /** Stable id sent as modelId and persisted on jobs. Never renamed. */
  id: string;
  label: string;
  /** One-line "when would I pick this?" for the studio. */
  blurb: string;
  /** Which provider catalog entry serves it (lib/videoGen/index.ts). */
  provider: "replicate" | "openrouter";
  /** Provider-native model slug per mode. A mode absent here is unsupported. */
  models: Partial<Record<VideoModelMode, string>>;
  tier: VideoModelTier;
  /** Aspect ratios the model renders natively; others are cover-cropped. */
  aspects: readonly VideoAspect[];
  /** Clip lengths in seconds the model accepts. A request snaps to the
   * nearest, and the studio only offers these. */
  durations: readonly number[];
  resolutions: readonly VideoResolution[];
  /** Whether the model exposes a basic/high quality switch. */
  hasQuality: boolean;
  /** Whether the model can generate its own audio (dialogue, SFX). */
  canGenerateAudio: boolean;
  /**
   * Whether the model interpolates between a START and an END frame. Only
   * meaningful in image mode. A model without it never receives an end frame,
   * and the route refuses the request up front rather than quietly dropping
   * the second photo the user chose.
   */
  supportsEndFrame?: boolean;
}

/** Ratios most hosted models render natively. */
const COMMON_ASPECTS = ["16:9", "9:16", "1:1"] as const;

export const VIDEO_MODEL_CATALOG: readonly VideoModelDef[] = [
  // ── Replicate ───────────────────────────────────────────────────────────
  {
    id: "wan-2.2-fast",
    label: "WAN 2.2 Fast",
    blurb: "Cheap and quick. The platform default — good enough for most social clips.",
    provider: "replicate",
    models: { text: "wan-video/wan-2.2-t2v-fast", image: "wan-video/wan-2.2-i2v-fast" },
    tier: "draft",
    aspects: COMMON_ASPECTS,
    durations: [5],
    resolutions: ["480p", "720p"],
    hasQuality: false,
    canGenerateAudio: false,
  },
  {
    id: "wan-2.5",
    label: "WAN 2.5",
    blurb: "Sharper and steadier than 2.2 Fast, and slower to render.",
    provider: "replicate",
    models: { text: "wan-video/wan-2.5-t2v", image: "wan-video/wan-2.5-i2v" },
    tier: "standard",
    aspects: COMMON_ASPECTS,
    durations: [5, 10],
    resolutions: ["480p", "720p", "1080p"],
    hasQuality: false,
    canGenerateAudio: false,
    supportsEndFrame: true,
  },
  {
    id: "kling-2.1-standard",
    label: "Kling 2.1 Standard",
    blurb: "Balanced motion and coherence. A safe pick for people and products.",
    provider: "replicate",
    models: { text: "kwaivgi/kling-v2.1-standard", image: "kwaivgi/kling-v2.1-standard" },
    tier: "standard",
    aspects: COMMON_ASPECTS,
    durations: [5, 10],
    resolutions: ["720p"],
    hasQuality: false,
    canGenerateAudio: false,
    supportsEndFrame: true,
  },
  {
    id: "kling-2.1-master",
    label: "Kling 2.1 Master",
    blurb: "The best Kling quality — worth it for a hero shot, not for drafts.",
    provider: "replicate",
    models: { text: "kwaivgi/kling-v2.1-master", image: "kwaivgi/kling-v2.1-master" },
    tier: "premium",
    aspects: COMMON_ASPECTS,
    durations: [5, 10],
    resolutions: ["1080p"],
    hasQuality: false,
    canGenerateAudio: false,
    supportsEndFrame: true,
  },
  {
    id: "seedance-1-pro",
    label: "Seedance 1 Pro",
    blurb: "Cinematic camera language and lighting; strong on establishing shots.",
    provider: "replicate",
    models: { text: "bytedance/seedance-1-pro", image: "bytedance/seedance-1-pro" },
    tier: "standard",
    aspects: COMMON_ASPECTS,
    durations: [5, 10],
    resolutions: ["480p", "720p", "1080p"],
    hasQuality: false,
    canGenerateAudio: false,
  },
  {
    id: "hailuo-02",
    label: "MiniMax Hailuo 02",
    blurb: "Believable physical motion — bodies, cloth, liquids.",
    provider: "replicate",
    models: { text: "minimax/hailuo-02", image: "minimax/hailuo-02" },
    tier: "standard",
    aspects: COMMON_ASPECTS,
    durations: [6, 10],
    resolutions: ["720p", "1080p"],
    hasQuality: false,
    canGenerateAudio: false,
  },
  {
    id: "veo-3-fast",
    label: "Google Veo 3 Fast",
    blurb: "High quality WITH generated audio — dialogue and sound effects.",
    provider: "replicate",
    models: { text: "google/veo-3-fast", image: "google/veo-3-fast" },
    tier: "premium",
    aspects: ["16:9", "9:16"],
    durations: [8],
    resolutions: ["720p", "1080p"],
    hasQuality: false,
    canGenerateAudio: true,
  },
  {
    id: "veo-3",
    label: "Google Veo 3",
    blurb: "Top-tier quality with audio, at a premium price. For final cuts.",
    provider: "replicate",
    models: { text: "google/veo-3", image: "google/veo-3" },
    tier: "premium",
    aspects: ["16:9", "9:16"],
    durations: [8],
    resolutions: ["720p", "1080p"],
    hasQuality: false,
    canGenerateAudio: true,
  },

  // ── OpenRouter ──────────────────────────────────────────────────────────
  {
    id: "kling-3.0-std",
    label: "Kling 3.0 Standard",
    blurb: "Every aspect ratio, wide duration range. The OpenRouter default.",
    provider: "openrouter",
    models: {
      text: "kwaivgi/kling-v3.0-std",
      image: "kwaivgi/kling-v3.0-std",
    },
    tier: "draft",
    aspects: COMMON_ASPECTS,
    durations: [5, 10],
    resolutions: ["720p"],
    hasQuality: false,
    canGenerateAudio: false,
  },
  {
    id: "kling-3.0-pro",
    label: "Kling 3.0 Pro",
    blurb: "The best Kling generation available, with native audio.",
    provider: "openrouter",
    models: {
      text: "kwaivgi/kling-v3.0-pro",
      image: "kwaivgi/kling-v3.0-pro",
    },
    tier: "premium",
    aspects: COMMON_ASPECTS,
    durations: [5, 10],
    resolutions: ["720p", "1080p"],
    hasQuality: false,
    canGenerateAudio: true,
  },
  {
    id: "seedance-2.0-fast",
    label: "Seedance 2.0 Fast",
    blurb: "Cheap and quick with a cinematic look. Good for iterating on a shot.",
    provider: "openrouter",
    models: {
      text: "bytedance/seedance-2.0-fast",
      image: "bytedance/seedance-2.0-fast",
    },
    tier: "draft",
    aspects: ["16:9", "9:16", "4:3", "3:4"],
    durations: [5, 10],
    resolutions: ["480p", "720p"],
    hasQuality: true,
    canGenerateAudio: false,
  },
  {
    id: "seedance-2.0",
    label: "Seedance 2.0",
    blurb: "The full Seedance model: richer detail, stronger camera work.",
    provider: "openrouter",
    models: { text: "bytedance/seedance-2.0", image: "bytedance/seedance-2.0" },
    tier: "standard",
    aspects: ["16:9", "9:16", "4:3", "3:4"],
    durations: [5, 10, 15],
    resolutions: ["720p", "1080p"],
    hasQuality: true,
    canGenerateAudio: false,
  },
  {
    id: "wan-2.7",
    label: "WAN 2.7",
    blurb: "The newest WAN — a balanced all-rounder.",
    provider: "openrouter",
    models: { text: "alibaba/wan-2.7", image: "alibaba/wan-2.7" },
    tier: "standard",
    aspects: COMMON_ASPECTS,
    durations: [5, 10],
    resolutions: ["480p", "720p", "1080p"],
    hasQuality: false,
    canGenerateAudio: false,
  },
  {
    id: "hailuo-3",
    label: "MiniMax Hailuo 3",
    blurb: "Excellent motion realism; the model to reach for when things move fast.",
    provider: "openrouter",
    models: { text: "minimax/hailuo-3", image: "minimax/hailuo-3" },
    tier: "standard",
    aspects: COMMON_ASPECTS,
    durations: [5, 10],
    resolutions: ["720p", "1080p"],
    hasQuality: false,
    canGenerateAudio: false,
  },
  {
    id: "veo-3.1-fast",
    label: "Google Veo 3.1 Fast",
    blurb: "Newest Veo, with audio, at the faster tier.",
    provider: "openrouter",
    models: { text: "google/veo-3.1-fast", image: "google/veo-3.1-fast" },
    tier: "premium",
    aspects: ["16:9", "9:16"],
    durations: [4, 6, 8],
    resolutions: ["720p", "1080p"],
    hasQuality: false,
    canGenerateAudio: true,
  },
  {
    id: "veo-3.1",
    label: "Google Veo 3.1",
    blurb: "The best generation quality on the platform, with audio.",
    provider: "openrouter",
    models: { text: "google/veo-3.1", image: "google/veo-3.1" },
    tier: "premium",
    aspects: ["16:9", "9:16"],
    durations: [4, 6, 8],
    resolutions: ["720p", "1080p"],
    hasQuality: false,
    canGenerateAudio: true,
  },
  {
    id: "sora-2-pro",
    label: "OpenAI Sora 2 Pro",
    blurb: "Long, coherent shots with audio. The most expensive option here.",
    provider: "openrouter",
    models: { text: "openai/sora-2-pro", image: "openai/sora-2-pro" },
    tier: "premium",
    aspects: ["16:9", "9:16"],
    durations: [4, 8, 12, 16, 20],
    resolutions: ["720p", "1080p"],
    hasQuality: false,
    canGenerateAudio: true,
  },
] as const;

const BY_ID = new Map(VIDEO_MODEL_CATALOG.map((def) => [def.id, def]));

/** Look up a catalog model by id, or null. */
export function findVideoModel(id: string | null | undefined): VideoModelDef | null {
  if (!id) return null;
  return BY_ID.get(id) ?? null;
}

/** Whether the id names a catalog model (route validation). */
export function isVideoModelId(id: string): boolean {
  return BY_ID.has(id);
}

/** Whether a catalog model interpolates between a start and an end frame. */
export function supportsEndFrame(def: VideoModelDef | null | undefined): boolean {
  return def?.supportsEndFrame === true;
}

/** Whether a catalog model can serve this engine's mode. */
export function supportsMode(def: VideoModelDef, mode: VideoModelMode): boolean {
  return Boolean(def.models[mode]);
}

/**
 * How many video units a job costs BECAUSE OF ITS MODEL.
 *
 * Absent modelId means the job runs on the platform default exactly as it did
 * before per-generation model choice existed, and costs exactly what it did
 * then — 1. Nothing about existing pricing moves; picking a better model is
 * an opt-in that costs more.
 */
export function videoModelMultiplier(modelId: string | null | undefined): number {
  const def = findVideoModel(modelId);
  if (!def) return 1;
  return TIER_UNIT_MULTIPLIER[def.tier];
}

/**
 * Snap a requested clip length to what the model actually renders.
 *
 * This is the honesty fix: the provider adapters already clamped silently, so
 * a 7-second Kling request came back at 5 or 10 with no explanation. Doing it
 * here means the studio can offer only real lengths and preflight can tell
 * the user before their money is spent.
 */
export function snapDuration(def: VideoModelDef, durationSec: number): number {
  return def.durations.reduce((best, candidate) =>
    Math.abs(candidate - durationSec) < Math.abs(best - durationSec) ? candidate : best,
  );
}

/** The resolution to render at: the request when supported, else the model's best. */
export function resolveResolution(
  def: VideoModelDef,
  requested: VideoResolution | null | undefined,
): VideoResolution {
  if (requested && def.resolutions.includes(requested)) return requested;
  // Highest supported, so an unspecified request keeps today's behaviour of
  // delivering the best the model can do.
  return def.resolutions.reduce((best, candidate) =>
    RESOLUTION_SHORT_EDGE[candidate] > RESOLUTION_SHORT_EDGE[best] ? candidate : best,
  );
}

/** The model-shaped half of a job's options, resolved once per job. */
export interface ResolvedModelOptions {
  modelId: string | null;
  /** Snapped to a length the model renders; unchanged without a picked model. */
  durationSec: number;
  resolution: VideoResolution | null;
  quality: string | null;
  generateAudio: boolean | null;
}

/**
 * Turn a job's persisted options into the arguments the generation calls take.
 *
 * With no picked model this is a pass-through: duration is whatever was
 * requested, resolution is null (meaning "the 1080-class frame, as always"),
 * and no quality or audio flag is sent. Every existing job therefore behaves
 * exactly as it did. With a picked model, capability decides — the duration
 * snaps to a length the model actually renders instead of being silently
 * clamped inside the provider adapter three minutes later.
 */
export function resolveModelOptions(
  options: {
    modelId?: string | null;
    durationSec?: number;
    resolution?: string | null;
    quality?: string | null;
    generateAudio?: boolean | null;
  } | null,
  fallbackDurationSec = 5,
): ResolvedModelOptions {
  const requestedDuration = options?.durationSec ?? fallbackDurationSec;
  const def = findVideoModel(options?.modelId);
  if (!def) {
    return {
      modelId: null,
      durationSec: requestedDuration,
      resolution: null,
      quality: null,
      generateAudio: null,
    };
  }
  return {
    modelId: def.id,
    durationSec: snapDuration(def, requestedDuration),
    resolution: resolveResolution(def, options?.resolution as VideoResolution | null),
    quality: def.hasQuality ? (options?.quality ?? null) : null,
    generateAudio: def.canGenerateAudio ? (options?.generateAudio ?? null) : null,
  };
}
