/**
 * In-process provider health tracking: a small circuit breaker per provider
 * key ("imagegen:gemini", "videogen:replicate", "stock:pexels", ...).
 *
 * Scope-separated failure handling (pattern from OmniRoute, MIT):
 * - consecutive TRANSIENT failures (429/5xx/network) trip the breaker;
 * - an open breaker deprioritizes the provider for fallback ordering and
 *   short-circuits retries, then half-opens after a cooldown so one probe
 *   can close it again;
 * - permanent errors (bad prompt, invalid key) never trip it — they are the
 *   caller's problem, not the provider's health.
 *
 * In-memory by design: the API server is a single process, and breaker state
 * is worth nothing across restarts. No DB writes on the hot path.
 */

export interface ProviderHealthState {
  consecutiveFailures: number;
  /** Epoch ms until which the provider is considered unavailable. */
  openUntil: number;
  lastFailureMessage: string | null;
}

const FAILURES_TO_OPEN = 3;
const BASE_OPEN_MS = 60_000;
const MAX_OPEN_MS = 10 * 60 * 1000;

const state = new Map<string, ProviderHealthState>();

function entry(key: string): ProviderHealthState {
  let current = state.get(key);
  if (!current) {
    current = { consecutiveFailures: 0, openUntil: 0, lastFailureMessage: null };
    state.set(key, current);
  }
  return current;
}

/** Record a TRANSIENT failure (429/5xx/network/timeout). */
export function recordProviderFailure(key: string, message?: string): void {
  const current = entry(key);
  current.consecutiveFailures += 1;
  current.lastFailureMessage = message?.slice(0, 200) ?? null;
  if (current.consecutiveFailures >= FAILURES_TO_OPEN) {
    const backoff = Math.min(
      MAX_OPEN_MS,
      BASE_OPEN_MS * 2 ** (current.consecutiveFailures - FAILURES_TO_OPEN),
    );
    current.openUntil = Date.now() + backoff;
  }
}

/** Record a success: closes the breaker and resets the count. */
export function recordProviderSuccess(key: string): void {
  const current = entry(key);
  current.consecutiveFailures = 0;
  current.openUntil = 0;
  current.lastFailureMessage = null;
}

/**
 * Whether the provider should be PREFERRED right now. An open breaker only
 * deprioritizes: the explicitly-selected provider is always still attempted
 * (that attempt doubles as the half-open probe).
 */
export function isProviderHealthy(key: string): boolean {
  const current = state.get(key);
  if (!current) return true;
  return Date.now() >= current.openUntil;
}

/** Diagnostic snapshot (admin/debugging). */
export function getProviderHealth(key: string): ProviderHealthState | null {
  const current = state.get(key);
  if (!current) return null;
  return { ...current };
}

/** Test-only: wipe all breaker state. */
export function resetProviderHealthForTests(): void {
  state.clear();
}

/**
 * Order candidate keys healthiest-first, keeping the original order within
 * each health class — so the admin's chosen provider stays first unless its
 * breaker is open and a healthy alternative exists.
 */
export function orderByHealth<T>(items: T[], keyOf: (item: T) => string): T[] {
  const healthy: T[] = [];
  const unhealthy: T[] = [];
  for (const item of items) {
    (isProviderHealthy(keyOf(item)) ? healthy : unhealthy).push(item);
  }
  return [...healthy, ...unhealthy];
}
