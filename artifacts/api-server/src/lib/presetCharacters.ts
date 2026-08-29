import {
  db,
  presetCharactersTable,
  presetOutfitDerivativesTable,
  type PresetCharacter,
  type PresetStockVoice,
  type VideoJobOptions,
} from "@workspace/db";
import { and, asc, eq } from "drizzle-orm";

const LANGUAGES = ["en", "hi", "te", "ta"] as const;
const LICENSE = "Licensed OpenAI synthetic stock voice; no real-person voice or likeness.";

type Seed = Omit<
  typeof presetCharactersTable.$inferInsert,
  "id" | "createdAt" | "updatedAt" | "revision" | "isActive"
>;

function voice(speaker: PresetStockVoice["speaker"], languages = [...LANGUAGES]): PresetStockVoice {
  return {
    id: `openai-gpt-audio-${speaker}`,
    provider: "openai",
    model: "gpt-audio",
    speaker,
    label: `${speaker[0]!.toUpperCase()}${speaker.slice(1)}`,
    license: LICENSE,
    languages,
  };
}

type SeedRow = readonly [
  string,
  string,
  string,
  string,
  readonly string[],
  string,
  PresetStockVoice["speaker"],
];

/** Exactly ten bundled identities. stableId and reference paths are release-stable. */
const PRESET_CHARACTER_SEED_ROWS: readonly SeedRow[] = [
  ["amara-sen", "Amara Sen", "Fictional Indian documentary host in her early thirties, warm expression, shoulder-length dark hair.", "emerald field jacket over a cream shirt and dark trousers", ["documentary", "travel"], "Best for warm explainers, travel, nature, and documentary stories.", "nova"],
  ["arjun-mehta", "Arjun Mehta", "Fictional Indian technology presenter in his late thirties, short dark hair, neat beard, confident friendly manner.", "navy overshirt, white tee, charcoal chinos and trainers", ["technology", "business"], "Best for product demos, business education, and practical technology stories.", "echo"],
  ["zoya-khan", "Zoya Khan", "Fictional Indian culture reporter in her late twenties, expressive eyes, long wavy dark hair.", "rust kurta with subtle woven detail and neutral trousers", ["culture", "lifestyle"], "Best for culture, food, lifestyle, and human-interest stories.", "shimmer"],
  ["kabir-rao", "Kabir Rao", "Fictional Indian sports correspondent in his early thirties, athletic build, cropped dark hair.", "forest green bomber jacket, black tee and dark jeans", ["sports", "adventure"], "Best for energetic sports, fitness, and outdoor adventure stories.", "onyx"],
  ["leela-nair", "Leela Nair", "Fictional Indian science educator in her forties, silver-streaked dark bob, calm and precise presence.", "teal blazer over a white blouse and tailored navy trousers", ["science", "education"], "Best for trustworthy science, health education, and classroom-style explainers.", "alloy"],
  ["dev-malhotra", "Dev Malhotra", "Fictional Indian entertainment presenter in his mid thirties, swept-back dark hair, animated smile.", "burgundy casual blazer, black shirt and tailored trousers", ["entertainment", "music"], "Best for upbeat entertainment, cinema, music, and event coverage.", "fable"],
  ["maya-iyer", "Maya Iyer", "Fictional Indian finance guide in her early forties, shoulder-length dark hair, composed professional expression.", "sand-coloured suit with a soft blue blouse", ["finance", "business"], "Best for measured finance, careers, leadership, and professional learning.", "nova"],
  ["rohan-das", "Rohan Das", "Fictional Indian history storyteller in his fifties, salt-and-pepper hair and beard, approachable scholarly manner.", "brown textured jacket, pale shirt and dark trousers", ["history", "documentary"], "Best for history, heritage, books, and reflective long-form stories.", "echo"],
  ["tara-bose", "Tara Bose", "Fictional Indian youth and social trends host in her mid twenties, short curly dark hair, lively expression.", "cobalt denim jacket, graphic-free white tee and black trousers", ["social", "youth"], "Best for fast, optimistic social, campus, and trend-led stories.", "shimmer"],
  ["vikram-joshi", "Vikram Joshi", "Fictional Indian civic affairs correspondent in his late forties, short salt-and-pepper hair, steady expression.", "charcoal Nehru jacket over a pale blue shirt and dark trousers", ["news", "public-interest"], "Best for neutral public-interest, policy, infrastructure, and civic explainers.", "onyx"],
];

export const PRESET_CHARACTER_SEEDS: readonly Seed[] = PRESET_CHARACTER_SEED_ROWS.map(
([stableId, name, description, outfit, genreTags, usageGuidance, speaker], index) => ({
  stableId,
  name,
  description,
  referenceImagePath: `/preset-assets/${stableId}/identity.svg`,
  supportedLanguages: [...LANGUAGES],
  voices: [voice(speaker)],
  defaultOutfitName: "Signature",
  defaultOutfitDescription: outfit,
  defaultOutfitReferenceImagePath: `/preset-assets/${stableId}/signature.svg`,
  genreTags: [...genreTags],
  usageGuidance,
  sortOrder: index + 1,
}));

