import {
  db,
  creatorAttributionsTable,
  creatorCodesTable,
  tenantPaymentInstrumentsTable,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { logger } from "./logger";
import { hashPii } from "./creatorPayouts";

/**
 * Capture and compare hashed payment instruments.
 *
 * Capture runs from the gateway webhooks on every successful payment. The
 * comparison runs when a promoter saves payout details — the same account on
 * both sides is the signal no purchase-time check can produce.
 *
 * Best-effort throughout: a capture failure must never fail a payment, and a
 * comparison failure must never block a promoter from being paid. Both are
 * fraud *signals*, not gates.
 */

export interface InstrumentCapture {
  tenantId: number;
  gateway: "razorpay" | "cashfree";
  /** Razorpay: payment.method / Cashfree: payment_group. */
  method?: string | null;
  /** UPI virtual payment address, e.g. name@bank. */
  vpa?: string | null;
  /** Card fingerprint if the gateway gives one, else network|last4|issuer. */
  cardFingerprint?: string | null;
  cardLast4?: string | null;
  cardNetwork?: string | null;
  issuer?: string | null;
  /** Some gateways expose the settlement account for UPI/netbanking. */
  bankAccountNumber?: string | null;
  bankIfsc?: string | null;
}

function classify(c: InstrumentCapture): "upi" | "card" | "netbanking" | "other" {
  if (c.vpa) return "upi";
  if (c.cardFingerprint || c.cardLast4) return "card";
  if (c.bankAccountNumber) return "netbanking";
  const m = (c.method ?? "").toLowerCase();
  if (m.includes("upi")) return "upi";
  if (m.includes("card")) return "card";
  if (m.includes("net")) return "netbanking";
  return "other";
}

/**
 * Record the instrument a workspace paid with. Upserts on
 * (tenantId, instrumentHash), bumping the use count.
 *
 * Call from routes/razorpayWebhook.ts and routes/cashfreeWebhook.ts on every
 * verified successful payment — the same place `recordInvoice` is called.
 */
export async function capturePaymentInstrument(
  capture: InstrumentCapture,
): Promise<void> {
  try {
    const kind = classify(capture);
    const identity =
      capture.vpa?.trim().toLowerCase() ||
      capture.cardFingerprint?.trim() ||
      (capture.cardNetwork && capture.cardLast4
        ? `${capture.cardNetwork}|${capture.cardLast4}|${capture.issuer ?? ""}`.toLowerCase()
        : null) ||
      (capture.bankAccountNumber
        ? `${capture.bankAccountNumber.replace(/\D/g, "")}|${(capture.bankIfsc ?? "").toUpperCase()}`
        : null);
    if (!identity) return; // nothing distinguishing to store

    const instrumentHash = hashPii(identity);
    // Same shape as a payout destination hash, so the two are comparable.
    const bankAccountHash =
      capture.bankAccountNumber && capture.bankIfsc
        ? hashPii(
            `${capture.bankAccountNumber.replace(/\D/g, "")}|${capture.bankIfsc.toUpperCase()}`,
          )
        : null;

    await db
      .insert(tenantPaymentInstrumentsTable)
      .values({
        tenantId: capture.tenantId,
        kind,
        instrumentHash,
        bankAccountHash,
        last4: capture.cardLast4 ?? null,
        issuer: capture.issuer ?? null,
        gateway: capture.gateway,
      })
      .onConflictDoUpdate({
        target: [
          tenantPaymentInstrumentsTable.tenantId,
          tenantPaymentInstrumentsTable.instrumentHash,
        ],
        set: {
          lastSeenAt: new Date(),
          useCount: sql`${tenantPaymentInstrumentsTable.useCount} + 1`,
          // Fill the bank hash in if a later payment reveals it.
          bankAccountHash: sql`coalesce(${tenantPaymentInstrumentsTable.bankAccountHash}, ${bankAccountHash})`,
        },
      });
  } catch (err) {
    // CREATOR_PII_PEPPER may be unset in environments that never pay out.
    logger.warn(
      { err, tenantId: capture.tenantId },
      "payment instrument capture skipped",
    );
  }
}

/**
 * Does this payout destination match an instrument used by a workspace that
 * redeemed this promoter's own code?
 *
 * This is the real body for the `bankMatchesOwnReferrals` stub in
 * creatorPayouts.ts. Flags rather than blocks — a shared family account is a
 * real thing — but it belongs in front of a human before money moves.
 */
export async function payoutMatchesOwnReferrals(
  creatorId: number,
  bankAccountHash: string,
): Promise<{ matched: boolean; tenantIds: number[] }> {
  try {
    const rows = await db
      .select({ tenantId: tenantPaymentInstrumentsTable.tenantId })
      .from(tenantPaymentInstrumentsTable)
      .innerJoin(
        creatorAttributionsTable,
        eq(
          creatorAttributionsTable.tenantId,
          tenantPaymentInstrumentsTable.tenantId,
        ),
      )
      .innerJoin(
        creatorCodesTable,
        eq(creatorCodesTable.id, creatorAttributionsTable.creatorCodeId),
      )
      .where(
        and(
          eq(creatorCodesTable.creatorId, creatorId),
          eq(tenantPaymentInstrumentsTable.bankAccountHash, bankAccountHash),
        ),
      )
      .limit(20);
    return { matched: rows.length > 0, tenantIds: rows.map((r) => r.tenantId) };
  } catch (err) {
    logger.error(
      { err, creatorId },
      "payout/instrument cross-check failed — treating as no match",
    );
    return { matched: false, tenantIds: [] };
  }
}
