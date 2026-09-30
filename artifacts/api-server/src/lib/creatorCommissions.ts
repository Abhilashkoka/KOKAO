import {
  db as rootDb,
  creatorAccountsTable,
  creatorAttributionsTable,
  creatorCommissionsTable,
  creditAccountLedgerTable,
  tenantsTable,
  type CreatorCommission,
} from "@workspace/db";
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { getFeatureFlags } from "./featureFlags";
import { referralCreditsMilli } from "./referralPurchase";
import { logger } from "./logger";
import { grantCredits } from "./creditAccounts";
import { getCreditPricePaise, MILLI } from "./creditRates";
import { notifyCreatorAdmins, notifyCreatorEvent } from "./notifications";
import {
  commissionSlabsFrom,
  getActiveCreatorAttribution,
  creatorSettingsAccess,
  pickCommissionSlab,
} from "./creatorProgram";

/**
 * Program B — commission accrual, risk scoring and maturation.
 *
 * Nothing here moves money out. A commission accrues as `pending`, matures to
 * `payable` only once the refund window has closed AND the referred workspace
 * has actually consumed a meaningful share of what it bought, and waits there
 * for the payout runner (not in this bundle).
 *
 * The consumption gate is the important one. A self-referrer farming commission
 * does not want to burn credits — burning them costs real provider spend — so
 * requiring consumption means fraud has to genuinely lose money to unlock a
 * fraction of it back. A real customer crosses the line without noticing.
 */

export type CommissionState =
  | "pending"
  | "payable"
  | "held"
  | "in_payout"
  | "paid"
  | "reversed"
  | "expired";

/** Only real credit purchases earn. Plan renewals deliberately do not. */
const EARNING_PURCHASE_KINDS = new Set(["credit_pack", "wallet_topup"]);

// ---------------------------------------------------------------------------
// Risk scoring
// ---------------------------------------------------------------------------

export interface RiskAssessment {
  score: number;
  signals: Record<string, unknown>;
}

/**
 * Score a commission for review. Higher is worse; `riskHoldThreshold` decides
 * what gets held.
 *
 * These are the signals available WITHOUT gateway data. The strongest signal —
 * the same UPI VPA or card fingerprint paying in and receiving out — needs the
 * payment instrument, which only the webhook sees. SETUP.md describes that
 * follow-up; the shape here already accommodates it.
 */
export function assessRisk(input: {
  attachSignals: Record<string, unknown> | null;
  creatorEmail: string;
  buyerEmail: string | null;
  tenantAgeMinutesAtPurchase: number | null;
  creatorCommissionCount: number;
  newCreatorReviewCount: number;
  recentAttachCount: number;
  /** Promoters are KOKAO users, so both workspaces can be compared directly. */
  creatorTenantCreatedAt?: Date | null;
  buyerTenantCreatedAt?: Date | null;
}): RiskAssessment {
  const signals: Record<string, unknown> = {};
  let score = 0;

  const creatorDomain = input.creatorEmail.split("@")[1]?.toLowerCase();
  const buyerDomain = input.buyerEmail?.split("@")[1]?.toLowerCase() ?? null;
  const freeMail = new Set([
    "gmail.com",
    "yahoo.com",
    "outlook.com",
    "hotmail.com",
    "icloud.com",
    "proton.me",
  ]);
  if (creatorDomain && buyerDomain && creatorDomain === buyerDomain) {
    // Shared corporate domain is a real signal; shared gmail is noise.
    if (!freeMail.has(creatorDomain)) {
      score += 35;
      signals.sharedEmailDomain = creatorDomain;
    }
  }

  const creatorLocal = input.creatorEmail.split("@")[0]?.toLowerCase() ?? "";
  const buyerLocal = input.buyerEmail?.split("@")[0]?.toLowerCase() ?? "";
  if (creatorLocal && buyerLocal) {
    // "abhilash" vs "abhilash+kokao" / "abhilash.k" — plus-addressing and
    // dotted aliases are the cheapest way to fake a second identity.
    const stripped = (s: string) => s.split("+")[0]!.replace(/\./g, "");
    if (stripped(creatorLocal) === stripped(buyerLocal)) {
      score += 40;
      signals.similarEmailLocalPart = true;
    }
  }

  const age = input.tenantAgeMinutesAtPurchase;
  if (age !== null && age < 30) {
    score += 20;
    signals.workspaceMinutesOldAtPurchase = age;
  }

  if (input.creatorCommissionCount < input.newCreatorReviewCount) {
    score += 25;
    signals.newCreatorReview = input.creatorCommissionCount + 1;
  }

  if (input.recentAttachCount >= 10) {
    score += 20;
    signals.attachVelocity24h = input.recentAttachCount;
  }

  if (input.attachSignals?.tenantAgeMinutes === 0) {
    score += 10;
    signals.attachedAtSignup = true;
  }

  // Both parties are KOKAO workspaces now, so their signup times are
  // comparable. Two accounts minted in the same sitting is the classic shape
  // of one person running both sides.
  if (input.creatorTenantCreatedAt && input.buyerTenantCreatedAt) {
    const gapMinutes = Math.abs(
      (input.buyerTenantCreatedAt.getTime() -
        input.creatorTenantCreatedAt.getTime()) /
        60_000,
    );
    if (gapMinutes < 60) {
      score += 30;
      signals.workspacesCreatedMinutesApart = Math.floor(gapMinutes);
    }
  }

  return { score: Math.min(100, score), signals };
}

