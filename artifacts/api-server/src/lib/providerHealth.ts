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

/**
 * How many recent outcomes the success rate is computed over. Short on
 * purpose: the question scoring asks is "is this vendor working right now",
 * and a month of history would keep answering "yes" through an outage.
 */
const OUTCOME_WINDOW = 20;

/** Weight of the newest sample in the latency average. */
const LATENCY_ALPHA = 0.3;

interface Entry extends ProviderHealthState {
  /** Newest last, at most OUTCOME_WINDOW long. true = success. */
  outcomes: boolean[];
  /** Exponentially-weighted mean of timed successes; null until one arrives. */
  emaLatencyMs: number | null;
}

const state = new Map<string, Entry>();

function entry(key: string): Entry {
  let current = state.get(key);
  if (!current) {
    current = {
      consecutiveFailures: 0,
      openUntil: 0,
      lastFailureMessage: null,
      outcomes: [],
      emaLatencyMs: null,
    };
    state.set(key, current);
  }
  return current;
}

function pushOutcome(current: Entry, ok: boolean): void {
  current.outcomes.push(ok);
  if (current.outcomes.length > OUTCOME_WINDOW) current.outcomes.shift();
}

/** Record a TRANSIENT failure (429/5xx/network/timeout). */
export function recordProviderFailure(key: string, message?: string): void {
  const current = entry(key);
  current.consecutiveFailures += 1;
  current.lastFailureMessage = message?.slice(0, 200) ?? null;
  pushOutcome(current, false);
  if (current.consecutiveFailures >= FAILURES_TO_OPEN) {
    const backoff = Math.min(
      MAX_OPEN_MS,
      BASE_OPEN_MS * 2 ** (current.consecutiveFailures - FAILURES_TO_OPEN),
    );
    current.openUntil = Date.now() + backoff;
  }
}

/**
 * Record a success: closes the breaker and resets the count.
 *
 * `latencyMs` is optional because not every call site times itself, and a
 * missing measurement must not be recorded as a fast one.
 */
export function recordProviderSuccess(key: string, latencyMs?: number): void {
  const current = entry(key);
  current.consecutiveFailures = 0;
  current.openUntil = 0;
  current.lastFailureMessage = null;
  pushOutcome(current, true);
  if (typeof latencyMs === "number" && Number.isFinite(latencyMs) && latencyMs >= 0) {
    current.emaLatencyMs =
      current.emaLatencyMs === null
        ? latencyMs
        : current.emaLatencyMs * (1 - LATENCY_ALPHA) + latencyMs * LATENCY_ALPHA;
  }
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
  const { consecutiveFailures, openUntil, lastFailureMessage } = current;
  return { consecutiveFailures, openUntil, lastFailureMessage };
}

/** What scoring reads: observed behaviour rather than breaker mechanics. */
export interface ProviderStats {
  /** Recent calls this is based on. 0 = never called; nothing is known. */
  samples: number;
  successes: number;
  /** Observed typical latency in ms, or null when no success was ever timed. */
  typicalLatencyMs: number | null;
  /** False only while the breaker is open. */
  healthy: boolean;
}

/**
 * Observed stats for a provider key. An unseen provider comes back with zero
 * samples and a null latency — deliberately NOT with a flattering default, so
 * the scorer can treat "unknown" as its own case instead of as "perfect".
 */
export function getProviderStats(key: string): ProviderStats {
  const current = state.get(key);
  if (!current) return { samples: 0, successes: 0, typicalLatencyMs: null, healthy: true };
  return {
    samples: current.outcomes.length,
    successes: current.outcomes.filter(Boolean).length,
    typicalLatencyMs: current.emaLatencyMs === null ? null : Math.round(current.emaLatencyMs),
    healthy: Date.now() >= current.openUntil,
  };
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
