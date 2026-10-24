import type {
  BrandProductAngleView,
  GuidedStoryCameraMove,
  GuidedStoryLighting,
  GuidedStoryProductChoices,
  GuidedStoryProductReference,
  GuidedStoryScript,
  GuidedStoryShot,
  GuidedStoryShotType,
} from "@workspace/db";

/**
 * Product-hero Guided Stories.
 *
 * When a product is attached as the hero, the product is the subject of the
 * video and the story serves it: most of the runtime shows the product —
 * close-ups, in hand, in use, orbiting on a pedestal — with named camera
 * moves and lighting, using the photo of the angle each shot needs.
 */

export const SHOT_TYPES: readonly GuidedStoryShotType[] = [
  "macro_closeup",
  "hero_shot",
  "in_hand",
  "in_use",
  "texture",
  "product_only",
  "character_with_product",
  "story_wide",
];
export const CAMERA_MOVES: readonly GuidedStoryCameraMove[] = [
  "orbit",
  "push_in",
  "pull_out",
  "slide",
  "top_down",
  "tilt_reveal",
  "rack_focus",
  "static",
];
export const LIGHTING: readonly GuidedStoryLighting[] = [
  "studio_key",
  "rim_light",
  "backlit_glow",
  "window_light",
  "light_sweep",
  "golden_hour",
];
export const ANGLE_VIEWS: readonly BrandProductAngleView[] = [
  "front",
  "back",
  "side",
  "top",
  "label",
  "detail",
  "in_use",
  "packaging",
];

export const DEFAULT_HERO_SHARE = 0.7;
export const MIN_HERO_SHARE = 0.4;
export const MAX_HERO_SHARE = 0.8;
/**
 * Below this share the ad is character-led: the cast stays on screen with the
 * product (comedy, drama, slice-of-life ads) instead of product-only B-roll.
 */
export const CHARACTER_LED_BELOW = 0.6;
/** Below this share the script is repaired once, then warned. */
export const HERO_SHARE_TOLERANCE = 0.05;
/** One main photo plus extra angles. */
export const MAX_PRODUCT_PHOTOS = 5;

/** Shots where the product is the subject. story_wide is the only exception. */
export const PRODUCT_FOCUS_SHOTS: readonly GuidedStoryShotType[] = SHOT_TYPES.filter(
  (type) => type !== "story_wide",
);

/** Shots that should not show a face: the product fills the frame. */
const PRODUCT_ONLY_SHOTS: readonly GuidedStoryShotType[] = ["macro_closeup", "texture", "product_only", "hero_shot"];

const SHOT_TEXT: Record<GuidedStoryShotType, string> = {
  macro_closeup: "Extreme macro close-up of the product filling most of the frame; label, texture and finish razor sharp.",
  hero_shot: "Hero product shot: the product alone, centred on a clean surface or pedestal, premium commercial framing.",
  in_hand: "Close shot of the product held in hand, turned slowly to show it from several sides; hands only or the face soft in the background.",
  in_use: "The product being used or applied, shown close enough to see exactly how it works.",
  texture: "Texture shot: the product's contents, material or surface in close detail (pour, swatch, drop, fabric, crumb).",
  product_only: "Product-only B-roll: no people in frame, the product is the sole subject.",
  character_with_product: "The character interacts with the product; the product stays large in frame and in sharp focus.",
  story_wide: "Wider story shot that sets context; the product is visible in the scene.",
};

const CAMERA_TEXT: Record<GuidedStoryCameraMove, string> = {
  orbit: "Smooth 180–360° orbit around the product.",
  push_in: "Slow push-in toward the product.",
  pull_out: "Slow pull-out revealing the product in context.",
  slide: "Gentle lateral slide past the product.",
  top_down: "Top-down overhead angle on the product.",
  tilt_reveal: "Tilt up from below to reveal the product.",
  rack_focus: "Rack focus from the foreground to the product.",
  static: "Locked-off camera; only the product or hands move.",
};

const LIGHTING_TEXT: Record<GuidedStoryLighting, string> = {
  studio_key: "Clean studio key light with soft fill, crisp highlights on the product.",
  rim_light: "Rim light outlining the product's silhouette against a darker background.",
  backlit_glow: "Backlit glow through or around the product.",
  window_light: "Soft natural window light.",
  light_sweep: "A slow light sweep gliding across the product and its label.",
  golden_hour: "Warm golden-hour light.",
};

const ANGLE_TEXT: Record<BrandProductAngleView, string> = {
  front: "front",
  back: "back",
  side: "side",
  top: "top",
  label: "label close-up",
  detail: "detail",
  in_use: "in-use",
  packaging: "packaging",
};

export function clampHeroShare(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : DEFAULT_HERO_SHARE;
  return Math.round(Math.min(MAX_HERO_SHARE, Math.max(MIN_HERO_SHARE, n)) * 100) / 100;
}

export function isProductHero(products: GuidedStoryProductChoices | null | undefined): boolean {
  return products?.promotion === "hero" && (products.items?.length ?? 0) > 0;
}

