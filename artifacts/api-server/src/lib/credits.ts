import { db, creditBalancesTable, creditLedgerTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";

/**
 * Prepaid credit balances (captions/images) per tenant. Credits are consumed
 * only when the tenant's plan quota for the month is exhausted; the "payg"
 * plan has zero monthly quota so it is credit-driven from the first use.
 *
 * All mutations run in a transaction holding SELECT ... FOR UPDATE on the
 * balance row and append a credit_ledger entry, so concurrent spends can
 * never double-consume and the balance is always auditable.
 */
export type CreditKind = "caption" | "image" | "video";

export interface CreditBalances {
  captionCredits: number;
  imageCredits: number;
  videoCredits: number;
}

/** The credit_balances column backing each spendable kind. */
const BALANCE_COLUMN = {
  caption: "captionCredits",
  image: "imageCredits",
  video: "videoCredits",
} as const satisfies Record<CreditKind, keyof CreditBalances>;

export async function getCreditBalances(tenantId: number): Promise<CreditBalances> {
  const row = (
    await db
      .select()
      .from(creditBalancesTable)
      .where(eq(creditBalancesTable.tenantId, tenantId))
      .limit(1)
  )[0];
  return {
    captionCredits: row?.captionCredits ?? 0,
    imageCredits: row?.imageCredits ?? 0,
    videoCredits: row?.videoCredits ?? 0,
  };
}

/**
 * Atomically spend `count` credits of the given kind (all-or-nothing).
 * Returns true when the credits were consumed, false when the balance could
 * not cover the full count (caller should 402). Callers reserve credits
 * BEFORE doing the funded work and refund via `refundCredits` if the work
 * fails, so a credit-backed success always has a committed debit behind it.
 */
export async function spendCredit(
  tenantId: number,
  kind: CreditKind,
  count = 1,
  outerTx?: DbTransaction,
): Promise<boolean> {
  if (count <= 0) return true;
  const spend = async (tx: DbTransaction): Promise<boolean> => {
    const row = (
      await tx
        .select()
        .from(creditBalancesTable)
        .where(eq(creditBalancesTable.tenantId, tenantId))
        .for("update")
    )[0];
    const column = BALANCE_COLUMN[kind];
    const balance = row?.[column] ?? 0;
    if (balance < count) return false;

    await tx
      .update(creditBalancesTable)
      .set({ [column]: balance - count })
      .where(eq(creditBalancesTable.tenantId, tenantId));
    await tx.insert(creditLedgerTable).values({
      tenantId,
      kind: "spend",
      captionDelta: kind === "caption" ? -count : 0,
      imageDelta: kind === "image" ? -count : 0,
      videoDelta: kind === "video" ? -count : 0,
    });
    return true;
  };
  return outerTx ? spend(outerTx) : db.transaction(spend);
}

/** The transaction handle drizzle passes to `db.transaction` callbacks. */
type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Return credits that were reserved for work that then failed. Appends a
 * "refund" ledger entry so the reserve/refund pair is fully auditable.
 *
 * Pass `outerTx` to run the refund inside an existing transaction so the
 * refund commits or rolls back atomically with the caller's own writes
 * (e.g. cancelling a queued image job must never cancel without refunding).
 */
export async function refundCredits(
  tenantId: number,
  kind: CreditKind,
  count: number,
  note?: string,
  outerTx?: DbTransaction,
): Promise<void> {
  if (count <= 0) return;
  const run = async (tx: DbTransaction) => {
    const row = (
      await tx
        .select()
        .from(creditBalancesTable)
        .where(eq(creditBalancesTable.tenantId, tenantId))
        .for("update")
    )[0];
    const oldCaptions = row?.captionCredits ?? 0;
    const oldImages = row?.imageCredits ?? 0;
    const oldVideos = row?.videoCredits ?? 0;
    const newCaptions = kind === "caption" ? oldCaptions + count : oldCaptions;
    const newImages = kind === "image" ? oldImages + count : oldImages;
    const newVideos = kind === "video" ? oldVideos + count : oldVideos;

    await tx.insert(creditLedgerTable).values({
      tenantId,
      kind: "refund",
      captionDelta: newCaptions - oldCaptions,
      imageDelta: newImages - oldImages,
      videoDelta: newVideos - oldVideos,
      note: note ?? null,
    });
    if (row) {
      await tx
        .update(creditBalancesTable)
        .set({
          captionCredits: newCaptions,
          imageCredits: newImages,
          videoCredits: newVideos,
        })
        .where(eq(creditBalancesTable.tenantId, tenantId));
    } else {
      await tx.insert(creditBalancesTable).values({
        tenantId,
        captionCredits: newCaptions,
        imageCredits: newImages,
        videoCredits: newVideos,
      });
    }
  };
  if (outerTx) {
    await run(outerTx);
  } else {
    await db.transaction(run);
  }
}

/**
 * Atomically grant credits (purchase or admin grant). When `razorpayOrderId`
 * is provided the ledger's unique index makes the grant idempotent: a second
 * call for the same order returns false without changing the balance.
 */
export async function grantCredits(params: {
  tenantId: number;
  captionCredits: number;
  imageCredits: number;
  /** Optional so pre-video callers (and their tests) stay source-compatible. */
  videoCredits?: number;
  kind: "purchase" | "admin_grant";
  razorpayOrderId?: string | null;
  cashfreeOrderId?: string | null;
  creditPackId?: number | null;
  note?: string | null;
}): Promise<boolean> {
  const { tenantId } = params;
  try {
    return await db.transaction(async (tx) => {
      const row = (
        await tx
          .select()
          .from(creditBalancesTable)
          .where(eq(creditBalancesTable.tenantId, tenantId))
          .for("update")
      )[0];
      const oldCaptions = row?.captionCredits ?? 0;
      const oldImages = row?.imageCredits ?? 0;
      const oldVideos = row?.videoCredits ?? 0;
      // Balances never go below zero; the ledger records the APPLIED delta
      // (not the requested one) so ledger totals always reconcile with the
      // stored balance.
      const newCaptions = Math.max(0, oldCaptions + params.captionCredits);
      const newImages = Math.max(0, oldImages + params.imageCredits);
      const newVideos = Math.max(0, oldVideos + (params.videoCredits ?? 0));

      // A duplicate razorpay_order_id aborts here and rolls the whole
      // transaction back, so the balance is never touched twice per order.
      await tx.insert(creditLedgerTable).values({
        tenantId,
        kind: params.kind,
        captionDelta: newCaptions - oldCaptions,
        imageDelta: newImages - oldImages,
        videoDelta: newVideos - oldVideos,
        razorpayOrderId: params.razorpayOrderId ?? null,
        cashfreeOrderId: params.cashfreeOrderId ?? null,
        creditPackId: params.creditPackId ?? null,
        note: params.note ?? null,
      });

      if (row) {
        await tx
          .update(creditBalancesTable)
          .set({
            captionCredits: newCaptions,
            imageCredits: newImages,
            videoCredits: newVideos,
          })
          .where(eq(creditBalancesTable.tenantId, tenantId));
      } else {
        await tx.insert(creditBalancesTable).values({
          tenantId,
          captionCredits: newCaptions,
          imageCredits: newImages,
          videoCredits: newVideos,
        });
      }
      return true;
    });
  } catch (error) {
    // Unique violation on the order id = the payment was already credited
    // (verification raced the webhook backstop). Not an error. Drizzle wraps
    // the pg error, so walk the cause chain for code 23505.
    if (
      (params.razorpayOrderId || params.cashfreeOrderId) &&
      isOrderUniqueViolation(error)
    ) {
      return false;
    }
    throw error;
  }
}

function isOrderUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    const e = current as {
      code?: string;
      constraint?: string;
      message?: string;
      cause?: unknown;
    };
    if (
      e.code === "23505" ||
      e.constraint === "credit_ledger_order_unique" ||
      e.constraint === "credit_ledger_cf_order_unique" ||
      (typeof e.message === "string" &&
        /credit_ledger_(cf_)?order_unique|duplicate key/i.test(e.message))
    ) {
      return true;
    }
    current = e.cause;
  }
  return false;
}

/** Recent credit history for the billing page (newest first). */
export async function listCreditHistory(tenantId: number, limit = 50) {
  return db
    .select()
    .from(creditLedgerTable)
    .where(eq(creditLedgerTable.tenantId, tenantId))
    .orderBy(desc(creditLedgerTable.createdAt), desc(creditLedgerTable.id))
    .limit(limit);
}
