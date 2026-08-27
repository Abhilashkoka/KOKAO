import { describe, expect, it } from "vitest";

import type { TemplateSlot } from "@workspace/db";

import {
  PRESENTER_SLOT,
  TENANT_SCOPED_OPTION_KEYS,
  CreativeDirectionConflictError,
  UnsafeTemplateError,
  assertTemplateSafe,
  canRender,
  estimateVideoUnits,
  missingSlots,
  legacyFormatCreativeDirection,
  resolveCreativeBrief,
  resolveTemplateRuntimeSettings,
  validateCreativeDirection,
  visibleTemplates,
  type TemplateRow,
} from "./videoTemplates";

const row = (over: Partial<TemplateRow> = {}): TemplateRow => ({
  id: 1,
  tenantId: null,
  scope: "platform",
  sourceKind: "curated",
  published: true,
  name: "Expert Explainer",
  slots: [],
  jobDefaults: {},
  sourceVideoPath: null,
  payload: { transcriptExcerpt: "" },
  ...over,
});

/* ------------------------------------------------------------------ *
 * Cross-tenant safety
 * ------------------------------------------------------------------ */

describe("assertTemplateSafe", () => {
  it("accepts complete 600-second script-derived settings", () => {
    const jobDefaults = {
      durationMode: "script_derived",
      maxDurationSeconds: 600,
      speakingRateWpm: 160,
      scriptDetailLevel: "detailed",
      minSceneDurationSeconds: 3,
      maxSceneDurationSeconds: 30,
      minSceneCount: 4,
      maxSceneCount: 20,
      visualStrategy: "ai_video",
    };
    expect(() => assertTemplateSafe(row({ jobDefaults }))).not.toThrow();
    expect(resolveTemplateRuntimeSettings(jobDefaults)).toMatchObject({
      maxDurationSeconds: 600,
      visualStrategy: "ai_video",
    });
    expect(estimateVideoUnits(jobDefaults)).toBe(40);
  });

  it("accepts a 31-scene graphic template with a nine-color palette", () => {
    expect(() =>
      assertTemplateSafe(
        row({
          jobDefaults: {
            durationSec: 68,
            maxDurationSeconds: 68,
            minSceneCount: 10,
            maxSceneCount: 31,
            shotCount: 31,
          },
          payload: {
            transcriptExcerpt: "",
            creativeDirection: {
              version: 1,
              structure: { sceneCount: { min: 10, max: 31 } },
              visual: {
                composition: "left_aligned",
                palette: [
                  "#F1F0F4",
                  "#23212B",
                  "#6B6779",
                  "#1B1A21",
                  "#F3C6A3",
                  "#A9DCC4",
                  "#C4BCE8",
                  "#A9CFE8",
                  "#EEB4BF",
                ],
              },
              sonic: { energy: 2, rhythm: "minimal" },
            },
          },
        }),
      ),
    ).not.toThrow();
  });

  it("resolves legacy duration and visuals without changing their meaning", () => {
    expect(
      resolveTemplateRuntimeSettings({
        durationSec: 90,
        paragraphCount: 3,
        visualsSource: "character",
      }),
    ).toMatchObject({
      durationMode: "script_derived",
      maxDurationSeconds: 90,
      visualStrategy: "character",
      speakingRateWpm: 140,
    });
  });

  it("rejects inverted or insufficient scene ranges", () => {
    expect(() =>
      assertTemplateSafe(
        row({
          jobDefaults: {
            maxDurationSeconds: 600,
            minSceneDurationSeconds: 20,
            maxSceneDurationSeconds: 10,
            minSceneCount: 10,
            maxSceneCount: 5,
          },
        }),
      ),
    ).toThrow(UnsafeTemplateError);
    expect(() =>
      assertTemplateSafe(
        row({
          jobDefaults: {
            maxDurationSeconds: 600,
            maxSceneDurationSeconds: 20,
            maxSceneCount: 20,
          },
        }),
      ),
    ).toThrow(UnsafeTemplateError);
  });

  it("passes a platform template presetting only format options", () => {
    expect(() =>
      assertTemplateSafe(
        row({ jobDefaults: { aspectRatio: "9:16", durationSec: 30, captionStyle: "classic" } }),
      ),
    ).not.toThrow();
  });

  it.each(["9:16", "4:5", "1:1", "16:9", "4:3", "3:4", "21:9"])(
    "accepts the %s aspect ratio offered by Video Studio",
    (aspectRatio) => {
      expect(() => assertTemplateSafe(row({ jobDefaults: { aspectRatio } }))).not.toThrow();
    },
  );

  it("permits a long presenter format within the renderer's ten-minute limit", () => {
    expect(() =>
      assertTemplateSafe(
        row({
          jobDefaults: {
            aspectRatio: "9:16",
            durationSec: 90,
            captionStyle: "classic",
            visualsSource: "stock",
          },
        }),
      ),
    ).not.toThrow();
  });

  it("rejects every workspace-scoped key", () => {
    for (const key of TENANT_SCOPED_OPTION_KEYS) {
      expect(() => assertTemplateSafe(row({ jobDefaults: { [key]: 7 } }))).toThrow(
        UnsafeTemplateError,
      );
    }
  });

  it("names the offending keys so the error is actionable", () => {
    try {
      assertTemplateSafe(
        row({ jobDefaults: { brandKitId: 3, sourceVideoPath: "/objects/9/a.mp4" } }),
      );
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(UnsafeTemplateError);
      expect((error as UnsafeTemplateError).keys).toEqual(["brandKitId", "sourceVideoPath"]);
      expect((error as Error).message).toMatch(/declare tenant inputs as slots/);
    }
  });

  it("rejects unknown keys and nested objects even when they are not on the denylist", () => {
    expect(() =>
      assertTemplateSafe(
        row({ jobDefaults: { futureSettings: { source: "/objects/42/private.mp4" } } }),
      ),
    ).toThrow(UnsafeTemplateError);
    expect(() => assertTemplateSafe(row({ jobDefaults: { harmlessLookingId: null } }))).toThrow(
      UnsafeTemplateError,
    );
  });

  it("rejects platform rows still owned by or derived from a workspace", () => {
    expect(() => assertTemplateSafe(row({ tenantId: 9 }))).toThrow(UnsafeTemplateError);
    expect(() => assertTemplateSafe(row({ sourceKind: "reference" }))).toThrow(
      UnsafeTemplateError,
    );
    expect(() =>
      assertTemplateSafe(row({ sourceVideoPath: "/objects/9/uploads/reference.mp4" })),
    ).toThrow(UnsafeTemplateError);
    expect(() =>
      assertTemplateSafe(row({ payload: { transcriptExcerpt: "private narration" } })),
    ).toThrow(UnsafeTemplateError);
  });

  it("leaves a tenant's own profile alone — its ids are its own", () => {
    expect(() =>
      assertTemplateSafe(
        row({
          scope: "tenant",
          tenantId: 4,
          sourceKind: "reference",
          sourceVideoPath: "/objects/4/uploads/reference.mp4",
          payload: { transcriptExcerpt: "tenant-owned narration" },
          jobDefaults: { brandKitId: 3 },
        }),
      ),
    ).not.toThrow();
  });

  it("rejects object paths and tenant identifiers anywhere in creative direction", () => {
    const unsafe = {
      version: 1,
      narrative: { guidance: "Use /objects/42/uploads/private.png" },
      brandKitId: 42,
    };
    expect(validateCreativeDirection(unsafe)).toEqual(
      expect.arrayContaining([
        "creativeDirection.narrative.guidance",
        "creativeDirection.brandKitId",
      ]),
    );
    expect(() =>
      assertTemplateSafe(row({ payload: { transcriptExcerpt: "", creativeDirection: unsafe } })),
    ).toThrow(UnsafeTemplateError);
  });

  it("rejects contradictory vocabulary regardless of case or whitespace", () => {
    const issues = validateCreativeDirection({
      version: 1,
      narrative: {
        requiredVocabulary: ["Evidence"],
        forbiddenVocabulary: [" evidence "],
      },
    });
    expect(issues).toContain("creativeDirection.narrative.vocabularyConflict:evidence");
  });
});

