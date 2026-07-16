/**
 * Automatic one-shot retry for publishes rejected during a server restart.
 *
 * The API's trackSyncPublish middleware rejects publish requests with a 503
 * BEFORE any platform write starts when the server is shutting down, so this
 * specific 503 guarantees nothing was sent and a retry cannot duplicate a
 * post. Restarts usually complete within seconds, so we retry exactly once
 * after a short delay; any other error (or a second restart 503) is passed
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

interface MutateCallbacks<TVars, TRes> {
  onSuccess?: (res: TRes) => void;
  onError?: (err: unknown) => void;
}

interface MutationLike<TVars, TRes> {
  mutate: (vars: TVars, callbacks?: MutateCallbacks<TVars, TRes>) => void;
}

export interface RestartRetryCallbacks<TRes> {
  onSuccess: (res: TRes) => void;
  /** Called for non-restart errors AND when the single retry also fails. */
  onError: (err: unknown, opts: { retried: boolean }) => void;
  /** Called right before the automatic retry is scheduled (show a toast). */
  onRetrying?: () => void;
}

/**
 * Runs mutation.mutate(vars) and, if it fails with the restart 503, waits
 * RESTART_RETRY_DELAY_MS and retries exactly once.
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
      if (!isRestartRejection(err)) {
        callbacks.onError(err, { retried: false });
        return;
      }
      callbacks.onRetrying?.();
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
