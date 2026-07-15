import { describe, it, expect, vi } from "vitest";
import { createShutdownHandler } from "./shutdown";
import { enqueueBackgroundJob } from "./backgroundJobs";

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
