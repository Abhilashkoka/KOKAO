import { describe, expect, it } from "vitest";
import type { GuidedStoryProductChoices, GuidedStoryScript } from "@workspace/db";
import { activeAdSkill, adSkillDefaultHeroShare, adSkillScriptRules, jewelleryCategory, normalizeAdSkill } from "./productSkills";
import { chooseProductImage, productHeroScriptRules, productHeroShotClause, sanitizeShots } from "./productHero";
import { guidedSceneVisualPrompt } from "./guidedScenePrompt";

const necklace = {
  id: "p1", assetId: 1, name: "Temple Necklace", kind: "product" as const, description: "22K gold, rubies",
  aiDescription: "Gold temple necklace with ruby drops", displayMode: "in_scene" as const,
  imagePath: "/objects/1/uploads/front", imageSha256: "f".repeat(64), mimeType: "image/png",
  angles: [
    { view: "detail" as const, imagePath: "/objects/1/uploads/detail", imageSha256: "d".repeat(64), mimeType: "image/png" },
    { view: "label" as const, imagePath: "/objects/1/uploads/label", imageSha256: "l".repeat(64), mimeType: "image/png" },
  ],
};

function choices(model: "cast" | "body_only" | "none", promotion: "hero" | "featured" = "hero"): GuidedStoryProductChoices {
  return { version: 1, promotion, heroShare: 0.8, items: [necklace], adSkill: { id: "jewellery", look: "bridal", model } };
}

function scriptWithDialogue(): GuidedStoryScript {
  return {
    version: 1, title: "t", logline: "l", runtimeSeconds: 8,
    roles: [{ id: "r1", name: "Bride", description: "bride" }],
    scenes: [
      {
        id: "s1", startMs: 0, endMs: 4000, visualDirection: "x", roleIds: ["r1"], productIds: ["p1"],
        shot: { type: "character_with_product", camera: "push_in", lighting: "rim_light", angle: null },
        lines: [{ id: "l1", ownerRoleId: "r1", kind: "dialogue", text: "It's perfect", startMs: 0, endMs: 3000 }],
      },
      {
        id: "s2", startMs: 4000, endMs: 8000, visualDirection: "y", roleIds: ["r1"], productIds: [],
        lines: [{ id: "l2", ownerRoleId: "r1", kind: "dialogue", text: "Visit us", startMs: 4000, endMs: 7000 }],
      },
    ],
    warnings: [],
  };
}

describe("normalizeAdSkill", () => {
  it("fills defaults and rejects unknown skills", () => {
    expect(normalizeAdSkill({ id: "jewellery" })).toEqual({ id: "jewellery", look: "everyday", model: "cast" });
    expect(normalizeAdSkill({ id: "jewellery", look: "bridal", model: "nope" })).toEqual({ id: "jewellery", look: "bridal", model: "cast" });
    expect(normalizeAdSkill({ id: "general" })).toBeNull();
    expect(normalizeAdSkill(null)).toBeNull();
  });

  it("is only active on product hero stories", () => {
    expect(activeAdSkill(choices("cast"))?.id).toBe("jewellery");
    expect(activeAdSkill(choices("cast", "featured"))).toBeNull();
    expect(adSkillScriptRules(choices("cast", "featured"))).toEqual([]);
  });

  it("defaults jewellery to 80% product screen time", () => {
    expect(adSkillDefaultHeroShare(normalizeAdSkill({ id: "jewellery" }))).toBe(0.8);
    expect(adSkillDefaultHeroShare(null)).toBeNull();
  });
});

describe("jewellery script rules", () => {
  it("adds the jewellery brief, the look and who wears it after the hero rules", () => {
    const rules = productHeroScriptRules(choices("body_only")).join("\n");
    expect(rules).toContain("JEWELLERY & ACCESSORIES");
    expect(rules).toContain("Bridal look");
    expect(rules).toContain("face is never visible");
  });
});

describe("jewellery shots", () => {
  it("macro shots prefer the detail photo, not the label", () => {
    const shot = { type: "macro_closeup" as const, camera: "orbit" as const, lighting: "light_sweep" as const, angle: null };
    expect(chooseProductImage(necklace, shot, normalizeAdSkill({ id: "jewellery" })).view).toBe("detail");
    expect(chooseProductImage(necklace, shot).view).toBe("label");
  });

  it("drops the label rule and adds sparkle, look and people rules", () => {
    const clause = productHeroShotClause({
      shot: { type: "macro_closeup", camera: "orbit", lighting: "light_sweep", angle: null },
      productNames: ["Temple Necklace"],
      castCount: 0,
      skill: { id: "jewellery", look: "minimal", model: "none" },
    });
    expect(clause).not.toContain("label legible");
    expect(clause).toContain("sparkle");
    expect(clause).toContain("Minimal look");
    expect(clause).toContain("No people and no hands");
    expect(clause).not.toContain("hands may appear");
  });

  it("ends the scene prompt on the jewellery fidelity rule", () => {
    const prompt = guidedSceneVisualPrompt({
      scriptScene: { visualDirection: "Necklace on velvet" },
      sceneCast: [],
      backdrop: null,
      backdropLabel: "default",
      location: { mode: "auto" } as never,
      logoPath: null,
      platform: { aspectRatio: "9:16", safeArea: "Keep the centre clear." },
      products: [{ name: "Temple Necklace", kind: "product", aiDescription: null, description: "gold", displayMode: "in_scene" }],
      productHero: { shot: null, skill: { id: "jewellery", look: "festive", model: "cast" } },
    });
    expect(prompt).toContain("stone count");
    expect(prompt).not.toContain("packaging and label stay identical");
  });
});

