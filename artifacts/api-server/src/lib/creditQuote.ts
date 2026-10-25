import { creditsMilliFor, MILLI } from "./creditRates";
import { CHARACTER_SCENES_PER_PARAGRAPH } from "./videoGen/topicVideo/characterScenes";

/**
 * What a job is about to cost, computed from the SAME rate card the meter
 * charges from.
 *
 * That shared source is the whole point. A quote derived independently drifts
 * from the charge the first time either changes, and a prepaid product where
 * the quoted price and the debited price disagree is one support ticket per
 * generation.
 *
 * A quote is an ESTIMATE of a plan, not a promise. The meter charges what the
 * pipeline actually does, and a job that retries a keyframe genuinely costs
 * more than a job that does not. Quote the happy path, show it before the
 * button, and let the ledger tell the true story afterwards.
 */

export interface QuoteLine {
  rateKey: string;
  /** Units in the rate's own unit — seconds or items. */
  quantity: number;
  credits: number;
}

export interface CreditQuote {
  credits: number;
  lines: QuoteLine[];
}

function round(credits: number): number {
  return Math.round(credits * MILLI) / MILLI;
}

/** One unit of a single rate. Null when the key has no rate configured. */
export async function quoteActionCredits(
  rateKey: string,
  quantity = 1,
): Promise<number | null> {
  const milli = await creditsMilliFor(rateKey, quantity);
  return milli === null ? null : round(milli / MILLI);
}

export interface VideoJobQuoteInput {
  /** Finished length of the video. */
  durationSec: number;
  /**
   * Scenes the job will generate. Each one is a keyframe image plus a clip.
   * Defaults to the character-story rate, which is what most jobs use.
   */
  sceneCount?: number;
  /** "720p", "1080p", … — drives whether video bills at the HD rate. */
  resolution?: string | null;
  /** A narrated job voices its script, which is billed per second of audio. */
  narrated?: boolean;
  /** Lip sync is billed per second on top of the clip itself. */
  lipSync?: boolean;
}

/**
 * A whole video job, itemised.
 *
 * The scene keyframes are the line that matters. They were invisible in the
 * old accounting — generated inside the job, charged to nobody — and on a
 * four-scene video they can outweigh the clip seconds entirely.
 */
export async function quoteVideoJobCredits(
  input: VideoJobQuoteInput,
): Promise<CreditQuote> {
  const durationSec = Math.max(0, input.durationSec);
  const scenes = Math.max(
    1,
    Math.trunc(input.sceneCount ?? CHARACTER_SCENES_PER_PARAGRAPH),
  );
  const hd = isHd(input.resolution);
  const lines: QuoteLine[] = [];

  const videoKey = hd ? "video_hd" : "video";
  const videoMilli = (await creditsMilliFor(videoKey, durationSec)) ?? 0;
  lines.push({ rateKey: videoKey, quantity: durationSec, credits: round(videoMilli / MILLI) });

  // One generated keyframe per scene. The happy path assumes no retry; a job
  // that retries pays more, and the ledger will show it.
  const keyframeMilli = (await creditsMilliFor("image", scenes)) ?? 0;
  lines.push({ rateKey: "image", quantity: scenes, credits: round(keyframeMilli / MILLI) });

  // Scene planning and script are one text generation each.
  const captionMilli = (await creditsMilliFor("caption", 2)) ?? 0;
  if (captionMilli > 0) {
    lines.push({ rateKey: "caption", quantity: 2, credits: round(captionMilli / MILLI) });
  }

  let voiceMilli = 0;
  if (input.narrated) {
    voiceMilli = (await creditsMilliFor("voice", durationSec)) ?? 0;
    if (voiceMilli > 0) {
      lines.push({
        rateKey: "voice",
        quantity: durationSec,
        credits: round(voiceMilli / MILLI),
      });
    }
  }

  let lipSyncMilli = 0;
  if (input.lipSync) {
    lipSyncMilli = (await creditsMilliFor("lipsync", durationSec)) ?? 0;
    if (lipSyncMilli > 0) {
      lines.push({
        rateKey: "lipsync",
        quantity: durationSec,
        credits: round(lipSyncMilli / MILLI),
      });
    }
  }

  const totalMilli = videoMilli + keyframeMilli + captionMilli + voiceMilli + lipSyncMilli;
  return { credits: round(totalMilli / MILLI), lines };
}

/** The parts of a Guided Story draft that decide what its final render costs. */
export interface GuidedDraftQuoteSource {
  setup: { width: number; height: number; durationSeconds: number } | null;
  script: {
    runtimeSeconds: number;
    scenes: Array<{
      startMs: number;
      endMs: number;
      lines: Array<{ startMs: number; endMs: number }>;
    }>;
  } | null;
}

/**
 * The quote input for a Guided Story's final render, read from the approved
 * script rather than the generic request body.
 *
 * A guided enqueue sends no duration or paragraph count, so the generic
 * preflight used to price every guided story as a 5-second, 4-scene job. The
 * script carries the real runtime, the real scene count and every spoken line,
 * so the quote shown before the button and the preflight that guards it both
 * use those.
 */
export function guidedDraftQuoteInput(
  draft: GuidedDraftQuoteSource,
  options: { lipSync?: boolean } = {},
): VideoJobQuoteInput | null {
  const script = draft.script;
  if (!script || script.scenes.length === 0) return null;
  const sceneSpanSec = script.scenes.reduce(
    (total, scene) => total + Math.max(0, scene.endMs - scene.startMs) / 1000,
    0,
  );
  const durationSec = Math.max(
    1,
    Number.isFinite(script.runtimeSeconds) && script.runtimeSeconds > 0
      ? script.runtimeSeconds
      : sceneSpanSec || draft.setup?.durationSeconds || 1,
  );
  const spoken = script.scenes.some((scene) => scene.lines.length > 0);
  const shortSide = draft.setup
    ? Math.min(draft.setup.width, draft.setup.height)
    : null;
  return {
    durationSec,
    sceneCount: script.scenes.length,
    resolution: shortSide ? `${shortSide}p` : null,
    narrated: spoken,
    lipSync: options.lipSync === true,
  };
}

/** 720p and above bills as HD. Unknown resolutions bill at the base rate. */
function isHd(resolution?: string | null): boolean {
  if (!resolution) return false;
  const match = /(\d{3,4})\s*[pP]?/.exec(resolution);
  const value = match ? Number(match[1]) : NaN;
  return Number.isFinite(value) && value >= 720;
}