describe("creative direction resolution", () => {
  it("provides deterministic format-derived direction for a legacy row", () => {
    expect(
      legacyFormatCreativeDirection(
        { durationSec: 35, captionStyle: "dynamic" },
        { hookShape: "Start on the result", scriptGuidance: "Use short sentences." },
      ),
    ).toEqual({
      version: 1,
      narrative: {
        pacing: "brisk",
        guidance: "Start on the result Use short sentences.",
      },
      captions: { rhythm: "word_group", emphasis: "keywords" },
    });
  });

  it("uses explicit precedence, stable unions, range intersection and provenance", () => {
    const input = {
      jobDefaults: { durationSec: 60 },
      template: {
        version: 1 as const,
        narrative: {
          tone: "playful" as const,
          requiredVocabulary: ["proof"],
        },
        structure: { sceneCount: { min: 4, max: 8 } },
        visual: { palette: ["navy"] },
      },
      vertical: {
        version: 1 as const,
        structure: { sceneCount: { min: 5, max: 6 } },
        visual: { palette: ["navy", "white"] },
      },
      brand: {
        version: 1 as const,
        narrative: { tone: "warm" as const, requiredVocabulary: ["KOKAO"] },
      },
      user: {
        version: 1 as const,
        narrative: { tone: "conversational" as const },
      },
      topic: "  Teach better lighting  ",
      references: { template: "template:7:v3", brand: "brand-kit:version:12" },
    };
    const first = resolveCreativeBrief(input);
    expect(resolveCreativeBrief(input)).toEqual(first);
    expect(first.direction.narrative?.tone).toBe("conversational");
    expect(first.direction.narrative?.requiredVocabulary).toEqual(["proof", "KOKAO"]);
    expect(first.direction.visual?.palette).toEqual(["navy", "white"]);
    expect(first.direction.structure?.sceneCount).toEqual({ min: 5, max: 6 });
    expect(first.topic).toBe("Teach better lighting");
    expect(first.provenance.find((entry) => entry.source === "template")?.reference).toBe(
      "template:7:v3",
    );
  });

  it("reports incompatible ranges as a clamp and keeps the earlier constraint", () => {
    const brief = resolveCreativeBrief({
      jobDefaults: { shotCount: 3 },
      vertical: { version: 1, structure: { sceneCount: { min: 5, max: 8 } } },
    });
    expect(brief.direction.structure?.sceneCount).toEqual({ min: 3, max: 3 });
    expect(brief.clamps).toEqual([
      {
        field: "structure.sceneCount",
        reason: "range did not overlap an earlier constraint",
        source: "vertical",
      },
    ]);
  });

  it("rejects vocabulary conflicts introduced by separate layers", () => {
    expect(() =>
      resolveCreativeBrief({
        jobDefaults: {},
        template: { version: 1, narrative: { requiredVocabulary: ["safe"] } },
        brand: { version: 1, narrative: { forbiddenVocabulary: ["SAFE"] } },
      }),
    ).toThrow(CreativeDirectionConflictError);
  });
});

