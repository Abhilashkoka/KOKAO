import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GuidedStoryDraft, GuidedStoryScript, VideoJobOptions } from "@workspace/db";
import { loadActivePayload } from "../brandKit/service";
import { inspectBrandOutroClip } from "./brandOutro";
import { applyGuidedBrandEnding, confirmGuidedBrandEnding, loadGuidedBrandEnding, replaceableBrandEnding } from "./guidedBrandEnding";
import { videoJobUnits } from "./units";

vi.mock("../brandKit/service", () => ({ loadActivePayload: vi.fn() }));
vi.mock("./brandOutro", async importOriginal => ({
  ...await importOriginal<typeof import("./brandOutro")>(),
  inspectBrandOutroClip: vi.fn(),
}));

function script(): GuidedStoryScript {
  return {
    version: 1, title: "Brand story", logline: "Story and closing logo", runtimeSeconds: 15, warnings: [],
    roles: [{ id: "hero", name: "Hero", description: "Hero" }],
    scenes: [
      { id: "story", startMs: 0, endMs: 10000, visualDirection: "Hero speaks.", roleIds: ["hero"],
        lines: [{ id: "line1", text: "Our story.", kind: "dialogue", ownerRoleId: "hero", startMs: 0, endMs: 10000 }] },
      { id: "ending", startMs: 10000, endMs: 15000, visualDirection: "Clean branded KOKAO end card with logo.", roleIds: [],
        lines: [{ id: "line2", text: "Visit our website.", kind: "narration", ownerRoleId: null, startMs: 10000, endMs: 15000 }] },
    ],
  };
}
function draft(): GuidedStoryDraft {
  return { id: 7, tenantId: 23, revision: 4, state: { setup: { brandKitId: 9 }, script: script() } } as GuidedStoryDraft;
}
function jobOptions(): VideoJobOptions & { brandOutro?: import("./brandOutro").BrandOutroSnapshot } {
  return {
    aspectRatio: "9:16",
    guidedStoryRenderFlow: { version: 1, mode: "direct_video" },
    guidedStory: { script: script(), platform: { durationSeconds: 15 } },
  } as VideoJobOptions;
}

beforeEach(() => {
  vi.mocked(loadActivePayload).mockResolvedValue({
    payload: { video_outro: { enabled: true, mode: "upload", preset: "fade", duration_seconds: 3, background_color: "#000000", clip_path: "/objects/23/uploads/outro.mp4" } },
  } as Awaited<ReturnType<typeof loadActivePayload>>);
  vi.mocked(inspectBrandOutroClip).mockResolvedValue({ duration: 3, hasAudio: true, sha256: "a".repeat(64) });
});

describe("Guided brand ending suggestion and explicit approval", () => {
  it("suggests only a final explicitly branded end card, never merely an empty cast", () => {
    const original = script();
    expect(replaceableBrandEnding(original)?.id).toBe("ending");
    original.scenes[1].visualDirection = "A scenic sunset";
    expect(replaceableBrandEnding(original)).toBeNull();
    original.scenes[1].visualDirection = "A product shot showing a logo";
    expect(replaceableBrandEnding(original)).toBeNull();
    original.scenes[1].visualDirection = "Branded end card";
    original.scenes[1].roleIds = ["hero"];
    expect(replaceableBrandEnding(original)).toBeNull();
    original.scenes[1].roleIds = [];
    original.scenes[1].lines[0].kind = "dialogue";
    expect(replaceableBrandEnding(original)).toBeNull();
    expect(replaceableBrandEnding({ ...script(), scenes: [script().scenes[1]] })).toBeNull();
  });

  it("returns exact clip/audio details and projected timings without generation", async () => {
    const { offer } = await loadGuidedBrandEnding(draft());
    expect(offer).toMatchObject({ available: true, revision: 4, replaceSceneId: "ending",
      clipDurationSeconds: 3, hasAudio: true, storyDurationSeconds: 15,
      replacementDurationSeconds: 13, appendedDurationSeconds: 18 });
    expect(loadActivePayload).toHaveBeenCalledWith(23, 9);
  });

  it("requires confirmation and rejects stale script/clip revisions before funding", async () => {
    const row = draft();
    const { offer } = await loadGuidedBrandEnding(row);
    if (!offer.available) throw new Error("Expected uploaded ending");
    await expect(confirmGuidedBrandEnding(row, undefined)).rejects.toThrow("confirm");
    await expect(confirmGuidedBrandEnding({ ...row, revision: 5 }, { choice: "replace", token: offer.token! })).rejects.toThrow("confirm");
    vi.mocked(inspectBrandOutroClip).mockResolvedValue({ duration: 3, hasAudio: true, sha256: "b".repeat(64) });
    await expect(confirmGuidedBrandEnding(row, { choice: "append", token: offer.token! })).rejects.toThrow("confirm");
  });

  it.each(["keep", "append", "replace"] as const)("freezes %s without mutating the source or double-appending", async choice => {
    const row = draft();
    const before = structuredClone(row);
    const { offer } = await loadGuidedBrandEnding(row);
    if (!offer.available) throw new Error("Expected uploaded ending");
    const approval = await confirmGuidedBrandEnding(row, { choice, token: offer.token! });
    const options = jobOptions();
    const previousUnits = videoJobUnits("topic_to_video", options);
    applyGuidedBrandEnding(options, approval!);
    expect(row).toEqual(before);
    expect(options.brandOutro?.enabled).toBe(choice !== "keep");
    expect(options.guidedStory!.script.scenes.map(s => s.id)).toEqual(choice === "replace" ? ["story"] : ["story", "ending"]);
    expect(videoJobUnits("topic_to_video", options)).toBe(choice === "replace" ? previousUnits / 2 : previousUnits);
    if (choice === "replace") {
      expect(options.guidedBrandEnding?.originalScript).toEqual(before.state.script);
      expect(options.guidedStory!.script.runtimeSeconds).toBe(10);
      expect(options.guidedStory!.script.scenes.flatMap(s => s.lines).some(l => l.id === "line2")).toBe(false);
    }
  });

  it("offers keep/append but rejects replacement for an ordinary empty-cast scene", async () => {
    const row = draft();
    row.state.script!.scenes[1].visualDirection = "An empty product shelf";
    const { offer } = await loadGuidedBrandEnding(row);
    if (!offer.available) throw new Error("Expected uploaded ending");
    expect(offer.available).toBe(true);
    expect(offer.replaceSceneId).toBeNull();
    await expect(confirmGuidedBrandEnding(row, { choice: "replace", token: offer.token! })).rejects.toThrow("Only a final");
  });

  it("requires no confirmation for missing kits and refuses a choice after the clip disappears", async () => {
    vi.mocked(loadActivePayload).mockResolvedValue(null);
    expect((await loadGuidedBrandEnding(draft())).offer.available).toBe(false);
    expect(await confirmGuidedBrandEnding(draft(), undefined)).toBeNull();
    await expect(confirmGuidedBrandEnding(draft(), { choice: "append", token: "old" })).rejects.toThrow("no longer available");
  });

  it("rejects cross-tenant clip paths before storage access", async () => {
    const row = draft();
    row.tenantId = 99;
    await expect(loadGuidedBrandEnding(row)).rejects.toThrow("tenant-owned");
  });
});