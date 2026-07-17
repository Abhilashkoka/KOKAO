import { useCallback, useRef, useState } from "react";

import {
  mutateWithRestartRetry,
  RESTART_RETRY_DELAY_MS,
  type RestartRetryCallbacks,
} from "./restart-retry";

interface MutateCallbacks<TRes> {
  onSuccess?: (res: TRes) => void;
  onError?: (err: unknown) => void;
}

interface MutationLike<TVars, TRes> {
  mutate: (vars: TVars, callbacks?: MutateCallbacks<TRes>) => void;
}

/**
 * Wraps mutateWithRestartRetry and tracks whether an automatic one-shot
 * retry is currently waiting or in flight. During that window the underlying
 * mutation is NOT "pending" (the first attempt already settled), so UIs that
 * disable publish buttons on `isPending` alone would re-enable them and let
 * a double-tap race the retry. Gate the buttons on `isRetrying` too.
 */
export function useRestartRetry() {
  const [retryingCount, setRetryingCount] = useState(0);
  // A ref-backed counter keeps `run` referentially stable while still
  // supporting overlapping calls (each retry increments once and settles once).
  const countRef = useRef(0);

  const run = useCallback(
    <TVars, TRes>(
      mutation: MutationLike<TVars, TRes>,
      vars: TVars,
      callbacks: RestartRetryCallbacks<TRes>,
      delayMs: number = RESTART_RETRY_DELAY_MS,
    ): void => {
      let counted = false;
      const settle = () => {
        if (!counted) return;
        counted = false;
        countRef.current = Math.max(0, countRef.current - 1);
        setRetryingCount(countRef.current);
      };
      mutateWithRestartRetry(
        mutation,
        vars,
        {
          onSuccess: (res) => {
            settle();
            callbacks.onSuccess(res);
          },
          onError: (err, opts) => {
            settle();
            callbacks.onError(err, opts);
          },
          onRetrying: (reason) => {
            counted = true;
            countRef.current += 1;
            setRetryingCount(countRef.current);
            callbacks.onRetrying?.(reason);
          },
        },
        delayMs,
      );
    },
    [],
  );

  return { isRetrying: retryingCount > 0, run };
}
