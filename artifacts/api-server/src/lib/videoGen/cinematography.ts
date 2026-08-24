/**
 * Optics: the camera, lens, focal length and aperture a shot is "shot on".
 *
 * Motion presets (motionPresets.ts) say how the camera MOVES. This says what
 * the camera IS — and the two are independent choices, which is why they are
 * separate catalogs rather than one flattened list: a dolly-in on 16mm film at
 * f/1.4 is a different shot from the same dolly-in on a modern 8K digital body
 * stopped down to f/11, and a user should be able to change one without
 * disturbing the other.
 *
 * Every entry compiles to a prompt fragment for the same reason the motion
 * presets do: KOKAO's providers take plain text, so a label with no sentence
 * behind it is a control that does nothing.
 *
 * Each axis is independently optional. Picking only an aperture is a valid,
 * useful choice ("give me shallow depth of field, I don't care what body it
 * was shot on"), and the compiler emits exactly what was asked for.
 */

export interface CinematographyOption {
  /** Stable id persisted on jobs. Never renamed. */
  id: string;
  label: string;
  /** The clause appended to the shot prompt. */
  prompt: string;
}

export const CAMERAS: readonly CinematographyOption[] = [
  {
    id: "modular-8k-digital",
    label: "Modular 8K digital",
    prompt: "shot on a modular 8K digital cinema camera, pristine detail and enormous latitude",
  },
  {
    id: "full-frame-cine",
    label: "Full-frame cine digital",
    prompt: "shot on a full-frame digital cinema camera, smooth roll-off and rich skin tones",
  },
  {
    id: "super35-studio",
    label: "Super 35 studio digital",
    prompt: "shot on a Super 35 studio digital camera, classic television-drama rendering",
  },
  {
    id: "large-format-digital",
    label: "Large-format digital",
    prompt:
      "shot on a premium large-format digital cinema camera, shallow planes and immense apparent depth",
  },
  {
    id: "70mm-film",
    label: "70mm film",
    prompt: "shot on 70mm large-format film, fine grain, enormous tonal range, deep saturated colour",
  },
  {
    id: "16mm-film",
    label: "16mm film",
    prompt: "shot on 16mm film, visible grain, gentle halation in the highlights, slight gate weave",
  },
];

export const LENSES: readonly CinematographyOption[] = [
  {
    id: "modern-prime",
    label: "Modern prime",
    prompt: "on a premium modern prime lens, clinically even field and neutral colour",
  },
  {
    id: "vintage-prime",
    label: "Vintage prime",
    prompt: "on a vintage prime lens, softer contrast, warm cast and gentle edge falloff",
  },
  {
    id: "70s-cinema-prime",
    label: "70s cinema prime",
    prompt: "on a 1970s cinema prime lens, low-contrast blooming highlights and creamy falloff",
  },
  {
    id: "classic-anamorphic",
    label: "Classic anamorphic",
    prompt: "on a classic anamorphic lens, oval bokeh, horizontal flares and mild edge stretch",
  },
  {
    id: "compact-anamorphic",
    label: "Compact anamorphic",
    prompt: "on a compact anamorphic lens, subtle oval bokeh and restrained flaring",
  },
  {
    id: "swirl-bokeh",
    label: "Swirl bokeh portrait",
    prompt: "on a swirl-bokeh portrait lens, background highlights rotating around the subject",
  },
  {
    id: "halation-diffusion",
    label: "Halation diffusion",
    prompt: "through a halation diffusion filter, highlights blooming into a soft glow",
  },
  {
    id: "tilt-shift",
    label: "Tilt-shift",
    prompt: "on a tilt-shift lens, the plane of focus cutting diagonally across the frame",
  },
  {
    id: "macro",
    label: "Macro",
    prompt: "on a macro lens, life-size magnification and a razor-thin plane of focus",
  },
  {
    id: "clinical-sharp",
    label: "Clinical sharp",
    prompt: "on an ultra-sharp clinical prime lens, edge-to-edge resolution with no character",
  },
];

