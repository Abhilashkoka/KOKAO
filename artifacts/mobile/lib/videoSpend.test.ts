import { describe, expect, it } from "vitest";

import { formatVideoAiSpend } from "./videoSpend";

describe("formatVideoAiSpend", () => {
  it("shows the plain rate for a single-unit job", () => {
    expect(formatVideoAiSpend(500, 1)).toBe("\u20B95.00");
    // Missing units (older payloads) behaves like a single unit.
    expect(formatVideoAiSpend(500, undefined)).toBe("\u20B95.00");
  });

  it("multiplies the rate by the job's units for multi-scene jobs", () => {
    expect(formatVideoAiSpend(500, 4)).toBe("\u20B920.00");
  });

  it("clamps nonsense unit counts up to 1", () => {
    expect(formatVideoAiSpend(500, 0)).toBe("\u20B95.00");
  });

  it("renders nothing when the rate is zero or absent (flag off)", () => {
    expect(formatVideoAiSpend(0, 3)).toBeNull();
    expect(formatVideoAiSpend(null, 3)).toBeNull();
    expect(formatVideoAiSpend(undefined, 3)).toBeNull();
  });

  it("uses Indian digit grouping for large amounts", () => {
    expect(formatVideoAiSpend(50_000, 250)).toBe("\u20B91,25,000.00");
  });
});
