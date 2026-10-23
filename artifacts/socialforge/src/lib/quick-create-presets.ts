/**
 * Quick Create starters. Each one only pre-fills the Quick Create form —
 * the prompt, length, shape and music — so a user can start from one tap.
 * They are deliberately plain data so admin-managed templates can replace
 * this list later without touching the page.
 */
export type QuickCreateVertical =
  | "fashion"
  | "product"
  | "service"
  | "doctor"
  | "ca";

export interface QuickCreatePreset {
  id: string;
  label: string;
  vertical: QuickCreateVertical;
  prompt: string;
  durationSec: number;
  aspect: "9:16" | "1:1" | "16:9";
  /** Shown as a hint on the photo step; the photo stays optional. */
  photoHint?: string;
  musicPrompt?: string;
  /** Who models the outfit when no model photo is given. */
  gender?: ModelGender;
  /** Kind of outfit: sets the backdrop and, in a reel, the moves. */
  wearStyle?: WearStyle;
}

export type ModelGender = "woman" | "man";
export type WearStyle = "ethnic" | "formal" | "casual";

export const WEAR_STYLES: { id: WearStyle; label: string }[] = [
  { id: "ethnic", label: "Ethnic" },
  { id: "formal", label: "Formal" },
  { id: "casual", label: "Casual" },
];

/** Same idea as presetGender: read the kind of outfit from the template. */
export function presetWearStyle(
  preset: Pick<QuickCreatePreset, "label" | "prompt" | "wearStyle">,
): WearStyle | null {
  if (preset.wearStyle) return preset.wearStyle;
  const text = `${preset.label} ${preset.prompt}`.toLowerCase();
  if (/\b(suit|blazer|formal|office|corporate|tuxedo|trousers)\b/.test(text)) return "formal";
  if (/\b(casual|jeans|t-?shirt|tee|hoodie|street|denim|sneakers)\b/.test(text)) return "casual";
  if (/\b(saree|kurta|sherwani|lehenga|ethnic|salwar|anarkali|dhoti|wedding|festive)\b/.test(text)) return "ethnic";
  return null;
}

/**
 * Admin-made templates carry no gender field, so read it from the name:
 * "Kurta for men", "Sherwani", "Groom" mean a male model. Anything else
 * leaves the current choice alone.
 */
