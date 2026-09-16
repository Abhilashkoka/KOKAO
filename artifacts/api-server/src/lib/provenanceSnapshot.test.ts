import { describe, expect, it } from "vitest";
import { rebuildSavedCastProvenanceSnapshot } from "./provenanceSnapshot";

const HASH = "a".repeat(64);

function evidence(
  id: number,
  assetKind: "character_reference" | "character_outfit" | "reference_sheet",
  path: string,
  sourceKind: "textgenerated" | "upload" | "derived",
) {
  return {
    id,
    tenantId: 7,
    assetKind,
    sourceKind,
    operationIdentity: `library:${id}`,
    artifactPath: path,
    artifactSha256: HASH,
    parentPath: null,
    parentSha256: null,
    provider: sourceKind === "textgenerated" ? "library" : null,
    model: sourceKind === "textgenerated" ? "model-v2" : null,
    providerRequestId: null,
    providerOperationId: null,
    inputAncestry: {
      parents: [],
      referenceSource: sourceKind === "upload" ? "uploaded" : "generated",
      capturedAt: new Date(0).toISOString(),
    },
    succeededAt: new Date(0),
    characterId: 12,
    outfitId: assetKind === "character_outfit" ? 44 : null,
    roleId: null,
  } as any;
}

const character = (referenceSource: "generated" | "uploaded") =>
  ({
    id: 12,
    tenantId: 7,
    name: "Selected",
    description: "selected",
    referenceImagePath: "/objects/7/uploads/selected.png",
    referenceSource,
    bytePlusIdentityId: null,
    referenceSheetImagePath: "/objects/7/uploads/selected-sheet.png",
    referenceSheetStatus: "approved",
    referenceSheetApprovedSha256: HASH,
  }) as any;

const outfit = {
  id: 44,
  tenantId: 7,
  characterId: 12,
  name: "Selected outfit",
  description: "selected outfit",
  referenceImagePath: "/objects/7/uploads/selected.png",
  bytePlusAssetId: null,
  bytePlusAssetStatus: null,
} as any;

const current = {
  roleId: "hero",
  source: "generated",
  referenceSource: "generated",
  characterId: 99,
  outfitId: 100,
  character: {
    name: "Prior",
    description: "prior",
    referenceImagePath: "/objects/7/uploads/prior.png",
  },
  outfit: {
    name: "Prior outfit",
    description: "prior outfit",
    referenceImagePath: "/objects/7/uploads/prior-outfit.png",
  },
  provenanceEvidence: null,
  provenanceEvidenceRefs: [],
} as any;

describe("saved cast provenance snapshot rebuild", () => {
  it("uses selected generated rows after an uploaded prior cast member", () => {
    const selected = character("generated");
    const result = rebuildSavedCastProvenanceSnapshot({
      current: { ...current, referenceSource: "uploaded" },
      character: selected,
      outfit,
      characterEvidence: evidence(
        101,
        "character_reference",
        selected.referenceImagePath,
        "textgenerated",
      ),
      outfitEvidence: evidence(
        102,
        "character_outfit",
        outfit.referenceImagePath,
      "derived",
      ),
      sheetEvidence: evidence(
        103,
        "reference_sheet",
        selected.referenceSheetImagePath,
        "textgenerated",
      ),
    });

    expect(result.source).toBe("saved");
    expect(result.referenceSource).toBe("generated");
    expect(result.characterId).toBe(12);
    expect(result.outfitId).toBe(44);
    expect(result.character.referenceImagePath).toBe(selected.referenceImagePath);
    expect(result.provenanceEvidenceRefs?.map((item) => item.provenanceRecordId))
      .toEqual([101, 102, 103]);
  });

  it("does not launder generated provenance into an uploaded selection", () => {
    const selected = character("uploaded");
    const result = rebuildSavedCastProvenanceSnapshot({
      current,
      character: selected,
      outfit,
      characterEvidence: evidence(
        201,
        "character_reference",
        selected.referenceImagePath,
        "upload",
      ),
      outfitEvidence: evidence(
        202,
        "character_outfit",
        outfit.referenceImagePath,
        "upload",
      ),
      sheetEvidence: evidence(
        203,
        "reference_sheet",
        selected.referenceSheetImagePath,
        "upload",
      ),
    });

    expect(result.source).toBe("saved");
    expect(result.referenceSource).toBe("uploaded");
    expect(result.provenanceStatus).toBe("uploaded");
    expect(result.requiresAtlasAsset).toBe(false);
    expect(result.provenanceEvidenceRefs?.map((item) => item.provenanceRecordId))
      .toEqual([201, 202, 203]);
  });
});