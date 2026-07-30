import { describe, it, expect } from "vitest";
import {
  MAX_HISTORY,
  canRedo,
  canUndo,
  createHistory,
  historyTimeline,
  jumpTo,
  pushHistory,
  redo,
  undo,
} from "./history";

describe("history", () => {
  it("starts with nothing to undo or redo", () => {
    const history = createHistory("a");
    expect(canUndo(history)).toBe(false);
    expect(canRedo(history)).toBe(false);
    expect(history.present.state).toBe("a");
  });

  it("walks backwards and forwards through states", () => {
    let history = createHistory("a");
    history = pushHistory(history, "b", "B", { now: 1000 });
    history = pushHistory(history, "c", "C", { now: 5000 });

    expect(history.present.state).toBe("c");
    history = undo(history);
    expect(history.present.state).toBe("b");
    history = undo(history);
    expect(history.present.state).toBe("a");
    expect(canUndo(history)).toBe(false);

    history = redo(history);
    expect(history.present.state).toBe("b");
    history = redo(history);
    expect(history.present.state).toBe("c");
    expect(canRedo(history)).toBe(false);
  });

  it("is a no-op at either end rather than throwing", () => {
    const history = createHistory("a");
    expect(undo(history)).toBe(history);
    expect(redo(history)).toBe(history);
  });

  it("merges rapid edits that share a key into one entry", () => {
    // A slider drag fires a change per pixel of travel. Without this, one drag
    // buries the state the user actually wants to get back to.
    let history = createHistory("a");
    history = pushHistory(history, "b1", "Opacity", { mergeKey: "opacity:1", now: 1000 });
    history = pushHistory(history, "b2", "Opacity", { mergeKey: "opacity:1", now: 1200 });
    history = pushHistory(history, "b3", "Opacity", { mergeKey: "opacity:1", now: 1400 });

    expect(history.past).toHaveLength(1);
    expect(history.present.state).toBe("b3");
    expect(undo(history).present.state).toBe("a");
  });

  it("starts a new entry once the merge window has passed", () => {
    let history = createHistory("a");
    history = pushHistory(history, "b1", "Opacity", { mergeKey: "opacity:1", now: 1000 });
    history = pushHistory(history, "b2", "Opacity", { mergeKey: "opacity:1", now: 9000 });
    expect(history.past).toHaveLength(2);
  });

  it("does not merge across different keys", () => {
    let history = createHistory("a");
    history = pushHistory(history, "b", "Opacity", { mergeKey: "opacity:1", now: 1000 });
    history = pushHistory(history, "c", "Blur", { mergeKey: "blur:1", now: 1100 });
    expect(history.past).toHaveLength(2);
  });

  it("drops the redo branch when a new edit lands", () => {
    let history = createHistory("a");
    history = pushHistory(history, "b", "B", { now: 1000 });
    history = undo(history);
    expect(canRedo(history)).toBe(true);

    history = pushHistory(history, "c", "C", { now: 2000 });
    // Keeping it would let the user redo into a state that never followed from
    // what is on screen.
    expect(canRedo(history)).toBe(false);
    expect(history.present.state).toBe("c");
  });

  it("caps its depth so a long session cannot grow without bound", () => {
    let history = createHistory("start");
    for (let i = 0; i < MAX_HISTORY + 30; i += 1) {
      history = pushHistory(history, `s${i}`, `Step ${i}`, { now: i * 10_000 });
    }
    expect(history.past.length).toBeLessThanOrEqual(MAX_HISTORY);
    expect(history.present.state).toBe(`s${MAX_HISTORY + 29}`);
  });

  it("jumps to any point on the timeline, clamping out-of-range indices", () => {
    let history = createHistory("a");
    history = pushHistory(history, "b", "B", { now: 1000 });
    history = pushHistory(history, "c", "C", { now: 2000 });

    const { entries, currentIndex } = historyTimeline(history);
    expect(entries.map((e) => e.state)).toEqual(["a", "b", "c"]);
    expect(currentIndex).toBe(2);

    expect(jumpTo(history, 0).present.state).toBe("a");
    expect(jumpTo(history, 1).present.state).toBe("b");
    expect(jumpTo(history, -5).present.state).toBe("a");
    expect(jumpTo(history, 99).present.state).toBe("c");
  });

  it("keeps the timeline whole after jumping backwards", () => {
    let history = createHistory("a");
    history = pushHistory(history, "b", "B", { now: 1000 });
    history = pushHistory(history, "c", "C", { now: 2000 });
    const jumped = jumpTo(history, 0);
    expect(historyTimeline(jumped).entries.map((e) => e.state)).toEqual(["a", "b", "c"]);
    expect(canRedo(jumped)).toBe(true);
  });
});