// ---------------------------------------------------------------------------
// Accrual
// ---------------------------------------------------------------------------

export interface AccrueParams {
  tenantId: number;
  kind: string;
  refId: string;
  totalPaise: number;
  invoiceId?: number | null;
}

export interface AccrueResult {
  accrued: boolean;
  reason?:
    | "program_disabled"
    | "not_earning_kind"
    | "no_attribution"
    | "creator_not_approved"
    | "first_purchase_only"
    | "zero_amount"
    | "already_accrued";
  commissionPaise?: number;
  buyerCredits?: number;
  state?: CommissionState;
  notification?: { commissionId: number; creatorTenantId: number };
}

/**
 * Accrue a creator commission for a completed purchase, and grant the buyer
 * their bonus credits.
 *
 * Idempotent on (purchaseKind, purchaseRefId) — verify routes and webhook
 * backstops can both reach this for the same payment. Never throws: the money
 * has already moved, so a failure here is logged and swallowed.
 */
async function accrueInner(
  db: Database,
  params: AccrueParams,
): Promise<AccrueResult> {
  try {
    if (!EARNING_PURCHASE_KINDS.has(params.kind)) {
      return { accrued: false, reason: "not_earning_kind" };
    }
    if (!Number.isSafeInteger(params.totalPaise) || params.totalPaise > 2147483647 || !params.refId.trim() || params.totalPaise <= 0) {
      return { accrued: false, reason: "zero_amount" };
    }

    const settings = await creatorSettingsAccess.get();
    if (!settings.programEnabled || !(await getFeatureFlags()).creatorProgram) {
      return { accrued: false, reason: "program_disabled" };
    }

    const [attribution] = await db.select().from(creatorAttributionsTable).where(eq(creatorAttributionsTable.tenantId, params.tenantId)).limit(1);
    if (attribution?.expiresAt && attribution.expiresAt <= new Date()) return {accrued:false, reason:"no_attribution"};
    if (!attribution) return { accrued: false, reason: "no_attribution" };

    if (
      settings.triggerMode === "first_purchase" &&
      attribution.grantCount > 0
    ) {
      return { accrued: false, reason: "first_purchase_only" };
    }

    const [creator] = await db
      .select()
      .from(creatorAccountsTable)
      .where(eq(creatorAccountsTable.id, attribution.creatorId))
      .limit(1);
    if (!creator || creator.status !== "approved" || creator.tenantId === params.tenantId) {
      return { accrued: false, reason: "creator_not_approved" };
    }

    // Rate: a per-creator override wins, otherwise the live slab ladder.
    const priorCount = await countCreatorCommissions(creator.id, db);
    const slabs = commissionSlabsFrom(settings);
    const { slab, index } = pickCommissionSlab(slabs, priorCount);
    const commissionBps = creator.commissionOverrideBps ?? slab.commissionBps;
    const slabIndex = creator.commissionOverrideBps === null ? index : null;

    if (!Number.isSafeInteger(commissionBps) || commissionBps < 0 || commissionBps > 10000) throw new Error("Invalid commission rate");
    const commissionPaise = Number(BigInt(params.totalPaise) * BigInt(commissionBps) / 10000n);
    const creditPricePaise = await getCreditPricePaise();
    const creditsPurchasedMilli = referralCreditsMilli(params.totalPaise, 10000, creditPricePaise);
    const buyerBonusMilli = referralCreditsMilli(params.totalPaise, settings.buyerBonusBps, creditPricePaise);

    if (commissionPaise <= 0 && buyerBonusMilli <= 0) {
      return { accrued: false, reason: "zero_amount" };
    }

    const [buyerTenant, creatorTenant] = await Promise.all([
      getTenant(params.tenantId, db),
      getTenant(creator.tenantId, db),
    ]);

    const risk = assessRisk({
      attachSignals: attribution.attachSignals ?? null,
      creatorEmail: creator.contactEmail,
      buyerEmail: buyerTenant?.email ?? null,
      tenantAgeMinutesAtPurchase:
        buyerTenant ? Math.floor((Date.now() - buyerTenant.createdAt.getTime()) / 60000) : null,
      creatorCommissionCount: priorCount,
      newCreatorReviewCount: settings.newCreatorReviewCount,
      recentAttachCount: await recentAttachCount(creator.id, db),
      creatorTenantCreatedAt: creatorTenant?.createdAt ?? null,
      buyerTenantCreatedAt: buyerTenant?.createdAt ?? null,
    });

    const now = new Date();
    const holdUntil = new Date(
      now.getTime() + settings.holdDays * 24 * 60 * 60 * 1000,
    );
    const expiresAt = new Date(
      now.getTime() + settings.earningExpiryDays * 24 * 60 * 60 * 1000,
    );
    const state: CommissionState =
      risk.score >= settings.riskHoldThreshold || priorCount < settings.newCreatorReviewCount ? "held" : "pending";

    const inserted = await (async () => {
      const tx = db;
      const [row] = await tx
        .insert(creatorCommissionsTable)
        .values({
          creatorId: creator.id,
          creatorCodeId: attribution.creatorCodeId,
          tenantId: params.tenantId,
          invoiceId: params.invoiceId ?? null,
          purchaseKind: params.kind,
          purchaseRefId: params.refId,
          grossPaise: params.totalPaise,
          netPaise: params.totalPaise,
          commissionBps,
          commissionPaise,
          slabIndex,
          buyerBonusCreditsMilli: buyerBonusMilli,
          creditsPurchasedMilli,
          state,
          riskScore: risk.score,
          riskSignals: risk.signals,
          holdUntil,
          expiresAt,
          stateReason:
            state === "held" ? "Held for review: risk score" : null,
        })
        .onConflictDoNothing({
          target: [
            creatorCommissionsTable.purchaseKind,
            creatorCommissionsTable.purchaseRefId,
          ],
        })
        .returning({ id: creatorCommissionsTable.id });
      if (!row) return null;

      // The buyer's bonus is credits and is granted immediately — they paid,
      // they get their bonus. Only the creator's cash waits.
      if (buyerBonusMilli > 0) {
        await grantCredits(
          {
            tenantId: params.tenantId,
            credits: buyerBonusMilli / MILLI,
            kind: "grant_promo",
            expiresInDays: settings.buyerBonusExpiryDays,
            idempotencyKey: `creator-purchase:${row.id}:buyer`,
            note: `Creator code bonus (${attribution.code})`,
          },
          tx as unknown as Parameters<typeof grantCredits>[1],
        );
      }

      await tx
        .update(creatorAttributionsTable)
        .set({ grantCount: attribution.grantCount + 1, lastGrantAt: now })
        .where(eq(creatorAttributionsTable.tenantId, params.tenantId));

      return row.id;
    })();

    if (inserted === null) {
      return { accrued: false, reason: "already_accrued" };
    }
    return {
      accrued: true,
      commissionPaise,
      buyerCredits: buyerBonusMilli / MILLI,
      state,
      notification: { commissionId: inserted, creatorTenantId: creator.tenantId },
    };
  } catch (err) {
    logger.error(
      { err, kind: params.kind, refId: params.refId, tenantId: params.tenantId },
      "creator commission accrual failed (payment unaffected)",
    );
    throw err;
  }
}

