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

/** The product text a skill reads to tell what kind of piece it is. Data, not instructions. */
export type AdSkillProductText = {
  name: string;
  description?: string | null;
  aiDescription?: string | null;
};

type SkillDefinition = {
  label: string;
  /** Default share of runtime with the product on screen. */
  heroShare: number;
  /** Which product photo macro and texture shots prefer when none is chosen. */
  macroView: "detail" | "label";
  scriptRules: (skill: GuidedStoryAdSkill, products: readonly AdSkillProductText[]) => string[];
  shotClause: (
    skill: GuidedStoryAdSkill,
    shot: GuidedStoryShot | null | undefined,
    products: readonly AdSkillProductText[],
  ) => string;
  /** Replaces the generic "label stays identical" closing line. */
  fidelityLine: string;
  /** Replaces "keep its packaging and label legible" when the product is described. */
  keepText: string;
  /** Replaces the cast lock line; null keeps the generic one. */
  castLockLine: string | null;
};

/* ---------------------------------------------------------------- jewellery */

export type JewelleryCategory =
  | "set"
  | "necklace"
  | "earrings"
  | "nose"
  | "maang_tikka"
  | "ring"
  | "bangles"
  | "anklet"
  | "waist";

/**
 * Category words, English and common Indian names. On a tie (same position)
 * the earlier entry wins, so "necklace set" is a set and "nose ring" is not a ring.
 */
const JEWELLERY_CATEGORY_PATTERNS: ReadonlyArray<[JewelleryCategory, RegExp]> = [
  ["set", /\b(?:(?:bridal|jewell?e?ry|necklace|choker|haram)\s+sets?|parure)\b/],
  ["nose", /\b(?:nath|nathni|nose\s*(?:rings?|pins?|studs?)|mookuthi|mukkupudaka)\b/],
  ["maang_tikka", /\b(?:maang\s*tikk?a|tikk?a|matha\s*patti|borla|papidi\s*billa)\b/],
  ["anklet", /\b(?:anklets?|payal|pajeb|kolusu|pattilu|toe\s*rings?|metti|mettelu)\b/],
  ["waist", /\b(?:kamar\s*bandh?|vaddanam|oddiyanam|odiyanam|waist\s*(?:belt|chain|band)s?|hip\s*chains?)\b/],
  ["earrings", /\b(?:ear\s*rings?|jhumk[ai]s?|studs?|chand\s*balis?|hoops?|ear\s*cuffs?|danglers?|bugadi|kammal|buttalu|kammalu)\b/],
  ["necklace", /\b(?:necklaces?|neckpiece|haar|haram|choker|mangalsutra|pendants?|chains?|lockets?|kanthi|guttapusalu|kasu\s*mala|mala|nakshi)\b/],
  ["bangles", /\b(?:bangles?|kad[ae]s?|kada|bracelets?|kangan|kangans?|chud[ai]|gajulu|vala)\b/],
  ["ring", /\b(?:rings?|ungaram)\b/],
];

function categoryIn(text: string): JewelleryCategory | null {
  let best: { category: JewelleryCategory; index: number } | null = null;
  for (const [category, pattern] of JEWELLERY_CATEGORY_PATTERNS) {
    const match = pattern.exec(text);
    if (match && (!best || match.index < best.index)) best = { category, index: match.index };
  }
  return best?.category ?? null;
}

/**
 * What kind of piece a product is, from its name first, then the owner's
 * description, then the AI photo description. Null when nothing matches.
 */
export function jewelleryCategory(product: AdSkillProductText): JewelleryCategory | null {
  for (const text of [product.name, product.description, product.aiDescription]) {
    const found = categoryIn((text ?? "").toLowerCase());
    if (found) return found;
  }
  return null;
}

type CategoryText = {
  label: string;
  /** How the worn shot is framed. */
  worn: string;
  /** Wearer styling that keeps the piece visible. */
  styling: string;
  /** How it sits when nobody wears it. */
  display: string;
};