describe("who wears it", () => {
  it("cast keeps characters and dialogue", () => {
    const out = sanitizeShots(scriptWithDialogue(), choices("cast"));
    expect(out.scenes[0].roleIds).toEqual(["r1"]);
    expect(out.scenes[0].lines[0].kind).toBe("dialogue");
  });

  it("body only removes characters from product scenes only", () => {
    const out = sanitizeShots(scriptWithDialogue(), choices("body_only"));
    expect(out.scenes[0].roleIds).toEqual([]);
    expect(out.scenes[0].lines[0]).toMatchObject({ kind: "narration", ownerRoleId: null });
    expect(out.scenes[1].roleIds).toEqual(["r1"]);
  });

  it("none removes characters from every scene", () => {
    const out = sanitizeShots(scriptWithDialogue(), choices("none"));
    expect(out.scenes.every((scene) => scene.roleIds.length === 0)).toBe(true);
    expect(out.scenes.flatMap((scene) => scene.lines).every((line) => line.kind === "narration")).toBe(true);
  });
});

describe("jewellery category", () => {
  it("reads the category from the name, then the descriptions", () => {
    expect(jewelleryCategory({ name: "Temple Necklace" })).toBe("necklace");
    expect(jewelleryCategory({ name: "Gold Jhumkas" })).toBe("earrings");
    expect(jewelleryCategory({ name: "Diamond Nose Ring" })).toBe("nose");
    expect(jewelleryCategory({ name: "Silver Toe Rings" })).toBe("anklet");
    expect(jewelleryCategory({ name: "Kundan Necklace Set" })).toBe("set");
    expect(jewelleryCategory({ name: "Gold Kada" })).toBe("bangles");
    expect(jewelleryCategory({ name: "Solitaire", description: "18k engagement ring" })).toBe("ring");
    expect(jewelleryCategory({ name: "Lakshmi piece", description: "", aiDescription: "Gold vaddanam with ruby stones" })).toBe("waist");
    expect(jewelleryCategory({ name: "Gift box" })).toBeNull();
  });
});

describe("jewellery prompt v2", () => {
  const jewel = { id: "jewellery" as const, look: "everyday" as const, model: "cast" as const };
  const worn = { type: "in_use" as const, camera: "push_in" as const, lighting: "window_light" as const, angle: null };

  it("frames worn shots and styling for the piece's category", () => {
    const clause = productHeroShotClause({ shot: worn, productNames: ["Gold Jhumkas"], castCount: 1, skill: jewel, products: [{ name: "Gold Jhumkas" }] });
    expect(clause).toContain("earrings is worn on the ear");
    expect(clause).toContain("hair tucked behind the ear");
  });

  it("puts each piece's category and styling in the script brief", () => {
    const rules = adSkillScriptRules(choices("cast")).join("\n");
    expect(rules).toContain('"Temple Necklace" is a necklace');
    expect(rules).toContain("open or boat neckline");
    const none = adSkillScriptRules(choices("none")).join("\n");
    expect(none).toContain("velvet neck bust");
    expect(none).not.toContain("neckline");
  });

  it("lights by look instead of forcing dark backgrounds", () => {
    const clause = productHeroShotClause({ shot: worn, productNames: ["Ring"], castCount: 1, skill: jewel });
    expect(clause).not.toContain("deep rich blacks");
    expect(clause).toContain("soft diffused daylight");
  });

  it("asks for natural motion and photoreal metal", () => {
    const clause = productHeroShotClause({ shot: worn, productNames: ["Ring"], castCount: 1, skill: jewel });
    expect(clause).toContain("Never a frozen mannequin pose");
    expect(clause).toContain("no CGI or plastic sheen");
    const still = productHeroShotClause({ shot: worn, productNames: ["Ring"], castCount: 0, skill: { ...jewel, model: "none" } });
    expect(still).toContain("Never a frozen still");
    expect(still).not.toContain("mannequin");
  });

  it("drops the label wording and lets hair be tucked in jewellery scenes", () => {
    const prompt = guidedSceneVisualPrompt({
      scriptScene: { visualDirection: "Bride turns her head" },
      sceneCast: [{ roleId: "r1", character: { name: "Bride", referenceImagePath: "/objects/1/uploads/c" }, outfit: { description: "a red silk saree", referenceImagePath: "/objects/1/uploads/o" } } as never],
      backdrop: null,
      backdropLabel: "default",
      location: { mode: "auto" } as never,
      logoPath: null,
      platform: { aspectRatio: "9:16", safeArea: "Keep the centre clear." },
      products: [{ name: "Gold Jhumkas", kind: "product", aiDescription: null, description: "gold", displayMode: "in_scene" }],
      productHero: { shot: worn, skill: jewel },
    });
    expect(prompt).not.toMatch(/label text/);
    expect(prompt).toContain("Keep its design, metal colour, stones and proportions unchanged");
    expect(prompt).toContain("hair may only be tucked or pinned back");
    expect(prompt).not.toContain("Every face, hairstyle, build and garment");
  });
});
