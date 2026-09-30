import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { db, creatorPayoutsTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import {
  SavePromoterPayoutDetailsBody, ExportPromoterPayoutsBody,
  MarkPromoterPayoutPaidBody, MarkPromoterPayoutFailedBody,
  ClawbackPromoterCommissionBody,
} from "@workspace/api-zod";
import { requireSuperadmin } from "../middlewares/requireSuperadmin";
import { requireFeature } from "../lib/featureFlags";
import { recordAdminAction, type AdminAuditAction } from "../lib/adminAudit";
import { getCreatorForTenant } from "../lib/creatorProgram";
import { notifyCreatorEvent } from "../lib/notifications";
import { creatorAccountsTable } from "@workspace/db";
import {
  buildPayoutRun, clawbackPaidCommission, exportPayoutBatch,
  getCreatorPayoutIdentity, getPayoutBalance, listCreatorPayouts,
  markPayoutFailed, markPayoutPaid, PayoutIdentityError,
  releaseMatureReserves, saveCreatorPayoutIdentity,
} from "../lib/creatorPayouts";

// No raw request body, raw error object, hash or full number is ever logged.
const router: IRouter = Router();
const id = z.coerce.number().int().positive().safe();
const status = z.enum(["draft", "exported", "paid", "failed"]);
const money = (paise: number) => paise / 100;
function parse<T>(schema: z.ZodType<T>, input: unknown, res: Response): T | null {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  res.status(400).json({ error: "Invalid input", code: "invalid_input" });
  return null;
}
function run(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response) => {
    void handler(req, res).catch(error => {
      if (error instanceof PayoutIdentityError) {
        const status = error.code === "pii_not_configured" ? 503
          : error.code === "program_disabled" ? 403
          : error.code === "pan_in_use" || error.code === "reference_conflict" ||
            error.code === "invalid_state" || error.code === "payout_in_flight" ||
            error.code === "destination_changed" ? 409 : 400;
        res.status(status).json({ error: error.message, code: error.code });
        return;
      }
      // Driver exceptions sometimes include bind parameters (PAN/account numbers).
      req.log.error("Promoter payout operation failed");
      res.status(500).json({ error: "Payout operation failed. Try again later.", code: "payout_failed" });
    });
  };
}
async function audit(req: Request, action: AdminAuditAction, details: Record<string, unknown>) {
  try {
    await recordAdminAction({
      action, actorTenantId: req.tenantId, actorEmail: null, targetTenantId: null,
      targetEmail: null, oldValue: null, newValue: JSON.stringify(details),
    });
  } catch {
    req.log.error({ action }, "Promoter payout audit failed after mutation");
  }
}
async function ownCreator(req: Request, res: Response) {
  const creator = await getCreatorForTenant(req.tenantId);
  if (!creator) res.status(404).json({ error: "Not a promoter", code: "not_a_promoter" });
  return creator;
}
function masked(row: Awaited<ReturnType<typeof listCreatorPayouts>>[number]) {
  return {
    id: row.id, gross: money(row.grossPaise), tds: money(row.tdsPaise),
    tdsRateBps: row.tdsRateBps, reserveHeld: money(row.reserveHeldPaise),
    reserveReleasedAt: row.reserveReleasedAt, net: money(row.netPaise),
    status: row.status, paidAt: row.paidAt, reference: row.gatewayRef,
  };
}

router.use("/promoter", requireFeature("creatorProgram"));
router.get("/promoter/payout-details", run(async (req, res) => {
  const creator = await ownCreator(req, res);
  if (!creator) return;
  const identity = await getCreatorPayoutIdentity(creator.id);
  if (!identity) { res.json({ onFile: false }); return; }
  res.json({
    onFile: true, panLast4: identity.panLast4, bankLast4: identity.bankLast4,
    ifsc: identity.ifsc, beneficiaryName: identity.beneficiaryName,
    verified: identity.verifiedAt !== null,
  });
}));
router.post("/promoter/payout-details", run(async (req, res) => {
  const creator = await ownCreator(req, res);
  if (!creator) return;
  if (creator.status !== "approved") {
    res.status(403).json({ error: "Only approved promoters can save payout details.", code: "not_approved" });
    return;
  }
  const input = parse(SavePromoterPayoutDetailsBody.strict(), req.body, res);
  if (!input) return;
  const saved = await saveCreatorPayoutIdentity({ creatorId: creator.id, ...input });
  res.json({
    onFile: true, panLast4: saved.panLast4, bankLast4: saved.bankLast4,
    ifsc: saved.ifsc, beneficiaryName: saved.beneficiaryName, verified: false,
  });
}));
router.get("/promoter/payouts", run(async (req, res) => {
  const creator = await ownCreator(req, res);
  if (!creator) return;
  const [rows, balance] = await Promise.all([
    listCreatorPayouts(creator.id), getPayoutBalance(creator.id),
  ]);
  res.json({ balance: {
    payable: money(balance.payablePaise), netOwed: money(balance.netOwedPaise),
    owedBack: money(balance.owedBackPaise),
  }, payouts: rows.map(masked) });
}));

