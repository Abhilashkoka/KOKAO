import { describe, expect, it } from "vitest";
import type {
  GuidedStoryCastSnapshot,
  GuidedStoryProductChoices,
} from "@workspace/db";
import {
  GUIDED_FEATURED_PRODUCT_WARNING,
  guidedBackdropFingerprint,
  guidedInScenePhotoProducts,
  guidedProductScriptBrief,
  guidedSceneProducts,
  guidedStoryStoryboard,
  sanitizeGuidedScriptProducts,
  validateAndRepairGuidedScript,
  withGuidedProductWarnings,
} from "./guidedStory";
import { guidedSceneVisualPrompt, productClause } from "./guidedScenePrompt";

const WAN_REFERENCE_MODEL = "alibaba/wan-3.0/reference-to-video";
const SEEDANCE_REFERENCE_MODEL = "bytedance/seedance-2.5/reference-to-video";

function rawScript(productIds?: unknown) {
  return {
    title: "Glow up",
    logline: "A friend shares a night routine.",
    roles: [
      { id: "role-1", name: "Asha", description: "A fictional friend" },
      { id: "role-2", name: "Meera", description: "A fictional friend" },
    ],
    scenes: [
      {
        id: "scene-1",
        startMs: 0,
        endMs: 30_000,
        visualDirection: "Two friends at a bathroom counter",
        roleIds: ["role-1", "role-2"],
        ...(productIds !== undefined ? { productIds } : {}),
        lines: [
          {
            ownerRoleId: "role-1",
            kind: "dialogue",
            text: "My skin looked tired every single morning until I changed one small step in my night routine before bed.",
            startMs: 0,
            endMs: 10_000,
          },
          {
            ownerRoleId: "role-2",
            kind: "dialogue",
            text: "Show me the one you use, because I want that calm even glow before the wedding next month too.",
            startMs: 10_000,
            endMs: 20_000,
          },
        ],
      },
    ],
    warnings: [],
  };
}

const products: GuidedStoryProductChoices = {
  version: 1,
  promotion: "featured",
  items: [
    {
      id: "p11",
      assetId: 11,
      name: "Night Serum",
      kind: "product",
      description: "Niacinamide serum that helps even skin tone.",
      aiDescription: "A frosted glass dropper bottle with a lavender label reading NIGHT SERUM.",
      displayMode: "in_scene",
      imagePath: "/objects/1/uploads/serum.png",
      imageSha256: "b".repeat(64),
      mimeType: "image/png",
    },
    {
      id: "p12",
      assetId: 12,
      name: "Gift Box",
      kind: "product",
      description: "Festive gift set.",
      aiDescription: null,
      displayMode: "exact",
      imagePath: "/objects/1/uploads/box.png",
      imageSha256: "c".repeat(64),
      mimeType: "image/png",
    },
  ],
};

describe("guided product script contract", () => {
  it("keeps well-formed productIds, dedupes and caps them, and omits empty lists", () => {
    const tagged = validateAndRepairGuidedScript(rawScript(["p11", "p11", "p12", "p13", "bad id"]), {
      durationSeconds: 30,
    });
    expect(tagged.scenes[0]!.productIds).toEqual(["p11", "p12"]);
    const untagged = validateAndRepairGuidedScript(rawScript([]), { durationSeconds: 30 });
    expect("productIds" in untagged.scenes[0]!).toBe(false);
    const legacy = validateAndRepairGuidedScript(rawScript(), { durationSeconds: 30 });
    expect("productIds" in legacy.scenes[0]!).toBe(false);
  });

  it("drops ids that are not in the draft's frozen selection", () => {
    const script = validateAndRepairGuidedScript(rawScript(["p99", "p11"]), { durationSeconds: 30 });
    expect(sanitizeGuidedScriptProducts(script, products).scenes[0]!.productIds).toEqual(["p11"]);
    const cleared = sanitizeGuidedScriptProducts(script, null);
    expect("productIds" in cleared.scenes[0]!).toBe(false);
    const untouched = validateAndRepairGuidedScript(rawScript(), { durationSeconds: 30 });
    expect(sanitizeGuidedScriptProducts(untouched, products)).toBe(untouched);
  });

  it("warns, without blocking, when a featured story shows no product", () => {
    const script = validateAndRepairGuidedScript(rawScript(), { durationSeconds: 30 });
    const warned = withGuidedProductWarnings(script, products);
    expect(warned.warnings).toContain(GUIDED_FEATURED_PRODUCT_WARNING);
    const tagged = withGuidedProductWarnings(
      { ...warned, scenes: warned.scenes.map((scene) => ({ ...scene, productIds: ["p11"] })) },
      products,
    );
    expect(tagged.warnings).not.toContain(GUIDED_FEATURED_PRODUCT_WARNING);
    expect(withGuidedProductWarnings(script, { ...products, promotion: "subtle" })).toBe(script);
  });

  it("briefs featured and subtle promotion differently and never invites invented claims", () => {
    const featured = guidedProductScriptBrief(products)!;
    expect(featured).toContain("id p11");
    expect(featured).toContain("FEATURED");
    expect(featured).toContain("call to action");
    expect(featured).toContain("NIGHT SERUM");
    expect(featured).toMatch(/Never invent prices/);
    const subtle = guidedProductScriptBrief({ ...products, promotion: "subtle" })!;
    expect(subtle).toContain("SUBTLE");
    expect(subtle).toContain("Do not add a sales pitch");
    expect(guidedProductScriptBrief(null)).toBeNull();
    expect(guidedProductScriptBrief({ ...products, items: [] })).toBeNull();
  });
});

