import { describe, expect, it } from "vitest";
import type { GuidedStoryProductChoices, GuidedStoryScript } from "@workspace/db";
import { activeAdSkill, adSkillDefaultHeroShare, adSkillScriptRules, normalizeAdSkill } from "./productSkills";
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
