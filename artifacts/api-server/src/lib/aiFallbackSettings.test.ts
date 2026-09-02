import { describe, expect, it } from "vitest";
import { applyManualOrder } from "./aiFallbackSettings";

describe("applyManualOrder", () => {
  const candidates = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("retains the historical list when the family key is absent", () => {
    expect(applyManualOrder(candidates, undefined, (candidate) => candidate.id))
      .toEqual(candidates);
  });

  it("treats an explicit empty list as an intentionally disabled chain", () => {
    expect(applyManualOrder(candidates, [], (candidate) => candidate.id)).toEqual([]);
  });

  it("uses an exact saved order and never silently appends unknown candidates", () => {
    expect(applyManualOrder(candidates, ["c", "unknown", "a"], (candidate) => candidate.id))
      .toEqual([{ id: "c" }, { id: "a" }]);
  });
});