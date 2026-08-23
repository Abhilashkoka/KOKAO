import { describe, expect, it, vi } from "vitest";

import type OpenAI from "openai";

import {
  BEAT_PLANNER_TEMPLATE_BLOCKS,
  KIND_OPACITY,
  MAX_BEAT_MS,
  MIN_BEAT_MS,
  buildBeatPlannerPrompt,
  planBeats,
  repairBeats,
  type NarrationLine,
} from "./beatPlanner";

/** Six lines of 5s each: long enough that a pair clears the 4s floor. */
const LINES: NarrationLine[] = Array.from({ length: 6 }, (_, i) => ({
  index: i + 1,
  startMs: i * 5000,
  endMs: (i + 1) * 5000,
  text: `line ${i + 1}`,
}));

const raw = (
  firstLine: number,
  lastLine: number,
  kind: "graphic" | "lifestyle" | "product" | "data" = "lifestyle",
  query = "woman walking outdoors",
) => ({ firstLine, lastLine, query, kind });

/* ------------------------------------------------------------------ *
 * repairBeats
 * ------------------------------------------------------------------ */

describe("repairBeats", () => {
  it("turns line ranges into timings taken from the narration", () => {
    const { beats } = repairBeats([raw(1, 2), raw(3, 4)], LINES);
    expect(beats).toHaveLength(2);
    expect(beats[0]).toMatchObject({ startMs: 0, endMs: 10000, lineIndexes: [1, 2] });
    expect(beats[1]).toMatchObject({ startMs: 10000, endMs: 20000, lineIndexes: [3, 4] });
  });

  it("derives opacity from kind rather than taking it from the model", () => {
    const { beats } = repairBeats([raw(1, 2, "graphic"), raw(3, 4, "lifestyle")], LINES);
    expect(beats[0]!.opacity).toBe(KIND_OPACITY.graphic);
    expect(beats[1]!.opacity).toBe(KIND_OPACITY.lifestyle);
    expect(beats[1]!.opacity).toBeLessThan(beats[0]!.opacity);
  });

  it("always leaves the closing line bare", () => {
    const { beats, gaps, notes } = repairBeats([raw(1, 2), raw(3, 6)], LINES);
    expect(Math.max(...beats.map((b) => b.endMs))).toBeLessThanOrEqual(LINES[4]!.endMs);
    expect(gaps.at(-1)).toMatchObject({ endMs: 30000 });
    expect(notes.join(" ")).toMatch(/closing line/);
  });

  it("drops a beat that only covers the closing line", () => {
    const { beats, notes } = repairBeats([raw(1, 2), raw(6, 6)], LINES);
    expect(beats).toHaveLength(1);
    expect(notes.join(" ")).toMatch(/plays to camera/);
  });

  it("merges a beat too short to read into the one before it", () => {
    const short: NarrationLine[] = [
      { index: 1, startMs: 0, endMs: 6000, text: "a" },
      { index: 2, startMs: 6000, endMs: 8000, text: "b" },
      { index: 3, startMs: 8000, endMs: 20000, text: "c" },
    ];
    const { beats, notes } = repairBeats([raw(1, 1), raw(2, 2)], short);
    expect(beats).toHaveLength(1);
    expect(beats[0]!.endMs).toBe(8000);
    expect(beats[0]!.lineIndexes).toEqual([1, 2]);
    expect(notes.join(" ")).toMatch(/Merged/);
  });

  it("splits a beat over the ceiling on a line boundary", () => {
    const { beats, notes } = repairBeats([raw(1, 4)], LINES);
    expect(beats).toHaveLength(2);
    // Both halves are whole lines, and together they cover the original span.
    expect(beats[0]!.startMs).toBe(0);
    expect(beats[1]!.endMs).toBe(20000);
    expect(beats[0]!.endMs).toBe(beats[1]!.startMs);
    expect(beats.every((b) => b.endMs - b.startMs <= MAX_BEAT_MS)).toBe(true);
    expect(notes.join(" ")).toMatch(/Split/);
  });

  it("recursively splits very long ranges until every beat is within the ceiling", () => {
    const longLines: NarrationLine[] = Array.from({ length: 7 }, (_, i) => ({
      index: i + 1,
      startMs: i * 5000,
      endMs: (i + 1) * 5000,
      text: `line ${i + 1}`,
    }));
    const { beats } = repairBeats([raw(1, 6)], longLines);
    expect(beats.length).toBeGreaterThan(2);
    expect(beats.every((b) => b.endMs - b.startMs <= MAX_BEAT_MS)).toBe(true);
  });

  it("does not merge a short beat when that would exceed the ceiling", () => {
    const lines: NarrationLine[] = [
      { index: 1, startMs: 0, endMs: 11000, text: "long" },
      { index: 2, startMs: 11000, endMs: 13000, text: "short" },
      { index: 3, startMs: 13000, endMs: 18000, text: "closing" },
    ];
    const { beats, notes } = repairBeats([raw(1, 1), raw(2, 2)], lines);
    expect(beats).toHaveLength(2);
    expect(beats.every((b) => b.endMs - b.startMs <= MAX_BEAT_MS)).toBe(true);
    expect(notes.join(" ")).toMatch(/Kept.*separate/);
  });

  it("never produces a beat that starts mid-line", () => {
    const { beats } = repairBeats([raw(1, 2), raw(3, 5)], LINES);
    const starts = new Set(LINES.map((l) => l.startMs));
    const ends = new Set(LINES.map((l) => l.endMs));
    for (const b of beats) {
      expect(starts.has(b.startMs)).toBe(true);
      expect(ends.has(b.endMs)).toBe(true);
    }
  });

  it("drops a beat overlapping one already placed", () => {
    // Kept under the split ceiling on purpose: a 15s first beat would split
    // into two before the overlap rule ever ran, and the count would stop
    // saying anything about overlap.
    const { beats, notes } = repairBeats([raw(1, 2), raw(2, 3)], LINES);
    expect(beats).toHaveLength(1);
    expect(beats[0]!.lineIndexes).toEqual([1, 2]);
    expect(notes.join(" ")).toMatch(/already covered/);
  });

  it("drops a beat referring to lines that do not exist", () => {
    const { beats, notes } = repairBeats([raw(9, 11)], LINES);
    expect(beats).toHaveLength(0);
    expect(notes.join(" ")).toMatch(/do not exist/);
  });

  it("reports every uncovered stretch as a gap", () => {
    const { gaps } = repairBeats([raw(2, 3)], LINES);
    expect(gaps[0]).toMatchObject({ startMs: 0, endMs: 5000 });
    expect(gaps.at(-1)).toMatchObject({ startMs: 15000, endMs: 30000 });
  });

  it("says so when nothing usable survived", () => {
    const { beats, notes } = repairBeats([], LINES);
    expect(beats).toEqual([]);
    expect(notes.join(" ")).toMatch(/plays bare/);
  });

  it("produces beats the compositor can consume in order", () => {
    const { beats } = repairBeats([raw(1, 2), raw(3, 4)], LINES);
    for (let i = 1; i < beats.length; i += 1) {
      expect(beats[i]!.startMs).toBeGreaterThanOrEqual(beats[i - 1]!.endMs);
    }
    expect(beats.every((b) => b.endMs > b.startMs)).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * The template
 * ------------------------------------------------------------------ */

describe("beat planner template", () => {
  it("renders the governed blocks in order", () => {
    const prompt = buildBeatPlannerPrompt();
    expect(prompt.indexOf("ROLE")).toBeLessThan(prompt.indexOf("OUTPUT"));
  });

  it("states the constraints the repair pass enforces", () => {
    const prompt = buildBeatPlannerPrompt();
    expect(prompt).toContain(String(MIN_BEAT_MS / 1000));
    expect(prompt).toContain(String(MAX_BEAT_MS / 1000));
  });

  it("tells the model to leave the closing line bare and to keep queries English", () => {
    const prompt = buildBeatPlannerPrompt();
    expect(prompt).toMatch(/final line with no beat/i);
    expect(prompt).toMatch(/English/);
  });

  it("requires visual variety across consecutive beats", () => {
    const prompt = buildBeatPlannerPrompt();
    expect(prompt).toMatch(/SEQUENCE VARIETY/);
    expect(prompt).toMatch(/at least two of/i);
    expect(prompt).toMatch(/Never repeat.*adjacent beats/i);
  });

  it("forbids brand and real-person queries", () => {
    expect(buildBeatPlannerPrompt()).toMatch(/Never name a brand/i);
  });

  it("ships blocks in the shape prompt_template_versions stores", () => {
    for (const block of BEAT_PLANNER_TEMPLATE_BLOCKS) {
      expect(block).toMatchObject({
        id: expect.any(String),
        order: expect.any(Number),
        title: expect.any(String),
        content: expect.any(String),
        mandatory: true,
      });
    }
  });

  it("accepts governed blocks in place of the default", () => {
    const prompt = buildBeatPlannerPrompt([
      { order: 2, title: "Second", content: "b" },
      { order: 1, title: "First", content: "a" },
    ]);
    expect(prompt).toBe("FIRST\na\n\nSECOND\nb");
  });
});

/* ------------------------------------------------------------------ *
 * planBeats
 * ------------------------------------------------------------------ */

function fakeClient(body: string): { client: OpenAI; calls: string[] } {
  const calls: string[] = [];
  const create = vi.fn(async (params: Record<string, unknown>) => {
    const messages = params.messages as { role: string; content: string }[];
    calls.push(messages.find((m) => m.role === "user")?.content ?? "");
    return { choices: [{ message: { content: body } }] };
  });
  return { client: { chat: { completions: { create } } } as unknown as OpenAI, calls };
}

describe("planBeats", () => {
  it("plans, repairs and returns beats ready for the compositor", async () => {
    const { client } = fakeClient(
      JSON.stringify({
        beats: [
          { firstLine: 1, lastLine: 2, query: "crowded gym", kind: "lifestyle" },
          { firstLine: 3, lastLine: 4, query: "protein plate diagram", kind: "graphic" },
        ],
      }),
    );
    const result = await planBeats({ lines: LINES, client, model: "gpt-test" });
    expect(result.beats).toHaveLength(2);
    expect(result.beats[1]!.opacity).toBe(KIND_OPACITY.graphic);
    expect(result.gaps.length).toBeGreaterThan(0);
  });

  it("numbers the narration lines with their durations in the prompt", async () => {
    const { client, calls } = fakeClient('{"beats":[]}');
    await planBeats({ lines: LINES, client, model: "gpt-test" });
    expect(calls[0]).toContain("1. [5.0s] line 1");
    expect(calls[0]).toContain("30.0s total");
    expect(calls[0]).toMatch(/Adjacent beats must not reuse/i);
  });

  it("falls back to a safe kind when the model invents one", async () => {
    const { client } = fakeClient(
      JSON.stringify({ beats: [{ firstLine: 1, lastLine: 2, query: "x", kind: "hologram" }] }),
    );
    const result = await planBeats({ lines: LINES, client, model: "gpt-test" });
    expect(result.beats[0]!.kind).toBe("lifestyle");
  });

  it("survives unparseable output with an empty plan rather than throwing", async () => {
    const { client } = fakeClient("sorry, I can't do that");
    const result = await planBeats({ lines: LINES, client, model: "gpt-test" });
    expect(result.beats).toEqual([]);
    expect(result.notes.join(" ")).toMatch(/plays bare/);
  });

  it("skips beats with no query", async () => {
    const { client } = fakeClient(
      JSON.stringify({ beats: [{ firstLine: 1, lastLine: 2, query: "  ", kind: "graphic" }] }),
    );
    expect((await planBeats({ lines: LINES, client, model: "gpt-test" })).beats).toEqual([]);
  });

  it("refuses an empty narration", async () => {
    const { client } = fakeClient("{}");
    await expect(planBeats({ lines: [], client, model: "gpt-test" })).rejects.toThrow(/empty/);
  });

  it("passes usage-accounting params through", async () => {
    const create = vi.fn(async (_p: Record<string, unknown>) => ({
      choices: [{ message: { content: '{"beats":[]}' } }],
    }));
    const client = { chat: { completions: { create } } } as unknown as OpenAI;
    await planBeats({
      lines: LINES,
      client,
      model: "gpt-test",
      requestParams: { usage: { include: true } },
    });
    expect(create.mock.calls[0]![0]).toMatchObject({ usage: { include: true } });
  });
});