// This middleware attaches only to the /admin/payouts prefix, never /admin/*.
router.use("/admin/payouts", requireSuperadmin);
router.post("/admin/payouts/run", run(async (req, res) => {
  const result = await buildPayoutRun();
  await audit(req, "creator_payout_run", { created: result.created, totalNetPaise: result.totalNetPaise });
  res.json(result);
}));
router.get("/admin/payouts", run(async (req, res) => {
  const query = parse(z.object({ status: status.optional() }).strict(), req.query, res);
  if (!query) return;
  const rows = await db.select().from(creatorPayoutsTable)
    .where(query.status ? eq(creatorPayoutsTable.status, query.status) : undefined)
    .orderBy(desc(creatorPayoutsTable.createdAt)).limit(200);
  res.json(rows.map(row => ({
    ...masked(row),
    // The review destination is only a name, last four and IFSC; it is not
    // enough to route a bank transfer. Never serialize the full DB row.
    destination: row.destinationSnapshot && {
      beneficiaryName: row.destinationSnapshot.beneficiaryName,
      bankLast4: row.destinationSnapshot.bankLast4,
      ifsc: row.destinationSnapshot.ifsc,
    },
  })));
}));
router.post("/admin/payouts/export", run(async (req, res) => {
  const input = parse(ExportPromoterPayoutsBody.strict(), req.body, res);
  if (!input) return;
  const csv = await exportPayoutBatch(input.payoutIds);
  await audit(req, "creator_payout_export", { payoutIds: input.payoutIds });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="promoter-review-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
}));
router.post("/admin/payouts/:id/paid", run(async (req, res) => {
  const payoutId = parse(id, req.params.id, res);
  const input = parse(MarkPromoterPayoutPaidBody.strict(), req.body, res);
  if (!payoutId || !input) return;
  const paid = await markPayoutPaid(payoutId, input.reference);
  if (!paid) { res.status(409).json({ error: "Payout is not awaiting payment.", code: "bad_state" }); return; }
  const [creator] = await db.select({ tenantId: creatorAccountsTable.tenantId })
    .from(creatorAccountsTable).where(eq(creatorAccountsTable.id, paid.creatorId)).limit(1);
  if (creator) await notifyCreatorEvent({
    tenantId: creator.tenantId, type: "promoter_payout_sent", eventKey: `payout:${paid.id}`,
    title: "Promoter payout marked sent",
    message: `A payout of ₹${(paid.netPaise / 100).toFixed(2)} was marked sent. Reference: ${paid.gatewayRef ?? "not provided"}.`,
    linkUrl: "/promoter",
  });
  await audit(req, "creator_payout_paid", { payoutId, status: paid.status });
  res.json({ status: paid.status, paidAt: paid.paidAt });
}));
router.post("/admin/payouts/:id/failed", run(async (req, res) => {
  const payoutId = parse(id, req.params.id, res);
  const input = parse(MarkPromoterPayoutFailedBody.strict(), req.body, res);
  if (!payoutId || !input) return;
  const failed = await markPayoutFailed(payoutId, input.reason);
  if (!failed) { res.status(409).json({ error: "Payout is not awaiting payment.", code: "bad_state" }); return; }
  await audit(req, "creator_payout_failed", { payoutId, status: failed.status });
  res.json({ status: failed.status });
}));
router.post("/admin/payouts/clawback/:commissionId", run(async (req, res) => {
  const commissionId = parse(id, req.params.commissionId, res);
  const input = parse(ClawbackPromoterCommissionBody.strict(), req.body, res);
  if (!commissionId || !input) return;
  const result = await clawbackPaidCommission(commissionId, input.reason);
  if (!result.clawedBack) {
    res.status(409).json({ error: "Commission is not paid or already clawed back.", code: "bad_state" });
    return;
  }
  await audit(req, "creator_payout_clawback", { commissionId, amountPaise: result.amountPaise });
  res.json({ clawedBack: true, amount: money(result.amountPaise ?? 0) });
}));
router.post("/admin/payouts/release-reserves", run(async (req, res) => {
  const result = await releaseMatureReserves();
  await audit(req, "creator_payout_reserve_release", result);
  res.json(result);
}));
export default router;