const JEWELLERY_CATEGORY_TEXT: Record<JewelleryCategory, CategoryText> = {
  set: {
    label: "jewellery set",
    worn: "worn as a full set, framed from the face to the chest, then piece by piece",
    styling: "an open neckline, hair tucked behind the ears and bare wrists so every piece shows",
    display: "laid out together on a velvet bust or inside an open jewellery box",
  },
  necklace: {
    label: "necklace",
    worn: "worn on the neck, framed from the jawline to the collarbone and chest",
    styling: "an open or boat neckline with nothing covering the necklace, the pallu or dupatta draped away from the neck, hair off the shoulders",
    display: "on a velvet neck bust or laid in a curve on silk",
  },
  earrings: {
    label: "earrings",
    worn: "worn on the ear, framed on the ear, jawline and neck in profile or three-quarter view",
    styling: "hair tucked behind the ear or tied up so the earrings hang free",
    display: "hung from an earring stand or resting as a pair on velvet",
  },
  nose: {
    label: "nose ornament",
    worn: "worn on the nose, framed as a soft three-quarter close-up of the face",
    styling: "hair pulled back and light makeup so the face line stays clean",
    display: "on a small velvet pad or inside an open ring box",
  },
  maang_tikka: {
    label: "maang tikka",
    worn: "worn at the hair parting on the forehead, framed on the brow and hairline",
    styling: "a clean centre parting with hair pulled back and nothing draped over the forehead",
    display: "laid along a velvet bust's hairline or on folded silk",
  },
  ring: {
    label: "ring",
    worn: "worn on the finger, framed on a graceful relaxed hand",
    styling: "bare hands with neat nails in a nude or deep red shade and no other rings on that hand",
    display: "on a ring cone or inside an open ring box",
  },
  bangles: {
    label: "bangles",
    worn: "worn on the wrist, framed on the forearm and hand",
    styling: "short, elbow-length or sheer sleeves so the wrists are bare",
    display: "stacked on a bangle stand or a velvet roll",
  },
  anklet: {
    label: "anklet",
    worn: "worn on the ankle or toes, framed low on the foot",
    styling: "the saree or lehenga hem lifted above the ankle, bare feet or minimal sandals",
    display: "draped over a smooth stone or laid on silk",
  },
  waist: {
    label: "waist belt",
    worn: "worn at the waist, framed on the waist and hip",
    styling: "a saree or half-saree drape that keeps the waistline visible",
    display: "laid in a curve on silk or wrapped around a velvet form",
  },
};