export function presetGender(preset: Pick<QuickCreatePreset, "label" | "prompt" | "gender">): ModelGender | null {
  if (preset.gender) return preset.gender;
  const text = `${preset.label} ${preset.prompt}`.toLowerCase();
  if (/\b(men'?s|man|male|groom|sherwani|bandhgala|nehru jacket|he)\b/.test(text)) return "man";
  if (/\b(women'?s|woman|female|bride|saree|lehenga|she)\b/.test(text)) return "woman";
  return null;
}

export const QUICK_CREATE_VERTICALS: { id: QuickCreateVertical; label: string }[] = [
  { id: "fashion", label: "Fashion" },
  { id: "product", label: "Product" },
  { id: "service", label: "Service" },
  { id: "doctor", label: "Doctor" },
  { id: "ca", label: "CA" },
];

export const QUICK_CREATE_PRESETS: QuickCreatePreset[] = [
  {
    id: "saree-showcase",
    label: "Saree Showcase",
    vertical: "fashion",
    prompt:
      "A model wears this saree and sways gently to the music, small hand gestures, soft smile, full-body shot, static camera, pastel studio backdrop",
    durationSec: 10,
    aspect: "9:16",
    photoHint: "Add a photo of the saree",
    musicPrompt: "Soft Indian sitar and tabla, gentle and festive",
    gender: "woman",
    wearStyle: "ethnic",
  },
  {
    id: "kurta-showcase",
    label: "Kurta Showcase (Men)",
    vertical: "fashion",
    prompt:
      "A male model wears this kurta and walks confidently toward the camera, then turns to show the outfit, full-body shot, static camera, clean studio backdrop",
    durationSec: 10,
    aspect: "9:16",
    photoHint: "Add photos of the kurtas",
    musicPrompt: "Upbeat Indian fusion with dhol, confident",
    gender: "man",
    wearStyle: "ethnic",
  },
  {
    id: "sherwani-wedding",
    label: "Sherwani / Wedding (Men)",
    vertical: "fashion",
    prompt:
      "A groom wears this sherwani, stands tall, gives a warm namaste with a slight bow, then turns slowly to show the embroidery, full-body shot, warm festive studio light",
    durationSec: 10,
    aspect: "9:16",
    photoHint: "Add a photo of the sherwani",
    musicPrompt: "Grand shehnai and dhol, wedding celebration",
    gender: "man",
    wearStyle: "ethnic",
  },
  {
    id: "formal-menswear",
    label: "Formal / Office Wear (Men)",
    vertical: "fashion",
    prompt:
      "A male model in this formal outfit adjusts his cuff, slides a hand into his pocket and looks at the camera with quiet confidence, full-body shot, minimal grey studio",
    durationSec: 5,
    aspect: "9:16",
    photoHint: "Add a photo of the shirt, suit or blazer",
    musicPrompt: "Smooth, modern corporate lounge",
    gender: "man",
    wearStyle: "formal",
  },
  {
    id: "casual-showcase-men",
    label: "Casual Showcase (Men)",
    vertical: "fashion",
    prompt:
      "A male model in this casual outfit walks with an easy stride, smiles and relaxes into a natural pose, full-body shot, sunny street setting",
    durationSec: 10,
    aspect: "9:16",
    photoHint: "Add photos of the jeans, tees or jackets",
    musicPrompt: "Upbeat indie pop, feel-good",
    gender: "man",
    wearStyle: "casual",
  },
  {
    id: "outfit-twirl",
    label: "Outfit Reveal",
    vertical: "fashion",
    prompt:
      "A model wearing this outfit walks into frame, turns slowly to show the fabric, and smiles at the camera",
    durationSec: 5,
    aspect: "9:16",
    photoHint: "Add a photo of the outfit",
    musicPrompt: "Upbeat, modern Indian pop instrumental",
  },
  {
    id: "product-hero",
    label: "Product Hero",
    vertical: "product",
    prompt:
      "Slow cinematic close-up of this product on a clean pastel surface, soft light, gentle camera push-in",
    durationSec: 5,
    aspect: "9:16",
    photoHint: "Add a product photo",
    musicPrompt: "Minimal, calm, premium ambient",
  },
  {
    id: "unboxing",
    label: "Unboxing",
    vertical: "product",
    prompt:
      "Hands open a gift box and lift out this product, close-up, warm natural light",
    durationSec: 10,
    aspect: "9:16",
    photoHint: "Add a product photo",
  },
  {
    id: "salon-glow",
    label: "Salon Glow-up",
    vertical: "service",
    prompt:
      "A happy customer in a bright salon touches her freshly styled hair and smiles at the mirror",
    durationSec: 5,
    aspect: "9:16",
  },
  {
    id: "food-closeup",
    label: "Food Close-up",
    vertical: "service",
    prompt:
      "Steam rising from this dish, slow close-up, warm restaurant light, shallow depth of field",
    durationSec: 5,
    aspect: "9:16",
    photoHint: "Add a photo of the dish",
  },
  {
    id: "clinic-welcome",
    label: "Clinic Welcome",
    vertical: "doctor",
    prompt:
      "A calm, bright clinic reception with soft daylight, slow camera glide toward a welcoming front desk",
    durationSec: 5,
    aspect: "9:16",
    photoHint: "Optional: a photo of your clinic",
  },
  {
    id: "office-intro",
    label: "Office Intro",
    vertical: "ca",
    prompt:
      "A tidy, modern accounting office with natural light, slow pan across neatly arranged files and a laptop",
    durationSec: 5,
    aspect: "16:9",
    photoHint: "Optional: a photo of your office",
  },
];

export const QUICK_CREATE_LANGUAGES = [
  "None",
  "Hinglish",
  "Hindi",
  "English",
  "Telugu",
  "Tamil",
  "Kannada",
  "Malayalam",
  "Marathi",
  "Bengali",
  "Gujarati",
] as const;

export type QuickCreateLanguage = (typeof QUICK_CREATE_LANGUAGES)[number];

/**
 * The prompt actually sent: the user's sentence plus a short, readable
 * language line. Kept in one place so the page and its tests agree.
 */
export function buildQuickCreatePrompt(
  description: string,
  language: QuickCreateLanguage,
  music = "",
): string {
  const base = description.trim();
  if (!base) return "";
  const parts = [base];
  if (music.trim()) parts.push(`Background music: ${music.trim()}`);
  if (language !== "None") parts.push(`Any on-screen speech or text is in ${language}`);
  return parts.length === 1 ? base : `${parts.join(". ")}.`;
}

type CatalogModel = {
  id: string;
  provider: string;
  canGenerateAudio: boolean;
  providerModels?: Partial<Record<"text" | "image", string>>;
  models?: Partial<Record<"text" | "image", string>>;
  model?: string;
};
type CatalogChoice = { provider: string; model: string; modelId?: string | null } | null | undefined;
export type QuickCreateModelCatalog = {
  models?: CatalogModel[];
  defaults?: Partial<Record<"text" | "image", CatalogChoice>>;
  defaultTextToVideo?: CatalogChoice;
  defaultImageToVideo?: CatalogChoice;
};

/**
 * The admin-default model the server will use for this mode, so Quick Create
 * knows whether it renders sound itself. Music then rides in the prompt on
 * the video model's own audio instead of a separate music service.
 */
export function quickCreateDefaultModel(
  catalog: QuickCreateModelCatalog | undefined,
  mode: "text" | "image",
): CatalogModel | null {
  if (!catalog?.models) return null;
  const choice =
    catalog.defaults?.[mode] ??
    (mode === "text" ? catalog.defaultTextToVideo : catalog.defaultImageToVideo);
  if (!choice) return null;
  return (
    catalog.models.find((m) => choice.modelId != null && m.id === choice.modelId) ??
    catalog.models.find(
      (m) =>
        m.provider === choice.provider &&
        (m.providerModels?.[mode] ?? m.models?.[mode] ?? m.model ?? m.id) === choice.model,
    ) ??
    null
  );
}

/** The engine Quick Create uses: a photo animates it, otherwise text. */
export function quickCreateEngine(hasPhoto: boolean): "image_to_video" | "text_to_video" {
  return hasPhoto ? "image_to_video" : "text_to_video";
}

/** Stops the video model inventing captions, logos or watermark-like text. */
export const QUICK_CREATE_NO_TEXT =
  "No on-screen text, captions, logos or watermarks.";

/**
 * Prompt for the "dress the model" image: the uploaded photo is only a
 * reference for the garment or product, never the frame that gets animated,
 * so mannequins, flat-lays and any text on the photo do not reach the video.
 */
export function buildTryOnPrompt(description: string): string {
  const scene = description.trim();
  return [
    "Photorealistic full-length fashion photograph of a professional Indian model wearing exactly the outfit or holding exactly the product shown in the reference image.",
    "Keep the colours, print, pattern, border, cut and fabric identical to the reference.",
    "Natural pose, soft even studio light, clean plain background, sharp focus, high detail.",
    scene ? `Scene idea: ${scene}.` : "",
    "Do not copy any text, watermark, mannequin, hanger or background from the reference.",
    QUICK_CREATE_NO_TEXT,
  ]
    .filter(Boolean)
    .join(" ");
}
