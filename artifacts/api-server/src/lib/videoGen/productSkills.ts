import type {
  GuidedStoryAdSkill,
  GuidedStoryAdSkillLook,
  GuidedStoryAdSkillModel,
  GuidedStoryProductChoices,
  GuidedStoryShot,
} from "@workspace/db";

/**
 * Ad skills: category presets layered on a Product hero story.
 *
 * A skill changes how the ad is written and filmed for one kind of product
 * (shot grammar, lighting, pacing, fidelity rules, who wears it) without
 * touching the Product hero engine underneath. "general" is the plain
 * Product hero ad and stores nothing.
 *
 * Adding a category: add its id to GuidedStoryAdSkill["id"], a SKILLS entry
 * here, and an option in the setup picker.
 */

export const AD_SKILL_IDS = ["jewellery"] as const;
export const AD_SKILL_LOOKS: readonly GuidedStoryAdSkillLook[] = ["bridal", "festive", "everyday", "minimal"];
export const AD_SKILL_MODELS: readonly GuidedStoryAdSkillModel[] = ["cast", "body_only", "none"];

export const DEFAULT_AD_SKILL_LOOK: GuidedStoryAdSkillLook = "everyday";
export const DEFAULT_AD_SKILL_MODEL: GuidedStoryAdSkillModel = "cast";

export type AdSkillSelectionInput = {
  id: string;
  look?: string | null;
  model?: string | null;
};

type SkillDefinition = {
  label: string;
  /** Default share of runtime with the product on screen. */
  heroShare: number;
  /** Which product photo macro and texture shots prefer when none is chosen. */
  macroView: "detail" | "label";
  scriptRules: (skill: GuidedStoryAdSkill) => string[];
  shotClause: (skill: GuidedStoryAdSkill, shot: GuidedStoryShot | null | undefined) => string;
  /** Replaces the generic "label stays identical" closing line. */
  fidelityLine: string;
};

const JEWELLERY_LOOK_TEXT: Record<GuidedStoryAdSkillLook, string> = {
  bridal:
    "Bridal look: rich silk and velvet in deep red, maroon and gold, temple or palace textures, warm candle and diya glow, traditional styling and mehendi hands.",
  festive:
    "Festive look: marigold and jasmine accents, brass lamps, warm golden light with soft bokeh, celebratory but uncluttered.",
  everyday:
    "Everyday-luxe look: soft daylight, cream linen, marble or light wood surfaces, a modern working woman's styling, effortless and premium.",
  minimal:
    "Minimal look: seamless matte backdrop in one muted tone, a single pedestal or acrylic stand, lots of negative space, gallery-clean.",
};

const JEWELLERY_MODEL_RULES: Record<GuidedStoryAdSkillModel, string> = {
  cast:
    "Who wears it: the story's cast. Give at least two scenes where a character wears the piece (necklace on the neck, earrings with a hair tuck, ring on a hand gesture, bangles with a wrist turn), framed tight on the jewellery.",
  body_only:
    "Who wears it: an anonymous model shown only as a body crop — neck and collarbone, ear and jawline, hand, wrist. The face is never visible. Product scenes have an empty roleIds list and narration only.",
  none:
    "Who wears it: nobody. Every scene is product-only with no people and no hands: display bust, velvet tray, open jewellery box, mirror, pedestal. Every scene has an empty roleIds list and narration only.",
};

const JEWELLERY_SHOT_EXTRA: Partial<Record<GuidedStoryShot["type"], string>> = {
  macro_closeup: "Macro on the stones and setting: individual facets, prongs, filigree and hallmark crisp.",
  texture: "Metal texture in close detail: gold grain, engraving, meenakari or polish catching the light.",
  in_hand: "Fingertips lift and turn the piece slowly so it catches the light from several sides.",
  in_use: "The piece being worn, cropped tight to where it sits (neck, ear, finger or wrist).",
  character_with_product: "The jewellery is worn and stays the sharpest, brightest thing in frame; the face is soft or partly out of frame.",
  hero_shot: "The piece alone on a velvet bust, tray or pedestal, centred with generous space around it.",
  product_only: "No people; the piece rests on velvet, silk, marble or inside an opening jewellery box.",
};

