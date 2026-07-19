/**
 * Guard: unsent analytics events must survive the tab being closed while
 * the network is down. Failed batches are mirrored into localStorage and
 * restored on the next page load, with the existing caps (bounded attempts,
 * 120-event buffer) still applied after restore.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

type Analytics = typeof import("./analytics");

const PENDING_KEY = "kokao_pending_events";

const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }) as Response);

let analytics: Analytics;
let hooks: Analytics["__analyticsTestHooks"];

function event(name: string, attempts?: number) {
  return {
    name,
    params: {},
    clientTimestamp: new Date().toISOString(),
    ...(attempts !== undefined ? { attempts } : {}),
  };
}

beforeAll(async () => {
  vi.stubGlobal("fetch", fetchMock);
  analytics = await import("./analytics");
  hooks = analytics.__analyticsTestHooks;
});

beforeEach(() => {
  fetchMock.mockClear();
  fetchMock.mockImplementation(async () => ({ ok: true, status: 200 }) as Response);
  hooks.resetQueue();
  window.localStorage.removeItem(PENDING_KEY);
});

describe("web analytics queue persistence", () => {
  it("persists the re-queued batch to localStorage after a failed flush", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    analytics.track("page_view", { page: "/a" });
    analytics.track("feature_use", { feature: "x" });
    await hooks.flush();

    const raw = window.localStorage.getItem(PENDING_KEY);
    expect(raw).not.toBeNull();
    const stored = JSON.parse(raw!) as { name: string; attempts?: number }[];
    expect(stored.map((e) => e.name)).toEqual(["page_view", "feature_use"]);
    expect(stored.every((e) => e.attempts === 1)).toBe(true);
  });

  it("clears the persisted copy once a flush succeeds", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    analytics.track("feature_use", {});
    await hooks.flush();
    expect(window.localStorage.getItem(PENDING_KEY)).not.toBeNull();

    await hooks.flush(); // succeeds
    expect(hooks.getQueue()).toHaveLength(0);
    expect(window.localStorage.getItem(PENDING_KEY)).toBeNull();
  });

  it("persistQueue mirrors the current queue and clears when empty", () => {
    hooks.setQueue([event("a"), event("b")]);
    hooks.persistQueue();
    const stored = JSON.parse(window.localStorage.getItem(PENDING_KEY)!) as {
      name: string;
    }[];
    expect(stored.map((e) => e.name)).toEqual(["a", "b"]);

    hooks.resetQueue();
    hooks.persistQueue();
    expect(window.localStorage.getItem(PENDING_KEY)).toBeNull();
  });

  it("restores persisted events ahead of new ones and removes the stored copy", () => {
    window.localStorage.setItem(PENDING_KEY, JSON.stringify([event("old", 1)]));
    hooks.setQueue([event("fresh")]);
    hooks.restoreQueue();

    expect(hooks.getQueue().map((e) => e.name)).toEqual(["old", "fresh"]);
    expect(hooks.getQueue()[0]!.attempts).toBe(1);
    // Removed immediately so a second init can't replay it.
    expect(window.localStorage.getItem(PENDING_KEY)).toBeNull();
    hooks.restoreQueue();
    expect(hooks.getQueue()).toHaveLength(2);
  });

  it("still applies the attempt limit and buffer cap after restore", () => {
    const persisted = [
      event("over_attempted", 3),
      ...Array.from({ length: 130 }, (_, i) => ({ ...event("old"), params: { i } })),
    ];
    window.localStorage.setItem(PENDING_KEY, JSON.stringify(persisted));
    hooks.setQueue([event("fresh")]);
    hooks.restoreQueue();

    const queue = hooks.getQueue();
    expect(queue).toHaveLength(120);
    expect(queue.some((e) => e.name === "over_attempted")).toBe(false);
    // Newest survive the cap; the oldest restored events are trimmed.
    expect(queue[queue.length - 1]!.name).toBe("fresh");
  });

  it("ignores corrupt or malformed persisted data", () => {
    window.localStorage.setItem(PENDING_KEY, "not json");
    hooks.restoreQueue();
    expect(hooks.getQueue()).toHaveLength(0);

    window.localStorage.setItem(
      PENDING_KEY,
      JSON.stringify([{ bogus: true }, null, event("valid")]),
    );
    hooks.restoreQueue();
    expect(hooks.getQueue().map((e) => e.name)).toEqual(["valid"]);
  });
});
