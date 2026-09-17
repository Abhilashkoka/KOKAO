import { describe, expect, it, vi } from "vitest";

const provenanceState = vi.hoisted(() => ({
  rows: [] as unknown[],
  selectCalls: 0,
  table: {
    tenantId: Symbol("tenantId"),
    assetKind: Symbol("assetKind"),
    characterId: Symbol("characterId"),
    outfitId: Symbol("outfitId"),
    succeededAt: Symbol("succeededAt"),
    id: Symbol("id"),
  },
}));

vi.mock("@workspace/db", () => ({
  assetProvenanceTable: provenanceState.table,
  db: {
    select: () => {
      provenanceState.selectCalls += 1;
      return {
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: async () => provenanceState.rows,
            }),
            limit: async () => provenanceState.rows,
          }),
        }),
      };
    },
  },
}));

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => args,
  desc: (value: unknown) => value,
  eq: (left: unknown, right: unknown) => [left, right],
}));

import {
  captureAssetProvenance,
  immutableProvenanceProof,
  latestCharacterProvenance,
  persistedProvenanceMatches,
  provenanceStatus,
  replaceFrozenProvenanceReference,
  reuseFrozenProvenanceProof,
  summarizeProvenance,
  validateExactRecoveryEvidence,
  verifyFrozenAssetProvenance,
  type CaptureProvenanceInput,
} from "./provenance";

const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);

function validInput(overrides: Partial<CaptureProvenanceInput> = {}): CaptureProvenanceInput {
  return {
    tenantId: 17,
    assetKind: "character_reference",
    sourceKind: "textgenerated",
    characterId: 41,
    operationIdentity: "guided-story-cast:91:4:hero",
    provider: "mock-provider",
    model: "mock-model",
    providerOperationId: null,
    artifactPath: "/objects/17/characters/hero.png",
    artifactSha256: HASH,
    inputAncestry: {
      parents: [],
      referenceSource: "generated",
      capturedAt: new Date().toISOString(),
    },
    ...overrides,
  };
}

function returningTx(rows: unknown[], insertedRows = rows) {
  const insert = vi.fn(() => ({
    values: vi.fn(() => ({
      onConflictDoNothing: vi.fn(() => ({
              returning: vi.fn(async () => insertedRows),
      })),
    })),
  }));
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(async () => rows),
      })),
    })),
  }));
  return { tx: { insert, select }, insert };
}

