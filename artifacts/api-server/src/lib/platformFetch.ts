/**
 * Bounded-timeout fetch for outbound social-platform API calls.
 *
 * Why: synchronous publish requests (Facebook, LinkedIn, Threads, X) are
 * drained during graceful shutdown (see shutdown.ts / trackSyncPublish). The
 * drain is capped at SHUTDOWN_DRAIN_TIMEOUT_MS (10s), but a hung platform
 * call with no timeout of its own would always burn the entire drain window
 * on every restart, and the publish would end with an ambiguous cutoff
 * instead of a persisted "failed" status.
 *
 * Every platform HTTP call therefore goes through `platformFetch`, which
 * aborts after PLATFORM_FETCH_TIMEOUT_MS (kept comfortably below the drain
 * cap) and surfaces the timeout as a `PlatformTimeoutError` with a clear,
 * user-presentable message. Callers' existing error handling then persists a
 * terminal "failed" status like any other publish failure.
 */

/** Per-request timeout for platform calls. Must stay well below the 10s
 * shutdown drain cap so a hung call fails (and its failure is persisted)
 * before the drain gives up. */
export const PLATFORM_FETCH_TIMEOUT_MS = (() => {
  const raw = Number(process.env.PLATFORM_FETCH_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 6_000;
})();

/** Thrown when a platform call exceeds its bounded timeout. Treated as a
 * terminal (non-retryable) failure by publish flows so a hung platform never
 * burns the shutdown drain window on retries. */
export class PlatformTimeoutError extends Error {
  constructor(url: string, timeoutMs: number) {
    let host = "the platform";
    try {
      host = new URL(url).host;
    } catch {
      // keep the generic label
    }
    super(
      `Request to ${host} timed out after ${Math.round(timeoutMs / 1000)}s. The platform did not respond; please try again.`,
    );
    this.name = "PlatformTimeoutError";
  }
}

function isAbortLike(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "TimeoutError" || err.name === "AbortError")
  );
}

/**
 * Drop-in replacement for `fetch` with a bounded timeout. If the caller
 * passes its own `signal`, both signals apply (whichever aborts first wins).
 */
export async function platformFetch(
  url: string | URL,
  init?: RequestInit,
  timeoutMs: number = PLATFORM_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = init?.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal;
  try {
    return await fetch(url, { ...init, signal });
  } catch (err) {
    if (timeoutSignal.aborted && isAbortLike(err)) {
      throw new PlatformTimeoutError(String(url), timeoutMs);
    }
    throw err;
  }
}
