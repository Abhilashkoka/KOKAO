import {
  db,
  aiErrorClaimsTable,
  aiErrorGuaranteeSettingsTable,
  type AiErrorClaim,
} from "@workspace/db";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { isCreditFunded, refundCredits } from "./creditAccounts";
import { MILLI } from "./creditRates";
import { getVideoJobCreditReceipt } from "./creditReceipt";

/**
 * AI Error Guarantee: credits back when a finished video is wrong because of
 * the AI.
 *
 * Refund = what the video actually cost (net of earlier refunds) × the share
 * of the video the user marked as wrong. Objective categories inside the
 * auto-approve limits are refunded at once; anything else — "other", a range
 * covering most of the video, or a workspace past its monthly auto limit —
 * waits for an admin. One claim per video, ever.
 *
 * Refunds land in the never-expiring purchased bucket as an ordinary ledger
 * `refund` row tagged to the video, so the video's receipt shows it.
 */

export const OBJECTIVE_CATEGORIES = [
  "product_changed",
  "script_missed",
  "wrong_person",
  "garbled_text",
] as const;
export const CLAIM_CATEGORIES = [...OBJECTIVE_CATEGORIES, "other"] as const;
export type ClaimCategory = (typeof CLAIM_CATEGORIES)[number];

export const AI_ERROR_REFUND_RATE_KEY = "ai_error";

export interface GuaranteeSettings {
  enabled: boolean;
  claimWindowDays: number;
  autoApprovePerMonth: number;
  autoApproveMaxPercent: number;
}

export const DEFAULT_GUARANTEE_SETTINGS: GuaranteeSettings = {
  enabled: false,
  claimWindowDays: 7,
  autoApprovePerMonth: 2,
  autoApproveMaxPercent: 50,
};

const SETTINGS_ROW_ID = 1;
const MIN_RANGE_SEC = 0.5;
const MAX_NOTE = 500;

export class ClaimError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "ClaimError";
  }
}

export async function getGuaranteeSettings(): Promise<GuaranteeSettings> {
  const [row] = await db
    .select()
    .from(aiErrorGuaranteeSettingsTable)
    .where(eq(aiErrorGuaranteeSettingsTable.id, SETTINGS_ROW_ID))
    .limit(1);
  if (!row) return { ...DEFAULT_GUARANTEE_SETTINGS };
  return {
    enabled: row.enabled,
    claimWindowDays: row.claimWindowDays,
    autoApprovePerMonth: row.autoApprovePerMonth,
    autoApproveMaxPercent: row.autoApproveMaxPercent,
  };
}

export function validateGuaranteeSettings(input: GuaranteeSettings): GuaranteeSettings {
  const whole = (value: unknown, min: number, max: number, label: string): number => {
    if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
      throw new ClaimError(`${label} must be a whole number from ${min} to ${max}.`, 400, "invalid_settings");
    }
    return value as number;
  };
  if (typeof input.enabled !== "boolean") {
    throw new ClaimError("Enabled must be true or false.", 400, "invalid_settings");
  }
  return {
    enabled: input.enabled,
    claimWindowDays: whole(input.claimWindowDays, 1, 90, "Claim window"),
    autoApprovePerMonth: whole(input.autoApprovePerMonth, 0, 100, "Auto-approved claims per month"),
    autoApproveMaxPercent: whole(input.autoApproveMaxPercent, 0, 100, "Auto-approve range limit"),
  };
}

export async function setGuaranteeSettings(input: GuaranteeSettings): Promise<GuaranteeSettings> {
  const next = validateGuaranteeSettings(input);
  await db
    .insert(aiErrorGuaranteeSettingsTable)
    .values({ id: SETTINGS_ROW_ID, ...next })
    .onConflictDoUpdate({
      target: aiErrorGuaranteeSettingsTable.id,
      set: { ...next, updatedAt: new Date() },
    });
  return next;
}

/** Credits for the marked share of what the video cost, to 0.1 credit. */
export function suggestRefundCredits(
  netCharged: number,
  startSec: number,
  endSec: number,
  durationSec: number,
): number {
  if (!(netCharged > 0) || !(durationSec > 0)) return 0;
  const share = Math.min(1, Math.max(0, (endSec - startSec) / durationSec));
  return Math.round(netCharged * share * 10) / 10;
}

export function claimSharePercent(startSec: number, endSec: number, durationSec: number): number {
  if (!(durationSec > 0)) return 100;
  return Math.min(100, Math.max(0, ((endSec - startSec) / durationSec) * 100));
}

function monthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

const refundKey = (claimId: number) => `ai-error-claim:${claimId}`;

export interface FileClaimInput {
  tenantId: number;
  job: {
    id: number;
    status: string;
    createdAt: Date;
    isSmartEditChild: boolean;
  };
  versionId: string;
  videoDurationSec: number;
  category: string;
  startSec: number;
  endSec: number;
  note: string;
}

