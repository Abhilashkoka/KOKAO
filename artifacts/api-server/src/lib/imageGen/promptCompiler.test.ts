import { describe, it, expect } from "vitest";
import { GenerateImageBody } from "@workspace/api-zod";
import { compileImagePrompt, IMAGE_LOOK_IDS } from "./promptCompiler";

const BRIEF = "A tin of our single-origin espresso blend";

describe("compileImagePrompt", () => {
  it("returns the brief untouched when nothing was picked", () => {
    expect(compileImagePrompt(BRIEF)).toBe(BRIEF);
    expect(compileImagePrompt(BRIEF, null)).toBe(BRIEF);
    expect(compileImagePrompt(BRIEF, {})).toBe(BRIEF);
    expect(compileImagePrompt(`  ${BRIEF}  `)).toBe(BRIEF);
  });

  it("compiles a preset into scene, gear, light and finish", () => {
    const out = compileImagePrompt(BRIEF, { preset: "product" });
    expect(out).toBe(
      `${BRIEF}. Studio product photograph on a seamless gradient sweep, crisp edges and a ` +
        "subtle contact reflection. Shot on a medium-format digital camera with a 100mm macro " +
        "lens at f/8, the whole subject in focus. Lit by a large softbox key at 45 degrees " +
        "with a subtle rim light for edge separation. Overall: commercial catalogue finish, " +
        "true-to-life colour, high micro-detail.",
    );
  });

  it("lets a pill override the preset's default for that axis only", () => {
    const out = compileImagePrompt(BRIEF, { preset: "product", aperture: "f1.4" });
    expect(out).toContain("at f/1.4, very shallow depth of field and creamy bokeh");
    expect(out).not.toContain("f/8");
    // The axes it did not touch still come from the preset.
    expect(out).toContain("a medium-format digital camera");
    expect(out).toContain("a large softbox key");
  });

  it("uses a lone pill without a preset", () => {
    expect(compileImagePrompt(BRIEF, { lens: "natural-50" })).toBe(
      `${BRIEF}. Shot with a 50mm lens.`,
    );
    expect(compileImagePrompt(BRIEF, { lighting: "neon" })).toBe(
      `${BRIEF}. Lit by coloured neon practicals against deep shadow, with wet-surface reflections.`,
    );
  });

  it("keeps the gear sentence readable whichever axes are set", () => {
    expect(compileImagePrompt(BRIEF, { camera: "phone", aperture: "f2.8" })).toBe(
      `${BRIEF}. Shot on a modern smartphone camera at f/2.8, shallow depth of field with a ` +
        "softly blurred background.",
    );
  });

  it("does not double up the brief's own punctuation", () => {
    expect(compileImagePrompt("Launch day!", { lens: "wide-24" })).toBe(
      "Launch day! Shot with a 24mm wide-angle lens.",
    );
    expect(compileImagePrompt("Launch day.", { lens: "wide-24" })).toBe(
      "Launch day. Shot with a 24mm wide-angle lens.",
    );
  });

  it("does not leave a dangling separator when the brief is empty", () => {
    // The route's schema requires a prompt, so this only guards the join itself.
    expect(compileImagePrompt("", { lens: "wide-24" })).toBe("Shot with a 24mm wide-angle lens.");
  });

  it("ignores ids it does not know instead of emitting a hole", () => {
    // The schema rejects these before the route calls us; if one ever slips
    // through, losing that axis beats shipping "Shot on undefined".
    const out = compileImagePrompt(BRIEF, { camera: "hasselblad-907x", lens: "natural-50" });
    expect(out).toBe(`${BRIEF}. Shot with a 50mm lens.`);
  });

  it("falls back to the preset when an override id is unknown", () => {
    const out = compileImagePrompt(BRIEF, { preset: "food", aperture: "f0.95" });
    expect(out).toContain("at f/2.8");
  });

  it("is deterministic", () => {
    const recipe = { preset: "fashion", lighting: "golden-hour" };
    expect(compileImagePrompt(BRIEF, recipe)).toBe(compileImagePrompt(BRIEF, recipe));
  });

  it("gives every preset a full set of gear, light and finish", () => {
    for (const preset of IMAGE_LOOK_IDS.preset) {
      const out = compileImagePrompt(BRIEF, { preset });
      expect(out, preset).toContain("Shot on");
      expect(out, preset).toContain("with a");
      expect(out, preset).toContain("at f/");
      expect(out, preset).toContain("Lit by");
      expect(out, preset).toContain("Overall:");
    }
  });
});

describe("the Look vocabulary matches the API contract", () => {
  // The pill ids live in two places by necessity: the OpenAPI enums (which
  // clients are typed from) and the phrase tables here. A drift means a pill
  // the schema accepts but the compiler silently drops, so assert both ways.
  it("accepts every id the compiler knows", () => {
    for (const [axis, ids] of Object.entries(IMAGE_LOOK_IDS)) {
      for (const id of ids) {
        const parsed = GenerateImageBody.safeParse({
          prompt: BRIEF,
          promptRecipe: { [axis]: id },
        });
        expect(parsed.success, `${axis}=${id}`).toBe(true);
      }
    }
  });

  it("rejects an id the compiler does not know", () => {
    const parsed = GenerateImageBody.safeParse({
      prompt: BRIEF,
      promptRecipe: { camera: "hasselblad-907x" },
    });
    expect(parsed.success).toBe(false);
  });

  it("knows every id the schema accepts", () => {
    // Walks the generated zod enums so an id added to the spec without a
    // phrase here fails the build rather than shipping as a dead pill.
    const shape = (GenerateImageBody as unknown as {
      shape: { promptRecipe: { unwrap: () => { shape: Record<string, { unwrap: () => { options: string[] } }> } } };
    }).shape.promptRecipe
      .unwrap()
      .shape;
    for (const [axis, ids] of Object.entries(IMAGE_LOOK_IDS)) {
      expect(shape[axis]!.unwrap().options.sort(), axis).toEqual([...ids].sort());
    }
  });
});