/** Product hero with a 40–50% target: characters carry the product scenes. */
export function isCharacterLedHero(products: GuidedStoryProductChoices | null | undefined): boolean {
  return isProductHero(products) && clampHeroShare(products!.heroShare) < CHARACTER_LED_BELOW;
}

/** How the one-shot screen-time rework may change scenes. */
export function heroReworkInstruction(products: GuidedStoryProductChoices): string {
  const keep =
    "Keep every scene's id, startMs, endMs and lines exactly, the cast, and the story's meaning. Change only visualDirection, roleIds, productIds and shot.";
  return isCharacterLedHero(products)
    ? `${keep} Turn context scenes into character_with_product, in_hand or in_use shots where the characters handle, use or react to the product while the same words are spoken; keep each scene's speakers in roleIds. Do not turn dialogue scenes into product-only shots.`
    : `${keep} Turn context scenes into close-ups, in-hand, in-use, texture or product-only shots of the product while the same words are spoken. A product-only scene must have an empty roleIds and narration-only lines; if a scene has dialogue, keep its speaker in roleIds and use in_hand, in_use or character_with_product.`;
}

/** Views available for a frozen product: main photo plus its angles. */
export function productViews(item: Pick<GuidedStoryProductReference, "angles">): BrandProductAngleView[] {
  return ["front", ...(item.angles ?? []).map((angle) => angle.view).filter((view) => view !== "front")];
}

/** Format-only parse of a model's shot; null when unusable. */
export function parseShot(value: unknown): GuidedStoryShot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const pick = <T extends string>(field: unknown, allowed: readonly T[], fallback: T | null): T | null => {
    const text = typeof field === "string" ? field.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
    return (allowed as readonly string[]).includes(text) ? (text as T) : fallback;
  };
  const type = pick(raw.type, SHOT_TYPES, null);
  if (!type) return null;
  return {
    type,
    camera: pick(raw.camera, CAMERA_MOVES, "static")!,
    lighting: pick(raw.lighting, LIGHTING, "studio_key")!,
    angle: pick(raw.angle, ANGLE_VIEWS, null),
  };
}

/** Seconds and share of the runtime where a scene shows a product as its subject. */
export function productScreenTime(script: GuidedStoryScript): { seconds: number; share: number; runtime: number } {
  const runtime = script.scenes.reduce((sum, scene) => sum + (scene.endMs - scene.startMs), 0) / 1000;
  const seconds =
    script.scenes
      .filter((scene) => (scene.productIds?.length ?? 0) > 0 && (!scene.shot || PRODUCT_FOCUS_SHOTS.includes(scene.shot.type)))
      .reduce((sum, scene) => sum + (scene.endMs - scene.startMs), 0) / 1000;
  return {
    seconds: Math.round(seconds * 10) / 10,
    share: runtime > 0 ? Math.round((seconds / runtime) * 100) / 100 : 0,
    runtime: Math.round(runtime * 10) / 10,
  };
}

export function heroShareShortfall(script: GuidedStoryScript, products: GuidedStoryProductChoices | null | undefined): boolean {
  if (!isProductHero(products)) return false;
  return productScreenTime(script).share + 1e-9 < clampHeroShare(products!.heroShare) - HERO_SHARE_TOLERANCE;
}

export function heroShareWarning(target: number, share: number): string {
  return `${PRODUCT_HERO_WARNING_PREFIX}${Math.round(share * 100)}% of the video shows the product; the target is ${Math.round(target * 100)}%. Tag more scenes with the product or regenerate.`;
}
export const PRODUCT_HERO_WARNING_PREFIX = "Product screen time is low: ";

/** Adds or clears the low-screen-time warning; never blocks approval. */
export function withProductHeroWarnings(
  script: GuidedStoryScript,
  products: GuidedStoryProductChoices | null | undefined,
): GuidedStoryScript {
  const kept = script.warnings.filter((warning) => !warning.startsWith(PRODUCT_HERO_WARNING_PREFIX));
  const warnings = heroShareShortfall(script, products)
    ? [...kept, heroShareWarning(clampHeroShare(products!.heroShare), productScreenTime(script).share)]
    : kept;
  return warnings.length === script.warnings.length && warnings.every((warning, i) => warning === script.warnings[i])
    ? script
    : { ...script, warnings };
}

/**
 * Drop shots on scripts that are not product-hero, and drop shot angles the
 * product has no photo for. Absent keys stay absent so legacy scripts match.
 */
export function sanitizeShots(
  script: GuidedStoryScript,
  products: GuidedStoryProductChoices | null | undefined,
): GuidedStoryScript {
  const hero = isProductHero(products);
  const byId = new Map((products?.items ?? []).map((item) => [item.id, item]));
  let changed = false;
  const scenes = script.scenes.map((scene) => {
    if (!scene.shot) return scene;
    if (!hero) {
      changed = true;
      const { shot: _drop, ...rest } = scene;
      return rest;
    }
    const first = scene.productIds?.map((id) => byId.get(id)).find(Boolean);
    if (scene.shot.angle && first && !productViews(first).includes(scene.shot.angle)) {
      changed = true;
      return { ...scene, shot: { ...scene.shot, angle: null } };
    }
    return scene;
  });
  return changed ? { ...script, scenes } : script;
}

