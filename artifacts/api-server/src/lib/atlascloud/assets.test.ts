import { afterEach, describe, expect, it, vi } from "vitest";
import { createAtlasAsset, getAtlasAsset } from "./assets";
import { atlasRegistrationSourceError } from "../characterAssets";

describe("Atlas Cloud fictional-character assets", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the documented API host and exact create/status contracts", async () => {
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") return new Response(JSON.stringify({ id: "asset-fictional-1" }));
      return new Response(JSON.stringify({ id: "asset-fictional-1", status: "active" }));
    });
    vi.stubGlobal("fetch", fetch);
    await expect(createAtlasAsset("https://signed.example/image.png", "secret"))
      .resolves.toBe("asset-fictional-1");
    await expect(getAtlasAsset("asset-fictional-1", "secret"))
      .resolves.toEqual({ status: "Active", error: null });
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "https://console.atlascloud.ai/api/v1/sd/assets",
    );
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      type: "Image",
      url: "https://signed.example/image.png",
    });
    expect(fetch.mock.calls[1]?.[0]).toBe(
      "https://console.atlascloud.ai/api/v1/sd/assets/asset-fictional-1",
    );
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