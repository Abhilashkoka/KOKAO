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

/**
 * Run `task` in the background without blocking the caller. The task's own
 * errors must be handled inside `task`; any thrown error is swallowed here so a
 * rejected background promise never crashes the process.
 */
export function enqueueBackgroundJob(task: () => Promise<void>): void {
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
}

/**
 * Await all currently in-flight background jobs. Primarily for tests and
 * graceful shutdown. Jobs enqueued after this call are not awaited.
 */
export async function waitForPendingJobs(): Promise<void> {
  await Promise.all([...pending]);
}
