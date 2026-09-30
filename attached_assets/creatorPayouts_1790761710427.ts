import { createHmac, timingSafeEqual } from "node:crypto";
import {
  db,
  creatorAccountsTable,
  creatorCommissionsTable,
  creatorLedgerAdjustmentsTable,
  creatorPayoutIdentitiesTable,
  creatorPayoutsTable,
  type CreatorPayout,
  type CreatorPayoutIdentity,
} from "@workspace/db";
import { and, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { logger } from "./logger";
import { getCreatorProgramSettings } from "./creatorProgram";

/**
 * Promoter payouts.
 *
 * DESIGN CALL: this does not wire a payout API. It batches, withholds TDS and
 * reserve, produces a reviewable batch and an exportable bank file, and waits
 * for a human to mark it sent. Automating the first payouts of a new program
 * means discovering an arithmetic mistake by wiring money to strangers.
 *
 * `dispatchPayout` is the seam. When you are ready for RazorpayX or Cashfree
 * Payouts, implement it there — the batch, the ledger and the reserve logic do
 * not change.
 *
 * PII: PAN and bank account numbers are NEVER stored. They are HMAC-ed with a
 * server-side pepper and kept as hashes plus a last-4 for display. The hash is
 * what deduplicates a promoter across accounts and what a bank-account
 * cross-check compares against.
 */

// ---------------------------------------------------------------------------
// PII hashing
// ---------------------------------------------------------------------------

/**
 * Pepper for PII hashes. MUST be set before any payout identity is stored, and
 * MUST NOT change afterwards — rotating it orphans every existing hash and
 * silently breaks PAN deduplication.
 */
function pepper(): string {
  const value = process.env.CREATOR_PII_PEPPER;
  if (!value || value.length < 32) {
    throw new Error(
      "CREATOR_PII_PEPPER must be set to at least 32 characters before collecting payout details.",
    );
  }
  return value;
}

export function hashPii(value: string): string {
  return createHmac("sha256", pepper()).update(value).digest("hex");
}

/** ABCDE1234F — five letters, four digits, one letter. */
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;

export function normalizePan(raw: string): string {
  return raw.replace(/\s+/g, "").toUpperCase();
}

export function normalizeAccount(raw: string): string {
  return raw.replace(/[^0-9]/g, "");
}

export class PayoutIdentityError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "invalid_pan"
      | "invalid_account"
      | "invalid_ifsc"
      | "pan_in_use"
      | "not_a_promoter"
      | "self_payment_suspected",
  ) {
    super(message);
    this.name = "PayoutIdentityError";
  }
}

export interface PayoutIdentityInput {
  creatorId: number;
  pan: string;
  accountNumber: string;
  ifsc: string;
  beneficiaryName: string;
}

/**
 * Collect payout details. Called at the FIRST payout request, not at signup —
 * nobody hands over a PAN to get a link.
 *
 * Runs the cross-check described in the spec: if the bank account being paid
 * matches a payment instrument used by a workspace that redeemed this
 * promoter's own code, that is the same person on both sides of the trade.
 */
