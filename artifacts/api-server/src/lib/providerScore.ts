import { getProviderStats } from "./providerHealth";

/**
 * Scored provider selection.
 *
 * The circuit breaker answers one question — is this vendor broken right now —
 * and for a long time that was the only input to which provider ran. That is
 * enough to survive an outage and not enough to route well: between two
 * working vendors it has no opinion, so a static default keeps winning even
 * when it is four times the price and twice as slow.
 *
 * This ranks the candidates instead, on four axes with an explicit weight
 * each, and hands back a sentence saying what drove the decision. Task fit
 * stays a hard filter at the call site (a provider that cannot take a
 * reference image is not a worse candidate, it is not a candidate), and health
 * stays a hard partition rather than a weight, so the breaker's promise —
 * an open provider never gets preferred over a working one — survives
 * unchanged no matter how the weights are tuned.
 *
 * Idea from OpenMontage's scoring pass and OmniRoute's cost-optimized routing;
 * both reimplemented from the described behaviour.
 */

export interface ScoreCandidate {
  /** Provider id as it appears in the catalog and in logs. */
  id: string;
  /** Circuit-breaker key, e.g. "imagegen:gemini". */
  key: string;
  /**
   * Editorial quality tier in 0..1. A judgement about the model family, not a
   * measurement — undefined means "no opinion", which scores neutrally rather
   * than badly.
   */
  quality?: number;
  /** Known cost per call in paise; null/undefined = unpriced. */
  costPaise?: number | null;
}

export interface ScoreParts {
  reliability: number;
  latency: number;
  cost: number;
  quality: number;
}

export interface ScoredProvider {
  id: string;
  key: string;
  /** Weighted total in 0..1; higher wins. */
  score: number;
  parts: ScoreParts;
  /** Whether the circuit breaker is closed. Healthy candidates rank first. */
  healthy: boolean;
  /** The evidence behind this candidate's score, for logs and the admin UI. */
  reason: string;
}

export interface RankOptions {
  /**
   * Latency that should score neutrally for this kind of work. Image models
   * take tens of seconds and speech models take as long as the audio, so a
   * single global reference would flatter one and punish the other.
   */
  latencyReferenceMs?: number;
}

const WEIGHTS: ScoreParts = {
  reliability: 0.4,
  quality: 0.25,
  cost: 0.2,
  latency: 0.15,
};

/** What an unknown axis scores: no evidence must not read as bad evidence. */
const NEUTRAL = 0.5;

/**
 * Shrinkage for the success rate. Three notional prior calls at 0.8 means one
 * unlucky failure out of one call does not brand a provider unusable, while a
 * genuine run of failures still drags the rate down quickly.
 */
const PRIOR_CALLS = 3;
const PRIOR_RATE = 0.8;

const DEFAULT_LATENCY_REFERENCE_MS = 10_000;

/** Monotone 0..1 curve: the reference latency scores exactly neutral. */
function latencyScore(latencyMs: number | null, referenceMs: number): number {
  if (latencyMs === null) return NEUTRAL;
  return referenceMs / (referenceMs + Math.max(0, latencyMs));
}

/**
 * Cost is only ever scored relative to the other candidates, because a number
 * of paise means nothing on its own. With fewer than two priced candidates
 * there is nothing to compare, so cost drops out for everybody instead of
 * handing a free win to whichever provider the admin happened to price.
 */
function costScores(candidates: ScoreCandidate[]): Map<string, number> {
  const scores = new Map<string, number>();
  const priced = candidates.filter(
    (c) => typeof c.costPaise === "number" && Number.isFinite(c.costPaise),
  );
  if (priced.length < 2) return scores;
  const values = priced.map((c) => c.costPaise as number);
  const min = Math.min(...values);
  const max = Math.max(...values);
  for (const c of priced) {
    const cost = c.costPaise as number;
    scores.set(c.id, max === min ? NEUTRAL : (max - cost) / (max - min));
  }
  return scores;
}

function rupees(paise: number): string {
  return `₹${(paise / 100).toFixed(2)}`;
}

function seconds(ms: number): string {
  return `~${(ms / 1000).toFixed(1)}s`;
}

/** Score every candidate and rank them: healthy first, then by score. */
export function rankProviders(
  candidates: ScoreCandidate[],
  options: RankOptions = {},
): ScoredProvider[] {
  const referenceMs = options.latencyReferenceMs ?? DEFAULT_LATENCY_REFERENCE_MS;
  const relativeCost = costScores(candidates);

  const scored = candidates.map((candidate): ScoredProvider => {
    const stats = getProviderStats(candidate.key);
    const parts: ScoreParts = {
      reliability:
        (stats.successes + PRIOR_CALLS * PRIOR_RATE) / (stats.samples + PRIOR_CALLS),
      latency: latencyScore(stats.typicalLatencyMs, referenceMs),
      cost: relativeCost.get(candidate.id) ?? NEUTRAL,
      quality: candidate.quality ?? NEUTRAL,
    };
    const score =
      parts.reliability * WEIGHTS.reliability +
      parts.latency * WEIGHTS.latency +
      parts.cost * WEIGHTS.cost +
      parts.quality * WEIGHTS.quality;

    const evidence: string[] = [];
    if (!stats.healthy) evidence.push("breaker open");
    evidence.push(stats.samples === 0 ? "not tried yet" : `${stats.successes}/${stats.samples} ok`);
    if (stats.typicalLatencyMs !== null) evidence.push(seconds(stats.typicalLatencyMs));
    if (typeof candidate.costPaise === "number") evidence.push(rupees(candidate.costPaise));
    if (candidate.quality !== undefined) evidence.push(`quality ${candidate.quality.toFixed(2)}`);

    return {
      id: candidate.id,
      key: candidate.key,
      score: Number(score.toFixed(4)),
      parts,
      healthy: stats.healthy,
      reason: evidence.join(" · "),
    };
  });

  // Health is a partition, not a weight: no combination of cheap, fast and
  // well-regarded may promote a provider whose breaker is open above one that
  // is answering. Array.prototype.sort is stable, so equal scores keep the
  // caller's order — which is how an explicit admin choice stays first.
  const healthy = scored.filter((s) => s.healthy).sort((a, b) => b.score - a.score);
  const unhealthy = scored.filter((s) => !s.healthy).sort((a, b) => b.score - a.score);
  return [...healthy, ...unhealthy];
}

/** Cap for the routing reason stored on a usage row. */
const MAX_REASON_LENGTH = 200;

/**
 * One line saying why the front-runner is the front-runner, with the nearest
 * rival for contrast — a score on its own is unfalsifiable, a score next to
 * the one it beat is an argument.
 */
export function explainWinner(ranked: ScoredProvider[]): string | undefined {
  const [winner, runnerUp] = ranked;
  if (!winner) return undefined;
  let text = `${winner.id} won on ${winner.reason} (${winner.score})`;
  if (runnerUp) text += `, ahead of ${runnerUp.id} (${runnerUp.score})`;
  return text.length > MAX_REASON_LENGTH ? `${text.slice(0, MAX_REASON_LENGTH - 1)}…` : text;
}
