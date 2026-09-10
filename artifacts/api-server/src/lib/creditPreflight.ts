import type { Response } from "express";
import { getMeterMode } from "./creditRates";
import { peekCreditBalance } from "./creditAccounts";
import { quoteVideoJobCredits, type VideoJobQuoteInput } from "./creditQuote";
import { InsufficientCreditsError } from "./creditAccounts";
import { logger } from "./logger";

/**
 * Stop a job before it starts when the balance cannot cover it.
 *
 * The meter already refuses an individual provider call it cannot pay for, but
 * that is the wrong place to find out. A video job makes many calls; running
 * out at scene three leaves a half-rendered job, a partial charge and a user
 * who has no idea what happened. Quoting the whole job up front turns that
 * into one clear answer before any money is spent.
 *
 * The response body carries the numbers the UI needs to be useful — what the
 * job costs and what the workspace actually has — because "insufficient
 * credits" without those two figures tells someone they have a problem without
 * telling them how big it is.
 */

export interface CreditShortfall {
  error: string;
  code: "insufficient_credits";
  /** Credits the job needs. */
  required: number;
  /** Credits the workspace holds right now. */
  available: number;
  /** How many more are needed. */
  shortfall: number;
}

function shortfallBody(required: number, available: number): CreditShortfall {
  const shortfall = Math.max(0, Math.round((required - available) * 1000) / 1000);
  return {
    error: `This needs ${required.toFixed(required < 10 ? 1 : 0)} credits and you have ${available.toFixed(available < 10 ? 1 : 0)}. Top up to continue.`,
    code: "insufficient_credits",
    required,
    available,
    shortfall,
  };
}

/**
 * Answer 402 with the figures, or return false when nothing is wrong.
 *
 * Returns true when it has already sent a response, so callers read as
 * `if (await preflight(...)) return;`.
 */
export async function refuseIfShortOfCredits(
  res: Response,
  tenantId: number,
  job: VideoJobQuoteInput,
): Promise<boolean> {
  let mode: string;
  try {
    mode = await getMeterMode();
  } catch (err) {
    // A settings read that fails must never block a generation. The meter's
    // own per-call check still guards the money.
    logger.warn({ err }, "credit preflight: could not read meter mode; allowing");
    return false;
  }
  if (mode !== "enforce") return false;

  try {
    const [quote, balance] = await Promise.all([
      quoteVideoJobCredits(job),
      peekCreditBalance(tenantId),
    ]);
    if (quote.credits <= balance.total) return false;
    res.status(402).json(shortfallBody(quote.credits, balance.total));
    return true;
  } catch (err) {
    logger.warn({ err, tenantId }, "credit preflight failed; allowing the job through");
    return false;
  }
}

/**
 * Turn the meter's own mid-flight refusal into the same 402 shape, so a
 * shortfall the preflight could not predict — a retry, a scene the plan did
 * not account for — reaches the UI looking identical to one it did.
 */
export function respondToCreditError(res: Response, error: unknown): boolean {
  if (!(error instanceof InsufficientCreditsError)) return false;
  res
    .status(402)
    .json(shortfallBody(error.requiredMilli / 1000, error.availableMilli / 1000));
  return true;
}