export async function saveCreatorPayoutIdentity(
  input: PayoutIdentityInput,
): Promise<CreatorPayoutIdentity> {
  const pan = normalizePan(input.pan);
  if (!PAN_RE.test(pan)) {
    throw new PayoutIdentityError("That PAN doesn't look right.", "invalid_pan");
  }
  const account = normalizeAccount(input.accountNumber);
  if (account.length < 6 || account.length > 20) {
    throw new PayoutIdentityError(
      "That account number doesn't look right.",
      "invalid_account",
    );
  }
  const ifsc = input.ifsc.replace(/\s+/g, "").toUpperCase();
  if (!IFSC_RE.test(ifsc)) {
    throw new PayoutIdentityError("That IFSC doesn't look right.", "invalid_ifsc");
  }

  const panHash = hashPii(pan);
  const bankAccountHash = hashPii(`${account}|${ifsc}`);

  // One payout identity per PAN, across all promoter accounts.
  const [panOwner] = await db
    .select({ creatorId: creatorPayoutIdentitiesTable.creatorId })
    .from(creatorPayoutIdentitiesTable)
    .where(eq(creatorPayoutIdentitiesTable.panHash, panHash))
    .limit(1);
  if (panOwner && panOwner.creatorId !== input.creatorId) {
    throw new PayoutIdentityError(
      "These payout details are already registered to another promoter account.",
      "pan_in_use",
    );
  }

  if (await bankMatchesOwnReferrals(input.creatorId, bankAccountHash)) {
    // Not an outright refusal — a shared family account is possible — but it
    // must not clear silently. Flag the promoter and let a human decide.
    await db
      .update(creatorAccountsTable)
      .set({
        riskFlags: sql`coalesce(${creatorAccountsTable.riskFlags}, '{}'::jsonb) || ${JSON.stringify(
          { payoutAccountMatchesReferredBuyer: true },
        )}::jsonb`,
      })
      .where(eq(creatorAccountsTable.id, input.creatorId));
    logger.warn(
      { creatorId: input.creatorId },
      "promoter payout account matches a payment instrument used by one of their own referrals",
    );
  }

  const [saved] = await db
    .insert(creatorPayoutIdentitiesTable)
    .values({
      creatorId: input.creatorId,
      panHash,
      panLast4: pan.slice(-4),
      bankAccountHash,
      bankLast4: account.slice(-4),
      ifsc,
      beneficiaryName: input.beneficiaryName.trim().slice(0, 120),
    })
    .onConflictDoUpdate({
      target: creatorPayoutIdentitiesTable.creatorId,
      set: {
        panHash,
        panLast4: pan.slice(-4),
        bankAccountHash,
        bankLast4: account.slice(-4),
        ifsc,
        beneficiaryName: input.beneficiaryName.trim().slice(0, 120),
        // Changing bank details re-opens verification.
        verifiedAt: null,
      },
    })
    .returning();
  return saved!;
}

/**
 * Does this payout account match a payment instrument used by a workspace that
 * redeemed this promoter's code?
 *
 * INERT UNTIL INSTRUMENT CAPTURE EXISTS. The gateway webhooks carry the UPI VPA
 * and card fingerprint; nothing stores them yet. See SETUP.md — when
 * `tenant_payment_instruments` lands, replace this body with the join. The call
 * site is already in place so that change is additive.
 */
async function bankMatchesOwnReferrals(
  _creatorId: number,
  _bankAccountHash: string,
): Promise<boolean> {
  return false;
}