/** Idempotent bootstrap; conflicts preserve every admin edit and revision. */
export async function ensurePresetCharacterSeeds(): Promise<void> {
  // Bootstrap only an entirely new catalog. Individual admin deletions are
  // authoritative and must not be silently resurrected on the next browse.
  const existing = await db
    .select({ id: presetCharactersTable.id })
    .from(presetCharactersTable)
    .limit(1);
  if (existing.length > 0) {
    // Repair only paths written by the initial implementation; never rewrite
    // an administrator's deliberately custom bundled asset choice.
    for (const seed of PRESET_CHARACTER_SEEDS) {
      const oldPrefix = `/storage/public-objects/preset-characters/${seed.stableId}/`;
      await db
        .update(presetCharactersTable)
        .set({
          referenceImagePath: seed.referenceImagePath,
          defaultOutfitReferenceImagePath: seed.defaultOutfitReferenceImagePath,
        })
        .where(
          and(
            eq(presetCharactersTable.stableId, seed.stableId),
            eq(presetCharactersTable.referenceImagePath, `${oldPrefix}identity.png`),
            eq(
              presetCharactersTable.defaultOutfitReferenceImagePath,
              `${oldPrefix}signature.png`,
            ),
          ),
        );
    }
    return;
  }
  await db.insert(presetCharactersTable).values([...PRESET_CHARACTER_SEEDS]).onConflictDoNothing();
}

export function presetPublicAssetRelativePath(path: string): string | null {
  const prefix = "/preset-assets/";
  if (!path.startsWith(prefix)) return null;
  const relative = path.slice(prefix.length);
  return relative && !relative.includes("..") ? relative : null;
}

const PORTRAIT_COLORS: Record<string, readonly [string, string, string]> = {
  "amara-sen": ["#C7774D", "#2F2630", "#597B64"],
  "arjun-mehta": ["#9B613F", "#211B1B", "#314968"],
  "zoya-khan": ["#B87555", "#281F28", "#9B5C42"],
  "kabir-rao": ["#A96442", "#211D1C", "#3D6D53"],
  "leela-nair": ["#B77856", "#6E6770", "#327C82"],
  "dev-malhotra": ["#A96543", "#241C1C", "#71394A"],
  "maya-iyer": ["#B87555", "#292229", "#A18B66"],
  "rohan-das": ["#A96C49", "#77706B", "#725845"],
  "tara-bose": ["#B87555", "#29222B", "#396AA0"],
  "vikram-joshi": ["#A96C49", "#716B66", "#3D4149"],
};

/**
 * Bundled, deterministic illustrated fictional portraits. They deliberately
 * contain no photographed/real-person likeness and are served by our router,
 * not a manually provisioned bucket. SVG is also a valid image input for the
 * image provider's reference transport; callers retain its explicit mime.
 */
export function bundledPresetAsset(stableId: string, kind: string): Buffer | null {
  if ((kind !== "identity.svg" && kind !== "signature.svg") || !PORTRAIT_COLORS[stableId]) return null;
  const [skin, hair, outfit] = PORTRAIT_COLORS[stableId]!;
  const accent = kind === "signature.svg" ? outfit : "#EAE4D8";
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="768" height="1152" viewBox="0 0 768 1152">
<rect width="768" height="1152" fill="${accent}"/><circle cx="384" cy="352" r="174" fill="${hair}"/>
<ellipse cx="384" cy="386" rx="134" ry="174" fill="${skin}"/><path d="M250 350q134-220 268 0v-100q-134-145-268 0z" fill="${hair}"/>
<circle cx="334" cy="390" r="13" fill="#201C1A"/><circle cx="434" cy="390" r="13" fill="#201C1A"/><path d="M338 480q46 35 92 0" fill="none" stroke="#7D3F3A" stroke-width="12" stroke-linecap="round"/>
<path d="M142 1152V760q242-170 484 0v392z" fill="${outfit}"/><path d="M305 650h158l35 160H270z" fill="#F5F0E6"/>
</svg>`, "utf8");
}

export async function getPresetForTenant(
  tenantId: number,
  stableId: string,
  derivativeId?: number | null,
): Promise<{
  preset: PresetCharacter;
  outfit: {
    id: number;
    name: string;
    description: string;
    referenceImagePath: string;
    isDefault: boolean;
  };
} | null> {
  await ensurePresetCharacterSeeds();
  const preset = (
    await db
      .select()
      .from(presetCharactersTable)
      .where(and(eq(presetCharactersTable.stableId, stableId), eq(presetCharactersTable.isActive, true)))
      .limit(1)
  )[0];
  if (!preset) return null;
  if (derivativeId != null) {
    const derivative = (
      await db
        .select()
        .from(presetOutfitDerivativesTable)
        .where(
          and(
            eq(presetOutfitDerivativesTable.id, derivativeId),
            eq(presetOutfitDerivativesTable.tenantId, tenantId),
            eq(presetOutfitDerivativesTable.presetCharacterId, preset.id),
            eq(presetOutfitDerivativesTable.status, "approved"),
          ),
        )
        .limit(1)
    )[0];
    if (!derivative) return null;
    return { preset, outfit: { ...derivative, isDefault: false } };
  }
  return {
    preset,
    outfit: {
      id: 0,
      name: preset.defaultOutfitName,
      description: preset.defaultOutfitDescription,
      referenceImagePath: preset.defaultOutfitReferenceImagePath,
      isDefault: true,
    },
  };
}

export type PresetSnapshot = NonNullable<VideoJobOptions["presetSnapshot"]>;

export function presetSnapshot(
  resolved: NonNullable<Awaited<ReturnType<typeof getPresetForTenant>>>,
  language: string,
  selectedVoice: PresetStockVoice,
): PresetSnapshot {
  return {
    version: 1,
    stableId: resolved.preset.stableId,
    revision: resolved.preset.revision,
    name: resolved.preset.name,
    description: resolved.preset.description,
    referenceImagePath: resolved.preset.referenceImagePath,
    language,
    voice: { ...selectedVoice, languages: [...selectedVoice.languages] },
    outfit: { ...resolved.outfit },
  };
}

export async function listTenantPresetDerivatives(tenantId: number) {
  return db
    .select()
    .from(presetOutfitDerivativesTable)
    .where(eq(presetOutfitDerivativesTable.tenantId, tenantId))
    .orderBy(asc(presetOutfitDerivativesTable.id));
}