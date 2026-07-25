/**
 * Deterministic marketing prompt compiler.
 *
 * Image models answer to photographic direction — format, focal length,
 * aperture, light — far more reliably than to adjectives like "professional"
 * or "high quality". Tenants running a coffee shop have no reason to know that
 * vocabulary, so the studio offers it as a few pills and this file turns those
 * ids into the sentence a photographer would have written.
 *
 * It is a lookup and a join: no model call, no key, no cost, and the same
 * recipe always compiles to the same string. The compiled prompt is what gets
 * stored on the job, so the gallery shows something the tenant can paste back
 * in and re-run.
 */

/** Pill ids the studio may send. Unknown ids are rejected by the route's schema. */
export interface ImagePromptRecipe {
  preset?: string | null;
  camera?: string | null;
  lens?: string | null;
  aperture?: string | null;
  lighting?: string | null;
}

/** Bodies and formats, in the words these models were trained on. */
const CAMERAS: Record<string, string> = {
  phone: "a modern smartphone camera",
  mirrorless: "a full-frame mirrorless camera",
  dslr: "a full-frame DSLR",
  "medium-format": "a medium-format digital camera",
  film35: "a 35mm film camera with fine natural grain",
};

const LENSES: Record<string, string> = {
  "wide-24": "a 24mm wide-angle lens",
  "reportage-35": "a 35mm lens",
  "natural-50": "a 50mm lens",
  "portrait-85": "an 85mm portrait lens",
  "macro-100": "a 100mm macro lens",
  "tele-135": "a 135mm telephoto lens",
};

/**
 * Each aperture carries its own consequence, because the f-number alone is a
 * number the model can ignore and "creamy bokeh" is not.
 */
const APERTURES: Record<string, string> = {
  "f1.4": "f/1.4, very shallow depth of field and creamy bokeh",
  "f2.8": "f/2.8, shallow depth of field with a softly blurred background",
  "f5.6": "f/5.6, the subject sharp and gently separated from its background",
  f8: "f/8, the whole subject in focus",
  f16: "f/16, deep focus from front to back",
};

const LIGHTING: Record<string, string> = {
  softbox:
    "Lit by a large softbox key at 45 degrees with a subtle rim light for edge separation",
  window: "Lit by soft daylight through a window, gentle falloff and natural shadows",
  "golden-hour": "Lit by low golden-hour sun, long warm shadows and a hint of haze",
  flash: "Lit by direct flash, hard shadows and a crisp editorial snap",
  overcast: "Lit by flat overcast daylight, even and almost shadowless",
  neon: "Lit by coloured neon practicals against deep shadow, with wet-surface reflections",
};

interface LookPreset {
  /** What is being photographed and how it sits in frame. */
  scene: string;
  /** The grade and finish, appended last so it colours everything above it. */
  finish: string;
  /** Gear the preset implies; any of these can be overridden pill by pill. */
  camera: string;
  lens: string;
  aperture: string;
  lighting: string;
}

/**
 * One pill for each shoot a small brand actually books. The gear defaults are
 * the boring correct answer for that genre — macro at f/8 on a sweep for
 * packshots, 35mm wide open by a window for lifestyle — so a tenant who only
 * clicks "Product" still gets a coherent set rather than a slogan.
 */
const PRESETS: Record<string, LookPreset> = {
  product: {
    scene:
      "Studio product photograph on a seamless gradient sweep, crisp edges and a subtle contact reflection",
    finish: "commercial catalogue finish, true-to-life colour, high micro-detail",
    camera: "medium-format",
    lens: "macro-100",
    aperture: "f8",
    lighting: "softbox",
  },
  food: {
    scene:
      "Appetising food photograph, close tabletop scene with sparse props and honest crumb-level texture",
    finish: "fresh and edible-looking, warm neutral colour, no plastic sheen",
    camera: "mirrorless",
    lens: "natural-50",
    aperture: "f2.8",
    lighting: "window",
  },
  fashion: {
    scene:
      "Editorial fashion photograph, confident full-length pose with clean negative space around the figure",
    finish: "magazine-editorial grade, true skin tones, fabric weave still visible",
    camera: "dslr",
    lens: "portrait-85",
    aperture: "f2.8",
    lighting: "softbox",
  },
  lifestyle: {
    scene:
      "Candid lifestyle photograph, real people mid-moment in an unstaged everyday setting",
    finish: "authentic and lightly retouched, natural colour, a little movement left in the frame",
    camera: "mirrorless",
    lens: "reportage-35",
    aperture: "f2.8",
    lighting: "window",
  },
  architecture: {
    scene:
      "Architectural photograph with strictly vertical lines and a considered one-point composition",
    finish: "clean and geometric, corrected perspective, no lens distortion",
    camera: "dslr",
    lens: "wide-24",
    aperture: "f8",
    lighting: "golden-hour",
  },
};

/** The accepted ids, for the schema-drift test and for anything that lists them. */
export const IMAGE_LOOK_IDS = {
  preset: Object.keys(PRESETS),
  camera: Object.keys(CAMERAS),
  lens: Object.keys(LENSES),
  aperture: Object.keys(APERTURES),
  lighting: Object.keys(LIGHTING),
} as const;

/** `undefined` for a blank/absent id so the `??` chain falls through to the preset. */
function phrase(table: Record<string, string>, id: string | null | undefined): string | undefined {
  return id ? table[id] : undefined;
}

/**
 * Fold the tenant's brief and their pill choices into one prompt.
 *
 * Pills override the preset's gear rather than adding to it, and every axis is
 * independent: a lens with no preset is still useful direction, so it is still
 * compiled. With nothing chosen the brief comes back untouched — the whole
 * feature stays invisible to tenants who never open the Look row.
 *
 * The brand kit, taste pass and reference guide are layered on later by
 * `performImageGeneration`; this only writes the photography.
 */
export function compileImagePrompt(
  userPrompt: string,
  recipe?: ImagePromptRecipe | null,
): string {
  const brief = userPrompt.trim();
  const preset = recipe?.preset ? PRESETS[recipe.preset] : undefined;
  const camera = phrase(CAMERAS, recipe?.camera) ?? phrase(CAMERAS, preset?.camera);
  const lens = phrase(LENSES, recipe?.lens) ?? phrase(LENSES, preset?.lens);
  const aperture = phrase(APERTURES, recipe?.aperture) ?? phrase(APERTURES, preset?.aperture);
  const lighting = phrase(LIGHTING, recipe?.lighting) ?? phrase(LIGHTING, preset?.lighting);

  const sentences: string[] = [];
  if (preset) sentences.push(preset.scene);
  const gear = [camera && `on ${camera}`, lens && `with ${lens}`, aperture && `at ${aperture}`]
    .filter(Boolean)
    .join(" ");
  if (gear) sentences.push(`Shot ${gear}`);
  if (lighting) sentences.push(lighting);
  if (preset) sentences.push(`Overall: ${preset.finish}`);
  if (sentences.length === 0) return brief;

  const head = brief && !/[.!?]$/.test(brief) ? `${brief}.` : brief;
  return [head, ...sentences.map((s) => `${s}.`)].filter(Boolean).join(" ");
}
