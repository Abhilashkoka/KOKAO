import { describe, expect, it } from "vitest";
import { guidedSceneVisualPrompt } from "./guidedScenePrompt";

describe("guidedSceneVisualPrompt", () => {
  it("preserves the existing visual prompt wording and order", () => {
    expect(
      guidedSceneVisualPrompt({
        scriptScene: { visualDirection: "A warm two-shot at the station." },
        sceneCast: [
          {
            roleId: "hero",
            character: { name: "Mira", referenceImagePath: "/mira.png" },
            outfit: {
              description: "a saffron jacket",
              referenceImagePath: "/mira-outfit.png",
            },
          },
        ] as any,
        backdrop: null,
        backdropLabel: "shared",
        location: { mode: "text", imagePath: null, description: "A rainy station" },
        logoPath: "/logo.png",
        platform: { aspectRatio: "9:16", safeArea: "Keep faces in the safe area." },
      }),
    ).toBe(
      "A warm two-shot at the station.\n" +
        "Mira (hero) wears a saffron jacket; identity reference /mira.png; outfit reference /mira-outfit.png.\n" +
        "Shared location direction: A rainy station.\n" +
        "Place the approved logo /logo.png subtly in this scene.\n" +
        "Compose for 9:16. Keep faces in the safe area.",
    );
  });
});