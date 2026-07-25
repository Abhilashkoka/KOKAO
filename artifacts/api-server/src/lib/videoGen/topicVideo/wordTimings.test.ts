import { describe, it, expect } from "vitest";
import { tokenizeCueText, cueWordTimings, buildCaptionChunks } from "./wordTimings";
import type { NarrationCue } from "./narration";

describe("tokenizeCueText", () => {
  it("splits space-separated text into words", () => {
    expect(tokenizeCueText("Start your day with intent.")).toEqual([
      "Start",
      "your",
      "day",
      "with",
      "intent.",
    ]);
  });

  it("breaks long CJK runs into short groups", () => {
    const tokens = tokenizeCueText("每天早上五点起床锻炼身体");
    expect(tokens.length).toBeGreaterThan(1);
    for (const token of tokens) expect(token.length).toBeLessThanOrEqual(4);
    expect(tokens.join("")).toBe("每天早上五点起床锻炼身体");
  });

  it("returns empty for whitespace", () => {
    expect(tokenizeCueText("   ")).toEqual([]);
  });
});

describe("cueWordTimings", () => {
  const cue: NarrationCue = { text: "Start your morning right", startSec: 2, endSec: 5 };

  it("covers the cue exactly, in order, with no gaps", () => {
    const words = cueWordTimings(cue);
    expect(words[0]!.startSec).toBe(2);
    expect(words[words.length - 1]!.endSec).toBe(5);
    for (let i = 1; i < words.length; i++) {
      expect(words[i]!.startSec).toBeCloseTo(words[i - 1]!.endSec, 6);
    }
  });

  it("gives longer words more time", () => {
    const words = cueWordTimings({ text: "a extraordinary", startSec: 0, endSec: 3 });
    const short = words[0]!.endSec - words[0]!.startSec;
    const long = words[1]!.endSec - words[1]!.startSec;
    expect(long).toBeGreaterThan(short * 3);
  });
});

describe("buildCaptionChunks", () => {
  const cues: NarrationCue[] = [
    { text: "Start your morning with one clear intention.", startSec: 0, endSec: 3 },
    { text: "Write it down.", startSec: 3.25, endSec: 4.5 },
  ];

  it("groups at most 3 words / ~16 chars per chunk", () => {
    const chunks = buildCaptionChunks(cues);
    for (const chunk of chunks) {
      expect(chunk.text.split(" ").length).toBeLessThanOrEqual(3);
      expect(chunk.text.length).toBeLessThanOrEqual(20); // 16 + slack for a long word
    }
  });

  it("never crosses a sentence boundary and stays in order", () => {
    const chunks = buildCaptionChunks(cues);
    const boundary = chunks.findIndex((c) => c.startSec >= 3.25);
    expect(boundary).toBeGreaterThan(0);
    // Every chunk before the boundary ends by the first cue's end.
    for (const chunk of chunks.slice(0, boundary)) expect(chunk.endSec).toBeLessThanOrEqual(3);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.startSec).toBeGreaterThanOrEqual(chunks[i - 1]!.startSec);
    }
  });

  it("reassembles the full text in order", () => {
    const text = buildCaptionChunks(cues)
      .map((c) => c.text)
      .join(" ");
    expect(text).toBe("Start your morning with one clear intention. Write it down.");
  });
});