describe("guided product scene rendering inputs", () => {
  const imageSha256 = "a".repeat(64);
  const backdrop = {
    version: 1 as const,
    prompt: "A bright bathroom",
    imagePath: "/objects/1/uploads/backdrop.png",
    imageSha256,
    revision: 1,
    fingerprint: guidedBackdropFingerprint({
      prompt: "A bright bathroom",
      imagePath: "/objects/1/uploads/backdrop.png",
      imageSha256,
      revision: 1,
      sceneId: null,
    }),
    approvedAt: "2025-01-01T00:00:00.000Z",
  };

  function snapshot(productIds: string[] | undefined, model = WAN_REFERENCE_MODEL) {
    const script = sanitizeGuidedScriptProducts(
      validateAndRepairGuidedScript(rawScript(productIds), { durationSeconds: 30 }),
      products,
    );
    const cast: GuidedStoryCastSnapshot[] = script.roles.map((role, index) => ({
      roleId: role.id,
      source: "generated",
      characterId: index + 1,
      outfitId: index + 10,
      brandKitId: null,
      voiceId: `voice-${index}`,
      character: { name: role.name, description: role.description, referenceImagePath: `/objects/1/uploads/c${index}.png` },
      outfit: { name: "Outfit", description: "a linen kurta", referenceImagePath: `/objects/1/uploads/o${index}.png` },
      voice: { id: `voice-${index}`, label: "Voice", provider: "stock", providerVoiceId: null },
      isUserRole: false,
      consentGranted: true,
    }));
    return {
      version: 1 as const,
      draftId: 1,
      draftRevision: 1,
      scriptApprovedAt: "2025-01-01T00:00:00.000Z",
      videoModel: { provider: "atlascloud", model },
      platform: { id: "instagram_reels", aspectRatio: "9:16" as const, width: 1080, height: 1920, safeArea: "center", durationSeconds: 30 },
      script,
      cast,
      backdrops: { version: 1 as const, default: backdrop, sceneOverrides: {} },
      products,
    };
  }

  it("adds products to scene visuals only when tagged, leaving untagged fingerprints unchanged", () => {
    const untagged = guidedStoryStoryboard(snapshot(undefined));
    const { products: _unused, ...withoutProducts } = snapshot(undefined);
    const legacy = guidedStoryStoryboard(withoutProducts);
    expect(untagged.scenes[0]!.guidedStory!.visuals.products).toBeUndefined();
    expect(untagged.scenes[0]!.guidedStory!.inputFingerprint).toBe(
      legacy.scenes[0]!.guidedStory!.inputFingerprint,
    );
    const tagged = guidedStoryStoryboard(snapshot(["p11", "p12"]));
    expect(tagged.scenes[0]!.guidedStory!.visuals.products?.map((p) => p.id)).toEqual(["p11", "p12"]);
    expect(tagged.scenes[0]!.guidedStory!.inputFingerprint).not.toBe(
      untagged.scenes[0]!.guidedStory!.inputFingerprint,
    );
  });

  it("labels Wan product photos after the cast pairs and backdrop, and reserves room for exact cards", () => {
    const board = guidedStoryStoryboard(snapshot(["p11", "p12"]));
    const visual = board.scenes[0]!.visual;
    // Two cast members (@Image1-4), backdrop (@Image5), first in-scene product (@Image6).
    expect(visual).toContain("shown exactly in @Image5");
    expect(visual).toContain('"Night Serum" exactly as in @Image6');
    expect(visual).toContain("upper-right corner uncluttered for a product card");
    expect(visual).not.toContain("/objects/");
  });

  it("describes products in text for Seedance, which cannot take product photos", () => {
    const board = guidedStoryStoryboard(snapshot(["p11"], SEEDANCE_REFERENCE_MODEL));
    const visual = board.scenes[0]!.visual;
    expect(visual).toContain('"Night Serum" clearly in the shot');
    expect(visual).not.toMatch(/Night Serum" exactly as in @Image/);
  });

  it("maps scene ids to frozen products in tag order and splits photo from exact products", () => {
    const scene = guidedSceneProducts(products, ["p12", "p11", "p404"]);
    expect(scene.map((p) => p.id)).toEqual(["p12", "p11"]);
    expect(guidedInScenePhotoProducts(scene).map((p) => p.id)).toEqual(["p11"]);
    expect(guidedSceneProducts(products, undefined)).toEqual([]);
  });

  it("falls back to the owner description when no AI look is saved", () => {
    const clause = productClause({
      scriptScene: { visualDirection: "x" },
      sceneCast: [],
      backdrop: null,
      backdropLabel: "default",
      location: { mode: "none", imagePath: null, description: null },
      logoPath: null,
      platform: { aspectRatio: "9:16", safeArea: "center" },
      products: [{ name: "Consult", kind: "service", aiDescription: null, description: "Same-day skin consult", displayMode: "in_scene" }],
    });
    expect(clause).toContain('brand service setting "Consult"');
    expect(clause).toContain("Same-day skin consult");
    expect(
      guidedSceneVisualPrompt({
        scriptScene: { visualDirection: "A clinic lobby" },
        sceneCast: [],
        backdrop: null,
        backdropLabel: "default",
        location: { mode: "none", imagePath: null, description: null },
        logoPath: null,
        platform: { aspectRatio: "9:16", safeArea: "center" },
      }),
    ).not.toContain("brand");
  });
});