function jewelleryPieces(products: readonly AdSkillProductText[]): Array<{ name: string; text: CategoryText }> {
  return products.flatMap((product) => {
    const category = jewelleryCategory(product);
    return category
      ? [{ name: product.name.replace(/["\n\r]/g, " ").trim(), text: JEWELLERY_CATEGORY_TEXT[category] }]
      : [];
  });
}

const JEWELLERY_LOOK_TEXT: Record<GuidedStoryAdSkillLook, string> = {
  bridal:
    "Bridal look: rich silk and velvet in deep red, maroon and gold, heritage temple or palace textures, traditional bridal styling and mehendi hands. Light: warm candle and diya glow with a soft golden key.",
  festive:
    "Festive look: marigold and jasmine accents, brass lamps, celebratory but uncluttered. Light: warm golden light with soft bokeh from the lamps.",
  everyday:
    "Everyday-luxe look: cream linen, marble or light wood surfaces, a modern working woman's styling, effortless and premium. Light: soft diffused daylight from a window, bright and airy, no harsh shadows.",
  minimal:
    "Minimal look: seamless matte backdrop in one muted tone, a single pedestal or acrylic stand, lots of negative space, gallery-clean. Light: one muted soft key with controlled reflections; deep shadows are welcome.",
};

const JEWELLERY_MODEL_RULES: Record<GuidedStoryAdSkillModel, string> = {
  cast:
    "Who wears it: the story's cast. Give at least two scenes where a character wears the piece, framed tight on the jewellery, plus one half-body beauty shot where the face is visible but soft and the jewellery is the sharpest thing in frame.",
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

/** Shot types where the piece is worn, or sits alone on display. */
const WORN_SHOTS: readonly GuidedStoryShot["type"][] = ["in_use", "character_with_product"];
const DISPLAY_SHOTS: readonly GuidedStoryShot["type"][] = ["hero_shot", "product_only"];

function jewelleryShotExtra(
  skill: GuidedStoryAdSkill,
  shot: GuidedStoryShot | null | undefined,
  products: readonly AdSkillProductText[],
): string {
  if (!shot) return "";
  const piece = jewelleryPieces(products)[0];
  if (piece && skill.model !== "none" && WORN_SHOTS.includes(shot.type)) {
    const lead =
      shot.type === "character_with_product"
        ? "The jewellery is worn and stays the sharpest, brightest thing in frame; the face is soft or partly out of frame."
        : "The piece being worn.";
    return `${lead} The ${piece.text.label} is ${piece.text.worn}. Styling: ${piece.text.styling}.`;
  }
  if (piece && DISPLAY_SHOTS.includes(shot.type)) {
    return `${JEWELLERY_SHOT_EXTRA[shot.type]} The ${piece.text.label} sits ${piece.text.display}.`;
  }
  return JEWELLERY_SHOT_EXTRA[shot.type] ?? "";
}

const JEWELLERY_MOTION: Record<GuidedStoryAdSkillModel, string> = {
  cast:
    "Keep it alive with natural micro-motion: a slow breath, earrings swaying gently, the pallu or fabric drifting, a soft hand gesture, a pause and a glance. Never a frozen mannequin pose.",
  body_only:
    "Keep it alive with natural micro-motion: a slow breath, earrings swaying gently, fabric drifting, a soft hand or wrist turn. Never a frozen mannequin pose.",
  none:
    "Keep it alive: light glides across the piece, the stand turns slowly, silk or petals drift softly in the background. Never a frozen still.",
};

const JEWELLERY_REALISM =
  "Photoreal: real metal grain and true reflections, natural skin texture, no CGI or plastic sheen, no glow or bloom haloing the stones.";

const SKILLS: Record<GuidedStoryAdSkill["id"], SkillDefinition> = {
  jewellery: {
    label: "Jewellery & Accessories",
    heroShare: 0.8,
    macroView: "detail",
    scriptRules: (skill, products) => [
      "Ad skill: JEWELLERY & ACCESSORIES. This is a luxury jewellery commercial. It sells through detail and shine, not through talk.",
      "Pacing is slow and graceful: fewer, longer shots (3–5 seconds each), smooth camera moves, no jump cuts.",
      "Keep spoken words minimal: a short narration hook, at most one line per scene, and a brief call to action. Silence over music is fine.",
      "Build the video from: macro close-ups of stones and setting, 360° orbit or turntable turns, light sweeps that make the stones sparkle, slow rack focus, on-body shots where it is worn, and an opening-box or reveal moment.",
      "Light within the look below, and always give the stones and metal small crisp highlights (a light sweep or rim on the metal); avoid flat, shadowless light.",
      JEWELLERY_LOOK_TEXT[skill.look],
      JEWELLERY_MODEL_RULES[skill.model],
      ...jewelleryPieces(products).map(({ name, text }) =>
        skill.model === "none"
          ? `"${name}" is a ${text.label}: display it ${text.display}.`
          : `"${name}" is a ${text.label}: show it ${text.worn}. Choose the wearer's styling to show it off: ${text.styling}. If the outfit is fixed, change only the drape, hair and framing.`,
      ),
      "Every scene should feel alive, not posed: describe small natural movement (breath, fabric drift, earrings swaying, a slow hand gesture or turn) in each visualDirection.",
      "For close-ups prefer the detail photo; use the in-use photo for worn shots when it exists.",
    ],
    shotClause: (skill, shot, products) =>
      [
        "Luxury jewellery commercial cinematography: crisp specular highlights and sparkle on stones and metal, shallow depth of field.",
        jewelleryShotExtra(skill, shot, products),
        JEWELLERY_LOOK_TEXT[skill.look],
        JEWELLERY_MOTION[skill.model],
        JEWELLERY_REALISM,
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
    keepText: "keep its design, metal colour, stones and proportions unchanged",
    castLockLine:
      "Every face, build and garment stays identical to the references for the entire shot; hair may only be tucked or pinned back, and a drape moved aside, to show the jewellery.",
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
  return skill ? SKILLS[skill.id].scriptRules(skill, products?.items ?? []) : [];
}

export function adSkillShotClause(
  skill: GuidedStoryAdSkill | null | undefined,
  shot: GuidedStoryShot | null | undefined,
  products: readonly AdSkillProductText[] = [],
): string {
  return skill ? SKILLS[skill.id].shotClause(skill, shot, products) : "";
}

/** How a described product is kept unchanged, when the skill has no label to keep legible. */
export function adSkillKeepText(skill: GuidedStoryAdSkill | null | undefined): string | null {
  return skill ? SKILLS[skill.id].keepText : null;
}

/** The skill's cast lock line, or null for the generic one. */
export function adSkillCastLockLine(skill: GuidedStoryAdSkill | null | undefined): string | null {
  return skill ? SKILLS[skill.id].castLockLine : null;
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
