import { describe, it, expect } from "vitest";
import { mergeCoverCandidates } from "./video-studio";

const frame = (path: string, atSec: number) =>
  ({ path, source: "frame" as const, atSec });

describe("mergeCoverCandidates", () => {
  it("appends generated covers to the frames rather than replacing them", () => {
    // Generating is an additive request — the user asked for more options, not
    // different ones — and it costs credits, so throwing the frames away would
    // make the cheap choice unreachable without a second extraction.
    const frames = [frame("/a", 1), frame("/b", 2)];
    const merged = mergeCoverCandidates(frames, [
      { path: "/gen1", source: "generated", intensity: "bold" },
    ]);

    expect(merged.map((c) => c.path)).toEqual(["/a", "/b", "/gen1"]);
  });

  it("keeps a repeated path in its original position", () => {
    // The grid must not reorder under a pending click: a tile the user is
    // reaching for has to still be the tile they hit.
    const merged = mergeCoverCandidates(
      [frame("/a", 1), frame("/b", 2)],
      [frame("/b", 9), frame("/c", 3)],
    );

    expect(merged.map((c) => c.path)).toEqual(["/a", "/b", "/c"]);
    expect(merged.find((c) => c.path === "/b")?.atSec).toBe(2);
  });

  it("dedupes within a single incoming batch too", () => {
    const merged = mergeCoverCandidates([], [frame("/a", 1), frame("/a", 5)]);
    expect(merged).toHaveLength(1);
  });

  it("starts from the current cover so putting it back needs no undo", () => {
    const merged = mergeCoverCandidates(
      [{ path: "/current", source: "upload" }],
      [frame("/a", 1)],
    );
    expect(merged[0]!.path).toBe("/current");
  });

  it("leaves the existing list untouched", () => {
    const existing = [frame("/a", 1)];
    mergeCoverCandidates(existing, [frame("/b", 2)]);
    expect(existing).toHaveLength(1);
  });
});