/** Can this video be claimed at all? Used to show or hide the button. */
export async function claimEligibility(
  tenantId: number,
  job: FileClaimInput["job"],
): Promise<{ eligible: boolean; reason: string | null; claim: AiErrorClaim | null; windowDays: number }> {
  const settings = await getGuaranteeSettings();
  const [claim] = await db
    .select()
    .from(aiErrorClaimsTable)
    .where(and(eq(aiErrorClaimsTable.tenantId, tenantId), eq(aiErrorClaimsTable.jobId, job.id)))
    .limit(1);
  const base = { claim: claim ?? null, windowDays: settings.claimWindowDays };
  if (!settings.enabled) return { ...base, eligible: false, reason: "The AI Error Guarantee is not available yet." };
  if (claim) return { ...base, eligible: false, reason: "This video already has a claim." };
  if (job.isSmartEditChild || job.status !== "succeeded") {
    return { ...base, eligible: false, reason: "Claims are available once the video has finished." };
  }
  const deadline = job.createdAt.getTime() + settings.claimWindowDays * 86_400_000;
  if (Date.now() > deadline) {
    return { ...base, eligible: false, reason: `Claims must be made within ${settings.claimWindowDays} days of creating the video.` };
  }
  if (!(await isCreditFunded(tenantId))) {
    return { ...base, eligible: false, reason: "Credit refunds apply to credit plans. Contact support for help with this video." };
  }
  return { ...base, eligible: true, reason: null };
}

/**
 * File a claim. Approves and refunds in the same transaction when the
 * guarantee rules allow; otherwise leaves it pending for an admin.
 */
export async function fileClaim(input: FileClaimInput): Promise<AiErrorClaim> {
  const settings = await getGuaranteeSettings();
  const eligibility = await claimEligibility(input.tenantId, input.job);
  if (!eligibility.eligible) {
    throw new ClaimError(eligibility.reason ?? "This video cannot be claimed.", eligibility.claim ? 409 : 400, "not_eligible");
  }
  if (!(CLAIM_CATEGORIES as readonly string[]).includes(input.category)) {
    throw new ClaimError("Pick what went wrong.", 400, "invalid_category");
  }
  const duration = input.videoDurationSec;
  if (
    !Number.isFinite(input.startSec) ||
    !Number.isFinite(input.endSec) ||
    input.startSec < 0 ||
    input.endSec > duration + 0.5 ||
    input.endSec - input.startSec < MIN_RANGE_SEC
  ) {
    throw new ClaimError("Mark the part of the video that is wrong (at least half a second).", 400, "invalid_range");
  }
  const note = input.note.trim().slice(0, MAX_NOTE);
  if (input.category === "other" && note.length < 3) {
    throw new ClaimError("Tell us what went wrong.", 400, "note_required");
  }
  const startSec = Math.max(0, input.startSec);
  const endSec = Math.min(duration, input.endSec);

  const receipt = await getVideoJobCreditReceipt(input.tenantId, input.job.id);
  if (!(receipt.net > 0)) {
    throw new ClaimError("Nothing was charged for this video, so there is nothing to refund.", 400, "nothing_charged");
  }
  const suggested = suggestRefundCredits(receipt.net, startSec, endSec, duration);

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${7_340_019}, ${input.tenantId})`);
    const [existing] = await tx
      .select({ id: aiErrorClaimsTable.id })
      .from(aiErrorClaimsTable)
      .where(and(eq(aiErrorClaimsTable.tenantId, input.tenantId), eq(aiErrorClaimsTable.jobId, input.job.id)))
      .limit(1);
    if (existing) throw new ClaimError("This video already has a claim.", 409, "duplicate");

    const [{ count: autoThisMonth }] = await tx
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(aiErrorClaimsTable)
      .where(
        and(
          eq(aiErrorClaimsTable.tenantId, input.tenantId),
          eq(aiErrorClaimsTable.autoApproved, true),
          gte(aiErrorClaimsTable.createdAt, monthStartUtc(new Date())),
        ),
      );
    const objective = (OBJECTIVE_CATEGORIES as readonly string[]).includes(input.category);
    const auto =
      objective &&
      suggested > 0 &&
      claimSharePercent(startSec, endSec, duration) <= settings.autoApproveMaxPercent &&
      autoThisMonth < settings.autoApprovePerMonth;

    const [claim] = await tx
      .insert(aiErrorClaimsTable)
      .values({
        tenantId: input.tenantId,
        jobId: input.job.id,
        versionId: input.versionId,
        category: input.category,
        startSec,
        endSec,
        videoDurationSec: duration,
        note,
        status: auto ? "approved" : "pending",
        autoApproved: auto,
        suggestedCredits: suggested,
        creditsRefunded: auto ? suggested : 0,
        decidedAt: auto ? new Date() : null,
      })
      .returning();
    if (auto) {
      await refundCredits(
        {
          tenantId: input.tenantId,
          creditsMilli: Math.round(suggested * MILLI),
          rateKey: AI_ERROR_REFUND_RATE_KEY,
          refKind: "videoJob",
          refId: String(input.job.id),
          idempotencyKey: refundKey(claim!.id),
          note: "AI error refund",
        },
        tx,
      );
    }
    return claim!;
  });
}

/**
 * An admin decision on a pending claim. Approval refunds `credits` (default:
 * the suggestion), never more than the video's net charge.
 */
export async function decideClaim(input: {
  claimId: number;
  approve: boolean;
  credits?: number | null;
  note?: string | null;
  adminTenantId: number;
}): Promise<AiErrorClaim> {
  const [peek] = await db
    .select()
    .from(aiErrorClaimsTable)
    .where(eq(aiErrorClaimsTable.id, input.claimId))
    .limit(1);
  if (!peek) throw new ClaimError("Claim not found.", 404, "not_found");
  const receipt = input.approve ? await getVideoJobCreditReceipt(peek.tenantId, peek.jobId) : null;

  return db.transaction(async (tx) => {
    const [claim] = await tx
      .select()
      .from(aiErrorClaimsTable)
      .where(eq(aiErrorClaimsTable.id, input.claimId))
      .for("update");
    if (!claim) throw new ClaimError("Claim not found.", 404, "not_found");
    if (claim.status !== "pending") throw new ClaimError("This claim has already been decided.", 409, "decided");
    const note = input.note?.trim().slice(0, MAX_NOTE) || null;
    if (!input.approve) {
      if (!note) throw new ClaimError("Give the user a reason for rejecting.", 400, "reason_required");
      const [saved] = await tx
        .update(aiErrorClaimsTable)
        .set({ status: "rejected", decidedByTenantId: input.adminTenantId, decisionNote: note, decidedAt: new Date() })
        .where(eq(aiErrorClaimsTable.id, claim.id))
        .returning();
      return saved!;
    }
    const cap = Math.max(0, receipt?.net ?? 0);
    const wanted = input.credits ?? claim.suggestedCredits;
    if (!Number.isFinite(wanted) || wanted < 0) {
      throw new ClaimError("Refund must be 0 or more credits.", 400, "invalid_credits");
    }
    if (wanted > cap + 1e-9) {
      throw new ClaimError(`Refund can't exceed what this video cost (${cap} credits).`, 400, "over_cap");
    }
    const credits = Math.round(wanted * 1000) / 1000;
    if (credits > 0) {
      await refundCredits(
        {
          tenantId: claim.tenantId,
          creditsMilli: Math.round(credits * MILLI),
          rateKey: AI_ERROR_REFUND_RATE_KEY,
          refKind: "videoJob",
          refId: String(claim.jobId),
          idempotencyKey: refundKey(claim.id),
          note: "AI error refund",
        },
        tx,
      );
    }
    const [saved] = await tx
      .update(aiErrorClaimsTable)
      .set({
        status: "approved",
        creditsRefunded: credits,
        decidedByTenantId: input.adminTenantId,
        decisionNote: note,
        decidedAt: new Date(),
      })
      .where(eq(aiErrorClaimsTable.id, claim.id))
      .returning();
    return saved!;
  });
}