/* ------------------------------------------------------------------ *
 * Visibility
 * ------------------------------------------------------------------ */

describe("visibleTemplates", () => {
  const rows = [
    row({ id: 1, scope: "platform", published: true }),
    row({ id: 2, scope: "platform", published: false }),
    row({ id: 3, scope: "tenant", tenantId: 10, published: false }),
    row({ id: 4, scope: "tenant", tenantId: 99, published: false }),
  ];

  it("offers published platform templates and the workspace's own rows", () => {
    expect(visibleTemplates(rows, 10).map((r) => r.id)).toEqual([1, 3]);
  });

  it("hides unpublished platform drafts", () => {
    expect(visibleTemplates(rows, 10).some((r) => r.id === 2)).toBe(false);
  });

  it("never leaks another workspace's profile", () => {
    expect(visibleTemplates(rows, 10).some((r) => r.id === 4)).toBe(false);
    expect(visibleTemplates(rows, 99).map((r) => r.id)).toEqual([1, 4]);
  });

  it("still offers curated templates to a workspace with nothing of its own", () => {
    expect(visibleTemplates(rows, 1234).map((r) => r.id)).toEqual([1]);
  });
});

/* ------------------------------------------------------------------ *
 * Slots
 * ------------------------------------------------------------------ */

describe("slots", () => {
  const slots: TemplateSlot[] = [
    PRESENTER_SLOT,
    { kind: "script", required: true, label: "Your script" },
    { kind: "music", required: false, label: "A music track" },
  ];

  it("lists only the required slots still unfilled", () => {
    expect(missingSlots(slots, { script: true }).map((s) => s.kind)).toEqual([
      "presenter_video",
    ]);
  });

  it("ignores optional slots", () => {
    expect(missingSlots(slots, { presenter_video: true, script: true })).toEqual([]);
  });

  it("blocks rendering until every required slot is filled", () => {
    expect(canRender(slots, {})).toBe(false);
    expect(canRender(slots, { presenter_video: true })).toBe(false);
    expect(canRender(slots, { presenter_video: true, script: true })).toBe(true);
  });

  it("lets a template with no slots render immediately", () => {
    expect(canRender([], {})).toBe(true);
  });

  it("states the framing constraint on the presenter slot", () => {
    // The overlay lives in the top of the frame, so selfie-close footage puts a
    // graphic across the speaker's face. Saying so up front is cheaper than
    // rejecting the upload afterwards.
    expect(PRESENTER_SLOT.hint).toMatch(/lower two-thirds/);
    expect(PRESENTER_SLOT.required).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Cost
 * ------------------------------------------------------------------ */

describe("estimateVideoUnits", () => {
  it("treats a single-encode format as one unit", () => {
    expect(estimateVideoUnits({ aspectRatio: "9:16" })).toBe(1);
  });

  it("uses the authoritative topic-video pricing for AI imagery", () => {
    expect(estimateVideoUnits({ visualsSource: "ai", paragraphCount: 2 })).toBe(4);
  });

  it("uses the authoritative topic-video pricing for animated AI imagery", () => {
    expect(estimateVideoUnits({ visualsSource: "ai_video", paragraphCount: 3 })).toBe(9);
  });

  it("prices stock formats at one unit", () => {
    expect(estimateVideoUnits({ visualsSource: "stock", paragraphCount: 3 })).toBe(1);
    expect(estimateVideoUnits({})).toBe(1);
  });
});