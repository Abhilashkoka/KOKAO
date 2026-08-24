/**
 * Named camera-motion and treatment presets.
 *
 * Every AI clip KOKAO generates used to receive the same seven-word motion
 * suffix ("Subtle natural motion, cinematic."), which is a sensible default
 * and a hard ceiling: there was no way for a user to ask for a crash zoom, an
 * orbit, or a whip pan. These presets are that vocabulary.
 *
 * A preset is a LABEL plus the prompt fragment it expands into. The fragment
 * is the whole feature: KOKAO's providers (Replicate, OpenRouter, custom) take
 * plain text, not an effect id, so a preset is only as good as the sentence it
 * compiles to. Each one below names the move, the framing consequence, and the
 * pacing — the three things video models actually respond to — and none of
 * them mention cuts, dialogue, on-screen text, or watermarks, which the shot
 * planners already forbid.
 *
 * Deliberately curated rather than exhaustive. Every preset is a support
 * surface and a thing to keep working across model swaps; sixty that read well
 * beat three hundred that mostly rhyme.
 */

/** How a preset is grouped in the picker. */
export type MotionPresetCategory = "camera" | "lens" | "energy" | "style";

export interface MotionPreset {
  /** Stable id persisted on jobs and storyboard scenes. Never renamed. */
  id: string;
  /** Human label shown in the studio. */
  label: string;
  category: MotionPresetCategory;
  /** The sentence appended to the generation prompt. */
  prompt: string;
}

export const MOTION_PRESET_CATEGORIES: {
  id: MotionPresetCategory;
  label: string;
  description: string;
}[] = [
  {
    id: "camera",
    label: "Camera move",
    description: "How the camera travels through the shot.",
  },
  {
    id: "lens",
    label: "Lens & focus",
    description: "Optical behaviour — focal length, focus, distortion.",
  },
  {
    id: "energy",
    label: "Energy & time",
    description: "Pacing: how fast the world moves inside the frame.",
  },
  {
    id: "style",
    label: "Look",
    description: "Capture medium and grade, applied to the whole clip.",
  },
];

