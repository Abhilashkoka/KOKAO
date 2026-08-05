import type OpenAI from "openai";
import { openai as builtinOpenAI } from "@workspace/integrations-openai-ai-server";
import { resolveAiModel } from "./aiModels";
import { isTransientStatus } from "./videoGen/retry";
import {
  getProviderHealth,
  isProviderHealthy,
  recordProviderFailure,
  recordProviderSuccess,
} from "./providerHealth";
import { findModelPrice } from "./aiCost";
import {
  notifyTextGenFailover,
  resolveTextGenFailoverNotifications,
} from "./notifications";
import {
  TextGenNotConfiguredError,
  type TextGenClient,
  type TextGenProvider,
} from "./textGen";

/**
 * Text-generation failover: when the admin-selected provider is DOWN
 * (transient failures / open breaker), divert the request to another
 * CONFIGURED provider that can serve an admin-approved model, and tell the
 * platform admins that it happened.
 *
 * This deliberately does NOT weaken the no-silent-fallback design of
 * textGen.ts:
 *   - misconfiguration (missing key, empty model list) still throws
 *     TextGenNotConfiguredError → 503; failover never masks it;
 *   - permanent errors (bad prompt, invalid key, 4xx) are rethrown untouched;
 *   - the only failover target is the BUILT-IN provider, which is always
 *     configured and whose model list is the fixed admin-approved set —
 *     tenant models map through resolveAiModel(), the same mapping the admin
 *     gets by flipping the switch back to builtin;
 *   - the pricing gate holds: the substitute provider+model must have a
 *     price row in ai_model_prices or no failover happens;
 *   - the failover is never silent to the admin: a deduped superadmin
 *     notification fires once per outage window.
 *
 * When no healthy, configured, priced alternative exists the original error
 * (or 503) surfaces exactly as before.
 */

export function textGenHealthKey(provider: TextGenProvider): string {
  return `textgen:${provider}`;
}

/**
 * Transient = the PROVIDER's problem (outage/overload/network), worth a
 * failover. Everything else — bad prompts, invalid keys, misconfiguration —
 * is permanent and must surface to the caller unchanged.
 */
