import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  assetRows: [] as any[],
  character: null as any,
  outfit: null as any,
  assetCalls: 0,
  mode: "valid" as "valid" | "missingTenant" | "missingAsset",
}));

const fakeDb = vi.hoisted(() => ({
  select: vi.fn(),
}));

vi.mock("@workspace/db", async () => {
  const actual = await vi.importActual<typeof import("@workspace/db")>(
    "@workspace/db",
  );
  return { ...actual, db: fakeDb };
});

const { assetProvenanceTable, characterOutfitsTable, charactersTable } =
  await import("@workspace/db");
const { ObjectStorageService } = await import("../objectStorage");
const { verifyFrozenCharacterSnapshotProvenance } = await import("./jobRunner");

const TENANT_ID = 7;
const CHAR_ID = 12;
const OUTFIT_ID = 44;
const CHAR_PATH = `/objects/${TENANT_ID}/uploads/selected.png`;
const OUTFIT_PATH = `/objects/${TENANT_ID}/uploads/selected-outfit.png`;
const SHEET_PATH = `/objects/${TENANT_ID}/uploads/selected-sheet.png`;
const CHAR_BYTES = Buffer.from("selected-character");
const OUTFIT_BYTES = Buffer.from("selected-outfit");
const SHEET_BYTES = Buffer.from("selected-sheet");
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function row(
  id: number,
  assetKind: "character_reference" | "character_outfit" | "reference_sheet",
  artifactPath: string,
  artifactBytes: Buffer,
  parentPath: string | null = null,
  parentSha256: string | null = null,
) {
  return {
    id,
    tenantId: TENANT_ID,
    assetKind,
    sourceKind: assetKind === "character_outfit" ? "derived" : "textgenerated",
    characterId: CHAR_ID,
    outfitId: assetKind === "character_outfit" ? OUTFIT_ID : null,
    operationIdentity: `library:${id}`,
    provider: "library",
    model: "library-model",
    providerRequestId: null,
    providerOperationId: null,
    artifactPath,
    artifactSha256: hash(artifactBytes),
    parentPath,
    parentSha256,
    inputAncestry: {
      parents: parentPath
        ? [{
            kind: "character_reference",
            path: parentPath,
            sha256: parentSha256,
            characterId: CHAR_ID,
          }]
        : [],
      referenceSource: "generated",
      capturedAt: new Date(0).toISOString(),
    },
  };
}

function proof(asset: any) {
  return {
    provenanceRecordId: asset.id,
    assetKind: asset.assetKind,
    sourceKind: asset.sourceKind,
    operationIdentity: asset.operationIdentity,
    artifactPath: asset.artifactPath,
    artifactSha256: asset.artifactSha256,
    parentPath: asset.parentPath,
    parentSha256: asset.parentSha256,
    provider: asset.provider,
    model: asset.model,
    providerRequestId: asset.providerRequestId,
    providerOperationId: asset.providerOperationId,
    inputAncestry: asset.inputAncestry,
  };
}

function setupRows() {
  const characterRow = {
    id: CHAR_ID,
    tenantId: TENANT_ID,
    referenceImagePath: CHAR_PATH,
    referenceSource: "generated",
    bytePlusIdentityId: null,
    referenceSheetImagePath: SHEET_PATH,
    referenceSheetStatus: "approved",
    referenceSheetApprovedSha256: hash(SHEET_BYTES),
  };
  const outfitRow = {
    id: OUTFIT_ID,
    tenantId: TENANT_ID,
    characterId: CHAR_ID,
    referenceImagePath: OUTFIT_PATH,
    status: "approved",
    identityVerified: true,
  };
  const characterAsset = row(
    101,
    "character_reference",
    CHAR_PATH,
    CHAR_BYTES,
  );
  const outfitAsset = row(
    102,
    "character_outfit",
    OUTFIT_PATH,
    OUTFIT_BYTES,
    CHAR_PATH,
    hash(CHAR_BYTES),
  );
  const sheetAsset = row(
    103,
    "reference_sheet",
    SHEET_PATH,
    SHEET_BYTES,
    CHAR_PATH,
    hash(CHAR_BYTES),
  );
  state.character = characterRow;
  state.outfit = outfitRow;
  state.assetRows = [characterAsset, outfitAsset, sheetAsset];
  state.assetCalls = 0;
  state.mode = "valid";
  return { characterAsset, outfitAsset, sheetAsset };
}

