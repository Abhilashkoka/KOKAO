import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, charactersTable, characterOutfitsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";

const provider = vi.hoisted(() => ({
  createCalls: 0,
  getCalls: 0,
  deleteCalls: [] as number[],
  beforeCreateReturn: null as null | (() => Promise<void>),
  beforeHashReturn: null as null | (() => Promise<void>),
  deleteError: null as Error | null,
  compensatedGet: "absent" as "absent" | "active" | "error",
  waitGate: null as null | Promise<void>,
}));

vi.mock("./objectStorage", () => ({
  ObjectStorageService: class {
    async getSignedDownloadURL() { return "https://storage.test/exact"; }
    async getObjectEntityBytes() {
      await provider.beforeHashReturn?.();
      return Buffer.from("approved");
    }
  },
}));

vi.mock("./atlascloud/assets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./atlascloud/assets")>();
  return {
    ...actual,
    resolveAtlasAssetsKey: async () => "test-key",
    createAtlasAsset: vi.fn(async () => {
      provider.createCalls += 1;
      await provider.beforeCreateReturn?.();
      return {
        libraryRecordId: 9_100_001,
        atlasAssetId: "atlas-test-character",
        generationReferenceId: "asset-test-character",
      };
    }),
    waitForAtlasAsset: vi.fn(async (id: number) => {
      provider.getCalls += 1;
      await provider.waitGate;
      return {
        libraryRecordId: id,
        atlasAssetId: "atlas-test-character",
        generationReferenceId: "asset-test-character",
        status: "Active" as const,
        error: null,
      };
    }),
    getAtlasAsset: vi.fn(async (id: number) => {
      provider.getCalls += 1;
      if (provider.compensatedGet === "absent") {
        throw new actual.AtlasAssetsError("not found", 404);
      }
      if (provider.compensatedGet === "error") {
        throw new actual.AtlasAssetsError("timeout", 503);
      }
      return {
        libraryRecordId: id,
        atlasAssetId: "atlas-still-active",
        generationReferenceId: "asset-still-active",
        status: "Active" as const,
        error: null,
      };
    }),
    deleteAtlasAsset: vi.fn(async (id: number) => {
      provider.deleteCalls.push(id);
      if (provider.deleteError) throw provider.deleteError;
    }),
  };
});

import {
  atlasAssetRefsForOutfit,
  registerAtlasCharacterAsset,
  registerAtlasCharacterAssets,
  registerAtlasOutfitAsset,
} from "./characterAssets";

