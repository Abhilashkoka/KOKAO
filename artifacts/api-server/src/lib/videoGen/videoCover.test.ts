import { describe, it, expect } from "vitest";
import {
  coverFrameTimestamps,
  coverImagePrompt,
  genericCoverImagePrompt,
  coverShape,
  hasOnlyCoverPathKey,
  resolveCoverOutfit,
  COVER_CANDIDATE_COUNT,
  COVER_INTENSITIES,
} from "./videoCover";

describe("hasOnlyCoverPathKey", () => {
  it("accepts exactly the one key it expects", () => {
    expect(hasOnlyCoverPathKey({ coverPath: "/objects/1/uploads/a.png" })).toBe(true);
  });

  it("rejects extra keys instead of letting the parser strip them", () => {
    // The generated zod parser strips unknown properties and reports success,
    // so a boundary that takes a storage path cannot rely on it to prove a
    // rejection happened. Each of these must be refused outright.
    for (const body of [
      { coverPath: "/objects/1/uploads/a.png", tenantId: 2 },
      { coverPath: "/objects/1/uploads/a.png", thumbnailPath: "/objects/2/uploads/b.png" },
    ]) {
      expect(hasOnlyCoverPathKey(body)).toBe(false);
    }
  });

  it("rejects a prototype-polluting body as express would actually receive it", () => {
    // Built through JSON.parse rather than as a literal, because that is the
    // difference that matters: a literal's `__proto__:` sets the prototype and
    // adds no own key, while JSON.parse makes it a real own property. Only the
    // parsed form reproduces what arrives over the wire.
    const body = JSON.parse('{"coverPath":"/objects/1/uploads/a.png","__proto__":{"admin":true}}');
    expect(Object.keys(body)).toContain("__proto__");
    expect(hasOnlyCoverPathKey(body)).toBe(false);
  });

  it("rejects anything that is not a plain object", () => {
    for (const body of [null, undefined, [], "coverPath", 7, {}]) {
      expect(hasOnlyCoverPathKey(body)).toBe(false);
    }
  });
});

describe("resolveCoverOutfit", () => {
  const outfits = [
    { id: 1, isDefault: false },
    { id: 2, isDefault: true },
    { id: 3, isDefault: false },
  ];

  it("prefers the outfit the job actually locked", () => {
    expect(resolveCoverOutfit(outfits, 3)?.id).toBe(3);
  });

  it("falls back to the default, then to whatever exists", () => {
    expect(resolveCoverOutfit(outfits, null)?.id).toBe(2);
    expect(resolveCoverOutfit([{ id: 9, isDefault: false }], null)?.id).toBe(9);
  });

  it("falls back rather than returning nothing when the locked id is gone", () => {
    // A cover with no outfit is a 400 the user cannot act on; the default is a
    // better answer than a refusal.
    expect(resolveCoverOutfit(outfits, 404)?.id).toBe(2);
  });

  it("has nothing to offer when the snapshot has no outfits", () => {
    expect(resolveCoverOutfit([], 1)).toBeUndefined();
    expect(resolveCoverOutfit(undefined, 1)).toBeUndefined();
  });
});

describe("coverFrameTimestamps", () => {
  it("skips the opening, where every shot is still its keyframe", () => {
    // A scene opens on the composed still, before any motion, and openings
    // carry fades. 1.0s — the old fixed poster point — is the worst place to
    // look for an interesting frame, not the best.
    for (const t of coverFrameTimestamps(20)) expect(t).toBeGreaterThan(0.4);
  });

  it("never lands on the final frame, which is often a fade or a black tail", () => {
    const stamps = coverFrameTimestamps(20);
    expect(Math.max(...stamps)).toBeLessThan(20);
  });

  it("spreads evenly, so the third tile really is a third of the way in", () => {
    const stamps = coverFrameTimestamps(30, 6);
    const gaps = stamps.slice(1).map((t, i) => t - stamps[i]!);
    for (const gap of gaps) expect(Math.abs(gap - gaps[0]!)).toBeLessThan(0.05);
  });

  it("returns them in order, ready to show in a grid", () => {
    const stamps = coverFrameTimestamps(20);
    expect([...stamps].sort((a, b) => a - b)).toEqual(stamps);
    expect(stamps).toHaveLength(COVER_CANDIDATE_COUNT);
  });

  it("thins the grid rather than repeating one frame on a short video", () => {
    // Nine candidates out of a 2-second clip would be near-duplicates at
    // 30fps. Fewer real choices beats nine copies of the same face.
    const short = coverFrameTimestamps(2);
    expect(short.length).toBeLessThan(COVER_CANDIDATE_COUNT);
    expect(new Set(short).size).toBe(short.length);
  });

  it("survives a video whose duration could not be probed", () => {
    // probeDurationSec returns null on a damaged file and the caller passes 0.
    // One frame at the start beats throwing away the user's cover picker.
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(coverFrameTimestamps(bad)).toEqual([0]);
    }
  });
});