async function getTenant(tenantId: number, db: Database = rootDb) {
  const [row] = await db
    .select({
      id: tenantsTable.id,
      email: tenantsTable.email,
      createdAt: tenantsTable.createdAt,
    })
    .from(tenantsTable)
    .where(eq(tenantsTable.id, tenantId))
    .limit(1);
  return row ?? null;
}

export async function countCreatorCommissions(
  creatorId: number, db: Database = rootDb,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(creatorCommissionsTable)
    .where(
      and(
        eq(creatorCommissionsTable.creatorId, creatorId),
        sql`${creatorCommissionsTable.state} <> 'reversed'`,
      ),
    );
  return row?.count ?? 0;
}

async function recentAttachCount(creatorId: number, db: Database = rootDb): Promise<number> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(creatorAttributionsTable)
    .where(
      and(
        eq(creatorAttributionsTable.creatorId, creatorId),
        gte(creatorAttributionsTable.attachedAt, since),
      ),
    );
  return row?.count ?? 0;
}

// ---------------------------------------------------------------------------
// The consumption gate
// ---------------------------------------------------------------------------

/**
 * How much of what this workspace bought it has since burned, in bps.
 *
 * Reads the credit ledger directly: `spend` rows carry negative deltas on both
 * buckets, so the absolute sum since the purchase is the consumption. Capped at
 * 10000 so an unusually heavy month can't overflow the gate's arithmetic.
 */