/** Focal lengths, in millimetres, with the perspective each one gives. */
export const FOCAL_LENGTHS: readonly { mm: number; label: string; prompt: string }[] = [
  { mm: 8, label: "8mm", prompt: "at 8mm, an extreme ultra-wide perspective with visible curvature" },
  { mm: 14, label: "14mm", prompt: "at 14mm, a wide perspective that exaggerates depth" },
  { mm: 24, label: "24mm", prompt: "at 24mm, a dynamic wide perspective close to the subject" },
  { mm: 35, label: "35mm", prompt: "at 35mm, a natural perspective close to human vision" },
  { mm: 50, label: "50mm", prompt: "at 50mm, a standard perspective with no distortion" },
  { mm: 85, label: "85mm", prompt: "at 85mm, a compressed portrait perspective" },
  { mm: 135, label: "135mm", prompt: "at 135mm, heavily compressed, the background stacked close" },
];

export const APERTURES: readonly CinematographyOption[] = [
  {
    id: "f1.4",
    label: "f/1.4",
    prompt: "wide open at f/1.4, very shallow depth of field and creamy bokeh",
  },
  { id: "f2.8", label: "f/2.8", prompt: "at f/2.8, shallow depth of field with the subject clean" },
  { id: "f4", label: "f/4", prompt: "at f/4, balanced depth of field" },
  { id: "f8", label: "f/8", prompt: "at f/8, most of the scene rendered sharp" },
  { id: "f11", label: "f/11", prompt: "at f/11, deep focus from foreground to horizon" },
];

/** What a job stores and the request accepts. Every axis is optional. */
export interface Cinematography {
  camera?: string | null;
  lens?: string | null;
  focalLengthMm?: number | null;
  aperture?: string | null;
}

const CAMERA_BY_ID = new Map(CAMERAS.map((o) => [o.id, o]));
const LENS_BY_ID = new Map(LENSES.map((o) => [o.id, o]));
const APERTURE_BY_ID = new Map(APERTURES.map((o) => [o.id, o]));
const FOCAL_BY_MM = new Map(FOCAL_LENGTHS.map((o) => [o.mm, o]));

/** True when every set axis names something in the catalog (route validation). */
export function isValidCinematography(value: Cinematography): boolean {
  if (value.camera && !CAMERA_BY_ID.has(value.camera)) return false;
  if (value.lens && !LENS_BY_ID.has(value.lens)) return false;
  if (value.aperture && !APERTURE_BY_ID.has(value.aperture)) return false;
  if (value.focalLengthMm != null && !FOCAL_BY_MM.has(value.focalLengthMm)) return false;
  return true;
}

/** Drop anything unrecognised, so a stored selection can never break a render. */
export function normalizeCinematography(
  value: Cinematography | null | undefined,
): Cinematography | null {
  if (!value) return null;
  const normalized: Cinematography = {
    camera: value.camera && CAMERA_BY_ID.has(value.camera) ? value.camera : null,
    lens: value.lens && LENS_BY_ID.has(value.lens) ? value.lens : null,
    aperture: value.aperture && APERTURE_BY_ID.has(value.aperture) ? value.aperture : null,
    focalLengthMm:
      value.focalLengthMm != null && FOCAL_BY_MM.has(value.focalLengthMm)
        ? value.focalLengthMm
        : null,
  };
  const anySet = Object.values(normalized).some((v) => v != null);
  return anySet ? normalized : null;
}

/**
 * The optics clause for a shot prompt, or null when nothing is set.
 *
 * Ordered body → lens → focal length → aperture, which is how a DP would say
 * it out loud and how the phrasing reads most naturally to a model. Returns
 * null rather than an empty string so callers can leave a prompt byte-
 * identical when the user picked nothing.
 */
export function cinematographyClause(
  value: Cinematography | null | undefined,
): string | null {
  const normalized = normalizeCinematography(value);
  if (!normalized) return null;
  const parts = [
    normalized.camera ? CAMERA_BY_ID.get(normalized.camera)!.prompt : null,
    normalized.lens ? LENS_BY_ID.get(normalized.lens)!.prompt : null,
    normalized.focalLengthMm != null ? FOCAL_BY_MM.get(normalized.focalLengthMm)!.prompt : null,
    normalized.aperture ? APERTURE_BY_ID.get(normalized.aperture)!.prompt : null,
  ].filter((p): p is string => p !== null);
  if (parts.length === 0) return null;
  // One sentence, capitalised, so it reads as craft direction rather than a
  // list of tags bolted onto the end of the brief.
  const sentence = parts.join(", ");
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}
