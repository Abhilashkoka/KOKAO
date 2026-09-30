import { createHmac, timingSafeEqual } from "node:crypto";
import {
  db, creatorAccountsTable as accounts, creatorCommissionsTable as commissions,
  creatorLedgerAdjustmentsTable as adjustments, creatorPayoutIdentitiesTable as identities,
  creatorPayoutsTable as payouts, type CreatorPayout, type CreatorPayoutIdentity,
} from "@workspace/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { creatorSettingsAccess } from "./creatorProgram";
import { getFeatureFlags } from "./featureFlags";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export class PayoutIdentityError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = "PayoutIdentityError";
  }
}
const fail = (code: string, message: string): never => { throw new PayoutIdentityError(message, code); };
export function hashPii(value: string): string {
  const secret = process.env.CREATOR_PII_PEPPER;
  if (!secret || secret.length < 32) return fail("pii_not_configured", "Payout details are not available until the server privacy key is configured.");
  return createHmac("sha256", secret).update(value).digest("hex");
}
export const normalizePan = (raw: string) => raw.replace(/\s+/g, "").toUpperCase();
export const normalizeAccount = (raw: string) => raw.replace(/[\s-]/g, "");
export function hashesMatch(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
async function enabled() {
  const [settings, flags] = await Promise.all([creatorSettingsAccess.get(), getFeatureFlags()]);
  if (!settings.programEnabled || !flags.creatorProgram) fail("program_disabled", "The promoter program is disabled.");
  return settings;
}
/** One lock ordering for every financial mutation, also shared by accrual/reversal. */
async function lock(tx: Tx) {
  await tx.execute(sql`select pg_advisory_xact_lock(73142, 1)`);
}
export interface PayoutIdentityInput {
  creatorId: number; pan: string; accountNumber: string; ifsc: string; beneficiaryName: string;
}
export async function saveCreatorPayoutIdentity(input: PayoutIdentityInput): Promise<CreatorPayoutIdentity> {
  await enabled();
  const pan = normalizePan(input.pan), account = normalizeAccount(input.accountNumber);
  const ifsc = input.ifsc.replace(/\s+/g, "").toUpperCase();
  const name = input.beneficiaryName.trim();
  if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) fail("invalid_pan", "That PAN doesn't look right.");
  if (!/^[0-9]{6,20}$/.test(account)) fail("invalid_account", "That account number doesn't look right.");
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) fail("invalid_ifsc", "That IFSC doesn't look right.");
  if (!name || name.length > 120 || /[\r\n\u0000-\u001f]/.test(name)) fail("invalid_beneficiary", "Enter a beneficiary name of at most 120 characters.");
  const panHash = hashPii(pan), bankAccountHash = hashPii(`${account}|${ifsc}`);
  try {
    return await db.transaction(async tx => {
      await lock(tx);
      const [creator] = await tx.select().from(accounts).where(eq(accounts.id, input.creatorId)).for("update");
      if (!creator || creator.status !== "approved") fail("not_a_promoter", "An approved promoter account is required.");
      const [owner] = await tx.select({ creatorId: identities.creatorId }).from(identities).where(eq(identities.panHash, panHash));
      if (owner && owner.creatorId !== input.creatorId) fail("pan_in_use", "These payout details are already registered to another promoter.");
      const values = { panHash, bankAccountHash, panLast4: pan.slice(-4), bankLast4: account.slice(-4), ifsc, beneficiaryName: name };
      const [saved] = await tx.insert(identities).values({ creatorId: input.creatorId, ...values })
        .onConflictDoUpdate({ target: identities.creatorId, set: {
          ...values, verifiedAt: null, verificationRef: null, version: sql`${identities.version} + 1`,
        } }).returning();
      return saved!;
    });
  } catch (error) {
    // Database errors may embed bound PAN/account hashes. Never log or rethrow them.
    if (error instanceof PayoutIdentityError) throw error;
    const cause = error as { code?: string; cause?: { code?: string } };
    if (cause.code === "23505" || cause.cause?.code === "23505") fail("pan_in_use", "These payout details are already registered.");
    return fail("identity_save_failed", "Payout details could not be saved. Please try again.");
  }
}

