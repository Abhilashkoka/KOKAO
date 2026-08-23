/**
 * Composite timed B-roll over a continuous presenter plate.
 *
 * This is the "expert explains something while related footage plays above
 * him" format: one locked-off take of a person talking for the whole runtime,
 * with illustrative footage and graphics blended into the upper part of the
 * frame and crossfading between beats. It is not a cut-driven video — scene
 * detection on a reference of this format finds essentially nothing, because
 * the picture never cuts. Everything that changes is this overlay layer.
 *
 * Three things here are load-bearing:
 *
 * 1. The overlay is one continuous track, not N independent overlays. Building
 *    it as a single `xfade` chain and compositing once means true dissolves
 *    between beats and a single pass over the frame. Overlaying each beat
 *    separately would wash the transition (both layers semi-transparent over
 *    the base at the midpoint) and cost a pass per beat.
 *
 * 2. Gaps are transparent filler segments, not absences. The format
 *    deliberately drops the overlay near the end so the presenter lands the
 *    closing line unassisted, and `xfade` has no concept of a hole — so a hole
 *    is expressed as a fully transparent clip that the chain dissolves to.
 *
 * 3. The bottom edge of the overlay box is feathered through the alpha
 *    channel, per beat, at the beat's own opacity. A hard-edged box reads as a
 *    picture-in-picture window; the feather is what makes it read as one
 *    image. Alpha comes from a generated greyscale ramp merged in with
 *    `alphamerge`, which is exact and cheap — unlike `geq`, which would run a
 *    per-pixel expression on every frame.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";

import { encodeBudgetMs, runFfmpeg } from "./slideshow";

/** One illustrative beat: what to show, when, and how strongly. */
export interface BrollBeat {
  /** Local file path of the footage or still for this beat. */
  file: string;
  /** True when `file` is a still image rather than a clip. */
  still?: boolean;
  startMs: number;
  endMs: number;
  /**
   * How strongly this beat sits over the presenter, 0–1.
   *
   * Reference videos in this format vary it deliberately: anatomical graphics
   * and product shots sit near-opaque, lifestyle footage sits translucent so
   * the presenter still reads through it. Defaults to fully opaque.
   */
  opacity?: number;
}

export interface OverlayGeometry {
  /** Share of frame height the overlay box covers, measured from the top. */
  heightFraction: number;
  /** Share of the box's own height used to fade its bottom edge out. */
  featherFraction: number;
}

/** Measured from a reference video of this format; a sane starting point. */
export const DEFAULT_GEOMETRY: OverlayGeometry = {
  heightFraction: 0.45,
  featherFraction: 0.18,
};

export const DEFAULT_CROSSFADE_MS = 700;

/** A segment of the assembled overlay track: either a beat or a hole. */
export interface TrackSegment {
  kind: "beat" | "gap";
  /** Index into the caller's beats array; absent for gaps. */
  beatIndex?: number;
  startMs: number;
  endMs: number;
}

export interface BeatPlan {
  segments: TrackSegment[];
  /** `xfade` offset in seconds for each join, in chain order. */
  offsetsSec: number[];
  /** Crossfade actually used — clamped down when a segment is too short. */
  crossfadeMs: number;
  /** Length of the assembled overlay track. */
  trackDurationMs: number;
}

export class BrollPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrollPlanError";
  }
}

/**
 * Turn a list of beats into a continuous, gap-filled overlay track and work
 * out the `xfade` offsets that chain it together.
 *
 * Pure, because this is where the arithmetic is easy to get subtly wrong and
 * expensive to debug through a render. Each segment after the first is
 * extended by one crossfade in `compositeBroll`, so the dissolve happens before
 * its nominal start without shortening the absolute narration timeline.
 */