describe("server-owned asset provenance", () => {
  it.each([
    { rail: "quota", providerOperationId: null },
    { rail: "credit", providerOperationId: null },
    { rail: "wallet", providerOperationId: 9021 },
  ])("records a trusted successful generation on the $rail rail", async ({
    providerOperationId,
  }) => {
    const row = {
      ...validInput({ providerOperationId }),
      artifactSha256: HASH,
      succeededAt: new Date(),
    };
    const { tx } = returningTx([row]);

    const captured = await captureAssetProvenance(
      tx as any,
      validInput({ providerOperationId }),
    );

    expect(captured).toEqual(row);
    expect((tx.insert as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    expect(provenanceStatus(captured)).toBe("verified_generated");
  });

  it("never relabels a real-upload ancestry chain as generated", () => {
    const derivedUpload = {
      ...validInput({
        sourceKind: "imageedit",
        provider: "mock-provider",
        inputAncestry: {
          parents: [{
            kind: "character_reference" as const,
            path: "/objects/17/uploads/real-person.png",
            sha256: HASH,
          }],
          referenceSource: "uploaded" as const,
          capturedAt: new Date().toISOString(),
        },
      }),
      succeededAt: new Date(),
    };

    expect(provenanceStatus(derivedUpload as any)).toBe("uploaded");
    expect(summarizeProvenance(derivedUpload as any).status).toBe("uploaded");
  });

  it("freezes proof record references plus artifact and parent hashes for saved selections", () => {
    const portrait = immutableProvenanceProof({
      id: 1001,
      ...validInput(),
      parentPath: null,
      parentSha256: null,
    } as any);
    const outfit = immutableProvenanceProof({
      id: 1002,
      ...validInput({
        assetKind: "character_outfit",
        outfitId: 84,
        operationIdentity: "character-library:41:default-outfit",
        artifactPath: "/objects/17/characters/hero-outfit.png",
        parentPath: "/objects/17/characters/hero.png",
        parentSha256: HASH,
      }),
      parentPath: "/objects/17/characters/hero.png",
      parentSha256: HASH,
    } as any);

    expect(portrait).toMatchObject({
      operationIdentity: "guided-story-cast:91:4:hero",
      artifactPath: "/objects/17/characters/hero.png",
      artifactSha256: HASH,
    });
    expect(outfit).toMatchObject({
      operationIdentity: "character-library:41:default-outfit",
      artifactSha256: HASH,
      parentSha256: HASH,
    });
  });

  it("accepts a new library-origin record for generated preparation without Guided v1 evidence", () => {
    const libraryEvidence = {
      ...validInput({
        operationIdentity: "character-library:41:reference",
      }),
      sourceKind: "textgenerated" as const,
      succeededAt: new Date(),
    };

    expect(libraryEvidence).not.toHaveProperty("draftId");
    expect(provenanceStatus(libraryEvidence as any)).toBe("verified_generated");
  });

  it("fails closed when an idempotent collision has no existing immutable record", async () => {
    const { tx } = returningTx([]);

    await expect(captureAssetProvenance(tx as any, validInput())).rejects.toThrow(
      "operation identity collision",
    );
  });

  it("returns an exact existing row on a retry and rejects changed collision content", async () => {
    const input = validInput();
    const existing = {
      ...input,
      id: 771,
      characterId: 41,
      outfitId: null,
      roleId: null,
      providerRequestId: null,
      providerOperationId: null,
      parentPath: null,
      parentSha256: null,
      succeededAt: new Date(),
    };
    const matching = returningTx([existing], []);
    await expect(
      captureAssetProvenance(matching.tx as any, input),
    ).resolves.toEqual(existing);

    const reordered = {
      ...existing,
      inputAncestry: {
        capturedAt: input.inputAncestry.capturedAt,
        referenceSource: input.inputAncestry.referenceSource,
        parents: input.inputAncestry.parents,
      },
    };
    await expect(
      captureAssetProvenance(returningTx([reordered], []).tx as any, input),
    ).resolves.toEqual(reordered);

    const changed = returningTx([{ ...existing, artifactSha256: OTHER_HASH }], []);
    await expect(
      captureAssetProvenance(changed.tx as any, input),
    ).rejects.toThrow("operation identity collision");
    const providerChanged = returningTx([{ ...existing, provider: "other-provider" }], []);
    await expect(
      captureAssetProvenance(providerChanged.tx as any, input),
    ).rejects.toThrow("operation identity collision");
  });

  it("reuses the first promotion origin across a sheet retry without recapture", async () => {
    const firstPromotion = validInput({
      inputAncestry: {
        parents: [],
        referenceSource: "generated",
        capturedAt: "2026-09-17T05:58:00.000Z",
      },
    });
    const existing = {
      ...firstPromotion,
      id: 772,
      characterId: 41,
      outfitId: null,
      roleId: "hero",
      providerRequestId: null,
      providerOperationId: null,
      parentPath: null,
      parentSha256: null,
      succeededAt: new Date("2026-09-17T05:58:01.000Z"),
    };
    const retry = {
      ...firstPromotion,
      characterId: 41,
      roleId: "hero",
      inputAncestry: {
        ...firstPromotion.inputAncestry,
        capturedAt: "2026-09-17T05:59:00.000Z",
      },
    };

    // This is the promotion retry branch: the durable row is reused, so no
    // second capture (and therefore no second funding/provider continuation)
    // is needed for the sheet-only retry.
    expect(persistedProvenanceMatches(existing as any, retry)).toBe(true);
    expect(
      persistedProvenanceMatches(existing as any, {
        ...retry,
        artifactPath: "/objects/17/characters/changed.png",
      }),
    ).toBe(false);
    expect(
      persistedProvenanceMatches(existing as any, {
        ...retry,
        artifactSha256: OTHER_HASH,
      }),
    ).toBe(false);
    expect(
      persistedProvenanceMatches(existing as any, {
        ...retry,
        tenantId: 18,
      }),
    ).toBe(false);
    expect(
      persistedProvenanceMatches(existing as any, {
        ...retry,
        characterId: 99,
      }),
    ).toBe(false);
  });

  it("reuses the ready proof at finalization without recapture timestamps or charge", () => {
    const selectCallsBefore = provenanceState.selectCalls;
    const input = validInput({ inputAncestry: {
      parents: [],
      referenceSource: "generated",
      capturedAt: "2026-08-23T12:00:00.000Z",
    } });
    const row = {
      ...input,
      id: 8801,
      characterId: 41,
      outfitId: null,
      roleId: null,
      providerRequestId: null,
      providerOperationId: null,
      parentPath: null,
      parentSha256: null,
      succeededAt: new Date("2026-08-23T12:01:00.000Z"),
      createdAt: new Date("2026-08-23T12:01:00.000Z"),
    };
    const readyProof = immutableProvenanceProof(row as any)!;
    const finalizedProof = reuseFrozenProvenanceProof(
      { ...readyProof },
      row as any,
    );
    expect(finalizedProof).toEqual(readyProof);
    expect(finalizedProof?.provenanceRecordId).toBe(8801);
    expect(finalizedProof?.inputAncestry?.capturedAt).toBe(
      "2026-08-23T12:00:00.000Z",
    );
    expect(provenanceState.selectCalls).toBe(selectCallsBefore);
    expect(
      reuseFrozenProvenanceProof(
        {
          ...readyProof,
          inputAncestry: {
            ...readyProof.inputAncestry!,
            capturedAt: "2026-08-23T12:05:00.000Z",
          },
        },
        row as any,
      ),
    ).toBeNull();

    const portrait = { ...readyProof, assetKind: "character_reference" as const };
    const sheet = { ...readyProof, assetKind: "reference_sheet" as const };
    const outfit = { ...readyProof, assetKind: "character_outfit" as const };
    const refs = replaceFrozenProvenanceReference<any>(
      [portrait, sheet],
      outfit,
    );
    expect(refs).toEqual([portrait, sheet, outfit]);
    expect(replaceFrozenProvenanceReference<any>(refs, {
      ...outfit,
      provenanceRecordId: 8802,
    })).toEqual([portrait, sheet, { ...outfit, provenanceRecordId: 8802 }]);
  });

  it("fails closed when persistence is unavailable before the funding continuation", async () => {
    const events: string[] = [];
    const tx = {
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          onConflictDoNothing: vi.fn(() => ({
            returning: vi.fn(async () => {
              events.push("provenance-write");
              throw new Error("database unavailable");
            }),
          })),
        })),
      })),
    };

    await expect(captureAssetProvenance(tx as any, validInput())).rejects.toThrow(
      "database unavailable",
    );
    events.push("funding-continuation");
    expect(events).toEqual(["provenance-write", "funding-continuation"]);
  });

  it("keeps provenance persistence ahead of any funding continuation", async () => {
    const events: string[] = [];
    const row = { ...validInput(), succeededAt: new Date() };
    const tx = {
      insert: vi.fn(() => {
        events.push("provenance-write");
        return {
          values: vi.fn(() => ({
            onConflictDoNothing: vi.fn(() => ({
              returning: vi.fn(async () => [row]),
            })),
          })),
        };
      }),
    };

    await captureAssetProvenance(tx as any, validInput());
    events.push("funding-continuation");

    expect(events).toEqual(["provenance-write", "funding-continuation"]);
  });

  it("cannot verify a missing record", async () => {
    provenanceState.rows = [];

    const missing = await latestCharacterProvenance(17, 41);

    expect(missing).toBeNull();
    expect(summarizeProvenance(missing).status).toBe("unknown");
    expect(immutableProvenanceProof(missing)).toBeNull();
  });

  it("verifies the tenant-bound record, immutable claims, and current file hash", async () => {
    const row = {
      ...validInput(),
      id: 1201,
      characterId: 41,
      outfitId: null,
      roleId: null,
      providerRequestId: null,
      providerOperationId: null,
      parentPath: null,
      parentSha256: null,
      succeededAt: new Date(),
      createdAt: new Date(),
    };
    provenanceState.rows = [row];
    const proof = immutableProvenanceProof(row as any)!;
    const bytes = Buffer.from("proof-bytes");
    const hashed = {
      ...proof,
      artifactSha256: (await import("node:crypto"))
        .createHash("sha256")
        .update(bytes)
        .digest("hex"),
    };
    provenanceState.rows = [{
      ...row,
      artifactSha256: hashed.artifactSha256,
    }];

    await expect(
      verifyFrozenAssetProvenance(17, hashed, async () => bytes),
    ).resolves.toBe(true);
    await expect(
      verifyFrozenAssetProvenance(18, hashed, async () => bytes),
    ).resolves.toBe(false);
    await expect(
      verifyFrozenAssetProvenance(17, { ...hashed, artifactPath: "/objects/17/forged" }, async () => bytes),
    ).resolves.toBe(false);
  });

  it.each<{
    name: string;
    patch: {
      tenantId?: number;
      currentPath?: string;
      currentSha256?: string;
      provider?: string;
    };
    valid: boolean;
  }>([
    {
      name: "valid exact recovery",
      patch: {},
      valid: true,
    },
    {
      name: "forged tenant",
      patch: { tenantId: 18 },
      valid: false,
    },
    {
      name: "mismatched path",
      patch: { currentPath: "/objects/17/characters/other.png" },
      valid: false,
    },
    {
      name: "mismatched hash",
      patch: { currentSha256: OTHER_HASH },
      valid: false,
    },
    {
      name: "mismatched provider",
      patch: { provider: "forged" },
      valid: false,
    },
  ])("$name recovery evidence", ({ patch, valid }) => {
    const result = validateExactRecoveryEvidence({
      tenantId: 17,
      characterTenantId: 17,
      draftId: 91,
      roleId: "hero",
      currentPath: "/objects/17/characters/hero.png",
      currentSha256: HASH,
      checkpoint: {
        draftId: 91,
        roleId: "hero",
        status: "completed",
        sourcePath: "/objects/17/characters/hero.png",
        sourceSha256: HASH,
        provider: "mock-provider",
        model: "mock-model",
        operationKey: "guided-story-cast:91:4:hero",
        operationId: 9021,
      },
      ...patch,
      providerReceipt: {
        tenantId: 17,
        operationKind: "character_reference",
        operationKey: "guided-story-cast:91:4:hero",
        provider: patch.provider ?? "mock-provider",
        model: "mock-model",
        status: "settled",
      },
    });
    expect(result.ok).toBe(valid);
  });

  it("allows no-charge recovery evidence without a wallet receipt", () => {
    const result = validateExactRecoveryEvidence({
      tenantId: 17,
      characterTenantId: 17,
      draftId: 91,
      roleId: "hero",
      currentPath: "/objects/17/characters/hero.png",
      currentSha256: HASH,
      checkpoint: {
        draftId: 91,
        roleId: "hero",
        status: "completed",
        sourcePath: "/objects/17/characters/hero.png",
        sourceSha256: HASH,
        provider: "mock-provider",
        model: "mock-model",
        operationKey: "guided-story-cast:91:4:hero",
        operationId: null,
      },
    });

    expect(result).toEqual({ ok: true });
  });
});