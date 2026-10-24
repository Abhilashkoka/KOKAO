import { describe, expect, it } from "vitest";
import type { GuidedStoryProductChoices, GuidedStoryScript } from "@workspace/db";
import {
  PRODUCT_HERO_WARNING_PREFIX,
  chooseProductImage,
  clampHeroShare,
  heroReworkInstruction,
  heroShareShortfall,
  isCharacterLedHero,
  parseShot,
  productHeroScriptRules,
  productHeroShotClause,
  productScreenTime,
  sanitizeShots,
  withProductHeroWarnings,
} from "./productHero";
import { guidedProductScriptBrief, guidedSceneProducts, validateAndRepairGuidedScript } from "./guidedStory";
import { guidedSceneVisualPrompt } from "./guidedScenePrompt";

const products: GuidedStoryProductChoices = {
  version: 1,
  promotion: "hero",
  heroShare: 0.7,
  items: [{
    id: "p1", assetId: 1, name: "Night Serum", kind: "product", description: "Hydrates overnight",
    aiDescription: "Frosted dropper bottle", displayMode: "in_scene",
    imagePath: "/objects/1/uploads/front", imageSha256: "f".repeat(64), mimeType: "image/png",
    angles: [
      { view: "label", imagePath: "/objects/1/uploads/label", imageSha256: "l".repeat(64), mimeType: "image/png" },
      { view: "back", imagePath: "/objects/1/uploads/back", imageSha256: "b".repeat(64), mimeType: "image/png" },
    ],
  }],
};

function script(productSeconds: number[], totalSeconds = 20): GuidedStoryScript {
  let start = 0;
  const scenes = productSeconds.map((seconds, index) => {
    const scene = {
      id: `s${index + 1}`, startMs: start, endMs: start + seconds * 1000, visualDirection: "x", roleIds: [],
      productIds: ["p1"], shot: { type: "macro_closeup" as const, camera: "orbit" as const, lighting: "studio_key" as const, angle: null },
      lines: [{ id: `l${index}`, ownerRoleId: null, kind: "narration" as const, text: "words", startMs: start, endMs: start + seconds * 1000 }],
    };
    start += seconds * 1000;
    return scene;
  });
  const rest = totalSeconds - start / 1000;
  if (rest > 0) {
    scenes.push({
      id: "story", startMs: start, endMs: start + rest * 1000, visualDirection: "context", roleIds: [], productIds: [] as never,
      shot: undefined as never,
      lines: [{ id: "lx", ownerRoleId: null, kind: "narration", text: "words", startMs: start, endMs: start + rest * 1000 }],
    });
  }
  return { version: 1, title: "t", logline: "l", runtimeSeconds: totalSeconds, roles: [], scenes, warnings: [] };
}

describe("shots", () => {
  it("parses loose model output and falls back on camera and light", () => {
    expect(parseShot({ type: "Macro Closeup", camera: "push-in", lighting: "nope", angle: "Label" }))
      .toEqual({ type: "macro_closeup", camera: "push_in", lighting: "studio_key", angle: "label" });
    expect(parseShot({ type: "selfie" })).toBeNull();
    expect(parseShot(null)).toBeNull();
  });

  it("keeps shots only on hero scripts and drops angles without a photo", () => {
    const withSide = { ...script([10]), scenes: script([10]).scenes.map((scene) => ({ ...scene, shot: { ...scene.shot!, angle: "side" as const } })) };
    expect(sanitizeShots(withSide, products).scenes[0]!.shot!.angle).toBeNull();
    expect(sanitizeShots(withSide, { ...products, promotion: "featured" }).scenes[0]!.shot).toBeUndefined();
  });
});

describe("screen time", () => {
  it("measures product-focused seconds and warns below target", () => {
    expect(productScreenTime(script([8, 6]))).toEqual({ seconds: 14, share: 0.7, runtime: 20 });
    expect(heroShareShortfall(script([8, 6]), products)).toBe(false);
    const low = script([5]);
    expect(heroShareShortfall(low, products)).toBe(true);
    const warned = withProductHeroWarnings(low, products);
    expect(warned.warnings[0]).toContain(PRODUCT_HERO_WARNING_PREFIX);
    expect(warned.warnings[0]).toContain("25%");
    expect(withProductHeroWarnings(warned, products)).toBe(warned);
    expect(withProductHeroWarnings(low, { ...products, promotion: "featured" }).warnings).toEqual([]);
  });

  it("clamps the target to 40–80%", () => {
    expect(clampHeroShare(0.95)).toBe(0.8);
    expect(clampHeroShare(0.1)).toBe(0.4);
    expect(clampHeroShare(0.5)).toBe(0.5);
    expect(clampHeroShare(undefined)).toBe(0.7);
  });
});

