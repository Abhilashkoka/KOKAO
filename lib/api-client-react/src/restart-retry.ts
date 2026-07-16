/**
 * Automatic one-shot retry for publishes that fail transiently.
 *
 * Two failure classes are retried exactly once:
 *
 * 1. Restart 503 — the API's trackSyncPublish middleware rejects publish
 *    requests with a 503 BEFORE any platform write starts when the server is
 *    shutting down, so this specific 503 guarantees nothing was sent and a
 *    retry cannot duplicate a post.
 * 2. Network failure — the request never produced an HTTP response (fetch
 *    threw a TypeError: connection refused/reset mid-restart, a dropped
 *    mobile connection, etc). The request may or may not have reached the
 *    server, but every publish route dedupes server-side (Facebook, X,
 *    LinkedIn and Threads probe recent posts before writing; the Instagram
 *    endpoint safely re-runs its bounded background flow), so a single
 *    retry cannot create a duplicate post.
 *
 * Restarts and blips usually resolve within seconds, so we retry exactly
 * once after a short delay; any other error (or a failed retry) is passed
 * through to the caller's error handler.
 */

export const RESTART_RETRY_DELAY_MS = 3500;

/** Matches only the trackSyncPublish restart rejection (safe to retry). */
export function isRestartRejection(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const status = (err as { status?: unknown }).status;
  if (status !== 503) return false;
  const data = (err as { data?: unknown }).data;
  const message =
    data && typeof data === "object"
      ? (data as { error?: unknown }).error
      : undefined;
  return typeof message === "string" && message.toLowerCase().includes("restarting");
}

/**
 * Matches a request that never produced an HTTP response: fetch throws a
 * TypeError ("Failed to fetch" in browsers, "Network request failed" in
 * React Native) when the connection is refused, reset, or drops. Anything
 * carrying an HTTP status (ApiError, ResponseParseError) is NOT a network
 * failure, and deliberate aborts are excluded.
 */
export function isNetworkFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if ("status" in err) return false;
  if (err.name === "AbortError") return false;
  return err.name === "TypeError";
}

export type RetryReason = "restart" | "network";

/** Classifies an error as retryable-once, or null when it must surface. */
export function transientRetryReason(err: unknown): RetryReason | null {
  if (isRestartRejection(err)) return "restart";
  if (isNetworkFailure(err)) return "network";
  return null;
}

interface MutateCallbacks<TVars, TRes> {
  onSuccess?: (res: TRes) => void;
  onError?: (err: unknown) => void;
}

interface MutationLike<TVars, TRes> {
  mutate: (vars: TVars, callbacks?: MutateCallbacks<TVars, TRes>) => void;
}

export interface RestartRetryCallbacks<TRes> {
  onSuccess: (res: TRes) => void;
  /** Called for non-transient errors AND when the single retry also fails. */
  onError: (err: unknown, opts: { retried: boolean }) => void;
  /** Called right before the automatic retry is scheduled (show a toast). */
  onRetrying?: (reason: RetryReason) => void;
}

/**
 * Runs mutation.mutate(vars) and, if it fails with the restart 503 or a
 * network-class failure, waits RESTART_RETRY_DELAY_MS and retries exactly
 * once.
 */
export function mutateWithRestartRetry<TVars, TRes>(
  mutation: MutationLike<TVars, TRes>,
  vars: TVars,
  callbacks: RestartRetryCallbacks<TRes>,
  delayMs: number = RESTART_RETRY_DELAY_MS,
): void {
  mutation.mutate(vars, {
    onSuccess: callbacks.onSuccess,
    onError: (err: unknown) => {
      const reason = transientRetryReason(err);
      if (!reason) {
        callbacks.onError(err, { retried: false });
        return;
      }
      callbacks.onRetrying?.(reason);
      setTimeout(() => {
        mutation.mutate(vars, {
          onSuccess: callbacks.onSuccess,
          onError: (retryErr: unknown) => {
            callbacks.onError(retryErr, { retried: true });
          },
        });
      }, delayMs);
    },
  });
}
