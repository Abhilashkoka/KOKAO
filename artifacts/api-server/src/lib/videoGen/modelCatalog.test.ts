import { describe, it, expect } from "vitest";
import {
  VIDEO_MODEL_CATALOG,
  TIER_UNIT_MULTIPLIER,
  findVideoModel,
  isVideoModelId,
  resolveModelOptions,
  resolveResolution,
  snapDuration,
  supportsMode,
  videoModelMultiplier,
} from "./modelCatalog";
import { VIDEO_ASPECTS } from "./types";
import { videoJobUnits } from "./units";

describe("video model catalog", () => {
  it("has unique, url-safe ids", () => {
    const ids = VIDEO_MODEL_CATALOG.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+([.-][a-z0-9]+)*$/);
  });

  it("names a provider the video provider catalog actually has", () => {
    for (const model of VIDEO_MODEL_CATALOG) {
      expect(["replicate", "openrouter"]).toContain(model.provider);
    }
  });

  it("serves at least one mode, with a real provider slug", () => {
    for (const model of VIDEO_MODEL_CATALOG) {
      const modes = (["text", "image"] as const).filter((m) => supportsMode(model, m));
      expect(modes.length, model.id).toBeGreaterThan(0);
      for (const mode of modes) expect(model.models[mode]!.length, model.id).toBeGreaterThan(3);
    }
  });

  it("declares at least one duration, resolution and aspect for every model", () => {
    for (const model of VIDEO_MODEL_CATALOG) {
      expect(model.durations.length, model.id).toBeGreaterThan(0);
      expect(model.resolutions.length, model.id).toBeGreaterThan(0);
      expect(model.aspects.length, model.id).toBeGreaterThan(0);
      for (const aspect of model.aspects) expect(VIDEO_ASPECTS).toContain(aspect);
      for (const duration of model.durations) expect(duration).toBeGreaterThan(0);
    }
  });

  it("keeps at least one draft-tier model, so cheap iteration is always possible", () => {
    expect(VIDEO_MODEL_CATALOG.some((m) => m.tier === "draft")).toBe(true);
  });
});

describe("videoModelMultiplier", () => {
  it("is 1 with no picked model — the pre-catalog price, unchanged", () => {
    expect(videoModelMultiplier(null)).toBe(1);
    expect(videoModelMultiplier(undefined)).toBe(1);
  });

  it("is 1 for an unknown id rather than a surprise charge", () => {
    // Validation rejects unknown ids at the route; if one ever reaches here
    // (a legacy row, a removed model), charging MORE for it would be the
    // worst possible failure mode.
    expect(videoModelMultiplier("model-we-removed-last-year")).toBe(1);
  });

  it("charges by tier", () => {
    expect(videoModelMultiplier("wan-2.2-fast")).toBe(TIER_UNIT_MULTIPLIER.draft);
    expect(videoModelMultiplier("wan-2.5")).toBe(TIER_UNIT_MULTIPLIER.standard);
    expect(videoModelMultiplier("veo-3")).toBe(TIER_UNIT_MULTIPLIER.premium);
  });
});

describe("videoJobUnits with a picked model", () => {
  const base = { aspectRatio: "9:16" as const };

  it("prices a plain job exactly as it did before model choice existed", () => {
    expect(videoJobUnits("text_to_video", { ...base, shotCount: 1 })).toBe(1);
    expect(videoJobUnits("text_to_video", { ...base, shotCount: 4 })).toBe(4);
    expect(videoJobUnits("image_to_video", base)).toBe(1);
    expect(videoJobUnits("slideshow", base)).toBe(1);
  });

  it("multiplies the GENERATION count, not the job", () => {
    // Four premium shots really are sixteen premium generations' worth of
    // provider spend; charging 4 + 3 would under-bill the expensive half.
    expect(videoJobUnits("text_to_video", { ...base, shotCount: 4, modelId: "veo-3" })).toBe(16);
    expect(videoJobUnits("text_to_video", { ...base, shotCount: 4, modelId: "wan-2.5" })).toBe(8);
  });

  it("leaves a draft model at the plain price", () => {
    expect(videoJobUnits("text_to_video", { ...base, shotCount: 3, modelId: "wan-2.2-fast" })).toBe(
      3,
    );
  });

  it("adds the AI music bed after the multiplier, not through it", () => {
    // The bed runs on MusicGen whichever video model was picked, so it is one
    // unit — not four because the video happened to be premium.
    expect(
      videoJobUnits("text_to_video", {
        ...base,
        shotCount: 1,
        modelId: "veo-3",
        musicPrompt: "warm lo-fi",
      }),
    ).toBe(5);
  });

  it("multiplies review-added scenes too, matching what the insert route charged", () => {
    // The insert route reserves videoModelMultiplier() units per added scene,
    // so the recomputation here has to agree or a refund hands back more (or
    // less) than was ever taken.
    expect(
      videoJobUnits("topic_to_video", {
        ...base,
        visualsSource: "ai",
        paragraphCount: 1,
        addedScenes: 2,
        modelId: "wan-2.5",
      }),
    ).toBe(8); // (2 base + 2 added) x standard tier
  });

  it("prices a character topic video per scene, then by model", () => {
    expect(
      videoJobUnits("topic_to_video", {
        ...base,
        visualsSource: "character",
        paragraphCount: 2,
        modelId: "wan-2.5",
      }),
    ).toBe(16); // 4 scenes x 2 paragraphs x 2
  });
});

