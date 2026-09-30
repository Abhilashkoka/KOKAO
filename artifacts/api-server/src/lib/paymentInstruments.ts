import { db, creatorAttributionsTable as attributions, tenantPaymentInstrumentsTable as instruments } from "@workspace/db";
import { and, eq, isNotNull } from "drizzle-orm";
import { hashPii } from "./creatorPii";
import { logger } from "./logger";

export interface InstrumentCapture {
  tenantId: number;
  gateway: "razorpay" | "cashfree";
  vpa?: string | null;
  /** A documented stable gateway fingerprint, never last4 or opaque card/payment ID. */
  cardFingerprint?: string | null;
  cardLast4?: string | null;
  /** Only set when canonical gateway data explicitly identifies the funding account. */
  bankAccountNumber?: string | null;
  bankIfsc?: string | null;
}
export async function capturePaymentInstrument(c: InstrumentCapture): Promise<{ status: "captured" | "unavailable" | "no_identifier" }> {
  try {
    if (!Number.isSafeInteger(c.tenantId) || c.tenantId <= 0) return { status: "no_identifier" };
    const account = c.bankAccountNumber?.replace(/[\s-]/g, "");
    const ifsc = c.bankIfsc?.replace(/\s/g, "").toUpperCase();
    const bank = account && /^[0-9]{6,20}$/.test(account) && ifsc && /^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc) ? `${account}|${ifsc}` : null;
    const vpa = c.vpa?.trim().toLowerCase();
    const fingerprint = c.cardFingerprint?.trim();
    const kind = bank ? "bank" : vpa && /^[^\s@]+@[^\s@]+$/.test(vpa) ? "upi" : fingerprint ? "card" : null;
    if (!kind) return { status: "no_identifier" };
    // Type and provider namespaces prevent unrelated identity families colliding.
    const identity = kind === "bank" ? bank! : kind === "upi" ? vpa! : `${c.gateway}:${fingerprint}`;
    if (identity.length > 300) return { status: "no_identifier" };
    const instrumentHash = hashPii(`${kind}:${identity}`);
    const bankAccountHash = bank ? hashPii(bank) : null;
    await db.insert(instruments).values({
      tenantId: c.tenantId, gateway: c.gateway, kind, instrumentHash, bankAccountHash,
      last4: bank ? account!.slice(-4) : c.cardLast4 && /^\d{4}$/.test(c.cardLast4) ? c.cardLast4 : null,
    }).onConflictDoUpdate({ target: [instruments.tenantId, instruments.instrumentHash], set: { lastSeenAt: new Date() } });
    return { status: "captured" };
  } catch {
    // Driver errors can contain bound identifiers/hashes. Never attach the error.
    logger.warn({ tenantId: c.tenantId }, "Payment instrument capture unavailable");
    return { status: "unavailable" };
  }
}
export async function payoutMatchesOwnReferrals(creatorId: number, bankAccountHash: string):
Promise<{ matched: boolean; comparable: boolean; unavailable?: boolean; tenantIds: number[] }> {
  try {
    const rows = await db.select({ tenantId: instruments.tenantId, hash: instruments.bankAccountHash })
      .from(instruments).innerJoin(attributions, eq(attributions.tenantId, instruments.tenantId))
      .where(and(eq(attributions.creatorId, creatorId), isNotNull(instruments.bankAccountHash)));
    return { matched: rows.some(r => r.hash === bankAccountHash), comparable: rows.length > 0,
      tenantIds: [...new Set(rows.filter(r => r.hash === bankAccountHash).map(r => r.tenantId))] };
  } catch {
    logger.warn({ creatorId }, "Payout instrument comparison unavailable");
    return { matched: false, comparable: false, unavailable: true, tenantIds: [] };
  }
}