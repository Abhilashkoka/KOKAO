/**
 * Non-destructive adjustments, expressed as a filter plan.
 *
 * Konva applies filters as an array of functions on a cached node, each
 * reading its parameters off node attributes. That API is fine to drive but
 * impossible to test: it needs a real canvas, and jsdom has none, so anything
 * written directly against Konva is code that ships unverified.
 *
 * So the mapping from an `Adjustments` object to "which filters, with which
 * attributes, in which order" is computed here as plain data, and the canvas
 * component is left with the mechanical job of setting what the plan says.
 * The two filters Konva does not provide — unsharp mask and per-channel gain —
 * are implemented here as pixel functions over a plain typed array, for the
 * same reason.
 */

import type { Adjustments } from "./doc";

/** A Konva built-in filter, named, with the node attributes it reads. */
export interface FilterStep {
  filter:
    | "Blur"
    | "Brighten"
    | "Contrast"
    | "Grayscale"
    | "HSL"
    | "Invert"
    | "Noise"
    | "Pixelate"
    | "Posterize"
    | "Sepia"
    | "Threshold"
    | "Sharpen"
    | "Channels";
  attrs: Record<string, number>;
}

/**
 * Order matters and is not arbitrary.
 *
 * Tone (exposure, contrast) runs before colour (HSL) so that saturation acts
 * on the corrected image rather than the raw one — pushing saturation on an
 * underexposed layer and then brightening it produces a different, muddier
 * result than the other way round. Structural effects (blur, sharpen,
 * pixelate) run last because they are about pixels, not about colour, and
 * anything that runs after them re-grades edges the user just shaped.
 */
export function buildFilterPlan(adj: Adjustments | undefined): FilterStep[] {
  if (!adj) return [];
  const steps: FilterStep[] = [];

  if (typeof adj.brightness === "number" && adj.brightness !== 0) {
    steps.push({ filter: "Brighten", attrs: { brightness: adj.brightness } });
  }
  if (typeof adj.contrast === "number" && adj.contrast !== 0) {
    steps.push({ filter: "Contrast", attrs: { contrast: adj.contrast } });
  }
  if (adj.channels) {
    steps.push({
      filter: "Channels",
      attrs: { channelR: adj.channels.r, channelG: adj.channels.g, channelB: adj.channels.b },
    });
  }

  const hue = adj.hue ?? 0;
  const saturation = adj.saturation ?? 0;
  const luminance = adj.luminance ?? 0;
  if (hue !== 0 || saturation !== 0 || luminance !== 0) {
    steps.push({ filter: "HSL", attrs: { hue, saturation, luminance } });
  }

  if (adj.grayscale) steps.push({ filter: "Grayscale", attrs: {} });
  if (adj.sepia) steps.push({ filter: "Sepia", attrs: {} });
  if (adj.invert) steps.push({ filter: "Invert", attrs: {} });

  if (typeof adj.posterize === "number" && adj.posterize > 0) {
    // Konva's Posterize takes 0..1, where the value is levels/255.
    steps.push({ filter: "Posterize", attrs: { levels: Math.min(1, adj.posterize / 255) } });
  }
  if (typeof adj.threshold === "number" && adj.threshold > 0) {
    steps.push({ filter: "Threshold", attrs: { threshold: adj.threshold } });
  }

  if (typeof adj.blur === "number" && adj.blur > 0) {
    steps.push({ filter: "Blur", attrs: { blurRadius: adj.blur } });
  }
  if (typeof adj.sharpen === "number" && adj.sharpen > 0) {
    steps.push({ filter: "Sharpen", attrs: { sharpenAmount: adj.sharpen } });
  }
  if (typeof adj.pixelate === "number" && adj.pixelate > 1) {
    steps.push({ filter: "Pixelate", attrs: { pixelSize: Math.round(adj.pixelate) } });
  }
  if (typeof adj.noise === "number" && adj.noise > 0) {
    steps.push({ filter: "Noise", attrs: { noise: adj.noise } });
  }

  return steps;
}

/* ------------------------------------------------------------------ *
 * Pixel functions for the two filters Konva does not ship
 * ------------------------------------------------------------------ */

