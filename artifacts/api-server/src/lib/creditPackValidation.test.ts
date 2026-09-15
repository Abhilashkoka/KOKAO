import { describe, expect, it } from "vitest";
import { AdminCreateCreditPackBody, AdminUpdateCreditPackBody } from "@workspace/api-zod";
import { invalidPack } from "./creditPackValidation";

const unified = {
  name: "SUPER",
  pricePaise: 200000,
  credits: 300,
  captionCredits: 0,
  imageCredits: 0,
  active: true,
};

describe("credit pack request validation", () => {
  it.each([
    ["create", AdminCreateCreditPackBody],
    ["update", AdminUpdateCreditPackBody],
  ])("accepts the unified-only form payload for %s", (_, schema) => {
    expect(invalidPack(schema.parse(unified))).toBe(false);
  });

  it.each([0, -1, 1.5, NaN, Infinity])("rejects invalid unified quantity %s", (credits) => {
    expect(invalidPack({ ...unified, credits })).toBe(true);
  });

  it.each(["captionCredits", "imageCredits", "videoCredits"] as const)(
    "keeps legacy %s packs valid", (key) => {
      expect(invalidPack({ ...unified, credits: 0, [key]: 5 })).toBe(false);
    },
  );

  it("validates omitted update quantities against the preserved stored values", () => {
    const { credits, ...withoutCredits } = unified;
    const parsed = AdminUpdateCreditPackBody.parse(withoutCredits);
    expect(invalidPack({ ...parsed, credits, videoCredits: 0 })).toBe(false);
    expect(invalidPack({ ...parsed, credits: 0, videoCredits: 5 })).toBe(false);
  });

  it("rejects invalid prices, names and legacy quantities even with unified credits", () => {
    expect(invalidPack({ ...unified, name: " " })).toBe(true);
    expect(invalidPack({ ...unified, pricePaise: 0 })).toBe(true);
    expect(invalidPack({ ...unified, pricePaise: 1.5 })).toBe(true);
    expect(invalidPack({ ...unified, captionCredits: -1 })).toBe(true);
  });
});