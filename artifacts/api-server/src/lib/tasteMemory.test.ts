import { describe, it, expect } from "vitest";
import {
  emptyPayload,
  parsePayload,
  applySignal,
  guidanceFromPayload,
  classifyLength,
  classifyHashtags,
  hasEmoji,
  decayFactor,
} from "./tasteMemory";

describe("classifiers", () => {
  it("classifies caption length", () => {
    expect(classifyLength("Short one")).toBe("short");
    expect(classifyLength("a".repeat(120))).toBe("medium");
    expect(classifyLength("a".repeat(300))).toBe("long");
  });

  it("classifies hashtag usage", () => {
    expect(classifyHashtags("no tags here")).toBe("none");
    expect(classifyHashtags("hi #one #two")).toBe("few");
    expect(classifyHashtags("#a #b #c #d #e #f")).toBe("many");
  });

  it("detects emoji", () => {
    expect(hasEmoji("plain text")).toBe(false);
    expect(hasEmoji("nice \u{1F600}")).toBe(true);
  });
});

describe("decayFactor", () => {
  it("is 1 for fresh signals and decreases over weeks", () => {
    const now = Date.now();
    expect(decayFactor(new Date(now).toISOString(), now)).toBeCloseTo(1);
    const fourWeeksAgo = new Date(now - 4 * 7 * 24 * 3600 * 1000).toISOString();
    expect(decayFactor(fourWeeksAgo, now)).toBeCloseTo(0.8, 1);
    const yearAgo = new Date(now - 52 * 7 * 24 * 3600 * 1000).toISOString();
    expect(decayFactor(yearAgo, now)).toBe(0);
  });

  it("treats invalid timestamps as no decay", () => {
    expect(decayFactor("not-a-date")).toBe(1);
  });
});

describe("parsePayload", () => {
  it("falls back to empty on garbage", () => {
    expect(parsePayload(null).counts.saved).toBe(0);
    expect(parsePayload("junk").counts.saved).toBe(0);
    expect(parsePayload({ version: 99 }).counts.saved).toBe(0);
  });

  it("preserves valid data and repairs missing arrays", () => {
    const p = emptyPayload();
    p.counts.saved = 4;
    const roundTripped = parsePayload(JSON.parse(JSON.stringify(p)));
    expect(roundTripped.counts.saved).toBe(4);
    const broken = { ...JSON.parse(JSON.stringify(p)), caption: { exemplars: "nope" } };
    expect(parsePayload(broken).caption.exemplars).toEqual([]);
  });
});

describe("applySignal", () => {
  it("records approvals with weights and exemplars", () => {
    const p = emptyPayload();
    applySignal(p, { kind: "published", caption: "Great short one", platform: "instagram" });
    expect(p.counts.published).toBe(1);
    expect(p.caption.lengthBuckets.short).toBe(3); // published weight
    expect(p.caption.exemplars[0]?.text).toBe("Great short one");
    expect(p.caption.exemplars[0]?.weight).toBe(3);
  });

  it("records discards as rejections, not approvals", () => {
    const p = emptyPayload();
    applySignal(p, { kind: "discarded", caption: "Bad caption" });
    expect(p.counts.discarded).toBe(1);
    expect(p.caption.lengthBuckets.short).toBe(0);
    expect(p.caption.exemplars).toHaveLength(0);
    expect(p.caption.rejected[0]?.text).toBe("Bad caption");
  });

  it("dedupes exemplars and caps the list", () => {
    const p = emptyPayload();
    for (let i = 0; i < 12; i++) {
      applySignal(p, { kind: "saved", caption: `caption number ${i}` });
    }
    applySignal(p, { kind: "saved", caption: "caption number 11" });
    expect(p.caption.exemplars.length).toBeLessThanOrEqual(8);
    expect(p.caption.exemplars.filter((e) => e.text === "caption number 11")).toHaveLength(1);
  });

  it("stores approved image prompts", () => {
    const p = emptyPayload();
    applySignal(p, { kind: "published", imagePrompt: "minimalist flat lay, pastel" });
    expect(p.image.exemplars[0]?.text).toContain("minimalist");
  });
});

describe("guidanceFromPayload", () => {
  it("returns nothing for an empty profile", () => {
    const g = guidanceFromPayload(emptyPayload());
    expect(g.captionLines).toEqual([]);
    expect(g.imageHint).toBeNull();
  });

  it("emits guidance once signal is strong enough", () => {
    const p = emptyPayload();
    for (let i = 0; i < 3; i++) {
      applySignal(p, { kind: "published", caption: "Punchy!" });
    }
    const g = guidanceFromPayload(p);
    expect(g.captionLines.join(" ")).toContain("short");
    expect(g.captionLines.join(" ")).toContain("Style reference");
    expect(g.captionLines[0]).toContain("soft guidance");
  });

  it("does not emit a length preference on mixed signals", () => {
    const p = emptyPayload();
    applySignal(p, { kind: "saved", caption: "short" });
    applySignal(p, { kind: "saved", caption: "b".repeat(150) });
    applySignal(p, { kind: "saved", caption: "c".repeat(300) });
    const g = guidanceFromPayload(p);
    expect(g.captionLines.join(" ")).not.toContain("prefers short");
  });

  it("builds an image hint from approved prompts", () => {
    const p = emptyPayload();
    applySignal(p, { kind: "published", imagePrompt: "bold neon 3D render" });
    const g = guidanceFromPayload(p);
    expect(g.imageHint).toContain("bold neon 3D render");
  });
});