/** Constant-time compare, for verification callbacks that echo a hash back. */
export function hashesMatch(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

// ---------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------

export interface PayoutBalance {
  payablePaise: number;
  adjustmentsPaise: number;
  /** What would actually be paid: payable + adjustments, floored at 0. */
  netOwedPaise: number;
  /** Negative adjustments not yet worked off. */
  owedBackPaise: number;
  commissionIds: number[];
}

export async function getPayoutBalance(
  creatorId: number,
): Promise<PayoutBalance> {
  const [rows, [adj]] = await Promise.all([
    db
      .select({
        id: creatorCommissionsTable.id,
        commissionPaise: creatorCommissionsTable.commissionPaise,
      })
      .from(creatorCommissionsTable)
      .where(
        and(
          eq(creatorCommissionsTable.creatorId, creatorId),
          eq(creatorCommissionsTable.state, "payable"),
        ),
      ),
    db
      .select({
        total: sql<number>`coalesce(sum(${creatorLedgerAdjustmentsTable.amountPaise}), 0)::int`,
      })
      .from(creatorLedgerAdjustmentsTable)
      .where(eq(creatorLedgerAdjustmentsTable.creatorId, creatorId)),
  ]);

  const payablePaise = rows.reduce((s, r) => s + r.commissionPaise, 0);
  const adjustmentsPaise = adj?.total ?? 0;
  const net = payablePaise + adjustmentsPaise;
  return {
    payablePaise,
    adjustmentsPaise,
    netOwedPaise: Math.max(0, net),
    owedBackPaise: net < 0 ? -net : 0,
    commissionIds: rows.map((r) => r.id),
  };
}

// ---------------------------------------------------------------------------
// Payout runs
// ---------------------------------------------------------------------------

export interface PayoutRunSummary {
  created: number;
  skipped: { creatorId: number; reason: string }[];
  totalNetPaise: number;
}

/**
 * Build draft payout batches for every eligible promoter.
 *
 * Creates batches only — nothing is sent. A human reviews, exports and marks
 * them paid. Safe to re-run: commissions move to `in_payout` inside the same
 * transaction that creates the batch, so a second run cannot pick them up.
 */
export async function buildPayoutRun(
  periodStart?: Date,
  periodEnd?: Date,
): Promise<PayoutRunSummary> {
  const settings = await getCreatorProgramSettings();
  const summary: PayoutRunSummary = {
    created: 0,
    skipped: [],
    totalNetPaise: 0,
  };

  const creators = await db
    .select()
    .from(creatorAccountsTable)
    .where(eq(creatorAccountsTable.status, "approved"));

  for (const creator of creators) {
    try {
      const balance = await getPayoutBalance(creator.id);
      if (balance.commissionIds.length === 0) continue;

      if (balance.netOwedPaise < settings.minPayoutPaise) {
        summary.skipped.push({
          creatorId: creator.id,
          reason:
            balance.owedBackPaise > 0
              ? "negative balance"
              : "below minimum payout",
        });
        continue;
      }

      const [identity] = await db
        .select()
        .from(creatorPayoutIdentitiesTable)
        .where(eq(creatorPayoutIdentitiesTable.creatorId, creator.id))
        .limit(1);
      if (!identity) {
        summary.skipped.push({
          creatorId: creator.id,
          reason: "no payout details on file",
        });
        continue;
      }

      const gross = balance.netOwedPaise;
      const reserve = Math.floor((gross * settings.reserveBps) / 10_000);
      const afterReserve = gross - reserve;
      const tds = Math.floor((afterReserve * settings.tdsRateBps) / 10_000);
      const net = afterReserve - tds;

      await db.transaction(async (tx) => {
        const [payout] = await tx
          .insert(creatorPayoutsTable)
          .values({
            creatorId: creator.id,
            payoutIdentityId: identity.id,
            grossPaise: gross,
            tdsPaise: tds,
            tdsRateBps: settings.tdsRateBps,
            reserveHeldPaise: reserve,
            netPaise: net,
            status: "draft",
            periodStart: periodStart ?? null,
            periodEnd: periodEnd ?? new Date(),
          })
          .returning({ id: creatorPayoutsTable.id });

        // Claim the commissions. The state guard means a concurrent run that
        // read the same rows updates nothing.
        await tx
          .update(creatorCommissionsTable)
          .set({ state: "in_payout", payoutId: payout!.id })
          .where(
            and(
              inArray(creatorCommissionsTable.id, balance.commissionIds),
              eq(creatorCommissionsTable.state, "payable"),
            ),
          );

        // Consume any negative balance that was netted off above.
        if (balance.adjustmentsPaise < 0) {
          await tx.insert(creatorLedgerAdjustmentsTable).values({
            creatorId: creator.id,
            amountPaise: -balance.adjustmentsPaise,
            kind: "correction",
            payoutId: payout!.id,
            idempotencyKey: `offset-consumed:${payout!.id}`,
            note: "Negative balance settled against this payout",
          });
        }
      });

      summary.created += 1;
      summary.totalNetPaise += net;
    } catch (err) {
      logger.error(
        { err, creatorId: creator.id },
        "payout batch build failed for one promoter",
      );
      summary.skipped.push({ creatorId: creator.id, reason: "error" });
    }
  }
  return summary;
}

/**
 * Bank-transfer export for a draft batch. A plain CSV an operator can hand to
 * a bank portal, or eyeball before paying by hand.
 *
 * Deliberately carries no PAN — only the last 4, the IFSC and the beneficiary
 * name. A payout file lands in inboxes and download folders.
 */
export async function exportPayoutBatch(payoutIds: number[]): Promise<string> {
  const rows = await db
    .select({
      payout: creatorPayoutsTable,
      identity: creatorPayoutIdentitiesTable,
      creator: creatorAccountsTable,
    })
    .from(creatorPayoutsTable)
    .innerJoin(
      creatorPayoutIdentitiesTable,
      eq(creatorPayoutsTable.payoutIdentityId, creatorPayoutIdentitiesTable.id),
    )
    .innerJoin(
      creatorAccountsTable,
      eq(creatorPayoutsTable.creatorId, creatorAccountsTable.id),
    )
    .where(inArray(creatorPayoutsTable.id, payoutIds));

  const header = [
    "payout_id",
    "promoter",
    "beneficiary_name",
    "account_last4",
    "ifsc",
    "gross_inr",
    "reserve_inr",
    "tds_inr",
    "net_inr",
  ].join(",");

  const lines = rows.map((r) =>
    [
      r.payout.id,
      csv(r.creator.displayName),
      csv(r.identity.beneficiaryName ?? r.creator.displayName),
      r.identity.bankLast4 ?? "",
      r.identity.ifsc ?? "",
      (r.payout.grossPaise / 100).toFixed(2),
      (r.payout.reserveHeldPaise / 100).toFixed(2),
      (r.payout.tdsPaise / 100).toFixed(2),
      (r.payout.netPaise / 100).toFixed(2),
    ].join(","),
  );

  await db
    .update(creatorPayoutsTable)
    .set({ status: "exported" })
    .where(
      and(
        inArray(creatorPayoutsTable.id, payoutIds),
        eq(creatorPayoutsTable.status, "draft"),
      ),
    );

  return [header, ...lines].join("\n");
}

function csv(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * The dispatch seam. Implement RazorpayX / Cashfree Payouts here when you want
 * automation; nothing above needs to change.
 */
export async function dispatchPayout(
  _payoutId: number,
): Promise<{ dispatched: boolean; reason: string }> {
  return {
    dispatched: false,
    reason:
      "No payout gateway is wired up. Export the batch and mark it paid once the transfer clears.",
  };
}

/** Confirm a transfer actually landed. */
export async function markPayoutPaid(
  payoutId: number,
  gatewayRef: string | null,
): Promise<CreatorPayout | null> {
  return db.transaction(async (tx) => {
    const [payout] = await tx
      .update(creatorPayoutsTable)
      .set({ status: "paid", paidAt: new Date(), gatewayRef })
      .where(
        and(
          eq(creatorPayoutsTable.id, payoutId),
          inArray(creatorPayoutsTable.status, ["draft", "exported"]),
        ),
      )
      .returning();
    if (!payout) return null;
    await tx
      .update(creatorCommissionsTable)
      .set({ state: "paid" })
      .where(eq(creatorCommissionsTable.payoutId, payoutId));
    return payout;
  });
}

/** A transfer bounced. Put the money back in the queue. */
export async function markPayoutFailed(
  payoutId: number,
  reason: string,
): Promise<CreatorPayout | null> {
  return db.transaction(async (tx) => {
    const [payout] = await tx
      .update(creatorPayoutsTable)
      .set({ status: "failed", failureReason: reason.slice(0, 500) })
      .where(
        and(
          eq(creatorPayoutsTable.id, payoutId),
          inArray(creatorPayoutsTable.status, ["draft", "exported"]),
        ),
      )
      .returning();
    if (!payout) return null;
    await tx
      .update(creatorCommissionsTable)
      .set({ state: "payable", payoutId: null })
      .where(eq(creatorCommissionsTable.payoutId, payoutId));
    return payout;
  });
}

// ---------------------------------------------------------------------------
// Reserve release and clawback
// ---------------------------------------------------------------------------

/**
 * Release reserves held on payouts old enough that a chargeback is no longer
 * plausible. Idempotent on the payout id, so re-running is harmless.
 */
export async function releaseMatureReserves(): Promise<{ released: number }> {
  const settings = await getCreatorProgramSettings();
  const cutoff = new Date(
    Date.now() - settings.reserveReleaseDays * 24 * 60 * 60 * 1000,
  );

  const due = await db
    .select()
    .from(creatorPayoutsTable)
    .where(
      and(
        eq(creatorPayoutsTable.status, "paid"),
        isNull(creatorPayoutsTable.reserveReleasedAt),
        lte(creatorPayoutsTable.paidAt, cutoff),
      ),
    )
    .limit(500);

  let released = 0;
  for (const p of due) {
    if (p.reserveHeldPaise <= 0) {
      await db
        .update(creatorPayoutsTable)
        .set({ reserveReleasedAt: new Date() })
        .where(eq(creatorPayoutsTable.id, p.id));
      continue;
    }
    try {
      await db.transaction(async (tx) => {
        await tx.insert(creatorLedgerAdjustmentsTable).values({
          creatorId: p.creatorId,
          amountPaise: p.reserveHeldPaise,
          kind: "reserve_release",
          payoutId: p.id,
          idempotencyKey: `reserve-release:${p.id}`,
          note: `Reserve from payout #${p.id} released`,
        });
        await tx
          .update(creatorPayoutsTable)
          .set({ reserveReleasedAt: new Date() })
          .where(eq(creatorPayoutsTable.id, p.id));
      });
      released += 1;
    } catch (err) {
      logger.error({ err, payoutId: p.id }, "reserve release failed");
    }
  }
  return { released };
}

/**
 * Claw back a commission that was already paid out.
 *
 * This is the case `reverseCreatorCommission` refuses. The money is gone, so
 * the only honest move is to record what is owed: a negative adjustment that
 * the reserve absorbs first and the next payout settles against.
 */
export async function clawbackPaidCommission(
  commissionId: number,
  reason: string,
): Promise<{ clawedBack: boolean; amountPaise?: number }> {
  const [c] = await db
    .select()
    .from(creatorCommissionsTable)
    .where(eq(creatorCommissionsTable.id, commissionId))
    .limit(1);
  if (!c) return { clawedBack: false };
  if (!["in_payout", "paid"].includes(c.state)) {
    return { clawedBack: false };
  }

  try {
    await db.transaction(async (tx) => {
      await tx.insert(creatorLedgerAdjustmentsTable).values({
        creatorId: c.creatorId,
        amountPaise: -c.commissionPaise,
        kind: "clawback",
        commissionId: c.id,
        payoutId: c.payoutId,
        idempotencyKey: `clawback:${c.id}`,
        note: reason.slice(0, 500),
      });
      await tx
        .update(creatorCommissionsTable)
        .set({ state: "reversed", netPaise: 0, stateReason: reason.slice(0, 500) })
        .where(eq(creatorCommissionsTable.id, c.id));
    });
    return { clawedBack: true, amountPaise: c.commissionPaise };
  } catch (err) {
    // The unique idempotency key means a redelivered refund lands here.
    logger.warn({ err, commissionId }, "clawback already recorded");
    return { clawedBack: false };
  }
}

// ---------------------------------------------------------------------------
// Promoter-facing history
// ---------------------------------------------------------------------------

export async function listCreatorPayouts(
  creatorId: number,
): Promise<CreatorPayout[]> {
  return db
    .select()
    .from(creatorPayoutsTable)
    .where(eq(creatorPayoutsTable.creatorId, creatorId))
    .orderBy(sql`${creatorPayoutsTable.createdAt} desc`)
    .limit(100);
}

export async function getCreatorPayoutIdentity(
  creatorId: number,
): Promise<CreatorPayoutIdentity | null> {
  const [row] = await db
    .select()
    .from(creatorPayoutIdentitiesTable)
    .where(eq(creatorPayoutIdentitiesTable.creatorId, creatorId))
    .limit(1);
  return row ?? null;
}