export interface PayoutBalance {
  payablePaise: number; adjustmentsPaise: number; netOwedPaise: number; owedBackPaise: number; commissionIds: number[];
}
async function balance(tx: Tx | typeof db, creatorId: number) {
  const rows = await tx.select().from(commissions).where(and(eq(commissions.creatorId, creatorId), eq(commissions.state, "payable")));
  const entries = await tx.select().from(adjustments).where(and(eq(adjustments.creatorId, creatorId), isNull(adjustments.consumedByPayoutId)));
  const payablePaise = rows.reduce((s, r) => s + r.commissionPaise, 0);
  const adjustmentsPaise = entries.reduce((s, r) => s + r.amountPaise, 0);
  const total = payablePaise + adjustmentsPaise;
  return { rows, entries, payablePaise, adjustmentsPaise, netOwedPaise: Math.max(0, total), owedBackPaise: Math.max(0, -total), commissionIds: rows.map(r => r.id) };
}
export async function getPayoutBalance(creatorId: number): Promise<PayoutBalance> {
  const { rows: _rows, entries: _entries, ...result } = await balance(db, creatorId);
  return result;
}
/** Integer paise throughout; tax treatment must be confirmed by the operator's CA. */
export function payoutAmounts(gross: number, reserveBase: number, reserveBps: number, tdsBps: number) {
  for (const value of [gross, reserveBase, reserveBps, tdsBps]) {
    if (!Number.isSafeInteger(value) || value < 0) fail("invalid_amount", "Payout amounts must be nonnegative safe integers.");
  }
  if (gross > 2_147_483_647 || reserveBps > 10000 || tdsBps > 10000) fail("invalid_amount", "Payout amount or rate is out of range.");
  const reserve = Math.floor(Math.min(gross, reserveBase) * reserveBps / 10000);
  const tds = Math.floor((gross - reserve) * tdsBps / 10000);
  return { gross, reserve, tds, net: gross - reserve - tds };
}
export interface PayoutRunSummary { created: number; skipped: { creatorId: number; reason: string }[]; totalNetPaise: number }
export async function buildPayoutRun(periodStart?: Date, periodEnd?: Date, creatorIds?: number[]): Promise<PayoutRunSummary> {
  const settings = await enabled();
  if ((periodStart && !Number.isFinite(periodStart.getTime())) || (periodEnd && !Number.isFinite(periodEnd.getTime())) ||
      (periodStart && periodEnd && periodStart > periodEnd)) fail("invalid_period", "Invalid payout period.");
  const summary: PayoutRunSummary = { created: 0, skipped: [], totalNetPaise: 0 };
  // Entire run commits or rolls back: no swallowed partial financial failures.
  return db.transaction(async tx => {
    await lock(tx);
    const creators = await tx.select().from(accounts).where(and(eq(accounts.status, "approved"),
      creatorIds ? inArray(accounts.id, creatorIds) : undefined)).orderBy(accounts.id).for("update");
    for (const creator of creators) {
      const b = await balance(tx, creator.id);
      if (!b.rows.length && !b.entries.length) continue;
      const skip = (reason: string) => summary.skipped.push({ creatorId: creator.id, reason });
      if (b.netOwedPaise <= 0 || b.netOwedPaise < settings.minPayoutPaise) {
        skip(b.owedBackPaise > 0 ? "negative balance" : "below minimum payout"); continue;
      }
      const [identity] = await tx.select().from(identities).where(eq(identities.creatorId, creator.id)).for("update");
      if (!identity?.bankLast4 || !identity.ifsc || !identity.beneficiaryName) { skip("no payout details on file"); continue; }
      // A released reserve is taxable on release but never reserved again.
      const amount = payoutAmounts(b.netOwedPaise, b.payablePaise, settings.reserveBps, settings.tdsRateBps);
      if (amount.net <= 0) { skip("zero net payout"); continue; }
      const [p] = await tx.insert(payouts).values({
        creatorId: creator.id, payoutIdentityId: identity.id, identityVersion: identity.version,
        destinationSnapshot: { beneficiaryName: identity.beneficiaryName, bankLast4: identity.bankLast4, ifsc: identity.ifsc },
        grossPaise: amount.gross, reserveHeldPaise: amount.reserve, tdsPaise: amount.tds,
        tdsRateBps: settings.tdsRateBps, reserveReleaseDays: settings.reserveReleaseDays,
        netPaise: amount.net, status: "draft", periodStart: periodStart ?? null, periodEnd: periodEnd ?? new Date(),
      }).returning();
      if (b.rows.length) {
        const claimed = await tx.update(commissions).set({ state: "in_payout", payoutId: p!.id })
          .where(and(inArray(commissions.id, b.commissionIds), eq(commissions.state, "payable"))).returning({ id: commissions.id });
        if (claimed.length !== b.rows.length) fail("claim_conflict", "Commission claims changed; retry the run.");
      }
      if (b.entries.length) {
        const claimed = await tx.update(adjustments).set({ consumedByPayoutId: p!.id })
          .where(and(inArray(adjustments.id, b.entries.map(r => r.id)), isNull(adjustments.consumedByPayoutId))).returning({ id: adjustments.id });
        if (claimed.length !== b.entries.length) fail("claim_conflict", "Ledger claims changed; retry the run.");
      }
      summary.created++; summary.totalNetPaise += amount.net;
    }
    return summary;
  });
}