export function planBeatTrack(
  beats: readonly BrollBeat[],
  options: { crossfadeMs?: number } = {},
): BeatPlan {
  if (beats.length === 0) throw new BrollPlanError("No beats to composite.");

  const sorted = [...beats].sort((a, b) => a.startMs - b.startMs);
  sorted.forEach((beat, i) => {
    if (beat.endMs <= beat.startMs) {
      throw new BrollPlanError(`Beat ${i} ends before it starts.`);
    }
    const previous = sorted[i - 1];
    if (previous && beat.startMs < previous.endMs) {
      throw new BrollPlanError(`Beat ${i} overlaps the one before it.`);
    }
    if (beat.opacity !== undefined && (beat.opacity < 0 || beat.opacity > 1)) {
      throw new BrollPlanError(`Beat ${i} has an opacity outside 0–1.`);
    }
  });

  // Build the continuous track: a leading hole if the first beat starts late,
  // then each beat with a hole wherever the next one does not follow directly.
  const segments: TrackSegment[] = [];
  let cursor = 0;
  for (const beat of sorted) {
    if (beat.startMs > cursor) {
      segments.push({ kind: "gap", startMs: cursor, endMs: beat.startMs });
    }
    segments.push({
      kind: "beat",
      beatIndex: beats.indexOf(beat),
      startMs: beat.startMs,
      endMs: beat.endMs,
    });
    cursor = beat.endMs;
  }

  // A crossfade longer than the segments it joins produces a broken chain, so
  // clamp it to a fraction of the shortest segment rather than failing: the
  // caller's beat timings are the intent, the transition length is a taste.
  const shortestMs = Math.min(...segments.map((s) => s.endMs - s.startMs));
  const requested = options.crossfadeMs ?? DEFAULT_CROSSFADE_MS;
  const crossfadeMs =
    segments.length > 1 ? Math.max(0, Math.min(requested, Math.floor(shortestMs * 0.4))) : 0;

  const offsetsSec: number[] = [];
  let accumulatedMs = segments[0]!.endMs - segments[0]!.startMs;
  for (let i = 1; i < segments.length; i += 1) {
    offsetsSec.push(Number(((accumulatedMs - crossfadeMs) / 1000).toFixed(3)));
    accumulatedMs += segments[i]!.endMs - segments[i]!.startMs;
  }

  return { segments, offsetsSec, crossfadeMs, trackDurationMs: accumulatedMs };
}

/**
 * Build the greyscale alpha ramp for one beat.
 *
 * Opaque across the top, easing to fully transparent across the bottom
 * `featherFraction` of the box, then scaled by the beat's opacity. Written as
 * raw single-channel pixels through sharp — the same rasteriser the watermark
 * already uses — because an exact ramp matters more here than convenience.
 */
export async function renderFeatherMask(
  width: number,
  height: number,
  featherFraction: number,
  opacity: number,
): Promise<Buffer> {
  const clampedFeather = Math.min(0.95, Math.max(0, featherFraction));
  const clampedOpacity = Math.min(1, Math.max(0, opacity));
  const featherStart = Math.floor(height * (1 - clampedFeather));
  const featherRows = Math.max(1, height - featherStart);

  const pixels = Buffer.alloc(width * height);
  for (let y = 0; y < height; y += 1) {
    const ramp = y < featherStart ? 1 : 1 - (y - featherStart) / featherRows;
    pixels.fill(Math.round(ramp * clampedOpacity * 255), y * width, (y + 1) * width);
  }

  return sharp(pixels, { raw: { width, height, channels: 1 } }).png().toBuffer();
}

export interface CompositeInput {
  /** The presenter plate: one continuous take, already the output size. */
  baseVideo: Buffer;
  beats: readonly BrollBeat[];
  width: number;
  height: number;
  fps?: number;
  geometry?: OverlayGeometry;
  crossfadeMs?: number;
}

/**
 * Composite the beats onto the plate and return the finished video.
 *
 * The base video's own audio is carried through untouched: in this format the
 * narration *is* the presenter's take, so re-encoding it would only lose
 * quality.
 */
