import { describe, it, expect, beforeEach } from "vitest";
import {
  recordProviderSuccess,
  recordProviderFailure,
  resetProviderHealthForTests,
} from "./providerHealth";
import { rankProviders, explainWinner } from "./providerScore";

/**
 * The arithmetic is asserted with literal numbers on purpose. Re-deriving the
 * weights inside the test would make it pass for any weights at all, which is
 * exactly the change these tests exist to catch.
 *
 * Baseline for an unseen, unpriced, unrated candidate:
 *   reliability (0 + 3*0.8)/(0+3) = 0.8, everything else neutral at 0.5
 *   0.8*0.4 + 0.5*0.15 + 0.5*0.2 + 0.5*0.25 = 0.62
 */
const BASELINE = 0.62;

describe("rankProviders scoring", () => {
  beforeEach(() => {
    resetProviderHealthForTests();
  });

  it("scores an unseen candidate at the neutral baseline", () => {
    const [only] = rankProviders([{ id: "a", key: "imagegen:a" }]);
    expect(only?.score).toBe(BASELINE);
    expect(only?.parts.reliability).toBeCloseTo(0.8, 6);
    expect(only?.parts).toMatchObject({ latency: 0.5, cost: 0.5, quality: 0.5 });
  });

  it("keeps the caller's order when scores tie", () => {
    const ranked = rankProviders([
      { id: "second", key: "imagegen:second" },
      { id: "first", key: "imagegen:first" },
    ]);
    expect(ranked.map((r) => r.id)).toEqual(["second", "first"]);
    expect(ranked.every((r) => r.score === BASELINE)).toBe(true);
  });

  it("rewards a good recent record and punishes a bad one", () => {
    for (let i = 0; i < 9; i++) recordProviderSuccess("imagegen:good");
    for (let i = 0; i < 9; i++) recordProviderFailure("imagegen:bad");
    // Both breakers matter: "bad" is open, so compare parts, not order.
    const ranked = rankProviders([
      { id: "bad", key: "imagegen:bad" },
      { id: "good", key: "imagegen:good" },
    ]);
    const good = ranked.find((r) => r.id === "good")!;
    const bad = ranked.find((r) => r.id === "bad")!;
    // (9 + 2.4) / (9 + 3) = 0.95
    expect(good.parts.reliability).toBeCloseTo(0.95, 4);
    // (0 + 2.4) / (9 + 3) = 0.2
    expect(bad.parts.reliability).toBeCloseTo(0.2, 4);
  });

  it("does not brand a provider unusable after a single failure", () => {
    recordProviderFailure("imagegen:unlucky");
    const [only] = rankProviders([{ id: "unlucky", key: "imagegen:unlucky" }]);
    // (0 + 2.4) / (1 + 3) = 0.6 — worse than the 0.8 prior, not catastrophic.
    expect(only?.parts.reliability).toBeCloseTo(0.6, 4);
  });

  it("scores cost only relative to the other candidates", () => {
    const ranked = rankProviders([
      { id: "dear", key: "imagegen:dear", costPaise: 500 },
      { id: "cheap", key: "imagegen:cheap", costPaise: 100 },
    ]);
    expect(ranked.map((r) => r.id)).toEqual(["cheap", "dear"]);
    expect(ranked[0]?.parts.cost).toBe(1);
    expect(ranked[1]?.parts.cost).toBe(0);
    // 0.62 baseline shifted by the cost axis (weight 0.2) alone.
    expect(ranked[0]?.score).toBe(0.72);
    expect(ranked[1]?.score).toBe(0.52);
  });

  it("drops cost entirely when only one candidate is priced", () => {
    const ranked = rankProviders([
      { id: "priced", key: "imagegen:priced", costPaise: 100 },
      { id: "unpriced", key: "imagegen:unpriced" },
    ]);
    // The one priced provider must not win just for having a price on file.
    expect(ranked.every((r) => r.parts.cost === 0.5)).toBe(true);
    expect(ranked.every((r) => r.score === BASELINE)).toBe(true);
  });

  it("scores equal prices neutrally instead of dividing by zero", () => {
    const ranked = rankProviders([
      { id: "a", key: "imagegen:a", costPaise: 250 },
      { id: "b", key: "imagegen:b", costPaise: 250 },
    ]);
    expect(ranked.every((r) => Number.isFinite(r.score))).toBe(true);
    expect(ranked.every((r) => r.parts.cost === 0.5)).toBe(true);
  });

  it("treats the latency reference as the neutral point", () => {
    recordProviderSuccess("imagegen:a", 10_000);
    const [atReference] = rankProviders([{ id: "a", key: "imagegen:a" }], {
      latencyReferenceMs: 10_000,
    });
    expect(atReference?.parts.latency).toBeCloseTo(0.5, 4);

    resetProviderHealthForTests();
    recordProviderSuccess("imagegen:a", 10_000);
    const [underReference] = rankProviders([{ id: "a", key: "imagegen:a" }], {
      latencyReferenceMs: 30_000,
    });
    // The same 10s is fast for image work: 30000 / 40000 = 0.75.
    expect(underReference?.parts.latency).toBeCloseTo(0.75, 4);
  });

  it("passes an editorial quality tier straight through", () => {
    const ranked = rankProviders([
      { id: "meh", key: "imagegen:meh", quality: 0.7 },
      { id: "great", key: "imagegen:great", quality: 0.9 },
    ]);
    expect(ranked.map((r) => r.id)).toEqual(["great", "meh"]);
    expect(ranked[0]?.parts.quality).toBe(0.9);
  });

  it("never ranks an open breaker above a working provider", () => {
    // "star" is cheap, fast, flawless and top-rated. It is also broken.
    for (let i = 0; i < 10; i++) recordProviderSuccess("imagegen:star", 100);
    for (let i = 0; i < 3; i++) recordProviderFailure("imagegen:star", "503");
    const ranked = rankProviders([
      { id: "star", key: "imagegen:star", quality: 1, costPaise: 1 },
      { id: "plain", key: "imagegen:plain", costPaise: 900 },
    ]);
    expect(ranked.map((r) => r.id)).toEqual(["plain", "star"]);
    expect(ranked[1]?.healthy).toBe(false);
  });

  it("recovers a provider's place once its cooldown lapses", () => {
    for (let i = 0; i < 3; i++) recordProviderFailure("imagegen:star");
    expect(rankProviders([{ id: "star", key: "imagegen:star" }])[0]?.healthy).toBe(false);
    recordProviderSuccess("imagegen:star");
    expect(rankProviders([{ id: "star", key: "imagegen:star" }])[0]?.healthy).toBe(true);
  });

  it("returns an empty ranking for no candidates", () => {
    expect(rankProviders([])).toEqual([]);
  });
});