function csv(value: string | number) {
  // Defend spreadsheet formula execution even inside quoted cells.
  let text = String(value);
  if (/^[\s]*[=+\-@\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
async function unchangedDestination(tx: Tx, p: CreatorPayout) {
  if (!p.payoutIdentityId || !p.destinationSnapshot || !p.identityVersion) fail("destination_missing", "This legacy payout requires manual reconciliation.");
  const [identity] = await tx.select({ version: identities.version }).from(identities).where(eq(identities.id, p.payoutIdentityId!)).for("update");
  if (identity?.version !== p.identityVersion) fail("destination_changed", "Payout details changed. Reconcile and fail this batch before building a new one.");
}
/** REVIEW ONLY: last4 cannot route a transfer. Verify the full destination outside this app. */
export async function exportPayoutBatch(payoutIds: number[]): Promise<string> {
  await enabled();
  if (!payoutIds.length || payoutIds.length > 500 || payoutIds.some(id => !Number.isSafeInteger(id) || id <= 0)) fail("invalid_ids", "Select between 1 and 500 payout IDs.");
  return db.transaction(async tx => {
    await lock(tx);
    const ids = [...new Set(payoutIds)];
    const rows = await tx.select().from(payouts).where(inArray(payouts.id, ids)).orderBy(payouts.id).for("update");
    if (rows.length !== ids.length) fail("payout_not_found", "One or more payouts were not found.");
    const lines = ["review_only,payout_id,beneficiary_name,account_last4,ifsc,gross_inr,reserve_inr,tds_inr,net_inr"];
    for (const p of rows) {
      if (!["draft", "exported"].includes(p.status)) fail("invalid_state", "Only draft or exported payouts can be reviewed.");
      await unchangedDestination(tx, p);
      const d = p.destinationSnapshot!;
      lines.push(["REVIEW ONLY - verify full destination independently", p.id, d.beneficiaryName, d.bankLast4, d.ifsc,
        ...[p.grossPaise, p.reserveHeldPaise, p.tdsPaise, p.netPaise].map(n => (n / 100).toFixed(2))].map(csv).join(","));
    }
    await tx.update(payouts).set({ status: "exported" }).where(inArray(payouts.id, ids));
    return lines.join("\n");
  });
}
export async function dispatchPayout(_payoutId: number): Promise<{ dispatched: boolean; reason: string }> {
  return { dispatched: false, reason: "Manual review only. No bank transfer integration is installed. Verify the destination independently; the review CSV cannot execute payments." };
}
export async function markPayoutPaid(payoutId: number, gatewayRef: string | null): Promise<CreatorPayout | null> {
  await enabled();
  if (!gatewayRef?.trim() || gatewayRef.length > 200) fail("reference_required", "Record the independently confirmed transfer reference.");
  const reference = gatewayRef!.trim();
  return db.transaction(async tx => {
    await lock(tx);
    const [p] = await tx.select().from(payouts).where(eq(payouts.id, payoutId)).for("update");
    if (!p) return null;
    if (p.status === "paid") {
      if (p.gatewayRef !== reference) fail("reference_conflict", "This payout already has a different transfer reference.");
      return p;
    }
    if (p.status !== "exported") fail("invalid_state", "Review/export the payout before recording a confirmed transfer.");
    await unchangedDestination(tx, p);
    const [paid] = await tx.update(payouts).set({ status: "paid", paidAt: new Date(), gatewayRef: reference, gateway: "manual" }).where(eq(payouts.id, payoutId)).returning();
    await tx.update(commissions).set({ state: "paid" }).where(and(eq(commissions.payoutId, payoutId), eq(commissions.state, "in_payout")));
    return paid!;
  });
}
/** Recovery remains available with either switch off. This asserts no transfer cleared. */
export async function markPayoutFailed(payoutId: number, reason: string): Promise<CreatorPayout | null> {
  return db.transaction(async tx => {
    await lock(tx);
    const [p] = await tx.select().from(payouts).where(eq(payouts.id, payoutId)).for("update");
    if (!p) return null;
    if (p.status === "failed") return p;
    if (!["draft", "exported"].includes(p.status)) fail("invalid_state", "A paid payout cannot be failed.");
    const [failed] = await tx.update(payouts).set({ status: "failed", failureReason: reason.slice(0, 500) }).where(eq(payouts.id, payoutId)).returning();
    await tx.update(commissions).set({ state: "payable", payoutId: null }).where(and(eq(commissions.payoutId, payoutId), eq(commissions.state, "in_payout")));
    await tx.update(adjustments).set({ consumedByPayoutId: null }).where(eq(adjustments.consumedByPayoutId, payoutId));
    return failed!;
  });
}
/** Accounting-only recovery, not a transfer; safe with the recruitment switches off. */
export async function releaseMatureReserves(payoutIds?: number[]): Promise<{ released: number }> {
  return db.transaction(async tx => {
    await lock(tx);
    const due = await tx.select().from(payouts).where(and(eq(payouts.status, "paid"), isNull(payouts.reserveReleasedAt),
      sql`${payouts.paidAt} + (${payouts.reserveReleaseDays} * interval '1 day') <= now()`,
      payoutIds ? inArray(payouts.id, payoutIds) : undefined)).orderBy(payouts.id).limit(500).for("update");
    for (const p of due) {
      const remaining = p.reserveHeldPaise - p.reserveConsumedPaise;
      if (remaining < 0) fail("invalid_reserve", "Reserve accounting requires reconciliation.");
      if (remaining > 0) await tx.insert(adjustments).values({
        creatorId: p.creatorId, amountPaise: remaining, kind: "reserve_release", payoutId: p.id,
        idempotencyKey: `reserve-release:${p.id}`, note: "Mature reserve released",
      });
      await tx.update(payouts).set({ reserveReleasedAt: new Date() }).where(eq(payouts.id, p.id));
    }
    return { released: due.length };
  });
}
export async function clawbackPaidCommission(commissionId: number, reason: string): Promise<{ clawedBack: boolean; amountPaise?: number }> {
  return db.transaction(async tx => {
    await lock(tx);
    const [c] = await tx.select().from(commissions).where(eq(commissions.id, commissionId)).for("update");
    if (!c || c.state === "reversed") return { clawedBack: false };
    // Exported may already have been sent. Never guess whether money left.
    if (c.state === "in_payout") fail("payout_in_flight", "Reconcile the batch first: mark a confirmed transfer paid, or fail an unpaid batch before reversing.");
    if (c.state !== "paid") return { clawedBack: false };
    const [prior] = await tx.select({ id: adjustments.id }).from(adjustments).where(eq(adjustments.idempotencyKey, `clawback:${c.id}`));
    if (prior) return { clawedBack: false };
    let remainder = c.commissionPaise;
    const reserves = await tx.select().from(payouts).where(and(eq(payouts.creatorId, c.creatorId), eq(payouts.status, "paid"), isNull(payouts.reserveReleasedAt))).orderBy(payouts.id).for("update");
    for (const p of reserves) {
      const absorbed = Math.min(remainder, Math.max(0, p.reserveHeldPaise - p.reserveConsumedPaise));
      if (!absorbed) continue;
      await tx.update(payouts).set({ reserveConsumedPaise: p.reserveConsumedPaise + absorbed }).where(eq(payouts.id, p.id));
      await tx.insert(adjustments).values({
        creatorId: c.creatorId, amountPaise: absorbed, kind: "reserve_offset", commissionId: c.id, payoutId: p.id,
        idempotencyKey: `reserve-offset:${c.id}:${p.id}`, note: "Held reserve applied to clawback",
      });
      remainder -= absorbed;
    }
    await tx.insert(adjustments).values({
      creatorId: c.creatorId, amountPaise: -c.commissionPaise, kind: "clawback", commissionId: c.id, payoutId: c.payoutId,
      idempotencyKey: `clawback:${c.id}`, note: reason.slice(0, 500),
    });
    await tx.update(commissions).set({ state: "reversed", netPaise: 0, stateReason: reason.slice(0, 500) }).where(eq(commissions.id, c.id));
    return { clawedBack: true, amountPaise: c.commissionPaise };
  });
}
export async function listCreatorPayouts(creatorId: number): Promise<CreatorPayout[]> {
  return db.select().from(payouts).where(eq(payouts.creatorId, creatorId)).orderBy(sql`${payouts.createdAt} desc`).limit(100);
}
/** Internal only: callers MUST select a masked DTO, never spread this row into JSON. */
export async function getCreatorPayoutIdentity(creatorId: number): Promise<CreatorPayoutIdentity | null> {
  return (await db.select().from(identities).where(eq(identities.creatorId, creatorId)).limit(1))[0] ?? null;
}