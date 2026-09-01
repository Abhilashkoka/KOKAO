import { writeFile, readFile, mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { runFfmpeg, probeDurationSec } from "./slideshow";
import type { VideoAspect } from "./types";

/**
 * The video's cover image — what the library grid, the share preview and every
 * platform that embeds the video shows before anyone presses play.
 *
 * Until now this was one frame grabbed at 1.0s and never revisited. That is a
 * reasonable default and a poor cover: 1.0s is wherever the first shot happens
 * to be, and the choice was never the user's to make.
 *
 * Two sources, because they fail in opposite directions:
 *
 *  - EXTRACTED frames are free and always available, but they are motion-blurred,
 *    compression-damaged, and locked to the video's own aspect. Cropping a 9:16
 *    frame to 16:9 leaves 1080x608 — either the subject's head is cut off or the
 *    subject is too small to read at thumbnail size.
 *  - A GENERATED cover is composed for the shape it will be shown in, at full
 *    sharpness, and can be deliberately over-expressive in the way a cover wants
 *    and a video does not. It costs an image generation, so it is on request.
 */

/** Cover candidates extracted from the finished video. */
export const COVER_CANDIDATE_COUNT = 9;

/**
 * A cover frame is never taken from the first half-second. Shots open on the
 * keyframe — a composed still, before any motion — and openings also carry
 * fades. The interesting frame is always later.
 */
const COVER_LEAD_IN_SEC = 0.5;

/** Cover frames are capped at 1080px wide, as poster frames already were. */
const COVER_MAX_WIDTH = 1080;

/**
 * Frame timestamps for a video of this length: an even spread across the body
 * of the video, skipping the lead-in. Even rather than golden-ratio (which the
 * compositor uses to pick b-roll seek points) because these are shown to a
 * person in a grid, and a visibly regular spread is easier to reason about than
 * a scattered one: the third tile is a third of the way in.
 */
export function coverFrameTimestamps(durationSec: number, count = COVER_CANDIDATE_COUNT): number[] {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return [0];
  const start = durationSec > COVER_LEAD_IN_SEC * 2 ? COVER_LEAD_IN_SEC : 0;
  // Land inside each slice rather than on its edge, so the last candidate is
  // never the final frame (often a fade-out, or a black tail).
  const span = durationSec - start;
  const usable = Math.max(1, Math.min(count, Math.floor(durationSec * 2)));
  return Array.from({ length: usable }, (_, i) =>
    Number((start + (span * (i + 0.5)) / usable).toFixed(2)),
  );
}

/** Extract the cover candidates from a finished video, in timestamp order. */
export async function extractCoverCandidates(
  video: Buffer,
  count = COVER_CANDIDATE_COUNT,
): Promise<Array<{ atSec: number; buffer: Buffer }>> {
  const dir = await mkdtemp(join(tmpdir(), "kokao-cover-"));
  try {
    await writeFile(join(dir, "in.mp4"), video);
    const duration = (await probeDurationSec("in.mp4", dir)) ?? 0;
    const stamps = coverFrameTimestamps(duration, count);
    const frames: Array<{ atSec: number; buffer: Buffer }> = [];
    for (const [i, atSec] of stamps.entries()) {
      const name = `cover_${i}.png`;
      try {
        await runFfmpeg(
          [
            "-y",
            "-ss", atSec.toFixed(2),
            "-i", "in.mp4",
            "-frames:v", "1",
            "-vf", `scale='min(${COVER_MAX_WIDTH},iw)':-2`,
            name,
          ],
          dir,
        );
        frames.push({ atSec, buffer: await readFile(join(dir, name)) });
      } catch {
        // One unreadable seek must not cost the user the whole grid; a short
        // or damaged tail is exactly where this happens.
        continue;
      }
    }
    return frames;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Cover composition per aspect. A cover is not a frame of the video: it is a
 * still that has to survive being shown at the size of a thumbnail, next to
 * other thumbnails, usually with a title over it.
 *
 * So each shape gets its own composition rather than a crop of one image. The
 * wide shape in particular cannot be cropped out of a vertical video at all —
 * that is the whole reason a generated cover exists.
 */
const COVER_COMPOSITION: Record<"vertical" | "wide" | "square", string> = {
  vertical:
    "Vertical cover composition: the subject's head and shoulders fill the " +
    "upper two thirds of the frame, with the lower third left as clean, " +
    "uncluttered background for a title to sit over.",
  wide:
    "Wide cover composition: the subject's head and shoulders placed to one " +
    "side of the frame, filling roughly the left or right third, with the " +
    "remaining width left as clean, uncluttered background for a title.",
  square:
    "Square cover composition: the subject's face centred and large, filling " +
    "most of the frame, with a little clean background above the head.",
};

/**
 * Derived from the ratio rather than enumerated, so an aspect added to the
 * catalog later gets a sensible composition instead of a crash or a silent
 * fallback to the wrong shape.
 */
export function coverShape(aspect: VideoAspect): "vertical" | "wide" | "square" {
  const [w, h] = aspect.split(":").map(Number);
  if (!w || !h || w === h) return "square";
  return h > w ? "vertical" : "wide";
}

/**
 * The expression a cover wants — and the one a video does not.
 *
 * This is deliberately the opposite instruction to the one the animation stage
 * now carries. A talking-head shot has to hold a calm face for its whole
 * duration or it reads as unhinged; a cover is a single frame competing for a
 * glance in a grid, and the exaggerated face is what earns the click. Same
 * character, same wardrobe, opposite register.
 */
const COVER_EXPRESSION: Record<CoverIntensity, string> = {
  natural:
    "Warm, engaged expression: a genuine open smile, eyes alert and friendly, " +
    "eyebrows relaxed. Approachable rather than dramatic.",
  bold:
    "Animated, emphatic expression: eyes wide and bright with interest, " +
    "eyebrows raised, mouth open mid-sentence as if revealing something. " +
    "Energetic and attention-catching.",
  extreme:
    "Highly exaggerated reaction expression: eyes very wide in astonishment, " +
    "eyebrows raised high, mouth open in an unmistakable look of shock and " +
    "surprise. Deliberately over-the-top, in the style of a viral video " +
    "thumbnail.",
};

export type CoverIntensity = "natural" | "bold" | "extreme";

/** The three takes a generate request produces, mild to wild. */
export const COVER_INTENSITIES: readonly CoverIntensity[] = ["natural", "bold", "extreme"];

/**
 * The cover-set body carries a storage path, so the boundary has to PROVE it
 * rejected everything else rather than relying on the generated parser, which
 * strips unknown keys and returns a successful parse. Exactly one key, and it
 * is the one we expect.
 */
export function hasOnlyCoverPathKey(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const keys = Object.keys(body as Record<string, unknown>);
  return keys.length === 1 && keys[0] === "coverPath";
}

/**
 * The outfit a generated cover should wear: the one the job locked, else the
 * character's default, else whatever it has.
 *
 * Deliberately NOT `resolveOutfit` from lib/characters, which filters by
 * current selectability. This snapshot is frozen at enqueue and is the record
 * of what the video actually rendered in — an outfit rejected since the render
 * is still the outfit on screen, and a cover has to match the video, not the
 * wardrobe's present state.
 */
export function resolveCoverOutfit<T extends { id: number; isDefault: boolean }>(
  outfits: readonly T[] | undefined,
  outfitId: number | null | undefined,
): T | undefined {
  if (!outfits || outfits.length === 0) return undefined;
  return (
    (outfitId != null ? outfits.find((o) => o.id === outfitId) : undefined) ??
    outfits.find((o) => o.isDefault) ??
    outfits[0]
  );
}

/**
 * Prompt for a generated cover. Built on the same reference-anchored contract
 * as a scene keyframe — the reference is authoritative for identity and
 * clothing, and nothing else — so a cover is provably the same person, in the
 * same outfit, as the video it fronts.
 */
export function coverImagePrompt(args: {
  /** Description of the character, for the identity clause. */
  characterDescription?: string | null;
  /** The locked outfit, so the cover matches the video's wardrobe. */
  outfitName: string;
  outfitDescription: string;
  /** Where the video is set, so the cover is not a studio portrait. */
  sceneVisual: string;
  aspect: VideoAspect;
  intensity: CoverIntensity;
}): string {
  const identity = args.characterDescription ? ` (${args.characterDescription})` : "";
  return (
    "The reference image is authoritative for identity and clothing only. " +
    `Create a video cover image of the exact character from the reference${identity}. ` +
    `Required outfit: ${args.outfitName} — ${args.outfitDescription}. ` +
    "Copy every visible garment, color, pattern, layer, accessory and footwear " +
    "from the reference exactly. Do not redesign, substitute, infer or add clothing. " +
    `Setting: ${args.sceneVisual}. ` +
    "Do not copy the reference's background, pose, camera angle or framing — the " +
    "reference is a plain studio portrait and this is a new photograph on location. " +
    `${COVER_EXPRESSION[args.intensity]} ` +
    `${COVER_COMPOSITION[coverShape(args.aspect)]} ` +
    "Keep the identical face, hair, body and identity. " +
    "Photorealistic, sharp focus, bright punchy lighting that reads clearly at " +
    "small size. No text, no watermark, no logos, no captions."
  );
}

/**
 * Prompt for videos without a locked character reference. These covers are
 * intentionally derived from the video's own topic/first scene and requested
 * aspect rather than inventing a person that is not present in the source.
 */
export function genericCoverImagePrompt(args: {
  topic: string;
  sceneVisual: string;
  aspect: VideoAspect;
  intensity: CoverIntensity;
}): string {
  const treatment =
    args.intensity === "natural"
      ? "Clear, polished and inviting, with natural contrast."
      : args.intensity === "bold"
        ? "Bold, energetic and attention-catching, with strong contrast."
        : "Highly dramatic and scroll-stopping, with vivid contrast and a striking focal point.";
  return (
    `Create a purpose-made video cover for this topic: ${args.topic}. ` +
    `Base the setting and subject matter on this scene: ${args.sceneVisual}. ` +
    `${treatment} ${COVER_COMPOSITION[coverShape(args.aspect)]} ` +
    "Use one immediately readable focal subject and preserve the video's subject matter. " +
    "Do not invent a presenter, spokesperson, celebrity, brand mark or product that was not described. " +
    "Sharp focus and clean composition that reads clearly at small size. " +
    "No text, no watermark, no logos, no captions."
  );
}
