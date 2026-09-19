import { db, tenantsTable, creditAccountsTable, creditAccountLedgerTable, adminAuditLogsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod/v4";

export const creditCorrectionInput = z.object({
  amountMilli: z.number().int().positive().max(2147483647),
  expectedPurchasedMilli: z.number().int().nonnegative().max(2147483647),
  reference: z.string().trim().min(1).max(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9:._-]*$/),
  reason: z.string().trim().min(1).max(1000),
}).strict();

export class CreditCorrectionError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** No lazy expiry, account creation, grant changes, or approximate unit conversions. */
export async function correctPurchasedCredits(
  tenantId: number,
  input: z.infer<typeof creditCorrectionInput>,
  actor: { tenantId: number; email?: string | null },
) {
  input = creditCorrectionInput.parse(input);
  return db.transaction(async (tx) => {
    const [tenant] = await tx.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId));
    if (!tenant) throw new CreditCorrectionError(404, "Tenant not found");
    const [account] = await tx.select().from(creditAccountsTable)
      .where(eq(creditAccountsTable.tenantId, tenantId)).for("update");
    if (!account) throw new CreditCorrectionError(404, "Canonical credit account not found");
    const key = `admin:purchased-correction:${input.reference}`;
    const [previous] = await tx.select().from(creditAccountLedgerTable).where(and(
      eq(creditAccountLedgerTable.tenantId, tenantId),
      eq(creditAccountLedgerTable.idempotencyKey, key),
    ));
    // The immutable receipt is persisted in the ledger note, not reconstructed
    // from today's balance. Replay intentionally precedes optimistic validation.
    if (previous) {
      if (previous.purchasedDeltaMilli !== -input.amountMilli) {
        throw new CreditCorrectionError(409, "Reference already used with a different amount");
      }
      return JSON.parse(previous.note!).receipt as {
        tenantId: number; reference: string; amountMilli: number;
        beforePurchasedMilli: number; afterPurchasedMilli: number; reason: string;
      };
    }
    if (account.purchasedMilli !== input.expectedPurchasedMilli) {
      throw new CreditCorrectionError(409, "Purchased balance changed; refresh and review before retrying");
    }
    if (account.purchasedMilli < input.amountMilli) {
      throw new CreditCorrectionError(409, "Insufficient purchased credits");
    }
    const receipt = {
      tenantId, reference: input.reference, amountMilli: input.amountMilli,
      beforePurchasedMilli: account.purchasedMilli,
      afterPurchasedMilli: account.purchasedMilli - input.amountMilli,
      reason: input.reason,
    };
    await tx.update(creditAccountsTable).set({
      purchasedMilli: receipt.afterPurchasedMilli, updatedAt: new Date(),
    }).where(eq(creditAccountsTable.tenantId, tenantId));
    await tx.insert(creditAccountLedgerTable).values({
      tenantId, kind: "admin_purchased_correction",
      purchasedDeltaMilli: -input.amountMilli, grantedDeltaMilli: 0,
      balanceAfterMilli: receipt.afterPurchasedMilli + (
        account.grantedExpiresAt && account.grantedExpiresAt.getTime() <= Date.now()
          ? 0 : account.grantedMilli
      ),
      idempotencyKey: key, refKind: "admin_purchased_correction", refId: input.reference,
      note: JSON.stringify({ receipt }),
    });
    // Unlike best-effort operational logs, this audit MUST commit with the debit.
    await tx.insert(adminAuditLogsTable).values({
      action: "credit_account_correction",
      actorTenantId: actor.tenantId, actorEmail: actor.email ?? null,
      targetTenantId: tenantId, targetEmail: tenant.email ?? null,
      oldValue: JSON.stringify({ purchasedMilli: account.purchasedMilli, grantedMilli: account.grantedMilli }),
      newValue: JSON.stringify({ ...receipt, purchasedMilli: receipt.afterPurchasedMilli, grantedMilli: account.grantedMilli }),
    });
    return receipt;
  });
}