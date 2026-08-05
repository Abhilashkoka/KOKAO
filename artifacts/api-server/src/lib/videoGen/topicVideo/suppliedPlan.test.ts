import { describe, it, expect } from "vitest";
import {
  validateSuppliedPlan,
  isSuppliedPlan,
  MAX_SUPPLIED_PLAN_BYTES,
} from "./suppliedPlan";

describe("validateSuppliedPlan", () => {
  it("accepts a well-formed b-roll plan", () => {
    expect(
      validateSuppliedPlan("broll", { style: "warm dawn", prompts: ["a close-up", "hands"] }),
    ).toBeNull();
    // style is optional
    expect(validateSuppliedPlan("broll", { prompts: ["a"] })).toBeNull();
  });

  it("accepts a well-formed character plan", () => {
    expect(
      validateSuppliedPlan("character", {
        scenes: [{ visual: "waking up" }, { visual: "gym", outfitId: 11 }],
      }),
    ).toBeNull();
  });

  it("rejects non-objects and empty or missing lists with clear messages", () => {
    expect(validateSuppliedPlan("broll", null)).toMatch(/JSON object/);
    expect(validateSuppliedPlan("broll", [1, 2])).toMatch(/JSON object/);
    expect(validateSuppliedPlan("broll", { prompts: [] })).toMatch(/prompts/);
    expect(validateSuppliedPlan("broll", { style: "x" })).toMatch(/prompts/);
    expect(validateSuppliedPlan("character", { scenes: [] })).toMatch(/scenes/);
    expect(validateSuppliedPlan("character", { prompts: ["a"] })).toMatch(/scenes/);
  });

  it("rejects malformed entries instead of silently fixing them", () => {
    expect(validateSuppliedPlan("broll", { prompts: ["ok", "   "] })).toMatch(/Prompt 2/);
    expect(validateSuppliedPlan("broll", { prompts: ["ok", 42] })).toMatch(/Prompt 2/);
    expect(validateSuppliedPlan("broll", { prompts: ["a"], style: 9 })).toMatch(/style/);
    expect(validateSuppliedPlan("character", { scenes: ["nope"] })).toMatch(/Scene 1/);
    expect(validateSuppliedPlan("character", { scenes: [{ visual: "" }] })).toMatch(/Scene 1/);
    expect(
      validateSuppliedPlan("character", { scenes: [{ visual: "ok", outfitId: "10" }] }),
    ).toMatch(/outfitId/);
  });

  it("bounds sizes: entry counts, entry lengths, and total bytes", () => {
    expect(
      validateSuppliedPlan("broll", { prompts: Array.from({ length: 101 }, () => "p") }),
    ).toMatch(/at most/);
    expect(validateSuppliedPlan("broll", { prompts: ["x".repeat(2001)] })).toMatch(/too long/);
    expect(
      validateSuppliedPlan("broll", {
        prompts: Array.from({ length: 60 }, () => "y".repeat(1900)),
      }),
    ).toMatch(/too large/);
    expect(MAX_SUPPLIED_PLAN_BYTES).toBe(100_000);
  });
});

describe("isSuppliedPlan", () => {
  it("guards the persisted options shape", () => {
    expect(isSuppliedPlan({ flow: "broll", raw: { prompts: ["a"] } })).toBe(true);
    expect(isSuppliedPlan({ flow: "character", raw: null })).toBe(true);
    expect(isSuppliedPlan({ flow: "stock", raw: {} })).toBe(false);
    expect(isSuppliedPlan({ flow: "broll" })).toBe(false);
    expect(isSuppliedPlan(null)).toBe(false);
  });
});