export async function compositeBroll(input: CompositeInput): Promise<Buffer> {
  const geometry = input.geometry ?? DEFAULT_GEOMETRY;
  const fps = input.fps ?? 30;
  const boxWidth = input.width;
  // Even dimensions keep yuv420p happy; an odd height fails the encode.
  const boxHeight = Math.max(2, Math.round((input.height * geometry.heightFraction) / 2) * 2);

  const plan = planBeatTrack(input.beats, { crossfadeMs: input.crossfadeMs });
  const dir = await mkdtemp(join(tmpdir(), "kokao-broll-"));

  try {
    await writeFile(join(dir, "base.mp4"), input.baseVideo);

    const args: string[] = ["-y", "-i", "base.mp4"];
    const chains: string[] = [];
    const labels: string[] = [];
    let inputIndex = 1;

    for (const [i, segment] of plan.segments.entries()) {
      const durationSec = (segment.endMs - segment.startMs) / 1000;
      // xfade overlaps this much of every segment after the first with the
      // preceding one. Extending the input compensates for that overlap so a
      // beat ending at 10s still ends at 10s, rather than 10s minus the fade.
      const inputDurationSec = durationSec + (i > 0 ? plan.crossfadeMs / 1000 : 0);

      if (segment.kind === "gap") {
        // A hole in the overlay, expressed as something the chain can dissolve
        // to rather than as an absence.
        chains.push(
          `color=c=black@0.0:s=${boxWidth}x${boxHeight}:d=${inputDurationSec.toFixed(3)}:r=${fps},` +
            `format=yuva420p[s${i}]`,
        );
        labels.push(`s${i}`);
        continue;
      }

      const beat = input.beats[segment.beatIndex!]!;
      const maskName = `mask${i}.png`;
      await writeFile(
        join(dir, maskName),
        await renderFeatherMask(boxWidth, boxHeight, geometry.featherFraction, beat.opacity ?? 1),
      );

      if (beat.still) {
        args.push("-loop", "1", "-framerate", String(fps), "-t", inputDurationSec.toFixed(3));
      } else {
        // Loop shorter footage so it fills its slot instead of freezing or
        // ending the chain early. `-t` bounds it, so the loop always stops.
        args.push("-stream_loop", "-1", "-t", inputDurationSec.toFixed(3));
      }
      args.push("-i", beat.file);
      const clipIndex = inputIndex;
      inputIndex += 1;

      args.push("-loop", "1", "-framerate", String(fps), "-t", inputDurationSec.toFixed(3));
      args.push("-i", maskName);
      const maskIndex = inputIndex;
      inputIndex += 1;

      chains.push(
        `[${clipIndex}:v]scale=${boxWidth}:${boxHeight}:force_original_aspect_ratio=increase,` +
          `crop=${boxWidth}:${boxHeight},fps=${fps},setpts=PTS-STARTPTS,format=yuva420p[c${i}]`,
      );
      chains.push(`[${maskIndex}:v]format=gray,scale=${boxWidth}:${boxHeight}[m${i}]`);
      // alphamerge drops the input frame-rate metadata on ffmpeg 7.1.1.
      // Re-stamp it here because xfade rejects streams whose rate becomes 1/0.
      chains.push(`[c${i}][m${i}]alphamerge,fps=${fps}[s${i}]`);
      labels.push(`s${i}`);
    }

    // Chain the segments into one track.
    let current = labels[0]!;
    for (let i = 1; i < labels.length; i += 1) {
      const next = `x${i}`;
      if (plan.crossfadeMs === 0) {
        chains.push(`[${current}][${labels[i]}]concat=n=2:v=1:a=0[${next}]`);
      } else {
        chains.push(
          `[${current}][${labels[i]}]xfade=transition=fade:` +
            `duration=${(plan.crossfadeMs / 1000).toFixed(3)}:offset=${plan.offsetsSec[i - 1]}[${next}]`,
        );
      }
      current = next;
    }

    // eof_action=pass leaves the plate untouched once the track runs out,
    // which is what makes a trailing hole free rather than a black box.
    chains.push(`[0:v][${current}]overlay=0:0:format=auto:eof_action=pass[v]`);

    args.push(
      "-filter_complex",
      chains.join(";"),
      "-map",
      "[v]",
      "-map",
      "0:a?",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "copy",
      "-movflags",
      "+faststart",
      "out.mp4",
    );

    await runFfmpeg(args, dir, encodeBudgetMs(plan.trackDurationMs / 1000));
    return await readFile(join(dir, "out.mp4"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}