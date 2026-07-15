/**
 * Minimal in-process background job runner.
 *
 * The API server has no external job queue, so long-running side tasks (e.g.
 * polling Instagram until a media container finishes processing) are run
 * fire-and-forget after the HTTP response has already been sent. Each task
 * runs to completion in the background and is responsible for persisting its
 * own result/failure (there is no automatic retry).
 *
 * Every enqueued task is tracked in `pending` so tests (and graceful shutdown)
 * can await in-flight work via `waitForPendingJobs()`.
 */
const pending = new Set<Promise<void>>();

let shuttingDown = false;

/**
 * Flip the runner into shutdown mode. Called once by the graceful-shutdown
 * handler before draining. Request handlers should check `isShuttingDown()`
 * and reject new work with a retriable error instead of starting jobs that
 * race the process exit.
 */
export function markShutdownStarted(): void {
  shuttingDown = true;
}

/** Whether graceful shutdown has begun. */
export function isShuttingDown(): boolean {
  return shuttingDown;
}

/** Test-only: reset the shutdown flag between test cases. */
export function resetShutdownStateForTests(): void {
  shuttingDown = false;
}

/**
 * Run `task` in the background without blocking the caller. The task's own
 * errors must be handled inside `task`; any thrown error is swallowed here so a
 * rejected background promise never crashes the process.
 *
 * Returns `false` WITHOUT starting the task if shutdown has already begun:
 * once the drain snapshot is empty the process may exit at any moment, so a
 * late job could be killed mid-flight and silently dropped. Callers must
 * handle a `false` return by surfacing a retriable error (and reverting any
 * "in progress" state they persisted). Jobs that were accepted while a drain
 * is still actively running are covered by the re-snapshot loop in
 * `waitForPendingJobs`.
 */
export function enqueueBackgroundJob(task: () => Promise<void>): boolean {
  if (shuttingDown) {
    return false;
  }
  const job = (async () => {
    try {
      await task();
    } catch {
      // Tasks are expected to catch and persist their own failures. Swallow
      // anything that escapes so an unhandled rejection can't take down the
      // process.
    }
  })();
  pending.add(job);
  void job.finally(() => {
    pending.delete(job);
  });
  return true;
}

/**
 * Await all in-flight background jobs, including any enqueued while the drain
 * is in progress (the loop re-snapshots `pending` until it is empty). Used by
 * tests and graceful shutdown.
 */
export async function waitForPendingJobs(): Promise<void> {
  while (pending.size > 0) {
    await Promise.all([...pending]);
  }
}
