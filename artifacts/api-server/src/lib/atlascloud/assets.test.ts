import { afterEach, describe, expect, it, vi } from "vitest";
import { createAtlasAsset, getAtlasAsset, listAtlasAssets } from "./assets";
import { atlasRegistrationSourceError } from "../characterAssets";

describe("Atlas Cloud fictional-character assets", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the documented API host and exact create/status contracts", async () => {
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") return new Response(JSON.stringify({
        code: "200",
        data: {
          id: 2094547,
          atlas_asset_id: "atlas-asset-fictional-1",
          ark_asset_id: "asset-2026-fictional-1",
          status: "processing",
        },
      }));
      return new Response(JSON.stringify({
        code: 200,
        data: {
          id: 2094547,
          atlas_asset_id: "atlas-asset-fictional-1",
          ark_asset_id: "asset-2026-fictional-1",
          status: "active",
        },
      }));
    });
    vi.stubGlobal("fetch", fetch);
    await expect(createAtlasAsset("https://signed.example/image.png", "secret"))
      .resolves.toEqual({
        libraryRecordId: 2094547,
        atlasAssetId: "atlas-asset-fictional-1",
        generationReferenceId: "asset-2026-fictional-1",
      });
    await expect(getAtlasAsset(2094547, "secret"))
      .resolves.toEqual({
        libraryRecordId: 2094547,
        atlasAssetId: "atlas-asset-fictional-1",
        generationReferenceId: "asset-2026-fictional-1",
        status: "Active",
        error: null,
      });
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "https://console.atlascloud.ai/api/v1/sd/assets",
    );
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      type: "Image",
      url: "https://signed.example/image.png",
    });
    expect(fetch.mock.calls[1]?.[0]).toBe(
      "https://console.atlascloud.ai/api/v1/sd/assets/2094547",
    );
  });

  it("parses the live list envelope without conflating its three ids", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      code: "200",
      data: {
        list: [{
          id: 2094547,
          atlas_asset_id: "atlas-asset-fictional-1",
          ark_asset_id: "asset-2026-fictional-1",
          status: "active",
        }],
      },
    }))));
    await expect(listAtlasAssets("secret")).resolves.toEqual([{
      libraryRecordId: 2094547,
      atlasAssetId: "atlas-asset-fictional-1",
      generationReferenceId: "asset-2026-fictional-1",
      status: "Active",
    }]);
  });

  it("preserves application-code errors instead of relabeling them as JSON errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      code: "400",
      message: "numeric record id required",
      data: {},
    }))));
    await expect(createAtlasAsset("https://signed.example/image.png", "secret"))
      .rejects.toThrow(/application code 400.*numeric record id required/);
  });

  it("rejects a non-ark or non-ASCII ark_asset_id from the live envelope", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      code: 200,
      data: { id: 2094547, atlas_asset_id: "atlas-asset-valid", ark_asset_id: "asset-💥" },
    }))));
    await expect(createAtlasAsset("https://signed.example/image.png", "secret"))
      .rejects.toThrow(/id, atlas_asset_id, and ark_asset_id/);
  });

  it("rejects uploads, unknown provenance, real people, and unapproved outfits", () => {
    const approved = { status: "approved" as const, identityVerified: true };
    expect(atlasRegistrationSourceError(
      { referenceSource: "generated", bytePlusIdentityId: null },
      approved,
    )).toBeNull();
    expect(atlasRegistrationSourceError(
      { referenceSource: "uploaded", bytePlusIdentityId: null },
      approved,
    )).toMatch(/Uploaded/);
    expect(atlasRegistrationSourceError(
      { referenceSource: null, bytePlusIdentityId: null },
      approved,
    )).toMatch(/explicitly classified/);
    expect(atlasRegistrationSourceError(
      { referenceSource: "uploaded", bytePlusIdentityId: 9 },
      approved,
    )).toMatch(/real-person/);
    expect(atlasRegistrationSourceError(
      { referenceSource: "generated", bytePlusIdentityId: null },
      { status: "preview", identityVerified: true },
    )).toMatch(/approved/);
  });
});