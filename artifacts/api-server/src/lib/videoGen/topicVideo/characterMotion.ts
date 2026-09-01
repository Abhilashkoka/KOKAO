/**
 * The image-to-video prompt for a character scene.
 *
 * The keyframe arrives correct — identity locked, outfit locked, calm face —
 * and the video model then has several seconds to fill. What it was being told
 * was the scene's VISUAL description followed by a camera note ("Subtle
 * natural motion, cinematic"). Neither constrains the face, and the visual
 * description is actively harmful here: it is a description of a still, the
 * image model has already rendered it into the keyframe, and re-sending it
 * asks the video model to perform the same beat a second time on top of a
 * frame that already contains it. Any emotional word in that prose becomes
 * facial acting.
 *
 * Unconstrained, wan-2.2-i2v-fast falls into its presenter prior: brows up,
 * eyes wide, and — because nothing pulls it back — it stays there. Measured on
 * a real render, the first frame of every scene was relaxed and natural, the
 * eyes were already wide by 0.8s, and full alarm held from 1.6s to the end of
 * the shot. The defect is entirely inside this stage.
 *
 * So a scene that will be lip-synced sends no scene prose at all. Its keyframe
 * IS the scene, and the only thing left to ask for is that the person move
 * like a person while nothing else changes. The mouth is a special case worth
 * naming: LatentSync replaces that region wholesale afterwards, so mouth
 * acting done here is paid for and then thrown away — what survives to the
 * finished video is the eyes and brows, which is exactly what had gone wrong.
 *
 * The motion clause always survives. A user who picked a motion preset picked
 * it deliberately, and the preset owns the camera; these clauses only ever
 * speak about the face.
 */

/** Facial hold for a shot whose mouth will be re-synced downstream. */
export const SPEAKING_HOLD =
  "The person in this image is speaking calmly to the camera. Animate them " +
  "talking: gentle natural head movement, normal relaxed blinking, small " +
  "natural lip movement. Hold the face as it is in the source image — the " +
  "same relaxed expression in the last frame as in the first. Eyes relaxed " +
  "and normally open, eyebrows level and still. Do not widen the eyes, do not " +
  "raise the eyebrows, and do not add surprise, shock, alarm, excitement or " +
  "any exaggerated expression. The expression must not build or intensify " +
  "across the shot. Keep the background, the clothing and the framing " +
  "unchanged.";

/**
 * The lighter guard for a character shot that is not being synced. Here the
 * scene prose still earns its place — the shot may be an action rather than a
 * piece to camera — so the visual is kept and only the drift is named.
 */
export const EXPRESSION_GUARD =
  "Keep the facial expression natural and consistent throughout: eyes relaxed " +
  "and normally open, eyebrows level. No surprise, shock, alarm or " +
  "exaggerated expression, and no build-up of expression across the shot.";

export function characterScenePrompt(args: {
  /** The scene's visual description, as written for the keyframe. */
  visual: string;
  /** The resolved motion instruction: a picked preset, or the governed default. */
  motion: string;
  /** Whether this shot's mouth will be replaced by the lip-sync pass. */
  lipSynced: boolean;
}): string {
  return args.lipSynced
    ? `${SPEAKING_HOLD} ${args.motion}`
    : `${args.visual}. ${args.motion} ${EXPRESSION_GUARD}`;
}