export async function consumptionBpsSince(
  tenantId: number,
  since: Date,
  creditsPurchasedMilli: number,
): Promise<number> {
  if (creditsPurchasedMilli <= 0) return 10_000;
  const [row] = await db
    .select({
      spentMilli: sql<string>`coalesce(-sum(${creditAccountLedgerTable.purchasedDeltaMilli}::bigint + ${creditAccountLedgerTable.grantedDeltaMilli}::bigint), 0)::text`,
    })
    .from(creditAccountLedgerTable)
    .where(
      and(
        eq(creditAccountLedgerTable.tenantId, tenantId),
        inArray(creditAccountLedgerTable.kind, ["spend", "refund"]),
        gte(creditAccountLedgerTable.createdAt, since),
      ),
    );
  const spent = BigInt(row?.spentMilli ?? "0");
  if (spent <= 0n) return 0;
  const ratio = spent * 10000n / BigInt(creditsPurchasedMilli);
  return Number(ratio > 10000n ? 10000n : ratio);
}

// ---------------------------------------------------------------------------
// Maturation worker
// ---------------------------------------------------------------------------

export interface MaturationSummary {
  examined: number;
  matured: number;
  expired: number;
}

/**
 * Promote eligible `pending` commissions to `payable`, and lapse `payable`
 * earnings that were never claimed.
 *
 * Idempotent and safe to run on a schedule — it only ever reads rows in a
 * state it is allowed to change, and writes the state it computed.
 */