function setupMocks() {
  fakeDb.select.mockImplementation(() => {
    let table: unknown;
    const chain = {
      from(nextTable: unknown) {
        table = nextTable;
        return chain;
      },
      where() {
        return chain;
      },
      limit: async () => {
        if (state.mode === "missingTenant") return [];
        if (table === charactersTable) return [state.character];
        if (table === characterOutfitsTable) return [state.outfit];
        if (table === assetProvenanceTable) {
          if (state.mode === "missingAsset") return [];
          const next = state.assetRows[Math.floor(state.assetCalls / 2)];
          state.assetCalls += 1;
          return next ? [next] : [];
        }
        return [];
      },
    };
    return chain;
  });
  vi.spyOn(ObjectStorageService.prototype, "getObjectEntityFile")
    .mockImplementation(async (path: string) => {
      const bytes = new Map([
        [CHAR_PATH, CHAR_BYTES],
        [OUTFIT_PATH, OUTFIT_BYTES],
        [SHEET_PATH, SHEET_BYTES],
      ]).get(path);
      if (!bytes) throw new Error("missing object");
      return {
        getMetadata: async () => [{ size: bytes.length, contentType: "image/png" }],
        download: async () => [bytes],
      } as any;
    });
}

function optionsFor(
  refs: any[],
  marker: number | undefined = 1,
  guided = false,
  model = "alibaba/wan-3.0-prime/reference-to-video",
) {
  const member = {
    roleId: "hero",
    source: "generated",
    referenceSource: "generated",
    characterId: CHAR_ID,
    outfitId: OUTFIT_ID,
    character: { referenceImagePath: CHAR_PATH },
    outfit: { referenceImagePath: OUTFIT_PATH },
    provenanceEvidenceRefs: refs,
    atlasApprovedReferenceSheetPath: SHEET_PATH,
  };
  if (guided) {
    return {
      ...(marker === undefined ? {} : { characterProvenanceVersion: marker }),
      resolvedVideoModel: {
        model,
      },
      guidedStory: {
        script: { scenes: [{ roleIds: ["hero"] }] },
        cast: [member],
      },
    } as any;
  }
  return {
    ...(marker === undefined ? {} : { characterProvenanceVersion: marker }),
    resolvedVideoModel: {
      model,
    },
    characterId: CHAR_ID,
    outfitId: OUTFIT_ID,
    characterSnapshot: {
      character: {
        id: CHAR_ID,
        referenceImagePath: CHAR_PATH,
        referenceSource: "generated",
        provenanceEvidenceRefs: refs,
      },
      outfits: [{
        id: OUTFIT_ID,
        referenceImagePath: OUTFIT_PATH,
        status: "approved",
        identityVerified: true,
      }],
    },
  } as any;
}

