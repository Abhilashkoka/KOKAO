import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  outfitStatus: null as string | null,
  groupClaimed: false,
  createGroupCalls: 0,
  createAssetCalls: 0,
}));
vi.mock("./objectStorage", () => ({
  ObjectStorageService: class {
    async getSignedDownloadURL() { return "https://storage.example/signed"; }
  },
}));
vi.mock("./byteplus/assets", () => ({
  resolveBytePlusAssetsCredentials: async () => ({ accessKeyId: "x", secretAccessKey: "y" }),
  createAssetGroup: async () => { state.createGroupCalls++; await Promise.resolve(); return "group-1"; },
  createAsset: async () => { state.createAssetCalls++; return "asset-1"; },
  waitForAssetActive: async () => "Active",
  deleteAsset: vi.fn(),
}));
vi.mock("./bytePlusIdentity", () => ({ getBytePlusIdentity: vi.fn() }));
vi.mock("@workspace/db", async (original) => {
  const actual = await original<typeof import("@workspace/db")>();
  const outfit = {
    id: 9, tenantId: 1, characterId: 7, name: "Default", description: "red",
    referenceImagePath: "/objects/1/outfit.png", isDefault: true,
    bytePlusAssetId: null, bytePlusAssetStatus: state.outfitStatus,
  };
  return {
    ...actual,
    db: {
      update(table: unknown) {
        return {
          set(values: Record<string, unknown>) {
            return {
              where() {
                let rows: unknown[] = [{}];
                if (table === actual.characterOutfitsTable && values.bytePlusAssetClaimedAt && values.bytePlusAssetStatus === "Processing") {
                  rows = state.outfitStatus === null ? [outfit] : [];
                  if (rows.length) state.outfitStatus = "Processing";
                } else if (table === actual.charactersTable && values.bytePlusAssetGroupClaimedAt) {
                  rows = state.groupClaimed ? [] : [{}];
                  if (rows.length) state.groupClaimed = true;
                } else if (table === actual.characterOutfitsTable && typeof values.bytePlusAssetStatus === "string") {
                  state.outfitStatus = values.bytePlusAssetStatus;
                }
                return Object.assign(Promise.resolve(rows), { returning: async () => rows });
              },
            };
          },
        };
      },
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ ...outfit, bytePlusAssetStatus: state.outfitStatus }] }) }) }),
    },
  };
});

import { registerOutfitAsset } from "./characterAssets";

describe("BytePlus registration claim", () => {
  it("allows only one concurrent upstream group and asset creation", async () => {
    state.outfitStatus = null;
    state.groupClaimed = false;
    state.createGroupCalls = 0;
    state.createAssetCalls = 0;
    const args = {
      tenantId: 1,
      character: {
        id: 7, tenantId: 1, name: "Generated", referenceSource: "generated",
        bytePlusIdentityId: null, bytePlusAssetGroupId: null,
      },
      outfit: {
        id: 9, tenantId: 1, characterId: 7, name: "Default", description: "red",
        referenceImagePath: "/objects/1/outfit.png", bytePlusAssetStatus: null,
      },
    };
    await Promise.all([
      registerOutfitAsset(args as never),
      registerOutfitAsset(args as never),
    ]);
    expect(state.createGroupCalls).toBe(1);
    expect(state.createAssetCalls).toBe(1);
  });
});