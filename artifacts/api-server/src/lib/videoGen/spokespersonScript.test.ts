import { describe, it, expect } from "vitest";
import {
  buildSpokespersonScriptPrompt,
  collectOpenItems,
  fitScriptToWordBudget,
  maxScriptChars,
  normalizeBeatDurations,
  type ScriptBeat,
} from "./spokespersonScript";
import { wordBudgetFor, type ResolvedScriptInputs } from "./scriptInputs";

function beat(over: Partial<ScriptBeat> & { id: string }): ScriptBeat {
  return {
    id: over.id,
    label: over.label ?? over.id,
    spoken: over.spoken ?? "words",
    onScreen: over.onScreen ?? "",
    bRoll: over.bRoll ?? "presenter hold",
    framing: over.framing ?? "medium",
    durationSec: over.durationSec ?? 5,
    note: over.note ?? null,
  };
}

function inputsFor(durationSeconds: number, wpm = 140): ResolvedScriptInputs {
  const { budget, min, max } = wordBudgetFor(durationSeconds, wpm);
  return {
    durationSeconds,
    wordsPerMinute: wpm,
    wordBudget: budget,
    wordBudgetMin: min,
    wordBudgetMax: max,
    audience: null,
    desiredTakeaway: null,
    cta: null,
    toneNote: null,
    presenterPersona: null,
    brandTerms: [],
    bannedTerms: [],
    sourceFacts: [],
    referenceStyle: null,
    runtimeContext: "",
  };
}

describe("maxScriptChars", () => {
  it("scales the cap with the request instead of a flat 2000", () => {
    // A 300s script at 200wpm is ~1000 words; the old flat cap rejected it.
    expect(maxScriptChars(inputsFor(300, 200))).toBeGreaterThan(8000);
  });

  it("never drops below the original floor for short scripts", () => {
    expect(maxScriptChars(inputsFor(15))).toBe(2000);
  });
});

describe("fitScriptToWordBudget", () => {
  it("keeps a 58-second draft at or below its hard spoken-word budget", () => {
    const { max } = wordBudgetFor(58, 140);
    const overlong = Array.from({ length: max + 30 }, (_, i) => `word${i + 1}`).join(" ");
    const fitted = fitScriptToWordBudget(overlong, max);
    expect(fitted.split(/\s+/)).toHaveLength(max);
  });

  it("prefers a complete sentence near the ceiling", () => {
    const words = [
      ...Array.from({ length: 7 }, (_, i) => `intro${i + 1}`),
      "done.",
      "extra",
      "words",
      "overflow",
    ].join(" ");
    expect(fitScriptToWordBudget(words, 10)).toBe(
      "intro1 intro2 intro3 intro4 intro5 intro6 intro7 done.",
    );
  });
});

describe("normalizeBeatDurations", () => {
  it("rescales beats that overrun the requested runtime", () => {
    const out = normalizeBeatDurations(
      [beat({ id: "b1", durationSec: 40 }), beat({ id: "b2", durationSec: 40 })],
      40,
    );
    expect(out.reduce((s, b) => s + b.durationSec, 0)).toBeCloseTo(40, 1);
  });

  it("preserves the model's relative pacing while rescaling", () => {
    const out = normalizeBeatDurations(
      [beat({ id: "b1", durationSec: 10 }), beat({ id: "b2", durationSec: 30 })],
      20,
    );
    expect(out[0]!.durationSec).toBeCloseTo(5, 1);
    expect(out[1]!.durationSec).toBeCloseTo(15, 1);
  });

  it("leaves a near-correct total alone rather than adding rounding noise", () => {
    const beats = [beat({ id: "b1", durationSec: 20 }), beat({ id: "b2", durationSec: 21 })];
    expect(normalizeBeatDurations(beats, 40)).toEqual(beats);
  });

  it("spreads evenly when every duration is unusable", () => {
    const out = normalizeBeatDurations(
      [beat({ id: "b1", durationSec: 0 }), beat({ id: "b2", durationSec: 0 })],
      30,
    );
    expect(out.map((b) => b.durationSec)).toEqual([15, 15]);
  });

  it("handles an empty beat list", () => {
    expect(normalizeBeatDurations([], 30)).toEqual([]);
  });
});

describe("collectOpenItems", () => {
  it("recovers a [VERIFY] flag the script cleaner stripped out", () => {
    // The regression this guards: cleanScript deletes every bracket, so a
    // flag left in the spoken text used to vanish without a trace.
    const items = collectOpenItems(
      null,
      ["[VERIFY: nine days is illustrative]", "[pause:short]"],
      [],
    );
    expect(items).toEqual(["nine days is illustrative"]);
  });

  it("also lifts flags out of beat text, which keeps its cues", () => {
    const items = collectOpenItems(
      null,
      [],
      [beat({ id: "b1", spoken: "We settle fast. [VERIFY: settlement window]" })],
    );
    expect(items).toEqual(["settlement window"]);
  });

  it("merges the model's own list, de-duplicated", () => {
    const items = collectOpenItems(
      ["settlement window", "Price needs sign-off"],
      ["[VERIFY: Settlement Window]"],
      [],
    );
    expect(items).toEqual(["settlement window", "Price needs sign-off"]);
  });

  it("ignores non-VERIFY cues", () => {
    expect(
      collectOpenItems(null, ["[pause:long]", "[tone:warm]", "[emphasis]"], []),
    ).toEqual([]);
  });

  it("gives a bare [VERIFY] a readable description", () => {
    expect(collectOpenItems(null, ["[VERIFY]"], [])).toEqual([
      "Unspecified claim needs confirming",
    ]);
  });
});

describe("buildSpokespersonScriptPrompt", () => {
  it("states the beat total and keeps cues out of the clean script", () => {
    const text = buildSpokespersonScriptPrompt("Weekly planning", inputsFor(45));
    expect(text).toContain("roughly 45 seconds");
    expect(text).toContain("HARD CEILING");
    expect(text).toContain('"script" is the clean spoken text');
    expect(text).toContain("Weekly planning");
  });
});