export async function matureCreatorCommissions(
  batchSize = 200,
): Promise<MaturationSummary> {
  const settings = await creatorSettingsAccess.get();
  if (!settings.programEnabled || !(await getFeatureFlags()).creatorProgram) return {examined:0,matured:0,expired:0};
  const now = new Date();
  let matured = 0;

  const candidates = await db
    .select()
    .from(creatorCommissionsTable)
    .where(
      and(
        eq(creatorCommissionsTable.state, "pending"),
        lte(creatorCommissionsTable.holdUntil, now),
      ),
    )
    .orderBy(creatorCommissionsTable.updatedAt, creatorCommissionsTable.id)
    .limit(Math.max(1, Math.min(200, Math.floor(batchSize))));

  for (const c of candidates) {
    try {
      const bps = await consumptionBpsSince(
        c.tenantId,
        c.createdAt,
        c.creditsPurchasedMilli,
      );
      const eligible = bps >= settings.consumptionThresholdBps;
      const changed = await db
        .update(creatorCommissionsTable)
        .set({
          consumptionBps: bps,
          ...(eligible
            ? { state: "payable", maturedAt: now, stateReason: null }
            : {}),
        })
        .where(
          and(
            eq(creatorCommissionsTable.id, c.id),
            eq(creatorCommissionsTable.state, "pending"),
          ),
        ).returning({ id: creatorCommissionsTable.id });
      if (eligible) matured += changed.length;
    } catch (err) {
      logger.error(
        { err, commissionId: c.id },
        "creator commission maturation failed for one row",
      );
    }
  }

  const lapsed = await db
    .update(creatorCommissionsTable)
    .set({ state: "expired", stateReason: "Unclaimed past expiry" })
    .where(
      and(
        eq(creatorCommissionsTable.state, "payable"),
        lte(creatorCommissionsTable.expiresAt, now),
      ),
    )
    .returning({ id: creatorCommissionsTable.id });

  return {
    examined: candidates.length,
    matured,
    expired: lapsed.length,
  };
}

// ---------------------------------------------------------------------------
// Reversal and admin actions
// ---------------------------------------------------------------------------

/**
 * Reverse a commission after a refund or chargeback.
 *
 * Reversible from pending/held/payable outright. A commission already in a
 * payout or paid cannot be un-sent here — that reversal belongs to the payout
 * runner, which must offset it against the creator's reserve and then their
 * future balance. This function refuses rather than pretending.
 */
export async function reverseCreatorCommission(
  purchaseKind: string,
  purchaseRefId: string,
  reason: string,
): Promise<{ reversed: boolean; state?: CommissionState }> {
  const [row] = await db
    .select()
    .from(creatorCommissionsTable)
    .where(
      and(
        eq(creatorCommissionsTable.purchaseKind, purchaseKind),
        eq(creatorCommissionsTable.purchaseRefId, purchaseRefId),
      ),
    )
    .limit(1);
  if (!row) return { reversed: false };

  if (!["pending", "held", "payable"].includes(row.state)) {
    logger.warn(
      { commissionId: row.id, state: row.state },
      "refund on a creator commission that already left the ledger — needs a reserve offset",
    );
    return { reversed: false, state: row.state as CommissionState };
  }

  const changed = await db.update(creatorCommissionsTable)
    .set({ state: "reversed", netPaise: 0, stateReason: reason })
    .where(and(eq(creatorCommissionsTable.id, row.id), inArray(creatorCommissionsTable.state, ["pending", "held", "payable"]))).returning();
  return { reversed: changed.length > 0, state: changed.length ? "reversed" : undefined };
}

/** Clear a held commission back into the normal flow. */
export async function releaseHeldCommission(
  commissionId: number,
  reason: string,
): Promise<CreatorCommission | null> {
  const [updated] = await db
    .update(creatorCommissionsTable)
    .set({ state: "pending", stateReason: reason })
    .where(
      and(
        eq(creatorCommissionsTable.id, commissionId),
        eq(creatorCommissionsTable.state, "held"),
      ),
    )
    .returning();
  return updated ?? null;
}

