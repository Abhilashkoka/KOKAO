import { describe, expect, it } from "vitest";
import { atlasRegistrationSourceError, registrationSourceError } from "./characterAssets";

describe("BytePlus registration source policy", () => {
  it("blocks legacy null source, including the policy used by admin retry", () => {
    expect(registrationSourceError({
      referenceSource: null,
      bytePlusIdentityId: null,
    })).toMatch(/durably classify/);
  });

  it("allows only generated virtual portraits or verified uploaded identities", () => {
    expect(registrationSourceError({ referenceSource: "generated", bytePlusIdentityId: null })).toBeNull();
    expect(registrationSourceError({ referenceSource: "uploaded", bytePlusIdentityId: 1 })).toBeNull();
    expect(registrationSourceError({ referenceSource: "uploaded", bytePlusIdentityId: null })).toMatch(/never sent/);
  });
});

describe("Atlas registration source policy", () => {
  const approved = { status: "approved" as const, identityVerified: true };

  it("allows only explicitly generated, approved fictional references", () => {
    expect(atlasRegistrationSourceError({
      referenceSource: "generated",
      bytePlusIdentityId: null,
    }, approved)).toBeNull();
    expect(atlasRegistrationSourceError({
      referenceSource: null,
      bytePlusIdentityId: null,
    }, approved)).toMatch(/explicitly classified/);
    expect(atlasRegistrationSourceError({
      referenceSource: "uploaded",
      bytePlusIdentityId: null,
    }, approved)).toMatch(/Uploaded/);
    expect(atlasRegistrationSourceError({
      referenceSource: "generated",
      bytePlusIdentityId: 3,
    }, approved)).toMatch(/real-person/);
  });

  it("blocks previews, rejected outfits, and failed identity preservation", () => {
    expect(atlasRegistrationSourceError({
      referenceSource: "generated",
      bytePlusIdentityId: null,
    }, { status: "preview", identityVerified: true })).toMatch(/approved/);
    expect(atlasRegistrationSourceError({
      referenceSource: "generated",
      bytePlusIdentityId: null,
    }, { status: "rejected", identityVerified: true })).toMatch(/approved/);
    expect(atlasRegistrationSourceError({
      referenceSource: "generated",
      bytePlusIdentityId: null,
    }, { status: "approved", identityVerified: false })).toMatch(/identity-verified/);
  });
});