describe("rankProviders reasons", () => {
  beforeEach(() => {
    resetProviderHealthForTests();
  });

  it("says so plainly when a provider has never been called", () => {
    const [only] = rankProviders([{ id: "a", key: "imagegen:a" }]);
    expect(only?.reason).toBe("not tried yet");
  });

  it("reports the record, speed, price and quality it used", () => {
    recordProviderSuccess("imagegen:a", 2_000);
    recordProviderSuccess("imagegen:a", 2_000);
    const [only] = rankProviders([
      { id: "a", key: "imagegen:a", quality: 0.9, costPaise: 350 },
    ]);
    expect(only?.reason).toBe("2/2 ok · ~2.0s · ₹3.50 · quality 0.90");
  });

  it("leads with the breaker when it is open", () => {
    for (let i = 0; i < 3; i++) recordProviderFailure("imagegen:a");
    const [only] = rankProviders([{ id: "a", key: "imagegen:a" }]);
    expect(only?.reason.startsWith("breaker open · ")).toBe(true);
  });
});

describe("explainWinner", () => {
  beforeEach(() => {
    resetProviderHealthForTests();
  });

  it("has nothing to say about an empty ranking", () => {
    expect(explainWinner([])).toBeUndefined();
  });

  it("names the winner and its evidence with no rival to cite", () => {
    const ranked = rankProviders([{ id: "solo", key: "imagegen:solo" }]);
    expect(explainWinner(ranked)).toBe("solo won on not tried yet (0.62)");
  });

  it("contrasts the winner with the runner-up", () => {
    const ranked = rankProviders([
      { id: "cheap", key: "imagegen:cheap", costPaise: 100 },
      { id: "dear", key: "imagegen:dear", costPaise: 500 },
    ]);
    expect(explainWinner(ranked)).toBe(
      "cheap won on not tried yet · ₹1.00 (0.72), ahead of dear (0.52)",
    );
  });

  it("truncates to fit the usage-row column", () => {
    const ranked = rankProviders([
      { id: "x".repeat(300), key: "imagegen:long" },
      { id: "y", key: "imagegen:y" },
    ]);
    const text = explainWinner(ranked)!;
    expect(text.length).toBe(200);
    expect(text.endsWith("…")).toBe(true);
  });
});