// ---------------------------------------------------------------------------
// Summary (for the creator dashboard, built later)
// ---------------------------------------------------------------------------

export interface CreatorEarnings {
  pendingPaise: number;
  heldPaise: number;
  payablePaise: number;
  paidPaise: number;
  reversedPaise: number;
  /** Purchases waiting on the consumption gate, for the "why" explainer. */
  awaitingActivation: number;
  /** Purchases inside the refund hold window. */
  inHoldWindow: number;
  totalPurchases: number;
  grossDrivenPaise: number;
}

export async function getCreatorEarnings(
  creatorId: number,
): Promise<CreatorEarnings> {
  const now = new Date();
  const rows = await db
    .select({
      state: creatorCommissionsTable.state,
      commissionPaise: creatorCommissionsTable.commissionPaise,
      grossPaise: creatorCommissionsTable.grossPaise,
      holdUntil: creatorCommissionsTable.holdUntil,
      consumptionBps: creatorCommissionsTable.consumptionBps,
    })
    .from(creatorCommissionsTable)
    .where(eq(creatorCommissionsTable.creatorId, creatorId));

  const out: CreatorEarnings = {
    pendingPaise: 0,
    heldPaise: 0,
    payablePaise: 0,
    paidPaise: 0,
    reversedPaise: 0,
    awaitingActivation: 0,
    inHoldWindow: 0,
    totalPurchases: rows.length,
    grossDrivenPaise: 0,
  };

  for (const r of rows) {
    out.grossDrivenPaise += r.grossPaise;
    switch (r.state) {
      case "pending":
        out.pendingPaise += r.commissionPaise;
        if (r.holdUntil && r.holdUntil > now) out.inHoldWindow += 1;
        else out.awaitingActivation += 1;
        break;
      case "held":
        out.heldPaise += r.commissionPaise;
        break;
      case "payable":
        out.payablePaise += r.commissionPaise;
        break;
      case "in_payout":
      case "paid":
        out.paidPaise += r.commissionPaise;
        break;
      case "reversed":
        out.reversedPaise += r.commissionPaise;
        break;
      default:
        break;
    }
  }
  return out;
}

export async function listCreatorCommissions(
  creatorId: number,
  states?: CommissionState[],
  limit = 200,
): Promise<CreatorCommission[]> {
  const base = db
    .select()
    .from(creatorCommissionsTable)
    .where(
      states && states.length > 0
        ? and(
            eq(creatorCommissionsTable.creatorId, creatorId),
            inArray(creatorCommissionsTable.state, states),
          )
        : eq(creatorCommissionsTable.creatorId, creatorId),
    );
  return base.orderBy(sql`${creatorCommissionsTable.createdAt} desc`).limit(limit);
}

const db = rootDb;
type Database = typeof rootDb;
export async function accrueCreatorCommission(params: AccrueParams): Promise<AccrueResult> {
 try { const result = await rootDb.transaction(async tx => {
  await tx.execute(sql`select pg_advisory_xact_lock(73142, 1)`);
  return accrueInner(tx as unknown as Database, params);
  });
  if (result.notification) {
    const { commissionId, creatorTenantId } = result.notification;
    await notifyCreatorEvent({
      tenantId: creatorTenantId, type: "promoter_commission_earned",
      eventKey: `commission:${commissionId}`,
      title: "Your promoter code earned a commission",
      message: "An eligible credit purchase earned a promoter commission. It may be held for review before becoming ready to pay.",
      linkUrl: "/promoter",
    });
    if (result.state === "held") await notifyCreatorAdmins({
      type: "promoter_commission_held", eventKey: `commission:${commissionId}`,
      title: "Promoter commission awaiting review",
      message: `Commission #${commissionId} is held for review.`,
      linkUrl: "/admin",
    });
  }
  return result;
 } catch (err) { logger.error({err, kind: params.kind, refId: params.refId}, "Creator accrual failed; payment unaffected"); return {accrued:false}; }
}
