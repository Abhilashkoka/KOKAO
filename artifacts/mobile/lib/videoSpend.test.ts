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

  it("prefers the job's charge-time rate snapshot over the current rate", () => {
    // Admin later raised the rate; the persisted snapshot must win.
    expect(formatVideoAiSpend(9900, 4, 2500)).toBe("\u20B9100.00");
    // Snapshot works even when the current rate is zero/absent.
    expect(formatVideoAiSpend(0, 1, 2500)).toBe("\u20B925.00");
    expect(formatVideoAiSpend(undefined, 1, 2500)).toBe("\u20B925.00");
  });

  it("falls back to the current rate for legacy jobs with no snapshot", () => {
    expect(formatVideoAiSpend(500, 2, null)).toBe("\u20B910.00");
    expect(formatVideoAiSpend(500, 2, undefined)).toBe("\u20B910.00");
  });

  it("renders nothing when the snapshot says the job was free", () => {
    // A persisted 0 means the job really charged nothing, even if the
    // current rate is positive... but callers pass 0 to force-hide too
    // (kill switch), so 0 must always render nothing.
    expect(formatVideoAiSpend(500, 2, 0)).toBeNull();
  });

  it("prefers the job's snapshotted total spend over any rate x units estimate", () => {
    // Cost_plus mode: the real spend (cost + margin) rarely equals
    // rate x units — the snapshot must win outright, ignoring units.
    expect(formatVideoAiSpend(500, 4, 2500, 1234)).toBe("\u20B912.34");
    expect(formatVideoAiSpend(500, 4, null, 1234)).toBe("\u20B912.34");
  });

  it("never replaces a genuine zero snapshot with a nonzero estimate", () => {
    // A snapshotted 0 means the job really charged nothing; hiding the line
    // is fine, showing the flat/charged rate is not.
    expect(formatVideoAiSpend(500, 4, 2500, 0)).toBeNull();
  });

  it("falls back to rate x units when there is no total snapshot", () => {
    expect(formatVideoAiSpend(500, 2, 2500, null)).toBe("\u20B950.00");
    expect(formatVideoAiSpend(500, 2, 2500, undefined)).toBe("\u20B950.00");
  });

  it("uses Indian digit grouping for large amounts", () => {
    expect(formatVideoAiSpend(50_000, 250)).toBe("\u20B91,25,000.00");
  });
});