describe("script brief and parsing", () => {
  it("tells the writer the product is the subject with a target and shot vocabulary", () => {
    const brief = guidedProductScriptBrief(products)!;
    expect(brief).toContain("PRODUCT HERO");
    expect(brief).toContain("At least 70% of the total runtime");
    expect(brief).toContain("photos of front, label close-up, back");
    expect(productHeroScriptRules(products).join(" ")).toContain("Never repeat the same shot type");
  });

  it("keeps the cast on screen when the target is 40–50%", () => {
    const low = { ...products, heroShare: 0.5 };
    expect(isCharacterLedHero(low)).toBe(true);
    expect(isCharacterLedHero(products)).toBe(false);
    expect(isCharacterLedHero({ ...low, promotion: "featured" })).toBe(false);
    const rules = productHeroScriptRules(low).join(" ");
    expect(rules).toContain("CHARACTER-LED");
    expect(rules).toContain("At least 50% of the total runtime");
    expect(rules).toContain("character_with_product");
    expect(rules).not.toContain("product-only B-roll with no people");
    expect(heroReworkInstruction(low)).toContain("Do not turn dialogue scenes into product-only shots");
    expect(heroReworkInstruction(products)).toContain("A product-only scene must have an empty roleIds");
  });

  it("allows a product-only opening hook in hero mode", () => {
    const raw = {
      title: "t", logline: "l", roles: [{ id: "maya", name: "Maya", description: "user" }],
      scenes: [
        { id: "s1", startMs: 0, endMs: 4000, visualDirection: "Macro of the bottle", roleIds: [], productIds: ["p1"],
          shot: { type: "macro_closeup", camera: "orbit", lighting: "rim_light", angle: "label" },
          lines: [{ id: "l1", ownerRoleId: null, kind: "narration", text: "Meet your new night ritual tonight.", startMs: 0, endMs: 3500 }] },
        { id: "s2", startMs: 4000, endMs: 20000, visualDirection: "Maya applies it", roleIds: ["maya"], productIds: ["p1"],
          shot: { type: "in_use", camera: "push_in", lighting: "window_light", angle: null },
          lines: [{ id: "l2", ownerRoleId: "maya", kind: "dialogue", text: Array.from({ length: 30 }, () => "word").join(" "), startMs: 4000, endMs: 19000 }] },
      ],
    };
    expect(() => validateAndRepairGuidedScript(raw, { durationSeconds: 20, requireOpeningBuildup: true })).toThrow(/opening buildup/);
    const parsed = validateAndRepairGuidedScript(raw, { durationSeconds: 20, requireOpeningBuildup: true, allowProductOpening: true });
    expect(parsed.scenes[0]!.shot).toEqual({ type: "macro_closeup", camera: "orbit", lighting: "rim_light", angle: "label" });
  });
});

describe("render inputs", () => {
  it("uses the photo of the angle each shot shows", () => {
    const item = products.items[0]!;
    expect(chooseProductImage(item, { type: "in_hand", camera: "orbit", lighting: "studio_key", angle: "back" }).imagePath).toBe("/objects/1/uploads/back");
    expect(chooseProductImage(item, { type: "macro_closeup", camera: "orbit", lighting: "studio_key", angle: null }).view).toBe("label");
    expect(chooseProductImage(item, null).imagePath).toBe("/objects/1/uploads/front");
    const scene = guidedSceneProducts(products, ["p1"], { type: "texture", camera: "static", lighting: "light_sweep", angle: "label" });
    expect(scene[0]).toMatchObject({ imagePath: "/objects/1/uploads/label", imageSha256: "l".repeat(64), view: "label" });
    expect(guidedSceneProducts({ ...products, promotion: "featured" }, ["p1"], { type: "texture", camera: "static", lighting: "light_sweep", angle: "label" })[0]!.imagePath)
      .toBe("/objects/1/uploads/front");
  });

  it("leads the scene prompt with product-first framing and drops face rules without cast", () => {
    expect(productHeroShotClause({ shot: { type: "product_only", camera: "orbit", lighting: "rim_light", angle: "back" }, productNames: ["Night Serum"], castCount: 0 }))
      .toMatch(/subject of this shot.*orbit.*Rim light.*back.*No people/s);
    const prompt = guidedSceneVisualPrompt({
      scriptScene: { visualDirection: "Bottle turns on a marble pedestal" }, sceneCast: [], backdrop: null, backdropLabel: "default",
      location: { mode: "none", imagePath: null, description: null }, logoPath: null, platform: { aspectRatio: "9:16", safeArea: "" },
      products: [{ name: "Night Serum", kind: "product", aiDescription: "Frosted dropper bottle", description: "x", displayMode: "in_scene" }],
      productHero: { shot: { type: "hero_shot", camera: "push_in", lighting: "light_sweep", angle: null } },
    });
    expect(prompt.startsWith('The product "Night Serum" is the subject')).toBe(true);
    expect(prompt).not.toContain("Every face");
    expect(prompt).toContain("label stay identical");
  });
});
