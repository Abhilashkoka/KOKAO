import { describe, it, expect, vi, afterEach } from "vitest";
import { createShutdownHandler } from "./shutdown";
import {
  enqueueBackgroundJob,
  isShuttingDown,
  resetShutdownStateForTests,
} from "./backgroundJobs";

afterEach(() => {
  resetShutdownStateForTests();
});

/**
 * Covers the graceful-shutdown drain path: a SIGTERM while an Instagram-style
 * background publish job is in flight must await the job (so the content item
 * reaches a terminal status like "published"/"failed" instead of staying stuck
 * on "publishing"), and a hung job must not block shutdown beyond the drain
 * timeout.
 */
describe("graceful shutdown drain", () => {
  function makeServer() {
    return { close: vi.fn() };
  }

  it("awaits an in-flight publish job so it reaches a terminal status before exit", async () => {
    // Simulated content item mid Instagram publish, as written by
    // enqueueBackgroundJob(() => finalizeInstagramPublish(...)) in routes/meta.ts.
    const contentItem: { status: string } = { status: "publishing" };

    let finishJob!: () => void;
    const jobDone = new Promise<void>((resolve) => {
      finishJob = resolve;
    });

    enqueueBackgroundJob(async () => {
      await jobDone;
      // The job persists its own outcome (published) once the platform call
      // completes.
      contentItem.status = "published";
    });

    const server = makeServer();
    const exit = vi.fn();
    const shutdown = createShutdownHandler({
      server,
      exit,
      drainTimeoutMs: 5_000,
    });

    const shutdownPromise = shutdown("SIGTERM");

    // Shutdown immediately stops accepting connections but must NOT exit while
    // the job is still in flight.
    await Promise.resolve();
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    expect(contentItem.status).toBe("publishing");

    // Let the in-flight publish finish; shutdown should then complete.
    finishJob();
    await shutdownPromise;

    expect(contentItem.status).toBe("published");
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("awaits a job that ends in failure, persisting the terminal 'failed' status", async () => {
    const contentItem: { status: string } = { status: "publishing" };

    let finishJob!: () => void;
    const jobDone = new Promise<void>((resolve) => {
      finishJob = resolve;
    });

    enqueueBackgroundJob(async () => {
      await jobDone;
      // Publish jobs catch platform errors and persist a terminal failure.
      contentItem.status = "failed";
    });

    const exit = vi.fn();
    const shutdown = createShutdownHandler({
      server: makeServer(),
      exit,
      drainTimeoutMs: 5_000,
    });

    const shutdownPromise = shutdown("SIGTERM");
    finishJob();
    await shutdownPromise;

    expect(contentItem.status).toBe("failed");
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("exits after the drain timeout when a job hangs, without waiting forever", async () => {
    vi.useFakeTimers();
    try {
      const contentItem: { status: string } = { status: "publishing" };

      // A job that never settles (e.g. a platform call that hangs).
      let releaseHungJob!: () => void;
      const hang = new Promise<void>((resolve) => {
        releaseHungJob = resolve;
      });
      enqueueBackgroundJob(async () => {
        await hang;
      });

      const exit = vi.fn();
      const shutdown = createShutdownHandler({
        server: makeServer(),
        exit,
        drainTimeoutMs: 10_000,
      });

      const shutdownPromise = shutdown("SIGTERM");

      // Just before the timeout, still draining.
      await vi.advanceTimersByTimeAsync(9_999);
      expect(exit).not.toHaveBeenCalled();

      // At the timeout, shutdown proceeds even though the job is stuck; the
      // item stays "publishing" and is reclaimed on next boot by
      // recoverStuckPublishingItems.
      await vi.advanceTimersByTimeAsync(1);
      await shutdownPromise;
      expect(exit).toHaveBeenCalledWith(0);
      expect(contentItem.status).toBe("publishing");

      // Unblock the hung job so it doesn't leak into other tests' drains.
      releaseHungJob();
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks the runner as shutting down so request handlers can reject new work", async () => {
    expect(isShuttingDown()).toBe(false);

    const shutdown = createShutdownHandler({
      server: makeServer(),
      exit: vi.fn(),
      drainTimeoutMs: 1_000,
    });

    const shutdownPromise = shutdown("SIGTERM");
    // The flag flips synchronously, before any await, so a request that
    // arrives after SIGTERM sees isShuttingDown() === true and returns 503
    // instead of enqueueing a job destined to be killed.
    expect(isShuttingDown()).toBe(true);
    await shutdownPromise;
  });

  it("rejects a job enqueued AFTER shutdown started so it can't be killed mid-flight (enqueue-during-shutdown race)", async () => {
    // A publish request that raced the SIGTERM window: it passed its
    // isShuttingDown() route check, then shutdown began before it enqueued.
    // The enqueue must be refused (returns false, task never started) so the
    // route can revert the item's status and return a retriable error —
    // instead of starting a job the exiting process would silently drop.
    const firstItem: { status: string } = { status: "publishing" };
    let lateTaskStarted = false;
    let lateEnqueueAccepted: boolean | undefined;

    let finishFirst!: () => void;
    const firstDone = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });

    enqueueBackgroundJob(async () => {
      await firstDone;
      firstItem.status = "published";
      // Simulate the racing request: while the drain is awaiting the first
      // job, a second enqueue is attempted.
      lateEnqueueAccepted = enqueueBackgroundJob(async () => {
        lateTaskStarted = true;
      });
    });

    const exit = vi.fn();
    const shutdown = createShutdownHandler({
      server: makeServer(),
      exit,
      drainTimeoutMs: 5_000,
    });

    const shutdownPromise = shutdown("SIGTERM");
    finishFirst();
    await shutdownPromise;

    expect(firstItem.status).toBe("published");
    expect(lateEnqueueAccepted).toBe(false);
    expect(lateTaskStarted).toBe(false);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("rejects an enqueue after shutdown completed with ZERO pending jobs", async () => {
    // Worst case: nothing was pending when SIGTERM arrived, so the drain
    // returned immediately and exit() already ran. A request still finishing
    // its handler must NOT be able to start a background job now — it gets a
    // false return and surfaces a retriable error instead.
    const exit = vi.fn();
    const shutdown = createShutdownHandler({
      server: makeServer(),
      exit,
      drainTimeoutMs: 1_000,
    });

    await shutdown("SIGTERM");
    expect(exit).toHaveBeenCalledWith(0);

    let taskStarted = false;
    const accepted = enqueueBackgroundJob(async () => {
      taskStarted = true;
    });

    expect(accepted).toBe(false);
    expect(taskStarted).toBe(false);
  });

  it("ignores a second signal while a shutdown is already in progress", async () => {
    const server = makeServer();
    const exit = vi.fn();
    const shutdown = createShutdownHandler({
      server,
      exit,
      drainTimeoutMs: 1_000,
    });

    await Promise.all([shutdown("SIGTERM"), shutdown("SIGINT")]);

    expect(server.close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
