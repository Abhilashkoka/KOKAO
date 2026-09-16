import {
  db,
  creditAccountsTable,
  creditAccountLedgerTable,
  creditMeterSettingsTable,
  tenantsTable,
  walletBalancesTable,
  walletLedgerTable,
  walletProviderOperationsTable,
  walletSettlementRetriesTable,
} from "@workspace/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

const MILLI = 1000n;
const MODE_ROW_ID = 1;
const WALLET_CONVERSION_REF_KIND = "walletConversion";
const POSTGRES_INTEGER_MAX = 2_147_483_647;

export interface WalletConversionPreview {
  walletPaise: number;
  creditPricePaise: number;
  credits: number;
  canConvert: boolean;
  reason: string | null;
}

export interface WalletConversionResult {
  walletPaiseConverted: number;
  creditsAdded: number;
  remainingWalletPaise: number;
  creditPricePaise: number;
  walletLedgerId: number;
  creditLedgerId: number;
}

export interface ReviewedWalletConversionException {
  /** The exact pending estimated-charge ledger rows reviewed for retention. */
  estimatedTrueUpLedgerIds: readonly number[];
  /** Human-readable authorization context persisted in both receipts. */
  authorization: string;
}

const REVIEWED_TRUE_UP_AUTHORIZATION = "tenant4-wallet-conversion-reviewed-trueups-v1";
const REVIEWED_TRUE_UP_COUNT = 30;

export class WalletConversionConflictError extends Error {
  readonly status = 409;

  constructor(message: string) {
    super(message);
    this.name = "WalletConversionConflictError";
  }
}

export class WalletConversionNotFoundError extends Error {
  readonly status = 404;

  constructor() {
    super("Tenant not found");
    this.name = "WalletConversionNotFoundError";
  }
}

export class WalletConversionValidationError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = "WalletConversionValidationError";
  }
}

type ConversionSnapshot = {
  walletPaise: number;
  creditPricePaise: number;
  creditsMilli: number;
};

/**
 * Keep conversion arithmetic integer-only. BigInt prevents a large paise
 * balance multiplied by 1000 from overflowing a JavaScript number before the
 * final safe-integer check.
 */
export function calculateWalletConversion(
  walletPaise: number,
  creditPricePaise: number,
): ConversionSnapshot | null {
  if (
    !Number.isSafeInteger(walletPaise) ||
    walletPaise <= 0 ||
    !Number.isSafeInteger(creditPricePaise) ||
    creditPricePaise <= 0
  ) {
    return null;
  }
  const creditsMilli =
    (BigInt(walletPaise) * MILLI + BigInt(creditPricePaise) - 1n) /
    BigInt(creditPricePaise);
  if (
    creditsMilli <= 0n ||
    creditsMilli > BigInt(POSTGRES_INTEGER_MAX)
  ) {
    return null;
  }
  const credits = Number(creditsMilli) / Number(MILLI);
  if (!Number.isFinite(credits)) return null;
  return {
    walletPaise,
    creditPricePaise,
    creditsMilli: Number(creditsMilli),
  };
}

type ConversionBlocker = {
  kind: "reserve" | "provider" | "outbox" | "true_up";
  detail: string;
};

function validateReviewedWalletConversionException(
  review: ReviewedWalletConversionException,
): number[] {
  const ids = [...review.estimatedTrueUpLedgerIds].sort((a, b) => a - b);
  if (
    ids.length !== REVIEWED_TRUE_UP_COUNT ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
    review.authorization !== REVIEWED_TRUE_UP_AUTHORIZATION
  ) {
    throw new WalletConversionValidationError(
      "The reviewed wallet conversion exception is invalid.",
    );
  }
  return ids;
}

