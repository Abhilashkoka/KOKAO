/**
 * Undo history.
 *
 * A plain snapshot stack. The document is immutable data and every edit
 * already produces a fresh tree, so storing whole states costs a few pointers
 * per entry rather than a deep copy, and undo becomes an assignment instead of
 * a pile of inverse operations that each have to be written and each have to
 * be right.
 *
 * The two things that stop the naive version being good enough:
 *
 *  - Coalescing. Dragging an opacity slider fires a change per pixel of travel.
 *    Without merging, one drag buries the user's real previous state under
 *    ninety entries. Entries with the same `mergeKey` arriving within
 *    `MERGE_WINDOW_MS` collapse into the newest one.
 *  - A depth cap. A 1024² document with a dozen layers is not small, and an
 *    unbounded stack in a long editing session is a tab that gets killed.
 */

export interface HistoryEntry<T> {
  /** What the user did, shown in the history panel: "Move layer", "Blur". */
  label: string;
  state: T;
  /** Entries sharing a key merge while the user is still doing the same thing. */
  mergeKey?: string;
  at: number;
}

export interface History<T> {
  past: HistoryEntry<T>[];
  present: HistoryEntry<T>;
  future: HistoryEntry<T>[];
}

export const MAX_HISTORY = 80;
export const MERGE_WINDOW_MS = 700;

export function createHistory<T>(state: T, label = "Open"): History<T> {
  return { past: [], present: { label, state, at: 0 }, future: [] };
}

/**
 * Push a new state.
 *
 * `now` is injected rather than read from Date.now() so coalescing is
 * deterministic under test — the merge window is the whole behaviour worth
 * testing here and it is invisible if the clock is ambient.
 */
export function pushHistory<T>(
  history: History<T>,
  state: T,
  label: string,
  options: { mergeKey?: string; now?: number } = {},
): History<T> {
  const now = options.now ?? Date.now();
  const entry: HistoryEntry<T> = { label, state, mergeKey: options.mergeKey, at: now };

  const canMerge =
    !!options.mergeKey &&
    history.present.mergeKey === options.mergeKey &&
    now - history.present.at <= MERGE_WINDOW_MS;

  if (canMerge) {
    // Replace the present in place: the past already holds the state this run
    // of edits started from, which is what undo should land on.
    return { past: history.past, present: entry, future: [] };
  }

  const past = [...history.past, history.present];
  return {
    past: past.length > MAX_HISTORY ? past.slice(past.length - MAX_HISTORY) : past,
    present: entry,
    // Any new edit invalidates the redo branch. Keeping it would let a user
    // redo their way into a state that never followed from what is on screen.
    future: [],
  };
}

export function canUndo<T>(history: History<T>): boolean {
  return history.past.length > 0;
}

export function canRedo<T>(history: History<T>): boolean {
  return history.future.length > 0;
}

export function undo<T>(history: History<T>): History<T> {
  if (history.past.length === 0) return history;
  const previous = history.past[history.past.length - 1];
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
  };
}

export function redo<T>(history: History<T>): History<T> {
  if (history.future.length === 0) return history;
  const [next, ...rest] = history.future;
  return { past: [...history.past, history.present], present: next, future: rest };
}

/**
 * Jump directly to an entry, the way clicking a row in the history panel does.
 *
 * Index 0 is the oldest state still held; the present sits at `past.length`.
 */
export function jumpTo<T>(history: History<T>, index: number): History<T> {
  const timeline = [...history.past, history.present, ...history.future];
  const clamped = Math.max(0, Math.min(timeline.length - 1, index));
  return {
    past: timeline.slice(0, clamped),
    present: timeline[clamped],
    future: timeline.slice(clamped + 1),
  };
}

/** The full timeline plus where the present sits, for rendering the panel. */
export function historyTimeline<T>(history: History<T>): {
  entries: HistoryEntry<T>[];
  currentIndex: number;
} {
  return {
    entries: [...history.past, history.present, ...history.future],
    currentIndex: history.past.length,
  };
}
