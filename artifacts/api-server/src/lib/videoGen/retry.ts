import { VideoGenProviderError } from "./types";

/**
 * Small bounded retry-with-backoff for the flaky edges of video generation:
 * provider create calls (429/5xx/network) and TTS. Retries are few and
 * short — a genuinely down upstream should fail the job quickly rather than
 * eat the whole deadline.
 */

export interface RetryOptions {
  /** Total attempts including the first (default 3). */
  attempts?: number;
  /** Base backoff in ms; grows ×2 per retry (default 1500). */
  baseDelayMs?: number;
  /** Whether an error is worth retrying (default: retryable provider errors + network). */
  isRetryable?: (error: unknown) => boolean;
  /** Called before each retry sleep (for logging). */
  onRetry?: (error: unknown, attempt: number) => void;
}

/** Transient upstream statuses worth one more try. */
export function isTransientStatus(status: number | undefined): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function defaultRetryable(error: unknown): boolean {
  if (error instanceof VideoGenProviderError) return isTransientStatus(error.status);
  // Network/abort-level failures (fetch TypeError, socket resets) are
  // transient by nature; anything typed as a permanent provider rejection
  // already returned false above.
  return error instanceof Error && !(error instanceof VideoGenProviderError);
}

export async function withRetries<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const baseDelayMs = options.baseDelayMs ?? 1500;
  const isRetryable = options.isRetryable ?? defaultRetryable;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !isRetryable(error)) throw error;
      options.onRetry?.(error, attempt);
      await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** (attempt - 1)));
    }
  }
  throw lastError;
}

/**
 * Bound a promise-returning call that has no abort support of its own (the
 * TTS SDK call): reject after `ms` so a hung upstream can never stall the
 * whole job. The abandoned promise settles harmlessly in the background.
 */
export async function withTimeout<T>(
  fn: () => Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new VideoGenProviderError(`${label} timed out after ${ms / 1000}s.`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
