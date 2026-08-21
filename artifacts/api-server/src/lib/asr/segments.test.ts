import { describe, expect, it } from "vitest";

import { groupWordsIntoSegments, normalizeSegments, secondsToMs } from "./segments";

describe("secondsToMs", () => {
  it("converts and rounds", () => {
    expect(secondsToMs(1.234)).toBe(1234);
    expect(secondsToMs(0)).toBe(0);
  });

  it("returns NaN for values a provider omitted", () => {
    expect(Number.isNaN(secondsToMs(undefined))).toBe(true);
    expect(Number.isNaN(secondsToMs(null))).toBe(true);
    expect(Number.isNaN(secondsToMs("abc"))).toBe(true);
  });
});

describe("normalizeSegments", () => {
  it("drops empty, zero-length and non-finite spans", () => {
    expect(
      normalizeSegments([
        { startMs: 0, endMs: 1000, text: "   " },
        { startMs: 1000, endMs: 1000, text: "zero length" },
        { startMs: NaN, endMs: 2000, text: "no start" },
        { startMs: 2000, endMs: 3000, text: "keep me" },
      ]),
    ).toEqual([{ startMs: 2000, endMs: 3000, text: "keep me" }]);
  });

  it("collapses internal whitespace", () => {
    expect(normalizeSegments([{ startMs: 0, endMs: 1000, text: " a   b \n c " }])[0]!.text).toBe(
      "a b c",
    );
  });

  it("sorts by start time", () => {
    const out = normalizeSegments([
      { startMs: 5000, endMs: 6000, text: "second" },
      { startMs: 0, endMs: 1000, text: "first" },
    ]);
    expect(out.map((s) => s.text)).toEqual(["first", "second"]);
  });

  it("trims an overlap rather than losing the line", () => {
    const out = normalizeSegments([
      { startMs: 0, endMs: 2000, text: "one" },
      { startMs: 1800, endMs: 4000, text: "two" },
    ]);
    expect(out).toEqual([
      { startMs: 0, endMs: 2000, text: "one" },
      { startMs: 2000, endMs: 4000, text: "two" },
    ]);
  });

  it("drops a span fully swallowed by its predecessor", () => {
    const out = normalizeSegments([
      { startMs: 0, endMs: 5000, text: "long" },
      { startMs: 1000, endMs: 2000, text: "inside" },
    ]);
    expect(out).toHaveLength(1);
  });

  it("rounds fractional milliseconds", () => {
    expect(normalizeSegments([{ startMs: 10.4, endMs: 999.6, text: "x" }])).toEqual([
      { startMs: 10, endMs: 1000, text: "x" },
    ]);
  });
});

describe("groupWordsIntoSegments", () => {
  const words = (specs: [string, number, number][]) =>
    specs.map(([text, startMs, endMs]) => ({ text, startMs, endMs }));

  it("breaks on sentence-final punctuation", () => {
    const out = groupWordsIntoSegments(
      words([
        ["Everything", 0, 400],
        ["you", 400, 600],
        ["need.", 600, 1000],
        ["In", 1200, 1400],
        ["one", 1400, 1600],
        ["place.", 1600, 2000],
      ]),
    );
    expect(out).toEqual([
      { startMs: 0, endMs: 1000, text: "Everything you need." },
      { startMs: 1200, endMs: 2000, text: "In one place." },
    ]);
  });

  it("breaks on length when the speaker never stops", () => {
    const spec: [string, number, number][] = Array.from({ length: 12 }, (_, i) => [
      `word${i}`,
      i * 1000,
      i * 1000 + 900,
    ]);
    const out = groupWordsIntoSegments(words(spec));
    expect(out.length).toBeGreaterThan(1);
    for (const segment of out) {
      expect(segment.endMs - segment.startMs).toBeLessThanOrEqual(8000);
    }
  });

  it("handles a trailing fragment with no final punctuation", () => {
    const out = groupWordsIntoSegments(
      words([
        ["Try", 0, 300],
        ["it", 300, 500],
      ]),
    );
    expect(out).toEqual([{ startMs: 0, endMs: 500, text: "Try it" }]);
  });

  it("ignores blank words", () => {
    const out = groupWordsIntoSegments(
      words([
        ["  ", 0, 100],
        ["Hello.", 100, 500],
      ]),
    );
    expect(out).toEqual([{ startMs: 100, endMs: 500, text: "Hello." }]);
  });

  it("returns nothing for no words", () => {
    expect(groupWordsIntoSegments([])).toEqual([]);
  });

  it("treats a closing quote after the stop as sentence-final", () => {
    const out = groupWordsIntoSegments(
      words([
        ['"Done."', 0, 500],
        ["Next", 700, 900],
      ]),
    );
    expect(out).toHaveLength(2);
  });
});