describe("frozen character worker preflight", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setupRows();
    setupMocks();
  });

  it("accepts regular and Guided library evidence without a wallet receipt", async () => {
    const { characterAsset, outfitAsset, sheetAsset } = setupRows();
    const refs = [proof(characterAsset), proof(outfitAsset), proof(sheetAsset)];

    await expect(
      verifyFrozenCharacterSnapshotProvenance({
        tenantId: TENANT_ID,
        options: optionsFor(refs),
      } as any),
    ).resolves.toBeUndefined();

    state.assetCalls = 0;
    await expect(
      verifyFrozenCharacterSnapshotProvenance({
        tenantId: TENANT_ID,
        options: optionsFor(refs, 1, true),
      } as any),
    ).resolves.toBeUndefined();
  });

  it.each([
    ["wrong tenant", "missingTenant"],
    ["missing row ID", "missingAsset"],
  ] as const)("rejects %s before any provider dispatch", async (_label, mode) => {
    const { characterAsset, outfitAsset, sheetAsset } = setupRows();
    state.mode = mode;
    const refs = [proof(characterAsset), proof(outfitAsset), proof(sheetAsset)];
    let providerCalls = 0;

    await expect(
      verifyFrozenCharacterSnapshotProvenance({
        tenantId: TENANT_ID,
        options: optionsFor(refs),
      } as any),
    ).rejects.toThrow(/provenance|approved/i);
    expect(providerCalls).toBe(0);
  });

  it.each([
    ["row ID", (refs: any[]) => [{ ...refs[0], provenanceRecordId: 999 }, ...refs.slice(1)]],
    ["artifact path", (refs: any[]) => [{ ...refs[0], artifactPath: "/objects/7/uploads/other.png" }, ...refs.slice(1)]],
    ["artifact hash", (refs: any[]) => [{ ...refs[0], artifactSha256: "b".repeat(64) }, ...refs.slice(1)]],
    ["parent path", (refs: any[]) => [refs[0], { ...refs[1], parentPath: "/objects/7/uploads/other.png" }, refs[2]]],
    ["parent hash", (refs: any[]) => [refs[0], { ...refs[1], parentSha256: "c".repeat(64) }, refs[2]]],
  ] as const)("rejects a mismatched %s before provider dispatch", async (_label, mutate) => {
    const { characterAsset, outfitAsset, sheetAsset } = setupRows();
    const refs = mutate([proof(characterAsset), proof(outfitAsset), proof(sheetAsset)]);

    await expect(
      verifyFrozenCharacterSnapshotProvenance({
        tenantId: TENANT_ID,
        options: optionsFor(refs),
      } as any),
    ).rejects.toThrow(/provenance|approved/i);
  });

  it.each([
    ["character row characterId", (rows: any[]) => { rows[0].characterId = 99; }],
    ["outfit row characterId", (rows: any[]) => { rows[1].characterId = 99; }],
    ["outfit row outfitId", (rows: any[]) => { rows[1].outfitId = 999; }],
    ["sheet row characterId", (rows: any[]) => { rows[2].characterId = 99; }],
  ] as const)("rejects an exact selected %s mismatch", async (_label, mutate) => {
    const { characterAsset, outfitAsset, sheetAsset } = setupRows();
    mutate([characterAsset, outfitAsset, sheetAsset]);
    const refs = [proof(characterAsset), proof(outfitAsset), proof(sheetAsset)];

    await expect(
      verifyFrozenCharacterSnapshotProvenance({
        tenantId: TENANT_ID,
        options: optionsFor(refs),
      } as any),
    ).rejects.toThrow(/provenance|approved/i);
  });

  it("leaves legacy funded rows on the old path without requiring proof rows", async () => {
    state.mode = "missingTenant";
    await expect(
      verifyFrozenCharacterSnapshotProvenance({
        tenantId: TENANT_ID,
        options: optionsFor([], 0),
      } as any),
    ).resolves.toBeUndefined();
  });

  it("does not blanket-ban uploaded or unknown legacy consent refs for non-Atlas providers", async () => {
    state.mode = "missingTenant";
    const options = optionsFor([], 0) as any;
    options.characterSnapshot.character.referenceSource = "unknown";
    await expect(
      verifyFrozenCharacterSnapshotProvenance({
        tenantId: TENANT_ID,
        options,
      } as any),
    ).resolves.toBeUndefined();
  });

  it("allows a new ordinary-provider snapshot with no ledger rows", async () => {
    state.mode = "missingTenant";
    const options = optionsFor([], 1, false, "replicate");
    await expect(
      verifyFrozenCharacterSnapshotProvenance({
        tenantId: TENANT_ID,
        options,
      } as any),
    ).resolves.toBeUndefined();
  });

  it("keeps unknown origin on the ordinary approved/consented path", async () => {
    state.mode = "missingTenant";
    const options = optionsFor([], 1, false, "replicate") as any;
    options.characterSnapshot.character.referenceSource = "unknown";
    await expect(
      verifyFrozenCharacterSnapshotProvenance({
        tenantId: TENANT_ID,
        options,
      } as any),
    ).resolves.toBeUndefined();
  });

  it("accepts null Atlas registration IDs when an ordinary provider consumes real ledger records", async () => {
    const { characterAsset, outfitAsset, sheetAsset } = setupRows();
    state.character.atlasAssetLibraryId = null;
    state.outfit.atlasAssetLibraryId = null;
    const refs = [proof(characterAsset), proof(outfitAsset), proof(sheetAsset)];
    await expect(
      verifyFrozenCharacterSnapshotProvenance({
        tenantId: TENANT_ID,
        options: optionsFor(refs, 1, false, "replicate"),
      } as any),
    ).resolves.toBeUndefined();
  });

  it.each([
    ["portrait", null],
    ["outfit", CHAR_ID],
  ])("verifies inline %s proofs without requiring library IDs on ordinary providers", async (_kind, characterId) => {
    const { characterAsset, outfitAsset, sheetAsset } = setupRows();
    for (const asset of state.assetRows) {
      asset.characterId = characterId;
      asset.outfitId = null;
    }
    const refs = [proof(characterAsset), proof(outfitAsset), proof(sheetAsset)];
    const options = optionsFor(refs, 1, true, "replicate");
    options.guidedStory.cast[0].characterId = characterId;
    options.guidedStory.cast[0].outfitId = null;
    await expect(
      verifyFrozenCharacterSnapshotProvenance({ tenantId: TENANT_ID, options } as any),
    ).resolves.toBeUndefined();
    expect(state.assetCalls).toBeGreaterThan(0);

    options.resolvedVideoModel.model = "alibaba/wan-3.0-prime/reference-to-video";
    await expect(
      verifyFrozenCharacterSnapshotProvenance({ tenantId: TENANT_ID, options } as any),
    ).rejects.toThrow(/immutable character proof/i);
  });

  it("still rejects a consumed ordinary-provider proof when its path is changed", async () => {
    const { characterAsset, outfitAsset, sheetAsset } = setupRows();
    const refs = [proof(characterAsset), proof(outfitAsset), proof(sheetAsset)];
    refs[0].artifactPath = "/objects/7/uploads/not-selected.png";
    await expect(
      verifyFrozenCharacterSnapshotProvenance({
        tenantId: TENANT_ID,
        options: optionsFor(refs, 1, false, "replicate"),
      } as any),
    ).rejects.toThrow(/provenance|approved/i);
  });

  it("rejects missing triple proof for fictional-only Wan/Atlas providers", async () => {
    state.mode = "missingTenant";
    await expect(
      verifyFrozenCharacterSnapshotProvenance({
        tenantId: TENANT_ID,
        options: optionsFor([], 1, false),
      } as any),
    ).rejects.toThrow(/provenance|approved/i);
  });

  it("rejects unknown origin for fictional-only Wan/Atlas providers", async () => {
    const { characterAsset, outfitAsset, sheetAsset } = setupRows();
    const refs = [proof(characterAsset), proof(outfitAsset), proof(sheetAsset)];
    const options = optionsFor(refs) as any;
    options.characterSnapshot.character.referenceSource = "unknown";
    await expect(
      verifyFrozenCharacterSnapshotProvenance({
        tenantId: TENANT_ID,
        options,
      } as any),
    ).rejects.toThrow(/approved character|generated|changed/i);
  });
});