describe("snapDuration", () => {
  it("snaps to a length the model actually renders", () => {
    const kling = findVideoModel("kling-2.1-standard")!;
    expect(snapDuration(kling, 7)).toBe(5);
    expect(snapDuration(kling, 8)).toBe(10);
    expect(snapDuration(kling, 30)).toBe(10);
    expect(snapDuration(kling, 1)).toBe(5);
  });

  it("returns the only length when a model has one", () => {
    const veo = findVideoModel("veo-3")!;
    expect(snapDuration(veo, 3)).toBe(8);
    expect(snapDuration(veo, 30)).toBe(8);
  });
});

describe("resolveResolution", () => {
  it("honours a supported request", () => {
    expect(resolveResolution(findVideoModel("wan-2.5")!, "480p")).toBe("480p");
  });

  it("falls back to the model's best rather than failing", () => {
    // Asking a 720p-only model for 1080p is a client that has not read the
    // catalog; refusing would cost the user their video for no reason.
    expect(resolveResolution(findVideoModel("kling-2.1-standard")!, "1080p")).toBe("720p");
    expect(resolveResolution(findVideoModel("wan-2.2-fast")!, "1080p")).toBe("720p");
  });

  it("defaults to the best the model offers", () => {
    expect(resolveResolution(findVideoModel("wan-2.5")!, null)).toBe("1080p");
  });
});

describe("resolveModelOptions", () => {
  it("passes everything through untouched with no picked model", () => {
    // This is the whole safety property: an existing job resolves to exactly
    // the arguments it always passed.
    expect(resolveModelOptions({ durationSec: 7 })).toEqual({
      modelId: null,
      durationSec: 7,
      resolution: null,
      quality: null,
      generateAudio: null,
    });
    expect(resolveModelOptions(null)).toEqual({
      modelId: null,
      durationSec: 5,
      resolution: null,
      quality: null,
      generateAudio: null,
    });
  });

  it("resolves capability once a model is picked", () => {
    expect(
      resolveModelOptions({ modelId: "kling-2.1-standard", durationSec: 7 }),
    ).toEqual({
      modelId: "kling-2.1-standard",
      durationSec: 5,
      resolution: "720p",
      quality: null,
      generateAudio: null,
    });
  });

  it("drops flags the model does not understand", () => {
    // WAN has no quality switch and generates no audio; forwarding either
    // would be a 422 from Replicate on a job the tenant already paid for.
    const resolved = resolveModelOptions({
      modelId: "wan-2.5",
      quality: "high",
      generateAudio: true,
    });
    expect(resolved.quality).toBeNull();
    expect(resolved.generateAudio).toBeNull();
  });

  it("keeps flags the model does understand", () => {
    expect(resolveModelOptions({ modelId: "veo-3", generateAudio: true }).generateAudio).toBe(
      true,
    );
    expect(resolveModelOptions({ modelId: "seedance-2.0", quality: "high" }).quality).toBe("high");
  });
});

describe("isVideoModelId", () => {
  it("accepts catalog ids only", () => {
    expect(isVideoModelId("veo-3")).toBe(true);
    expect(isVideoModelId("google/veo-3")).toBe(false);
    expect(isVideoModelId("constructor")).toBe(false);
  });
});