describe("atomic Atlas character claim", () => {
  const createdIds: number[] = [];

  beforeEach(() => {
    provider.createCalls = 0;
    provider.getCalls = 0;
    provider.deleteCalls.length = 0;
    provider.beforeCreateReturn = null;
    provider.beforeHashReturn = null;
    provider.deleteError = null;
    provider.compensatedGet = "absent";
    provider.waitGate = null;
  });

  afterEach(async () => {
    await db.delete(characterOutfitsTable)
      .where(eq(characterOutfitsTable.tenantId, 991_337));
    for (const id of createdIds.splice(0)) {
      await db.delete(charactersTable).where(eq(charactersTable.id, id));
    }
  });

  async function insertCharacter(overrides: Partial<typeof charactersTable.$inferInsert> = {}) {
    const [row] = await db.insert(charactersTable).values({
      tenantId: 991_337,
      name: "Atlas test",
      description: "fictional",
      referenceImagePath: "/objects/991337/uploads/portrait",
      referenceSource: "generated",
      referenceSheetImagePath: "/objects/991337/uploads/sheet",
      referenceSheetStatus: "approved",
      referenceSheetApprovedSha256: "approved-sha",
      ...overrides,
    }).returning();
    createdIds.push(row!.id);
    return row!;
  }

  function register(
    character: Awaited<ReturnType<typeof insertCharacter>>,
    afterMappingPersistence?: () => void,
  ) {
    return registerAtlasCharacterAsset({
      tenantId: character.tenantId,
      character,
      expectedReferenceSheetPath: character.referenceSheetImagePath!,
      expectedSourceSha256: "approved-sha",
      afterMappingPersistence,
    });
  }

  it("permits only one provider POST for concurrent claims and reuses the result", async () => {
    let release!: () => void;
    provider.waitGate = new Promise<void>((resolve) => { release = resolve; });
    const character = await insertCharacter();
    const first = register(character);
    while (provider.createCalls === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    const second = await register(character);
    expect(second.atlasAssetStatus).toBe("Processing");
    expect(provider.createCalls).toBe(1);
    release();
    const active = await first;
    expect(active.atlasAssetStatus).toBe("Active");
    const reused = await register(active);
    expect(reused.atlasAssetStatus).toBe("Active");
    expect(provider.createCalls).toBe(1);
  });

  it("uses GET-only reconciliation when a numeric id lacks a generation id", async () => {
    const character = await insertCharacter({
      atlasAssetLibraryId: 9_100_002,
      atlasAssetStatus: "Active",
      atlasAssetSourcePath: "/objects/991337/uploads/sheet",
      atlasAssetSourceSha256: "approved-sha",
    });
    const result = await register(character);
    expect(result.atlasAssetReferenceId).toBe("asset-test-character");
    expect(provider.getCalls).toBe(1);
    expect(provider.createCalls).toBe(0);
  });

  it("resumes polling a recent character registration owned by a prior API process", async () => {
    const character = await insertCharacter({
      atlasAssetLibraryId: 9_100_012,
      atlasAssetStatus: "Processing",
      atlasAssetClaimedAt: new Date(),
      atlasAssetLeaseOwner: "prior-process:character-worker",
      atlasAssetSubmitFencedAt: new Date(),
      atlasAssetFenceState: "submitting",
      atlasAssetSourcePath: "/objects/991337/uploads/sheet",
      atlasAssetSourceSha256: "approved-sha",
    });

    const result = await register(character);
    expect(result.atlasAssetStatus).toBe("Active");
    expect(result.atlasAssetLibraryId).toBe(9_100_012);
    expect(provider.getCalls).toBe(1);
    expect(provider.createCalls).toBe(0);
  });

  it("blocks an asset namespace without a numeric id and never posts", async () => {
    const character = await insertCharacter({
      atlasAssetReferenceId: "asset-orphan-character",
      atlasAssetStatus: "Failed",
    });
    const result = await register(character);
    expect(result.atlasAssetStatus).toBe("Failed");
    expect(provider.createCalls).toBe(0);
    expect(provider.getCalls).toBe(0);
  });

  it("compensates a known provider success when exact-source persistence loses CAS", async () => {
    const character = await insertCharacter();
    provider.beforeCreateReturn = async () => {
      await db.update(charactersTable).set({
        referenceSheetStatus: "rejected",
        referenceSheetApprovedSha256: null,
      }).where(eq(charactersTable.id, character.id));
    };
    await register(character);
    expect(provider.createCalls).toBe(1);
    expect(provider.deleteCalls).toEqual([9_100_001]);
    const [current] = await db.select().from(charactersTable)
      .where(eq(charactersTable.id, character.id)).limit(1);
    expect(current!.atlasAssetFenceState).toBe("compensated");
    expect(current!.atlasAssetLibraryId).toBe(9_100_001);
  });

  it("compensates a known parent id when the persistence update throws", async () => {
    const character = await insertCharacter();
    const originalUpdate = db.update.bind(db);
    let inject = false;
    const updateSpy = vi.spyOn(db, "update").mockImplementation(((table: Parameters<typeof db.update>[0]) => {
      if (inject && table === charactersTable) {
        inject = false;
        throw new Error("injected parent persistence failure");
      }
      return originalUpdate(table);
    }) as typeof db.update);
    provider.beforeCreateReturn = async () => { inject = true; };
    try {
      const result = await register(character);
      expect(result.atlasAssetFenceState).toBe("compensated");
      expect(provider.deleteCalls).toEqual([9_100_001]);
    } finally {
      updateSpy.mockRestore();
    }
  });

  it("retries exactly once after affirmative absence of a compensated parent id", async () => {
    const character = await insertCharacter();
    provider.beforeCreateReturn = async () => {
      if (provider.createCalls === 1) {
        await db.update(charactersTable).set({
          referenceSheetStatus: "rejected",
          referenceSheetApprovedSha256: null,
        }).where(eq(charactersTable.id, character.id));
      }
    };
    const compensated = await register(character);
    expect(compensated.atlasAssetFenceState).toBe("compensated");
    await db.update(charactersTable).set({
      referenceSheetStatus: "approved",
      referenceSheetApprovedSha256: "approved-sha",
    }).where(eq(charactersTable.id, character.id));
    provider.beforeCreateReturn = null;
    const [retryInput] = await db.select().from(charactersTable)
      .where(eq(charactersTable.id, character.id)).limit(1);
    const active = await register(retryInput!);
    expect(active.atlasAssetStatus).toBe("Active");
    expect(provider.getCalls).toBe(2);
    expect(provider.createCalls).toBe(2);
    expect(provider.deleteCalls).toEqual([9_100_001]);
  });

  it("does not POST when a compensated parent id still exists and reuses its GET identity", async () => {
    const character = await insertCharacter({
      atlasAssetLibraryId: 9_100_060,
      atlasAssetStatus: "Failed",
      atlasAssetFenceState: "compensated",
      atlasAssetSourcePath: "/objects/991337/uploads/sheet",
      atlasAssetSourceSha256: "approved-sha",
    });
    provider.compensatedGet = "active";
    const result = await register(character);
    expect(result.atlasAssetStatus).toBe("Active");
    expect(provider.createCalls).toBe(0);
    expect(provider.getCalls).toBe(2);
  });

  it("preserves compensated parent intent across GET ambiguity, then retries after a later 404", async () => {
    const character = await insertCharacter({
      atlasAssetLibraryId: 9_100_061,
      atlasAssetStatus: "Failed",
      atlasAssetFenceState: "compensated",
      atlasAssetSourcePath: "/objects/991337/uploads/sheet",
      atlasAssetSourceSha256: "approved-sha",
    });
    provider.compensatedGet = "error";
    const uncertain = await register(character);
    expect(uncertain.atlasAssetFenceState).toBe("compensated");
    expect(uncertain.atlasAssetLibraryId).toBe(9_100_061);
    expect(uncertain.atlasAssetLeaseOwner).toBeNull();
    expect(provider.createCalls).toBe(0);
    provider.compensatedGet = "absent";
    const active = await register(uncertain);
    expect(active.atlasAssetStatus).toBe("Active");
    expect(provider.createCalls).toBe(1);
    expect(provider.getCalls).toBe(3);
  });

  it("clears committed parent generation ids after acknowledgement loss before compensated retry", async () => {
    const character = await insertCharacter();
    const compensated = await register(character, () => {
      throw new Error("injected parent acknowledgement loss");
    });
    expect(compensated.atlasAssetFenceState).toBe("compensated");
    expect(compensated.atlasAssetLibraryId).toBe(9_100_001);
    expect(compensated.atlasAssetReferenceId).toBeNull();
    expect(compensated.atlasAssetId).toBeNull();
    expect(provider.deleteCalls).toEqual([9_100_001]);
    provider.compensatedGet = "absent";
    const active = await register(compensated);
    expect(active.atlasAssetStatus).toBe("Active");
    expect(provider.createCalls).toBe(2);
  });

  it("keeps committed ids outcome_unknown when acknowledgement-loss compensation fails", async () => {
    const character = await insertCharacter();
    provider.deleteError = new Error("injected compensation failure");
    const unknown = await register(character, () => {
      throw new Error("injected committed parent acknowledgement loss");
    });
    expect(unknown.atlasAssetFenceState).toBe("outcome_unknown");
    expect(unknown.atlasAssetLibraryId).toBe(9_100_001);
    expect(unknown.atlasAssetReferenceId).toBe("asset-test-character");
    expect(unknown.atlasAssetId).toBe("asset-test-character");
    const blocked = await register(unknown);
    expect(blocked.atlasAssetFenceState).toBe("outcome_unknown");
    expect(provider.createCalls).toBe(1);
  });

  it("does not POST when approval is revoked after hashing starts but before claim", async () => {
    const character = await insertCharacter({
      referenceSheetApprovedSha256: "2687f86ed6784b8a5fca36e6c468e12aa44dc3c7e8137e3160d1a95079bdcd02",
    });
    provider.beforeHashReturn = async () => {
      await db.update(charactersTable).set({
        referenceSheetStatus: "rejected",
        referenceSheetApprovedSha256: null,
      }).where(eq(charactersTable.id, character.id));
    };
    await expect(registerAtlasCharacterAssets({
      tenantId: character.tenantId,
      characterId: character.id,
      expectedReferenceSheetPath: character.referenceSheetImagePath!,
    })).rejects.toThrow(/registration did not become active|Approve/);
    expect(provider.createCalls).toBe(0);
  });

  it("rejects stale active parent reuse after approval evidence changes under lock", async () => {
    const character = await insertCharacter({
      atlasAssetLibraryId: 9_100_020,
      atlasAssetReferenceId: "asset-active-parent",
      atlasAssetId: "asset-active-parent",
      atlasAssetStatus: "Active",
      atlasAssetSourcePath: "/objects/991337/uploads/sheet",
      atlasAssetSourceSha256: "approved-sha",
    });
    await db.update(charactersTable).set({
      referenceSheetImagePath: "/objects/991337/uploads/replaced-sheet",
      referenceSheetApprovedSha256: "replaced-sha",
    }).where(eq(charactersTable.id, character.id));
    const result = await register(character);
    expect(result.atlasAssetStatus).toBe("Failed");
    expect(provider.createCalls).toBe(0);
  });

  it("locks parent before outfit and permits one outfit POST with safe reuse", async () => {
    let release!: () => void;
    provider.waitGate = new Promise<void>((resolve) => { release = resolve; });
    const character = await insertCharacter({
      atlasAssetLibraryId: 9_100_010,
      atlasAssetReferenceId: "asset-parent-ready",
      atlasAssetId: "asset-parent-ready",
      atlasAssetStatus: "Active",
      atlasAssetSourcePath: "/objects/991337/uploads/sheet",
      atlasAssetSourceSha256: "approved-sha",
    });
    const [outfit] = await db.insert(characterOutfitsTable).values({
      tenantId: character.tenantId,
      characterId: character.id,
      name: "Approved",
      description: "blue",
      referenceImagePath: "/objects/991337/uploads/outfit",
      status: "approved",
      identityVerified: true,
      atlasApprovedSourceSha256: "outfit-sha",
    }).returning();
    const registerOutfit = () => registerAtlasOutfitAsset({
      tenantId: character.tenantId,
      character,
      outfit: outfit!,
      expectedSourcePath: outfit!.referenceImagePath,
      expectedSourceSha256: "outfit-sha",
    });
    const first = registerOutfit();
    while (provider.createCalls === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    const second = await registerOutfit();
    expect(second.atlasAssetStatus).toBe("Processing");
    expect(provider.createCalls).toBe(1);
    release();
    const active = await first;
    expect(active.atlasAssetStatus).toBe("Active");
    const reused = await registerAtlasOutfitAsset({
      tenantId: character.tenantId,
      character,
      outfit: active,
      expectedSourcePath: active.referenceImagePath,
      expectedSourceSha256: "outfit-sha",
    });
    expect(reused.atlasAssetStatus).toBe("Active");
    expect(provider.createCalls).toBe(1);
  });

  it("resumes polling a recent outfit registration owned by a prior API process", async () => {
    const character = await insertCharacter({
      atlasAssetLibraryId: 9_100_013,
      atlasAssetReferenceId: "asset-parent-ready-restart",
      atlasAssetId: "asset-parent-ready-restart",
      atlasAssetStatus: "Active",
      atlasAssetSourcePath: "/objects/991337/uploads/sheet",
      atlasAssetSourceSha256: "approved-sha",
    });
    const [outfit] = await db.insert(characterOutfitsTable).values({
      tenantId: character.tenantId,
      characterId: character.id,
      name: "Restarted",
      description: "green",
      referenceImagePath: "/objects/991337/uploads/restarted-outfit",
      status: "approved",
      identityVerified: true,
      atlasApprovedSourceSha256: "restarted-outfit-sha",
      atlasAssetLibraryId: 9_100_014,
      atlasAssetStatus: "Processing",
      atlasAssetClaimedAt: new Date(),
      atlasAssetLeaseOwner: "prior-process:outfit-worker",
      atlasAssetSubmitFencedAt: new Date(),
      atlasAssetFenceState: "submitting",
      atlasAssetSourcePath: "/objects/991337/uploads/restarted-outfit",
      atlasAssetSourceSha256: "restarted-outfit-sha",
    }).returning();

    const result = await registerAtlasOutfitAsset({
      tenantId: character.tenantId,
      character,
      outfit: outfit!,
      expectedSourcePath: outfit!.referenceImagePath,
      expectedSourceSha256: "restarted-outfit-sha",
    });
    expect(result.atlasAssetStatus).toBe("Active");
    expect(result.atlasAssetLibraryId).toBe(9_100_014);
    expect(provider.getCalls).toBe(1);
    expect(provider.createCalls).toBe(0);
  });

  it("keeps an ambiguous outfit fenced and blocks POST and deletion-retry state changes", async () => {
    const character = await insertCharacter({
      atlasAssetLibraryId: 9_100_011,
      atlasAssetReferenceId: "asset-parent-ready-two",
      atlasAssetId: "asset-parent-ready-two",
      atlasAssetStatus: "Active",
      atlasAssetSourcePath: "/objects/991337/uploads/sheet",
      atlasAssetSourceSha256: "approved-sha",
    });
    const claimedAt = new Date(Date.now() - 60 * 60_000);
    const [outfit] = await db.insert(characterOutfitsTable).values({
      tenantId: character.tenantId,
      characterId: character.id,
      name: "Unknown",
      description: "black",
      referenceImagePath: "/objects/991337/uploads/unknown",
      status: "approved",
      identityVerified: true,
      atlasApprovedSourceSha256: "unknown-sha",
      atlasAssetStatus: "Processing",
      atlasAssetClaimedAt: claimedAt,
      atlasAssetLeaseOwner: "dead-worker",
      atlasAssetSubmitFencedAt: claimedAt,
      atlasAssetFenceState: "outcome_unknown",
    }).returning();
    const result = await registerAtlasOutfitAsset({
      tenantId: character.tenantId,
      character,
      outfit: outfit!,
      expectedSourcePath: outfit!.referenceImagePath,
      expectedSourceSha256: "unknown-sha",
    });
    expect(result.atlasAssetFenceState).toBe("outcome_unknown");
    expect(provider.createCalls).toBe(0);
    expect(provider.getCalls).toBe(0);
    const [current] = await db.select().from(characterOutfitsTable).where(and(
      eq(characterOutfitsTable.id, outfit!.id),
      eq(characterOutfitsTable.tenantId, character.tenantId),
    )).limit(1);
    expect(current!.atlasAssetLeaseOwner).toBe("dead-worker");
  });

  it("rejects stale active outfit reuse when its approval is revoked under the parent-first lock", async () => {
    const character = await insertCharacter({
      atlasAssetLibraryId: 9_100_030,
      atlasAssetReferenceId: "asset-parent-active",
      atlasAssetId: "asset-parent-active",
      atlasAssetStatus: "Active",
      atlasAssetSourcePath: "/objects/991337/uploads/sheet",
      atlasAssetSourceSha256: "approved-sha",
    });
    const [outfit] = await db.insert(characterOutfitsTable).values({
      tenantId: character.tenantId,
      characterId: character.id,
      name: "Frozen",
      description: "green",
      referenceImagePath: "/objects/991337/uploads/frozen",
      status: "approved",
      identityVerified: true,
      atlasApprovedSourceSha256: "outfit-sha",
      atlasAssetLibraryId: 9_100_031,
      atlasAssetReferenceId: "asset-outfit-active",
      atlasAssetId: "asset-outfit-active",
      atlasAssetStatus: "Active",
      atlasAssetSourcePath: "/objects/991337/uploads/frozen",
      atlasAssetSourceSha256: "outfit-sha",
    }).returning();
    await db.update(characterOutfitsTable).set({
      status: "rejected",
      atlasApprovedSourceSha256: null,
    }).where(eq(characterOutfitsTable.id, outfit!.id));
    const result = await registerAtlasOutfitAsset({
      tenantId: character.tenantId,
      character,
      outfit: outfit!,
      expectedSourcePath: outfit!.referenceImagePath,
      expectedSourceSha256: "outfit-sha",
    });
    expect(result.atlasAssetStatus).toBe("Failed");
    expect(provider.createCalls).toBe(0);
  });

  it("retains a known outfit id as outcome_unknown when thrown persistence and compensation both fail", async () => {
    const character = await insertCharacter({
      atlasAssetLibraryId: 9_100_040,
      atlasAssetReferenceId: "asset-parent-persist",
      atlasAssetId: "asset-parent-persist",
      atlasAssetStatus: "Active",
      atlasAssetSourcePath: "/objects/991337/uploads/sheet",
      atlasAssetSourceSha256: "approved-sha",
    });
    const [outfit] = await db.insert(characterOutfitsTable).values({
      tenantId: character.tenantId,
      characterId: character.id,
      name: "Persistence",
      description: "red",
      referenceImagePath: "/objects/991337/uploads/persistence",
      status: "approved",
      identityVerified: true,
      atlasApprovedSourceSha256: "persist-sha",
    }).returning();
    const originalUpdate = db.update.bind(db);
    let inject = false;
    const updateSpy = vi.spyOn(db, "update").mockImplementation(((table: Parameters<typeof db.update>[0]) => {
      if (inject && table === characterOutfitsTable) {
        inject = false;
        throw new Error("injected outfit persistence failure");
      }
      return originalUpdate(table);
    }) as typeof db.update);
    provider.beforeCreateReturn = async () => { inject = true; };
    provider.deleteError = new Error("injected compensation failure");
    try {
      const result = await registerAtlasOutfitAsset({
        tenantId: character.tenantId,
        character,
        outfit: outfit!,
        expectedSourcePath: outfit!.referenceImagePath,
        expectedSourceSha256: "persist-sha",
      });
      expect(result.atlasAssetFenceState).toBe("outcome_unknown");
      expect(result.atlasAssetLibraryId).toBe(9_100_001);
      expect(provider.deleteCalls).toEqual([9_100_001]);
      const blocked = await registerAtlasOutfitAsset({
        tenantId: character.tenantId,
        character,
        outfit: result,
        expectedSourcePath: outfit!.referenceImagePath,
        expectedSourceSha256: "persist-sha",
      });
      expect(blocked.atlasAssetFenceState).toBe("outcome_unknown");
      expect(provider.createCalls).toBe(1);
    } finally {
      updateSpy.mockRestore();
    }
  });

  it("rejects an outfit revoked immediately before renderer asset resolution", async () => {
    const approvedHash = "2687f86ed6784b8a5fca36e6c468e12aa44dc3c7e8137e3160d1a95079bdcd02";
    const character = await insertCharacter({
      referenceSheetApprovedSha256: approvedHash,
      atlasAssetLibraryId: 9_100_050,
      atlasAssetReferenceId: "asset-render-parent",
      atlasAssetId: "asset-render-parent",
      atlasAssetStatus: "Active",
      atlasAssetSourcePath: "/objects/991337/uploads/sheet",
      atlasAssetSourceSha256: approvedHash,
    });
    const [outfit] = await db.insert(characterOutfitsTable).values({
      tenantId: character.tenantId,
      characterId: character.id,
      name: "Render",
      description: "silver",
      referenceImagePath: "/objects/991337/uploads/render",
      status: "approved",
      identityVerified: true,
      atlasApprovedSourceSha256: approvedHash,
      atlasAssetLibraryId: 9_100_051,
      atlasAssetReferenceId: "asset-render-outfit",
      atlasAssetId: "asset-render-outfit",
      atlasAssetStatus: "Active",
      atlasAssetSourcePath: "/objects/991337/uploads/render",
      atlasAssetSourceSha256: approvedHash,
    }).returning();
    await db.update(characterOutfitsTable).set({
      status: "rejected",
      atlasApprovedSourceSha256: null,
    }).where(eq(characterOutfitsTable.id, outfit!.id));
    expect(await atlasAssetRefsForOutfit({
      tenantId: character.tenantId,
      characterId: character.id,
      outfitId: outfit!.id,
      expectedCharacterLibraryId: 9_100_050,
      expectedCharacterReferenceId: "asset-render-parent",
      expectedReferenceSheetPath: character.referenceSheetImagePath!,
      expectedReferenceSheetSha256: approvedHash,
      expectedOutfitLibraryId: 9_100_051,
      expectedOutfitAssetId: "asset-render-outfit",
      expectedOutfitPath: outfit!.referenceImagePath,
      expectedOutfitSha256: approvedHash,
    })).toEqual([]);
  });

  it("preserves compensated outfit intent across GET ambiguity, then retries after a later 404", async () => {
    const character = await insertCharacter({
      atlasAssetLibraryId: 9_100_070,
      atlasAssetReferenceId: "asset-parent-comp-chain",
      atlasAssetId: "asset-parent-comp-chain",
      atlasAssetStatus: "Active",
      atlasAssetSourcePath: "/objects/991337/uploads/sheet",
      atlasAssetSourceSha256: "approved-sha",
    });
    const [outfit] = await db.insert(characterOutfitsTable).values({
      tenantId: character.tenantId,
      characterId: character.id,
      name: "Compensated chain",
      description: "blue",
      referenceImagePath: "/objects/991337/uploads/comp-chain",
      status: "approved",
      identityVerified: true,
      atlasApprovedSourceSha256: "comp-chain-sha",
      atlasAssetLibraryId: 9_100_071,
      atlasAssetStatus: "Failed",
      atlasAssetFenceState: "compensated",
      atlasAssetSourcePath: "/objects/991337/uploads/comp-chain",
      atlasAssetSourceSha256: "comp-chain-sha",
    }).returning();
    const invoke = (input: typeof outfit) => registerAtlasOutfitAsset({
      tenantId: character.tenantId,
      character,
      outfit: input!,
      expectedSourcePath: outfit!.referenceImagePath,
      expectedSourceSha256: "comp-chain-sha",
    });
    provider.compensatedGet = "error";
    const uncertain = await invoke(outfit);
    expect(uncertain.atlasAssetFenceState).toBe("compensated");
    expect(uncertain.atlasAssetLibraryId).toBe(9_100_071);
    expect(uncertain.atlasAssetLeaseOwner).toBeNull();
    expect(provider.createCalls).toBe(0);
    provider.compensatedGet = "absent";
    const active = await invoke(uncertain);
    expect(active.atlasAssetStatus).toBe("Active");
    expect(provider.createCalls).toBe(1);
    expect(provider.getCalls).toBe(3);
  });

  it("does not POST when a compensated outfit id is still active and reconciles it GET-only", async () => {
    const character = await insertCharacter({
      atlasAssetLibraryId: 9_100_080,
      atlasAssetReferenceId: "asset-parent-comp-active",
      atlasAssetId: "asset-parent-comp-active",
      atlasAssetStatus: "Active",
      atlasAssetSourcePath: "/objects/991337/uploads/sheet",
      atlasAssetSourceSha256: "approved-sha",
    });
    const [outfit] = await db.insert(characterOutfitsTable).values({
      tenantId: character.tenantId,
      characterId: character.id,
      name: "Compensated active",
      description: "gold",
      referenceImagePath: "/objects/991337/uploads/comp-active",
      status: "approved",
      identityVerified: true,
      atlasApprovedSourceSha256: "comp-active-sha",
      atlasAssetLibraryId: 9_100_081,
      atlasAssetStatus: "Failed",
      atlasAssetFenceState: "compensated",
      atlasAssetSourcePath: "/objects/991337/uploads/comp-active",
      atlasAssetSourceSha256: "comp-active-sha",
    }).returning();
    provider.compensatedGet = "active";
    const result = await registerAtlasOutfitAsset({
      tenantId: character.tenantId,
      character,
      outfit: outfit!,
      expectedSourcePath: outfit!.referenceImagePath,
      expectedSourceSha256: "comp-active-sha",
    });
    expect(result.atlasAssetStatus).toBe("Active");
    expect(provider.createCalls).toBe(0);
    expect(provider.getCalls).toBe(2);
  });

  it("clears committed outfit generation ids after acknowledgement loss before compensated retry", async () => {
    const character = await insertCharacter({
      atlasAssetLibraryId: 9_100_090,
      atlasAssetReferenceId: "asset-parent-ack-loss",
      atlasAssetId: "asset-parent-ack-loss",
      atlasAssetStatus: "Active",
      atlasAssetSourcePath: "/objects/991337/uploads/sheet",
      atlasAssetSourceSha256: "approved-sha",
    });
    const [outfit] = await db.insert(characterOutfitsTable).values({
      tenantId: character.tenantId,
      characterId: character.id,
      name: "Ack loss",
      description: "white",
      referenceImagePath: "/objects/991337/uploads/ack-loss",
      status: "approved",
      identityVerified: true,
      atlasApprovedSourceSha256: "ack-loss-sha",
    }).returning();
    const compensated = await registerAtlasOutfitAsset({
      tenantId: character.tenantId,
      character,
      outfit: outfit!,
      expectedSourcePath: outfit!.referenceImagePath,
      expectedSourceSha256: "ack-loss-sha",
      afterMappingPersistence: () => {
        throw new Error("injected outfit acknowledgement loss");
      },
    });
    expect(compensated.atlasAssetFenceState).toBe("compensated");
    expect(compensated.atlasAssetLibraryId).toBe(9_100_001);
    expect(compensated.atlasAssetReferenceId).toBeNull();
    expect(compensated.atlasAssetId).toBeNull();
    expect(provider.deleteCalls).toEqual([9_100_001]);
    provider.compensatedGet = "absent";
    const active = await registerAtlasOutfitAsset({
      tenantId: character.tenantId,
      character,
      outfit: compensated,
      expectedSourcePath: outfit!.referenceImagePath,
      expectedSourceSha256: "ack-loss-sha",
    });
    expect(active.atlasAssetStatus).toBe("Active");
    expect(provider.createCalls).toBe(2);
  });
});