function sameIds(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/**
 * These checks deliberately use the same wallet row as reserve/settle. The
 * POST takes that row lock before rechecking them, so a reserve cannot appear
 * between the check and the debit. `wallet.ts` also takes this lock before
 * settling/refunding, avoiding a conversion/settlement lock inversion.
 */
async function findConversionBlocker(
  executor: Pick<typeof db, "select">,
  tenantId: number,
  reviewedException?: {
    ids: number[];
    lock: boolean;
  },
): Promise<ConversionBlocker | null> {
  const outstandingReserves = await executor
    .select({ id: walletLedgerTable.id })
    .from(walletLedgerTable)
    .where(
      and(
        eq(walletLedgerTable.tenantId, tenantId),
        eq(walletLedgerTable.kind, "reserve"),
        // A zero estimate never held money and refundWallet intentionally
        // skips it. Preserve its audit row, but don't block conversion on it.
        sql`${walletLedgerTable.amountPaise} < 0`,
        sql`NOT EXISTS (
          SELECT 1
          FROM wallet_ledger resolved
          WHERE resolved.tenant_id = ${tenantId}
            AND resolved.reservation_id = ${walletLedgerTable.id}
            AND resolved.kind IN ('settle', 'refund')
        )`,
      ),
    )
    .limit(1);
  if (outstandingReserves.length > 0) {
    return {
      kind: "reserve",
      detail: "Wallet has an outstanding generation reservation.",
    };
  }

  const outstandingProviderOperations = await executor
    .select({ id: walletProviderOperationsTable.id })
    .from(walletProviderOperationsTable)
    .where(
      and(
        eq(walletProviderOperationsTable.tenantId, tenantId),
        sql`${walletProviderOperationsTable.status} NOT IN ('failed', 'refunded', 'settled')`,
      ),
    )
    .limit(1);
  if (outstandingProviderOperations.length > 0) {
    return {
      kind: "provider",
      detail: "Wallet has an unsettled provider operation.",
    };
  }

  const outstandingSettlementRetries = await executor
    .select({
      id: walletSettlementRetriesTable.id,
      status: walletSettlementRetriesTable.status,
      reservationId: walletSettlementRetriesTable.reservationId,
      reservedPaise: walletSettlementRetriesTable.reservedPaise,
      targetChargePaise: walletSettlementRetriesTable.targetChargePaise,
    })
    .from(walletSettlementRetriesTable)
    .where(
      and(
        eq(walletSettlementRetriesTable.tenantId, tenantId),
        sql`${walletSettlementRetriesTable.status} <> 'settled'`,
      ),
    );
  if (outstandingSettlementRetries.length > 0) {
    const tenantLedger = await executor
      .select({
        id: walletLedgerTable.id,
        kind: walletLedgerTable.kind,
        amountPaise: walletLedgerTable.amountPaise,
        reservationId: walletLedgerTable.reservationId,
      })
      .from(walletLedgerTable)
      .where(eq(walletLedgerTable.tenantId, tenantId));
    const lifecycleByReservation = new Map<number, typeof tenantLedger>();
    for (const retry of outstandingSettlementRetries) {
      const lifecycle = tenantLedger.filter(
        (row) => row.id === retry.reservationId || row.reservationId === retry.reservationId,
      );
      lifecycleByReservation.set(retry.reservationId, lifecycle);
    }
    const isResolvedTerminalFailure = (retry: (typeof outstandingSettlementRetries)[number]) => {
      if (retry.status !== "failed") return false;
      const lifecycle = lifecycleByReservation.get(retry.reservationId) ?? [];
      const reserveRows = lifecycle.filter(
        (row) => row.id === retry.reservationId && row.kind === "reserve",
      );
      if (
        reserveRows.length !== 1 ||
        reserveRows[0]!.amountPaise !== -retry.reservedPaise
      ) {
        return false;
      }
      const resolutions = lifecycle.filter((row) => row.id !== retry.reservationId);
      if (resolutions.some((row) => !["settle", "refund"].includes(row.kind))) {
        return false;
      }
      const refundPaise = resolutions
        .filter((row) => row.kind === "refund")
        .reduce((sum, row) => sum + row.amountPaise, 0);
      const refundRows = resolutions.filter((row) => row.kind === "refund");
      const lifecycleNet = lifecycle.reduce((sum, row) => sum + row.amountPaise, 0);
      const settleRows = resolutions.filter((row) => row.kind === "settle");
      const exactSettled =
        settleRows.length === 1 &&
        refundPaise === 0 &&
        lifecycleNet === -retry.targetChargePaise;
      const exactRefunded =
        refundRows.length > 0 &&
        refundRows.every((row) => row.amountPaise > 0) &&
        refundPaise === retry.targetChargePaise &&
        refundPaise > 0 &&
        lifecycleNet === 0;
      return exactSettled || exactRefunded;
    };
    if (!outstandingSettlementRetries.every(isResolvedTerminalFailure)) {
      return {
        kind: "outbox",
        detail: "Wallet has an unsettled settlement outbox item.",
      };
    }
  }

  const pendingTrueUpsQuery = executor
    .select({
      id: walletLedgerTable.id,
      amountPaise: walletLedgerTable.amountPaise,
      kind: walletLedgerTable.kind,
      estimated: walletLedgerTable.estimated,
      trueUpAt: walletLedgerTable.trueUpAt,
    })
    .from(walletLedgerTable)
    .where(
      and(
        eq(walletLedgerTable.tenantId, tenantId),
        eq(walletLedgerTable.estimated, true),
        isNull(walletLedgerTable.trueUpAt),
      ),
    );
  const pendingTrueUps = reviewedException?.lock
    ? await pendingTrueUpsQuery.for("update")
    : await pendingTrueUpsQuery;
  let reviewedTrueUpsAllowed = false;
  if (reviewedException) {
    const reviewedRows = await executor
      .select({
        id: walletLedgerTable.id,
        amountPaise: walletLedgerTable.amountPaise,
        kind: walletLedgerTable.kind,
        estimated: walletLedgerTable.estimated,
        trueUpAt: walletLedgerTable.trueUpAt,
      })
      .from(walletLedgerTable)
      .where(
        and(
          eq(walletLedgerTable.tenantId, tenantId),
          inArray(walletLedgerTable.id, reviewedException.ids),
        ),
      )
      .for("update");
    const pendingIds = pendingTrueUps.map((row) => row.id).sort((a, b) => a - b);
    const reviewedIds = reviewedRows.map((row) => row.id).sort((a, b) => a - b);
    reviewedTrueUpsAllowed =
      sameIds(pendingIds, reviewedException.ids) &&
      sameIds(reviewedIds, reviewedException.ids) &&
      reviewedRows.every(
        (row) =>
          row.kind === "settle" &&
          row.estimated === true &&
          row.trueUpAt === null,
      );
  }
  if (pendingTrueUps.length > 0 && !reviewedTrueUpsAllowed) {
    if (reviewedException) {
      return {
        kind: "true_up",
        detail: "Reviewed estimated-charge set changed; refresh the review.",
      };
    }
    return {
      kind: "true_up",
      detail: "Wallet has a pending estimated-charge true-up.",
    };
  }
  if (reviewedException && !reviewedTrueUpsAllowed) {
    return {
      kind: "true_up",
      detail: "Reviewed estimated-charge set changed; refresh the review.",
    };
  }

  return null;
}

async function getPersistedCreditPrice(
  executor: Pick<typeof db, "select">,
  lock = false,
): Promise<number> {
  const query = executor
    .select({ creditPricePaise: creditMeterSettingsTable.creditPricePaise })
    .from(creditMeterSettingsTable)
    .where(eq(creditMeterSettingsTable.id, MODE_ROW_ID))
    .limit(1);
  const [row] = lock ? await query.for("update") : await query;
  return Number.isSafeInteger(row?.creditPricePaise) &&
    Number(row.creditPricePaise) > 0
    ? Number(row.creditPricePaise)
    : 0;
}

function unavailableRateReason(): string {
  return "No saved positive rupees-per-credit conversion rate is available.";
}

function overflowReason(): string {
  return "The wallet conversion exceeds the supported numeric range.";
}

async function hasPriorWalletMigrationReceipt(
  executor: Pick<typeof db, "select">,
  tenantId: number,
): Promise<boolean> {
  const rows = await executor
    .select({
      refKind: creditAccountLedgerTable.refKind,
      note: creditAccountLedgerTable.note,
    })
    .from(creditAccountLedgerTable)
    .where(
      and(
        eq(creditAccountLedgerTable.tenantId, tenantId),
        eq(creditAccountLedgerTable.kind, "migrate"),
      ),
    );
  return rows.some(
    (row) =>
      row.refKind === "wallet" ||
      /wallet\s+balance/i.test(row.note ?? ""),
  );
}

async function readWalletBalance(
  executor: Pick<typeof db, "select">,
  tenantId: number,
): Promise<number> {
  const [row] = await executor
    .select({ balancePaise: walletBalancesTable.balancePaise })
    .from(walletBalancesTable)
    .where(eq(walletBalancesTable.tenantId, tenantId))
    .limit(1);
  return Number.isSafeInteger(row?.balancePaise) ? Number(row.balancePaise) : 0;
}

export async function previewWalletConversion(
  tenantId: number,
): Promise<WalletConversionPreview> {
  const [walletPaise, creditPricePaise] = await Promise.all([
    readWalletBalance(db, tenantId),
    getPersistedCreditPrice(db),
  ]);
  if (creditPricePaise <= 0) {
    return {
      walletPaise,
      creditPricePaise: 0,
      credits: 0,
      canConvert: false,
      reason: unavailableRateReason(),
    };
  }
  if (walletPaise <= 0) {
    return {
      walletPaise,
      creditPricePaise,
      credits: 0,
      canConvert: false,
      reason: "Wallet has no positive balance to convert.",
    };
  }
  const conversion = calculateWalletConversion(walletPaise, creditPricePaise);
  if (!conversion) {
    return {
      walletPaise,
      creditPricePaise,
      credits: 0,
      canConvert: false,
      reason: overflowReason(),
    };
  }
  if (await hasPriorWalletMigrationReceipt(db, tenantId)) {
    return {
      walletPaise,
      creditPricePaise,
      credits: conversion.creditsMilli / Number(MILLI),
      canConvert: false,
      reason:
        "A prior broad wallet migration receipt exists; manual review is required before wallet conversion.",
    };
  }
  const blocker = await findConversionBlocker(db, tenantId);
  return {
    walletPaise,
    creditPricePaise,
    credits: conversion.creditsMilli / Number(MILLI),
    canConvert: blocker === null,
    reason: blocker?.detail ?? null,
  };
}

function parseReceiptNote(note: string | null): {
  walletPaiseConverted: number;
  creditsAddedMilli: number;
  remainingWalletPaise: number;
  creditPricePaise: number;
  walletLedgerId: number;
} | null {
  if (!note) return null;
  try {
    const parsed = JSON.parse(note) as Record<string, unknown>;
    if (
      !Number.isSafeInteger(parsed.walletPaiseConverted) ||
      !Number.isSafeInteger(parsed.creditsAddedMilli) ||
      !Number.isSafeInteger(parsed.remainingWalletPaise) ||
      !Number.isSafeInteger(parsed.creditPricePaise) ||
      !Number.isSafeInteger(parsed.walletLedgerId)
    ) {
      return null;
    }
    return {
      walletPaiseConverted: Number(parsed.walletPaiseConverted),
      creditsAddedMilli: Number(parsed.creditsAddedMilli),
      remainingWalletPaise: Number(parsed.remainingWalletPaise),
      creditPricePaise: Number(parsed.creditPricePaise),
      walletLedgerId: Number(parsed.walletLedgerId),
    };
  } catch {
    return null;
  }
}

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function applyConversion(
  tx: DbTransaction,
  tenantId: number,
  expectedWalletPaise: number,
  expectedCreditPricePaise: number,
  idempotencyKey: string,
  reviewedException?: {
    ids: number[];
    authorization: string;
  },
): Promise<WalletConversionResult> {
  // Wallet is the first business row lock. All reserve and settlement paths
  // must take this lock before touching a wallet ledger reservation.
  const [wallet] = await tx
    .select({ balancePaise: walletBalancesTable.balancePaise })
    .from(walletBalancesTable)
    .where(eq(walletBalancesTable.tenantId, tenantId))
    .for("update")
    .limit(1);
  if (!wallet) {
    throw new WalletConversionConflictError(
      "Wallet balance row does not exist; there is no existing balance to convert.",
    );
  }

  // This is the common lock with the broad legacy credit migration. The
  // migration takes the tenant lock before granting, while this transaction
  // takes the wallet lock first and then the tenant lock before rechecking
  // receipts. A migration that committed first is therefore visible here;
  // one that is in flight cannot race this conversion.
  const [tenant] = await tx
    .select({ id: tenantsTable.id })
    .from(tenantsTable)
    .where(eq(tenantsTable.id, tenantId))
    .for("update")
    .limit(1);
  if (!tenant) throw new WalletConversionNotFoundError();

  // The credit ledger is the durable conversion receipt. Looking it up after
  // the wallet lock makes same-key concurrent requests serialize with normal
  // wallet writes while still returning the original result on replay.
  const [receipt] = await tx
    .select({
      id: creditAccountLedgerTable.id,
      kind: creditAccountLedgerTable.kind,
      refKind: creditAccountLedgerTable.refKind,
      refId: creditAccountLedgerTable.refId,
      purchasedDeltaMilli: creditAccountLedgerTable.purchasedDeltaMilli,
      note: creditAccountLedgerTable.note,
    })
    .from(creditAccountLedgerTable)
    .where(
      and(
        eq(creditAccountLedgerTable.tenantId, tenantId),
        eq(creditAccountLedgerTable.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  if (receipt) {
    if (
      receipt.kind !== "purchase" ||
      receipt.refKind !== WALLET_CONVERSION_REF_KIND ||
      receipt.refId !== idempotencyKey
    ) {
      throw new WalletConversionConflictError(
        "Idempotency key has already been used for another credit ledger entry.",
      );
    }
    const stored = parseReceiptNote(receipt.note);
    if (!stored) {
      throw new WalletConversionConflictError(
        "The existing wallet conversion receipt is incomplete.",
      );
    }
    return {
      walletPaiseConverted: stored.walletPaiseConverted,
      creditsAdded: stored.creditsAddedMilli / Number(MILLI),
      remainingWalletPaise: stored.remainingWalletPaise,
      creditPricePaise: stored.creditPricePaise,
      walletLedgerId: stored.walletLedgerId,
      creditLedgerId: receipt.id,
    };
  }

  if (await hasPriorWalletMigrationReceipt(tx, tenantId)) {
    throw new WalletConversionConflictError(
      "A prior broad wallet migration receipt exists; manual review is required before wallet conversion.",
    );
  }

  const freshCreditPricePaise = await getPersistedCreditPrice(tx, true);
  const freshWalletPaise = Number(wallet.balancePaise);
  if (
    !Number.isSafeInteger(expectedWalletPaise) ||
    !Number.isSafeInteger(expectedCreditPricePaise) ||
    expectedWalletPaise !== freshWalletPaise ||
    expectedCreditPricePaise !== freshCreditPricePaise
  ) {
    throw new WalletConversionConflictError(
      "The wallet or saved conversion rate changed. Refresh the preview and try again.",
    );
  }
  if (freshCreditPricePaise <= 0) {
    throw new WalletConversionConflictError(unavailableRateReason());
  }
  if (freshWalletPaise <= 0) {
    throw new WalletConversionConflictError(
      "Wallet has no positive balance to convert.",
    );
  }

  const conversion = calculateWalletConversion(
    freshWalletPaise,
    freshCreditPricePaise,
  );
  if (!conversion) throw new WalletConversionValidationError(overflowReason());

  const blocker = await findConversionBlocker(
    tx,
    tenantId,
    reviewedException ? { ids: reviewedException.ids, lock: true } : undefined,
  );
  if (blocker) throw new WalletConversionConflictError(blocker.detail);

  await tx
    .insert(creditAccountsTable)
    .values({ tenantId })
    .onConflictDoNothing({ target: creditAccountsTable.tenantId });
  const [account] = await tx
    .select({
      purchasedMilli: creditAccountsTable.purchasedMilli,
      grantedMilli: creditAccountsTable.grantedMilli,
    })
    .from(creditAccountsTable)
    .where(eq(creditAccountsTable.tenantId, tenantId))
    .for("update")
    .limit(1);
  const purchasedMilli = Number(account?.purchasedMilli ?? 0);
  const grantedMilli = Number(account?.grantedMilli ?? 0);
  const balanceAfterMilli =
    BigInt(Math.max(0, purchasedMilli)) +
    BigInt(Math.max(0, grantedMilli)) +
    BigInt(conversion.creditsMilli);
  if (
    !account ||
    !Number.isSafeInteger(purchasedMilli) ||
    !Number.isSafeInteger(grantedMilli) ||
    purchasedMilli < 0 ||
    grantedMilli < 0 ||
    balanceAfterMilli > BigInt(POSTGRES_INTEGER_MAX)
  ) {
    throw new WalletConversionValidationError(
      "The credit balance exceeds the supported numeric range.",
    );
  }

  const receiptRef = idempotencyKey;
  const receiptNote = JSON.stringify({
    kind: "wallet_to_purchased_credits",
    walletPaiseConverted: freshWalletPaise,
    creditPricePaise: freshCreditPricePaise,
    creditsAddedMilli: conversion.creditsMilli,
    remainingWalletPaise: 0,
    expectedWalletPaise,
    expectedCreditPricePaise,
    idempotencyKey,
    ...(reviewedException
      ? {
          reviewedEstimatedTrueUpLedgerIds: reviewedException.ids,
          reviewedAuthorization: reviewedException.authorization,
        }
      : {}),
  });
  const [walletEntry] = await tx
    .insert(walletLedgerTable)
    .values({
      tenantId,
      kind: "admin_debit",
      amountPaise: -freshWalletPaise,
      refKind: WALLET_CONVERSION_REF_KIND,
      refId: receiptRef,
      note: receiptNote,
    })
    .returning({ id: walletLedgerTable.id });
  await tx
    .update(walletBalancesTable)
    .set({ balancePaise: 0, updatedAt: new Date() })
    .where(eq(walletBalancesTable.tenantId, tenantId));
  await tx
    .update(creditAccountsTable)
    .set({
      purchasedMilli: purchasedMilli + conversion.creditsMilli,
      updatedAt: new Date(),
    })
    .where(eq(creditAccountsTable.tenantId, tenantId));

  const [creditEntry] = await tx
    .insert(creditAccountLedgerTable)
    .values({
      tenantId,
      kind: "purchase",
      purchasedDeltaMilli: conversion.creditsMilli,
      grantedDeltaMilli: 0,
      balanceAfterMilli: Number(balanceAfterMilli),
      rateKey: `wallet_conversion:${freshCreditPricePaise}`,
      refKind: WALLET_CONVERSION_REF_KIND,
      refId: receiptRef,
      idempotencyKey,
      note: receiptNote,
    })
    .returning({ id: creditAccountLedgerTable.id });

  // Update the wallet-side receipt with the credit ledger id without making
  // either ledger dependent on a separate best-effort audit write.
  const linkedNote = JSON.stringify({
    kind: "wallet_to_purchased_credits",
    walletPaiseConverted: freshWalletPaise,
    creditPricePaise: freshCreditPricePaise,
    creditsAddedMilli: conversion.creditsMilli,
    remainingWalletPaise: 0,
    expectedWalletPaise,
    expectedCreditPricePaise,
    idempotencyKey,
    ...(reviewedException
      ? {
          reviewedEstimatedTrueUpLedgerIds: reviewedException.ids,
          reviewedAuthorization: reviewedException.authorization,
        }
      : {}),
    walletLedgerId: walletEntry.id,
    creditLedgerId: creditEntry.id,
  });
  await tx
    .update(walletLedgerTable)
    .set({ note: linkedNote })
    .where(eq(walletLedgerTable.id, walletEntry.id));
  await tx
    .update(creditAccountLedgerTable)
    .set({ note: linkedNote })
    .where(eq(creditAccountLedgerTable.id, creditEntry.id));

  return {
    walletPaiseConverted: freshWalletPaise,
    creditsAdded: conversion.creditsMilli / Number(MILLI),
    remainingWalletPaise: 0,
    creditPricePaise: freshCreditPricePaise,
    walletLedgerId: walletEntry.id,
    creditLedgerId: creditEntry.id,
  };
}

export async function convertWalletToCredits(params: {
  tenantId: number;
  expectedWalletPaise: number;
  expectedCreditPricePaise: number;
  idempotencyKey: string;
}): Promise<WalletConversionResult> {
  if (
    !Number.isSafeInteger(params.expectedWalletPaise) ||
    params.expectedWalletPaise < 0 ||
    !Number.isSafeInteger(params.expectedCreditPricePaise) ||
    params.expectedCreditPricePaise <= 0
  ) {
    throw new WalletConversionValidationError(
      "Expected wallet and credit price snapshots must be finite whole numbers.",
    );
  }
  if (!params.idempotencyKey.trim()) {
    throw new WalletConversionValidationError("Idempotency key is required.");
  }
  return db.transaction((tx) =>
    applyConversion(
      tx,
      params.tenantId,
      params.expectedWalletPaise,
      params.expectedCreditPricePaise,
      params.idempotencyKey,
    ),
  );
}

/**
 * Internal-only reviewed exception. The public conversion entry point above
 * remains strict; this capability is used only by the guarded tenant-4
 * migration script after it has fetched and compared the reviewed rows.
 */
export async function convertWalletToCreditsForReviewedInternalUse(
  params: {
    tenantId: number;
    expectedWalletPaise: number;
    expectedCreditPricePaise: number;
    idempotencyKey: string;
  },
  review: ReviewedWalletConversionException,
): Promise<WalletConversionResult> {
  const ids = validateReviewedWalletConversionException(review);
  if (
    !Number.isSafeInteger(params.expectedWalletPaise) ||
    params.expectedWalletPaise < 0 ||
    !Number.isSafeInteger(params.expectedCreditPricePaise) ||
    params.expectedCreditPricePaise <= 0
  ) {
    throw new WalletConversionValidationError(
      "Expected wallet and credit price snapshots must be finite whole numbers.",
    );
  }
  if (!params.idempotencyKey.trim()) {
    throw new WalletConversionValidationError("Idempotency key is required.");
  }
  return db.transaction((tx) =>
    applyConversion(
      tx,
      params.tenantId,
      params.expectedWalletPaise,
      params.expectedCreditPricePaise,
      params.idempotencyKey,
      { ids, authorization: review.authorization },
    ),
  );
}