export const MOTION_PRESETS: readonly MotionPreset[] = [
  // ── camera ──────────────────────────────────────────────────────────────
  {
    id: "dolly-in",
    label: "Dolly in",
    category: "camera",
    prompt:
      "The camera glides steadily forward on a dolly toward the subject, framing tightening from wide to medium at an even, unhurried pace.",
  },
  {
    id: "dolly-out",
    label: "Dolly out",
    category: "camera",
    prompt:
      "The camera glides steadily backward on a dolly, the subject holding centre frame while more of the surrounding space is revealed.",
  },
  {
    id: "dolly-left",
    label: "Dolly left",
    category: "camera",
    prompt:
      "The camera tracks smoothly to the left on a dolly, parallel to the subject, foreground elements sliding past to give depth.",
  },
  {
    id: "dolly-right",
    label: "Dolly right",
    category: "camera",
    prompt:
      "The camera tracks smoothly to the right on a dolly, parallel to the subject, foreground elements sliding past to give depth.",
  },
  {
    id: "push-in-slow",
    label: "Slow push in",
    category: "camera",
    prompt:
      "A very slow, almost imperceptible push toward the subject, tension building across the shot without the framing ever feeling rushed.",
  },
  {
    id: "crash-zoom-in",
    label: "Crash zoom in",
    category: "camera",
    prompt:
      "A fast, punchy zoom snaps in tight on the subject and settles, the sudden framing change landing like an emphasis beat.",
  },
  {
    id: "crash-zoom-out",
    label: "Crash zoom out",
    category: "camera",
    prompt:
      "A fast zoom snaps outward to reveal the wider scene around the subject, the sudden pull-back landing like a punchline.",
  },
  {
    id: "dolly-zoom",
    label: "Dolly zoom (vertigo)",
    category: "camera",
    prompt:
      "A dolly zoom: the camera moves toward the subject while the lens zooms out, so the subject stays the same size and the background warps and stretches unnervingly behind them.",
  },
  {
    id: "orbit-360",
    label: "360° orbit",
    category: "camera",
    prompt:
      "The camera orbits smoothly around the subject in a full circle at a constant radius, the subject held dead centre as the background sweeps past behind them.",
  },
  {
    id: "arc-left",
    label: "Arc left",
    category: "camera",
    prompt:
      "The camera arcs to the left around the subject on a curved path, revealing a new angle on them as the background parallaxes.",
  },
  {
    id: "arc-right",
    label: "Arc right",
    category: "camera",
    prompt:
      "The camera arcs to the right around the subject on a curved path, revealing a new angle on them as the background parallaxes.",
  },
  {
    id: "crane-up",
    label: "Crane up",
    category: "camera",
    prompt:
      "The camera rises smoothly on a crane, tilting slightly down to hold the subject as the scene opens out beneath it.",
  },
  {
    id: "crane-down",
    label: "Crane down",
    category: "camera",
    prompt:
      "The camera descends smoothly on a crane from above, settling to eye level on the subject.",
  },
  {
    id: "overhead",
    label: "Overhead descent",
    category: "camera",
    prompt:
      "A top-down overhead shot looking straight down, the camera lowering slowly toward the subject, the composition reading as a flat graphic plane.",
  },
  {
    id: "tilt-up",
    label: "Tilt up",
    category: "camera",
    prompt:
      "The camera tilts upward from the base of the subject to the top, revealing full scale from the ground up.",
  },
  {
    id: "tilt-down",
    label: "Tilt down",
    category: "camera",
    prompt:
      "The camera tilts downward across the subject from top to bottom in one continuous reveal.",
  },
  {
    id: "pan-left",
    label: "Pan left",
    category: "camera",
    prompt:
      "The camera pans smoothly to the left from a fixed position, sweeping across the scene at an even speed.",
  },
  {
    id: "pan-right",
    label: "Pan right",
    category: "camera",
    prompt:
      "The camera pans smoothly to the right from a fixed position, sweeping across the scene at an even speed.",
  },
  {
    id: "whip-pan",
    label: "Whip pan",
    category: "camera",
    prompt:
      "A fast whip pan blurs horizontally across the scene and settles hard on the subject, the motion blur streaking the frame mid-move.",
  },
  {
    id: "handheld",
    label: "Handheld",
    category: "camera",
    prompt:
      "Loose handheld camera work: small organic sway and micro-corrections in the framing, documentary feel, never stabilised.",
  },
  {
    id: "steadicam-follow",
    label: "Steadicam follow",
    category: "camera",
    prompt:
      "A Steadicam follows behind the subject at walking pace, the frame floating smoothly with almost no vertical bounce.",
  },
  {
    id: "fpv-drone",
    label: "FPV drone",
    category: "camera",
    prompt:
      "An FPV drone flies fast and low through the scene, banking through gaps and around obstacles in one continuous aggressive move.",
  },
  {
    id: "aerial-reveal",
    label: "Aerial reveal",
    category: "camera",
    prompt:
      "A high aerial shot pulls back and up, the subject shrinking as the full landscape opens out around it.",
  },
  {
    id: "car-mount",
    label: "Car mount",
    category: "camera",
    prompt:
      "The camera is rigidly mounted to a moving vehicle, the subject steady in frame while the world rushes past behind it.",
  },
  {
    id: "dutch-angle",
    label: "Dutch angle",
    category: "camera",
    prompt:
      "The camera is canted into a Dutch angle, the horizon tilted off level, slowly rolling further through the shot for unease.",
  },
  {
    id: "snorricam",
    label: "Snorricam",
    category: "camera",
    prompt:
      "A Snorricam rig fixes the subject dead centre and perfectly still in frame while the entire background swings and lurches around them.",
  },
  {
    id: "lazy-susan",
    label: "Lazy Susan",
    category: "camera",
    prompt:
      "The subject rotates slowly on a turntable in front of a locked-off camera, every face of it presented in turn under even light.",
  },
  {
    id: "static-lockoff",
    label: "Locked off",
    category: "camera",
    prompt:
      "The camera is completely locked off on a tripod. Nothing moves but the subject and the world it lives in.",
  },
  {
    id: "hero-low-angle",
    label: "Hero low angle",
    category: "camera",
    prompt:
      "A low angle looking up at the subject, camera pushing in slightly, making them tower over the frame.",
  },
  {
    id: "through-object",
    label: "Through the foreground",
    category: "camera",
    prompt:
      "The camera moves forward through a foreground element — leaves, a doorway, glass — which slides out of focus past the lens to reveal the subject beyond.",
  },
  {
    id: "focus-pull",
    label: "Focus pull",
    category: "lens",
    prompt:
      "A deliberate rack focus: the foreground starts sharp, then focus pulls smoothly to the subject behind it, the abandoned plane melting into bokeh.",
  },
  {
    id: "shallow-portrait",
    label: "Shallow depth",
    category: "lens",
    prompt:
      "Shot on a long fast prime wide open: very shallow depth of field, creamy bokeh, the subject cleanly separated from a softened background.",
  },
  {
    id: "deep-focus",
    label: "Deep focus",
    category: "lens",
    prompt:
      "Stopped well down for deep focus: foreground, subject and far background all rendered sharp, every plane of the scene readable.",
  },
  {
    id: "anamorphic-wide",
    label: "Anamorphic wide",
    category: "lens",
    prompt:
      "Shot on anamorphic glass: wide cinematic framing, oval bokeh, gentle horizontal flares across the highlights and mild edge distortion.",
  },
  {
    id: "macro-detail",
    label: "Extreme macro",
    category: "lens",
    prompt:
      "Extreme macro on a small detail of the subject, razor-thin focal plane, texture filling the frame, tiny camera drift keeping it alive.",
  },
  {
    id: "fisheye",
    label: "Fisheye",
    category: "lens",
    prompt:
      "Shot on an ultra-wide fisheye: heavy barrel distortion, the centre of frame bulging toward the lens, edges curving away.",
  },
  {
    id: "wide-establishing",
    label: "Wide establishing",
    category: "lens",
    prompt:
      "A wide establishing frame on a short lens, the subject small in a large environment, the geography of the place doing the storytelling.",
  },
  {
    id: "lens-flare",
    label: "Lens flare",
    category: "lens",
    prompt:
      "A hard light source clips the edge of frame and throws streaking anamorphic flare and warm haze across the lens as the camera moves.",
  },

  // ── energy & time ───────────────────────────────────────────────────────
  {
    id: "slow-motion",
    label: "Slow motion",
    category: "energy",
    prompt:
      "Filmed at high frame rate and played back in smooth slow motion, every gesture stretched and weighted, no stutter.",
  },
  {
    id: "hyperlapse",
    label: "Hyperlapse",
    category: "energy",
    prompt:
      "A hyperlapse: the camera travels a long distance while time compresses, the world streaking past in accelerated motion.",
  },
  {
    id: "timelapse-sky",
    label: "Timelapse",
    category: "energy",
    prompt:
      "A locked timelapse: clouds and light race across the scene while the subject holds still, shadows sweeping through the frame.",
  },
  {
    id: "freeze-then-move",
    label: "Freeze then move",
    category: "energy",
    prompt:
      "The scene holds almost perfectly still for a beat, then motion begins and builds smoothly through the rest of the shot.",
  },
  {
    id: "bullet-time",
    label: "Bullet time",
    category: "energy",
    prompt:
      "Bullet time: the action slows almost to a standstill while the camera continues to travel around the subject at full speed.",
  },
  {
    id: "subtle-drift",
    label: "Subtle drift",
    category: "energy",
    prompt:
      "Barely-there movement: a slow drift and gentle breathing in the frame, natural ambient motion, nothing calling attention to itself.",
  },

  // ── look ────────────────────────────────────────────────────────────────
  {
    id: "film-16mm",
    label: "16mm film",
    category: "style",
    prompt:
      "Captured on 16mm film: visible grain, slightly soft edges, warm halation around the highlights, gentle gate weave.",
  },
  {
    id: "film-70mm",
    label: "70mm film",
    category: "style",
    prompt:
      "Captured on large-format 70mm film: enormous tonal range, fine grain, rich saturated colour and immense apparent depth.",
  },
  {
    id: "vhs",
    label: "VHS",
    category: "style",
    prompt:
      "Degraded VHS capture: soft scan lines, chroma bleed, tracking noise along the edges, slightly washed contrast.",
  },
  {
    id: "super-8",
    label: "Super 8",
    category: "style",
    prompt:
      "Super 8 home-movie look: heavy grain, warm faded colour, soft focus falloff and a light flicker between frames.",
  },
  {
    id: "noir",
    label: "Film noir",
    category: "style",
    prompt:
      "High-contrast black-and-white film noir: hard key light, deep crushed shadows, venetian-blind patterns falling across the scene.",
  },
  {
    id: "golden-hour",
    label: "Golden hour",
    category: "style",
    prompt:
      "Late golden-hour sun: long warm raking light, amber rim on the subject, soft atmospheric haze in the air.",
  },
  {
    id: "neon-night",
    label: "Neon night",
    category: "style",
    prompt:
      "Night exterior lit by neon and wet reflections: saturated magenta and cyan pools of light, deep shadows, damp glistening surfaces.",
  },
  {
    id: "overcast-soft",
    label: "Soft overcast",
    category: "style",
    prompt:
      "Flat overcast daylight: huge soft source, no hard shadows, muted natural colour, calm editorial mood.",
  },
  {
    id: "studio-clean",
    label: "Clean studio",
    category: "style",
    prompt:
      "Clean commercial studio lighting: seamless backdrop, even soft key with a subtle rim, product-grade clarity and neutral colour.",
  },
] as const;

const BY_ID = new Map(MOTION_PRESETS.map((preset) => [preset.id, preset]));

/** Look up a preset by id, or null for an unknown/absent id. */
export function findMotionPreset(id: string | null | undefined): MotionPreset | null {
  if (!id) return null;
  return BY_ID.get(id) ?? null;
}

/** True when the id names a preset in the catalog (route validation). */
export function isMotionPresetId(id: string): boolean {
  return BY_ID.has(id);
}