/**
 * Unsharp mask.
 *
 * A 3×3 Laplacian sharpen scaled by `amount`, applied only where the alpha is
 * non-zero. Skipping transparent pixels matters for cut-out layers: sharpening
 * across a hard alpha edge pulls the background colour of the untouched
 * transparent pixels into the subject and leaves a bright halo.
 */
export function applySharpen(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  amount: number,
): void {
  if (amount <= 0 || width < 3 || height < 3) return;
  const src = new Uint8ClampedArray(data);
  const k = amount;

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = (y * width + x) * 4;
      if (src[i + 3] === 0) continue;
      for (let c = 0; c < 3; c += 1) {
        const centre = src[i + c];
        const sum =
          src[i - width * 4 + c] +
          src[i + width * 4 + c] +
          src[i - 4 + c] +
          src[i + 4 + c];
        // centre·(1+4k) − k·(neighbours) is the standard sharpen kernel,
        // normalised so amount 0 is a no-op.
        data[i + c] = centre * (1 + 4 * k) - k * sum;
      }
    }
  }
}

/** Per-channel gain, for split toning and quick colour casts. */
export function applyChannels(
  data: Uint8ClampedArray,
  r: number,
  g: number,
  b: number,
): void {
  if (r === 1 && g === 1 && b === 1) return;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = data[i] * r;
    data[i + 1] = data[i + 1] * g;
    data[i + 2] = data[i + 2] * b;
  }
}

/* ------------------------------------------------------------------ *
 * Presets
 * ------------------------------------------------------------------ */

export interface AdjustmentPreset {
  id: string;
  label: string;
  adjustments: Adjustments;
}

/**
 * A short, opinionated list rather than a filter grid.
 *
 * These exist so the common case — "warm this up a bit" — is one click instead
 * of three sliders, not to be a look library. Anything more elaborate is what
 * the sliders and adjustment layers are for.
 */
export const ADJUSTMENT_PRESETS: AdjustmentPreset[] = [
  { id: "none", label: "None", adjustments: {} },
  { id: "punch", label: "Punch", adjustments: { contrast: 18, saturation: 0.6, sharpen: 0.25 } },
  { id: "soft", label: "Soft", adjustments: { contrast: -10, saturation: -0.3, blur: 0.6 } },
  { id: "warm", label: "Warm", adjustments: { channels: { r: 1.06, g: 1.0, b: 0.94 }, saturation: 0.2 } },
  { id: "cool", label: "Cool", adjustments: { channels: { r: 0.94, g: 1.0, b: 1.07 }, saturation: 0.1 } },
  { id: "matte", label: "Matte", adjustments: { contrast: -14, brightness: 0.05, saturation: -0.4 } },
  { id: "mono", label: "Mono", adjustments: { grayscale: true, contrast: 12 } },
  { id: "film", label: "Film", adjustments: { noise: 0.08, contrast: 10, saturation: -0.2 } },
];

/** Slider definitions the properties panel renders, so the UI stays declarative. */
export interface AdjustmentControl {
  key: keyof Adjustments;
  label: string;
  min: number;
  max: number;
  step: number;
  /** Value that means "no change", used for the reset affordance. */
  identity: number;
}

export const ADJUSTMENT_CONTROLS: AdjustmentControl[] = [
  { key: "brightness", label: "Exposure", min: -1, max: 1, step: 0.01, identity: 0 },
  { key: "contrast", label: "Contrast", min: -100, max: 100, step: 1, identity: 0 },
  { key: "saturation", label: "Saturation", min: -2, max: 4, step: 0.05, identity: 0 },
  { key: "hue", label: "Hue", min: -180, max: 180, step: 1, identity: 0 },
  { key: "luminance", label: "Luminance", min: -1, max: 1, step: 0.01, identity: 0 },
  { key: "sharpen", label: "Sharpen", min: 0, max: 1, step: 0.02, identity: 0 },
  { key: "blur", label: "Blur", min: 0, max: 60, step: 0.5, identity: 0 },
  { key: "noise", label: "Grain", min: 0, max: 0.6, step: 0.01, identity: 0 },
  { key: "pixelate", label: "Pixelate", min: 0, max: 64, step: 1, identity: 0 },
];
