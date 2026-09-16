import type {
  AssetProvenance,
  Character,
  CharacterOutfit,
  GuidedStoryCastSnapshot,
} from "@workspace/db";
import {
  immutableProvenanceProof,
  summarizeProvenance,
} from "./provenance";

/**
 * Rebuild the identity/provenance portion of a saved cast member from the
 * selected tenant rows. The prior cast member is only a carrier for role and
 * voice UI fields; it is never an authority for source or proof.
 */
export function rebuildSavedCastProvenanceSnapshot(args: {
  current: GuidedStoryCastSnapshot;
  character: Character;
  outfit: CharacterOutfit;
  characterEvidence: AssetProvenance | null | undefined;
  outfitEvidence: AssetProvenance | null | undefined;
  sheetEvidence: AssetProvenance | null | undefined;
}): GuidedStoryCastSnapshot {
  const characterEvidence = immutableProvenanceProof(args.characterEvidence);
  const outfitEvidence = immutableProvenanceProof(args.outfitEvidence);
  const sheetEvidence = immutableProvenanceProof(args.sheetEvidence);
  const origin = summarizeProvenance(args.characterEvidence ?? null);
  return {
    ...args.current,
    source: "saved",
    referenceSource: args.character.referenceSource,
    characterId: args.character.id,
    outfitId: args.outfit.id,
    requiresBytePlusAsset: args.character.bytePlusIdentityId !== null,
    bytePlusAssetId: args.outfit.bytePlusAssetId,
    bytePlusAssetStatus: args.outfit.bytePlusAssetStatus,
    requiresAtlasAsset: args.character.referenceSource === "generated",
    provenanceStatus: origin.status,
    provenanceSummary: origin.summary,
    provenanceEvidence: characterEvidence,
    provenanceEvidenceRefs: [
      characterEvidence,
      outfitEvidence,
      sheetEvidence,
    ].filter((item): item is NonNullable<typeof item> => item !== null),
    character: {
      name: args.character.name,
      description: args.character.description,
      referenceImagePath: args.character.referenceImagePath,
    },
    outfit: {
      name: args.outfit.name,
      description: args.outfit.description,
      referenceImagePath: args.outfit.referenceImagePath,
    },
    generatedAsset: null,
    consentGranted: true,
  };
}