const SKILLS: Record<GuidedStoryAdSkill["id"], SkillDefinition> = {
  jewellery: {
    label: "Jewellery & Accessories",
    heroShare: 0.8,
    macroView: "detail",
    scriptRules: (skill) => [
      "Ad skill: JEWELLERY & ACCESSORIES. This is a luxury jewellery commercial. It sells through detail and shine, not through talk.",
      "Pacing is slow and graceful: fewer, longer shots (3–5 seconds each), smooth camera moves, no jump cuts.",
      "Keep spoken words minimal: a short narration hook, at most one line per scene, and a brief call to action. Silence over music is fine.",
      "Build the video from: macro close-ups of stones and setting, 360° orbit or turntable turns, light sweeps that make the stones sparkle, slow rack focus, on-body shots where it is worn, and an opening-box or reveal moment.",
      "Prefer rim light, light sweep, backlit glow and studio key on dark or rich backgrounds; avoid flat lighting.",
      JEWELLERY_LOOK_TEXT[skill.look],
      JEWELLERY_MODEL_RULES[skill.model],
      "For close-ups prefer the detail photo; use the in-use photo for worn shots when it exists.",
    ],
    shotClause: (skill, shot) =>
      [
        "Luxury jewellery commercial cinematography: specular highlights and sparkle on stones and metal, deep rich blacks, shallow depth of field.",
        shot ? JEWELLERY_SHOT_EXTRA[shot.type] ?? "" : "",
        JEWELLERY_LOOK_TEXT[skill.look],
        skill.model === "body_only"
          ? "If a person appears, show only a body crop (neck, ear, hand or wrist); the face is never in frame."
          : skill.model === "none"
            ? "No people and no hands anywhere in frame."
            : "",
      ]
        .filter(Boolean)
        .join(" "),
    fidelityLine:
      "The jewellery's exact design stays identical to its reference photo for the entire shot: same metal colour, motif, stone count, stone colours, setting and proportions. Never add, remove or restyle stones or patterns.",
  },
};

export function isAdSkillId(value: unknown): value is GuidedStoryAdSkill["id"] {
  return typeof value === "string" && (AD_SKILL_IDS as readonly string[]).includes(value);
}

/**
 * Normalise a requested skill. Unknown ids and "general" mean no skill;
 * unknown looks and models fall back to the defaults.
 */
export function normalizeAdSkill(input: AdSkillSelectionInput | null | undefined): GuidedStoryAdSkill | null {
  if (!input || !isAdSkillId(input.id)) return null;
  const look = (AD_SKILL_LOOKS as readonly string[]).includes(input.look ?? "")
    ? (input.look as GuidedStoryAdSkillLook)
    : DEFAULT_AD_SKILL_LOOK;
  const model = (AD_SKILL_MODELS as readonly string[]).includes(input.model ?? "")
    ? (input.model as GuidedStoryAdSkillModel)
    : DEFAULT_AD_SKILL_MODEL;
  return { id: input.id, look, model };
}

/** The skill in force: only on a Product hero story with products. */
export function activeAdSkill(products: GuidedStoryProductChoices | null | undefined): GuidedStoryAdSkill | null {
  if (products?.promotion !== "hero" || !products.items?.length || !products.adSkill) return null;
  return normalizeAdSkill(products.adSkill);
}

export function adSkillLabel(skill: GuidedStoryAdSkill): string {
  return SKILLS[skill.id].label;
}

export function adSkillDefaultHeroShare(skill: GuidedStoryAdSkill | null): number | null {
  return skill ? SKILLS[skill.id].heroShare : null;
}

export function adSkillScriptRules(products: GuidedStoryProductChoices | null | undefined): string[] {
  const skill = activeAdSkill(products);
  return skill ? SKILLS[skill.id].scriptRules(skill) : [];
}

export function adSkillShotClause(skill: GuidedStoryAdSkill | null | undefined, shot: GuidedStoryShot | null | undefined): string {
  return skill ? SKILLS[skill.id].shotClause(skill, shot) : "";
}

export function adSkillFidelityLine(skill: GuidedStoryAdSkill | null | undefined): string | null {
  return skill ? SKILLS[skill.id].fidelityLine : null;
}

export function adSkillMacroView(skill: GuidedStoryAdSkill | null | undefined): "detail" | "label" {
  return skill ? SKILLS[skill.id].macroView : "label";
}

/** No people may appear in any scene: cast is dropped from every scene. */
export function adSkillForbidsCast(skill: GuidedStoryAdSkill | null | undefined): boolean {
  return skill?.model === "none";
}

/** Faces never appear; any person is an anonymous body crop. */
export function adSkillFacelessProduct(skill: GuidedStoryAdSkill | null | undefined): boolean {
  return skill?.model === "body_only" || skill?.model === "none";
}
