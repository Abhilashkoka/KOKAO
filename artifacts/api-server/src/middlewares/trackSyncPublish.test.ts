import { describe, it, expect, vi, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { NextFunction, Request, Response } from "express";
import { trackSyncPublish } from "./trackSyncPublish";
import { createShutdownHandler } from "../lib/shutdown";
import {
  beginTrackedRequest,
  markShutdownStarted,
  resetShutdownStateForTests,
  waitForPendingJobs,
} from "../lib/backgroundJobs";

afterEach(() => {
  resetShutdownStateForTests();
});

/** Minimal mock Response: EventEmitter + status/json spies. */
function makeRes() {
  const emitter = new EventEmitter();
  const res = emitter as unknown as Response & {
    statusCode?: number;
    body?: unknown;
  };
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  }) as unknown as Response["status"];
  res.json = vi.fn((body: unknown) => {
    res.body = body;
    return res;
  }) as unknown as Response["json"];
  return res;
}

const req = {} as Request;

describe("trackSyncPublish middleware", () => {
  it("rejects with a retriable 503 before any platform write once shutdown has begun", () => {
    markShutdownStarted();
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    trackSyncPublish(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect((res as { body?: { error?: string } }).body?.error).toMatch(
      /restarting/i,
    );
  });

  it("calls next() and includes the in-flight request in the shutdown drain (sync publish racing SIGTERM)", async () => {
    // A Facebook/LinkedIn/X-style synchronous publish is mid-request when
    // SIGTERM arrives. The drain must await the request finishing (response
    // "finish") so the platform write + DB status persist before exit.
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;
    trackSyncPublish(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);

    const contentItem: { status: string } = { status: "draft" };

    const exit = vi.fn();
    const shutdown = createShutdownHandler({
      server: { close: vi.fn() },
      exit,
      drainTimeoutMs: 5_000,
    });

    const shutdownPromise = shutdown("SIGTERM");

    // Give the drain a chance to run; it must NOT exit while the tracked
    // request is still in flight.
    await Promise.resolve();
    await Promise.resolve();
    expect(exit).not.toHaveBeenCalled();

    // The request completes: platform write landed, DB status persisted,
    // response sent.
    contentItem.status = "published";
    res.emit("finish");

    await shutdownPromise;
    expect(contentItem.status).toBe("published");
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("releases the drain when the connection closes without a finished response", async () => {
    const res = makeRes();
    trackSyncPublish(req, res, vi.fn() as unknown as NextFunction);

    const drained = waitForPendingJobs();
    let settled = false;
    void drained.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    res.emit("close");
    await drained;
  });

  it("beginTrackedRequest returns null after shutdown started and done() is idempotent", async () => {
    const done = beginTrackedRequest();
    expect(done).not.toBeNull();
    done!();
    done!(); // second call is a no-op
    await waitForPendingJobs();

    markShutdownStarted();
    expect(beginTrackedRequest()).toBeNull();
  });
});