describe("coverShape", () => {
  it("groups every catalog aspect into a composition it can actually use", () => {
    expect(coverShape("9:16")).toBe("vertical");
    expect(coverShape("4:5")).toBe("vertical");
    expect(coverShape("3:4")).toBe("vertical");
    expect(coverShape("16:9")).toBe("wide");
    expect(coverShape("21:9")).toBe("wide");
    expect(coverShape("4:3")).toBe("wide");
    expect(coverShape("1:1")).toBe("square");
  });
});

describe("coverImagePrompt", () => {
  const base = {
    characterDescription: "a paediatrician",
    outfitName: "Ward round",
    outfitDescription: "blue saree under a white coat",
    sceneVisual: "a busy hospital corridor",
    aspect: "9:16" as const,
    intensity: "extreme" as const,
  };

  it("keeps the same identity and wardrobe contract as a scene keyframe", () => {
    // A cover that is a different person, or the same person in different
    // clothes, is worse than no cover: it misrepresents the video it fronts.
    const prompt = coverImagePrompt(base);
    expect(prompt).toMatch(/reference image is authoritative for identity and clothing only/i);
    expect(prompt).toContain("blue saree under a white coat");
    expect(prompt).toMatch(/identical face, hair, body and identity/i);
    expect(prompt).toMatch(/Do not copy the reference's background/i);
    expect(prompt).toContain("a busy hospital corridor");
  });

  it("asks for the expression the video is not allowed to have", () => {
    // The animation stage now holds a calm face for the whole shot, by design.
    // A cover is one frame competing for a glance, and wants the opposite.
    const extreme = coverImagePrompt(base);
    expect(extreme).toMatch(/eyes very wide/i);
    expect(extreme).toMatch(/shock and surprise/i);

    const natural = coverImagePrompt({ ...base, intensity: "natural" });
    expect(natural).toMatch(/genuine open smile/i);
    expect(natural).not.toMatch(/shock/i);
  });

  it("composes for the shape instead of cropping one image three ways", () => {
    // The wide cover is the whole reason generation exists: a 9:16 frame
    // cropped to 16:9 is 1080x608, which either beheads the subject or leaves
    // them unreadably small.
    const wide = coverImagePrompt({ ...base, aspect: "16:9" });
    const vertical = coverImagePrompt({ ...base, aspect: "9:16" });
    expect(wide).toMatch(/placed to one side/i);
    expect(vertical).toMatch(/upper two thirds/i);
    expect(wide).not.toBe(vertical);
  });

  it("leaves room for a title in the shapes that get one", () => {
    for (const aspect of ["9:16", "16:9"] as const) {
      expect(coverImagePrompt({ ...base, aspect })).toMatch(/for a title/i);
    }
  });

  it("bans text, because the title is added by whoever posts it", () => {
    for (const intensity of COVER_INTENSITIES) {
      expect(coverImagePrompt({ ...base, intensity })).toMatch(
        /No text, no watermark, no logos, no captions/i,
      );
    }
  });

  it("works for a character with no description", () => {
    const prompt = coverImagePrompt({ ...base, characterDescription: null });
    expect(prompt).not.toContain("()");
    expect(prompt).toMatch(/exact character from the reference\./i);
  });
});

describe("genericCoverImagePrompt", () => {
  it("supports generated covers for videos without a character reference", () => {
    const prompt = genericCoverImagePrompt({
      topic: "How solar power changes city life",
      sceneVisual: "solar panels above a busy modern neighbourhood",
      aspect: "16:9",
      intensity: "bold",
    });
    expect(prompt).toContain("How solar power changes city life");
    expect(prompt).toContain("solar panels above a busy modern neighbourhood");
    expect(prompt).toMatch(/placed to one side/i);
    expect(prompt).toMatch(/No text, no watermark, no logos, no captions/i);
    expect(prompt).toMatch(/Do not invent a presenter/i);
  });
});
