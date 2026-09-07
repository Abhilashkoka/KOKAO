import { describe, expect, it } from "vitest";
import { registrationSourceError } from "./characterAssets";

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