export function isTransientTextGenError(error: unknown): boolean {
  if (error instanceof TextGenNotConfiguredError) return false;
  const maybe = error as { status?: unknown; response?: { status?: unknown } };
  const status =
    typeof maybe?.status === "number"
      ? maybe.status
      : typeof maybe?.response?.status === "number"
        ? maybe.response.status
        : undefined;
  if (typeof status === "number") return isTransientStatus(status);
  if (error instanceof Error) {
    // OpenAI SDK connection failures carry no status; raw fetch failures are
    // TypeErrors. Both are network-level and transient by nature.
    if (
      error.name === "APIConnectionError" ||
      error.name === "APIConnectionTimeoutError" ||
      error.name === "TypeError"
    ) {
      return true;
    }
    return /fetch failed|network|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket|timeout/i.test(
      error.message,
    );
  }
  return false;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Test seam: candidate resolution can be overridden in unit tests. */
export interface FailoverCandidate {
  client: OpenAI;
  provider: TextGenProvider;
  model: string;
}

/**
 * The healthy, configured, PRICED alternative for a down primary — or null.
 *
 * Only the built-in provider qualifies today: it is always configured, and
 * its fixed supported-model list is the admin-approved equivalent set (the
 * exact models tenants get when the admin flips the switch back). OpenRouter
 * and Replicate model ids are provider-specific, so there is no safe way to
 * claim one hosts the other's model; and when builtin itself is the primary
 * there is no configured alternative catalog at all — the request fails as
 * before.
 */
export async function resolveTextGenFailoverCandidate(
  primaryProvider: TextGenProvider,
  tenantModel: string,
): Promise<FailoverCandidate | null> {
  if (primaryProvider === "builtin") return null;
  if (!isProviderHealthy(textGenHealthKey("builtin"))) return null;
  const model = resolveAiModel(tenantModel);
  // Pricing gate: no price row for the substitute → no failover. Uses the
  // same lookup semantics as cost capture (model-only fallback included).
  try {
    const price = await findModelPrice("text", "builtin", model);
    if (!price) return null;
  } catch {
    return null;
  }
  return { client: builtinOpenAI, provider: "builtin", model };
}

/** How long one admin notification covers an ongoing outage (in-memory). */
const NOTIFY_WINDOW_MS = 10 * 60 * 1000;
const lastNotifiedAt = new Map<string, number>();

/** Test-only: re-arm the once-per-window notification throttle. */
export function resetTextGenFailoverNotifyThrottleForTests(): void {
  lastNotifiedAt.clear();
}

/**
 * Fire the superadmin alert at most once per outage window per primary
 * provider. The DB layer additionally dedupes on the unread row (updates it
 * in place), so even across the window boundary one outage means one banner.
 * Best-effort: never throws, never blocks the generation response.
 */
function notifyOncePerWindow(args: {
  fromProvider: TextGenProvider;
  toProvider: TextGenProvider;
  model: string;
  lastError: string | null;
}): void {
  const now = Date.now();
  const last = lastNotifiedAt.get(args.fromProvider) ?? 0;
  if (now - last < NOTIFY_WINDOW_MS) return;
  lastNotifiedAt.set(args.fromProvider, now);
  void notifyTextGenFailover(args).catch(() => {});
}

type CreateParams = Record<string, unknown> & { model?: string };
type CreateFn = (params: CreateParams, options?: unknown) => Promise<unknown>;

export interface FailoverDeps {
  /** Injected in tests; defaults to resolveTextGenFailoverCandidate. */
  resolveCandidate?: (
    primaryProvider: TextGenProvider,
    tenantModel: string,
  ) => Promise<FailoverCandidate | null>;
}

/**
 * Wrap a TextGenClient so chat.completions.create records provider health
 * and fails over to the built-in provider on transient outages.
 *
 * The returned object is MUTATED on failover — provider/model flip to the
 * provider that actually served the request — so buildTextCostMeta (which
 * call sites feed this same object after the completion) records the true
 * server and prices against the right rows.
 */
export function withTextGenFailover(
  primary: TextGenClient,
  tenantModel: string,
  deps: FailoverDeps = {},
): TextGenClient {
  const resolveCandidate = deps.resolveCandidate ?? resolveTextGenFailoverCandidate;
  const primaryKey = textGenHealthKey(primary.provider);
  const primaryCreate = primary.client.chat.completions.create.bind(
    primary.client.chat.completions,
  ) as unknown as CreateFn;

  const wrapped: TextGenClient = {
    client: primary.client,
    provider: primary.provider,
    model: primary.model,
  };

  const serveViaCandidate = async (
    candidate: FailoverCandidate,
    params: CreateParams,
    options: unknown,
    cause: unknown,
  ): Promise<unknown> => {
    const candidateKey = textGenHealthKey(candidate.provider);
    const started = Date.now();
    try {
      const candidateCreate = candidate.client.chat.completions.create.bind(
        candidate.client.chat.completions,
      ) as unknown as CreateFn;
      // Strip provider-specific params the substitute would reject —
      // OpenRouter's usage-accounting flag (`usage: { include: true }`,
      // see usageAccountingParams) is not an OpenAI chat-completions param,
      // and forwarding it would 400 the very failover meant to save the
      // request. `stream_options` is honoured by both backends and stays.
      const { usage: _openrouterUsage, ...portable } = params;
      const result = await candidateCreate({ ...portable, model: candidate.model }, options);
      recordProviderSuccess(candidateKey, Date.now() - started);
      // Cost capture must bill the provider that really served the request.
      wrapped.provider = candidate.provider;
      wrapped.model = candidate.model;
      notifyOncePerWindow({
        fromProvider: primary.provider,
        toProvider: candidate.provider,
        model: candidate.model,
        lastError: cause === null ? null : errorMessage(cause),
      });
      return result;
    } catch (err) {
      if (isTransientTextGenError(err)) {
        recordProviderFailure(candidateKey, errorMessage(err));
      }
      // Surface the PRIMARY outage (or the candidate error when we diverted
      // pre-emptively on an open breaker) — the caller should see why its
      // configured provider failed, not a confusing substitute-only story.
      throw cause ?? err;
    }
  };

  const create: CreateFn = async (params, options) => {
    // Open breaker: divert immediately when a healthy alternative exists so
    // an ongoing outage doesn't eat a timeout per request. Without an
    // alternative the primary is still attempted (that attempt doubles as
    // the half-open probe once the cooldown lapses).
    if (!isProviderHealthy(primaryKey)) {
      const candidate = await resolveCandidate(primary.provider, tenantModel);
      if (candidate) return serveViaCandidate(candidate, params, options, null);
    }
    const started = Date.now();
    try {
      const result = await primaryCreate(params, options);
      // Recovery: the primary was failing but just served a request again —
      // clear the failover banner and re-arm the once-per-window throttle so
      // the NEXT outage produces a fresh alert. Best-effort, off hot path
      // for healthy providers (only fires on the recovery transition).
      const wasFailing = (getProviderHealth(primaryKey)?.consecutiveFailures ?? 0) > 0;
      recordProviderSuccess(primaryKey, Date.now() - started);
      if (wasFailing) {
        lastNotifiedAt.delete(primary.provider);
        void resolveTextGenFailoverNotifications(primary.provider).catch(() => {});
      }
      return result;
    } catch (err) {
      if (!isTransientTextGenError(err)) throw err;
      recordProviderFailure(primaryKey, errorMessage(err));
      const candidate = await resolveCandidate(primary.provider, tenantModel);
      if (!candidate) throw err;
      return serveViaCandidate(candidate, params, options, err);
    }
  };

  wrapped.client = {
    // Kept for diagnostics/tests that introspect which backend was selected.
    baseURL: (primary.client as { baseURL?: string }).baseURL,
    chat: { completions: { create } },
  } as unknown as OpenAI;
  return wrapped;
}
