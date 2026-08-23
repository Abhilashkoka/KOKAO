import { describe, expect, it } from "vitest";

import type { TemplateSlot } from "@workspace/db";

import {
  PRESENTER_SLOT,
  TENANT_SCOPED_OPTION_KEYS,
  UnsafeTemplateError,
  assertTemplateSafe,
  canRender,
  estimateVideoUnits,
  missingSlots,
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
  it("passes a platform template presetting only format options", () => {
    expect(() =>
      assertTemplateSafe(
        row({ jobDefaults: { aspectRatio: "9:16", durationSec: 30, captionStyle: "classic" } }),
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