/**
 * Brief for the screenplay planner in product-hero mode. Product text is data;
 * the rules are instructions.
 */
export function productHeroScriptRules(products: GuidedStoryProductChoices): string[] {
  const target = clampHeroShare(products.heroShare);
  const percent = Math.round(target * 100);
  const views = products.items
    .map((item) => `${item.id}: photos of ${productViews(item).map((view) => ANGLE_TEXT[view]).join(", ")}`)
    .join("; ");
  const lead = isCharacterLedHero(products)
    ? [
        "Promotion level: PRODUCT HERO, CHARACTER-LED. This is a product advertisement told through the characters: the story and the genre's tone stay intact, and the product is the turning point of that story.",
        `At least ${percent}% of the total runtime must be scenes whose subject is the product (tag them in productIds). Use the rest for the setup, the characters' reactions and the payoff.`,
        "Keep the characters on screen in product scenes: prefer character_with_product, in_hand and in_use shots, with the speaking characters in roleIds, so dialogue, reactions and comic timing run through the product moments.",
        "Use at most one product-only, macro or texture shot, and only as a short beat (for example a reveal or the final hero shot). Leave room for setup and reaction beats; do not pack every scene with the product.",
      ]
    : [
        "Promotion level: PRODUCT HERO. This is a product advertisement. The product is the subject of the video; the characters and story exist to show it off.",
        `At least ${percent}% of the total runtime must be scenes whose subject is the product (tag them in productIds). Use the rest for a short hook, context and the call to action.`,
        "Show the product from different angles across the video: macro close-ups, in hand being turned, in use, texture details, a clean hero shot, and product-only B-roll with no people.",
      ];
  return [
    ...lead,
    "Product-only scenes have an empty roleIds list and use narration only. Close-ups may show hands without a face.",
    "Never repeat the same shot type twice in a row; vary camera moves and lighting from scene to scene.",
    `Give every scene a shot object: {"type": one of ${SHOT_TYPES.join("|")}, "camera": one of ${CAMERA_MOVES.join("|")}, "lighting": one of ${LIGHTING.join("|")}, "angle": which product photo it shows, one of ${ANGLE_VIEWS.join("|")} or null}.`,
    `Only choose angles that have a photo (${views}). Describe the shot, camera and lighting in that scene's visualDirection too.`,
    "End on a hero shot of the product with the call to action.",
  ];
}

/** Which frozen photo a scene should use for a product, from its shot angle. */
export function chooseProductImage(
  item: Pick<GuidedStoryProductReference, "imagePath" | "imageSha256" | "angles">,
  shot: GuidedStoryShot | null | undefined,
): { imagePath: string; imageSha256: string; view: BrandProductAngleView } {
  const wanted = shot?.angle ?? (shot?.type === "macro_closeup" || shot?.type === "texture" ? "label" : null);
  const match = wanted && wanted !== "front" ? item.angles?.find((angle) => angle.view === wanted) : undefined;
  return match
    ? { imagePath: match.imagePath, imageSha256: match.imageSha256, view: match.view }
    : { imagePath: item.imagePath, imageSha256: item.imageSha256, view: "front" };
}

/**
 * Product-first framing for one scene: the shot, camera, lighting and focus
 * instructions that make the product the subject.
 */
export function productHeroShotClause(params: {
  shot: GuidedStoryShot | null | undefined;
  productNames: string[];
  castCount: number;
}): string {
  if (!params.productNames.length) return "";
  const name = params.productNames.length === 1 ? `"${params.productNames[0]}"` : params.productNames.map((n) => `"${n}"`).join(" and ");
  const shot = params.shot;
  const parts = [
    `The product ${name} is the subject of this shot: largest and sharpest thing in frame, shallow depth of field, background softly blurred, label legible.`,
    shot ? SHOT_TEXT[shot.type] : SHOT_TEXT.character_with_product,
    shot ? CAMERA_TEXT[shot.camera] : "",
    shot ? LIGHTING_TEXT[shot.lighting] : LIGHTING_TEXT.studio_key,
    shot?.angle && shot.angle !== "front" ? `Show the product's ${ANGLE_TEXT[shot.angle]}.` : "",
  ];
  if (params.castCount === 0 || (shot && PRODUCT_ONLY_SHOTS.includes(shot.type))) {
    parts.push(params.castCount === 0 ? "No people in frame; hands may appear only if the action needs them." : "Faces stay out of focus or out of frame.");
  }
  return parts.filter(Boolean).join(" ");
}

export function shotLabel(shot: GuidedStoryShot): string {
  return `${shot.type.replace(/_/g, " ")} · ${shot.camera.replace(/_/g, " ")} · ${shot.lighting.replace(/_/g, " ")}`;
}