export async function listClaims(status: string | null, limit = 50): Promise<AiErrorClaim[]> {
  return db
    .select()
    .from(aiErrorClaimsTable)
    .where(status ? eq(aiErrorClaimsTable.status, status) : undefined)
    .orderBy(desc(aiErrorClaimsTable.createdAt))
    .limit(Math.min(200, Math.max(1, limit)));
}

export interface ClaimsReport {
  pending: number;
  monthClaims: number;
  monthRefundedCredits: number;
  byCategory: Array<{ category: string; claims: number }>;
}

/**
 * What went wrong this month, by category: the list to fix prompts and
 * models against, so claims get rarer over time.
 */
export async function claimsReport(): Promise<ClaimsReport> {
  const month = monthStartUtc(new Date());
  const [pendingRow] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(aiErrorClaimsTable)
    .where(eq(aiErrorClaimsTable.status, "pending"));
  const rows = await db
    .select({
      category: aiErrorClaimsTable.category,
      claims: sql<number>`COUNT(*)::int`,
      refunded: sql<number>`COALESCE(SUM(${aiErrorClaimsTable.creditsRefunded}), 0)::float`,
    })
    .from(aiErrorClaimsTable)
    .where(gte(aiErrorClaimsTable.createdAt, month))
    .groupBy(aiErrorClaimsTable.category);
  return {
    pending: pendingRow?.count ?? 0,
    monthClaims: rows.reduce((t, r) => t + r.claims, 0),
    monthRefundedCredits: Math.round(rows.reduce((t, r) => t + r.refunded, 0) * 10) / 10,
    byCategory: rows
      .map((r) => ({ category: r.category, claims: r.claims }))
      .sort((a, b) => b.claims - a.claims),
  };
}

export function serializeClaim(claim: AiErrorClaim) {
  return {
    id: claim.id,
    jobId: claim.jobId,
    versionId: claim.versionId,
    category: claim.category,
    startSec: claim.startSec,
    endSec: claim.endSec,
    videoDurationSec: claim.videoDurationSec,
    note: claim.note,
    status: claim.status,
    autoApproved: claim.autoApproved,
    suggestedCredits: claim.suggestedCredits,
    creditsRefunded: claim.creditsRefunded,
    decisionNote: claim.decisionNote,
    createdAt: claim.createdAt.toISOString(),
    decidedAt: claim.decidedAt ? claim.decidedAt.toISOString() : null,
  };
}
