import { Router, type IRouter, type Request, type Response } from "express";
import { db, creatorCommissionsTable, tenantsTable } from "@workspace/db";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";
import {
  PromoterApplyBody, AttachCreatorCodeBody, AdminReviewCreatorBody,
  AdminSetCreatorStatusBody, AdminIssueCreatorCodeBody, AdminUpdateCreatorSettingsBody,
} from "@workspace/api-zod";
import { requireSuperadmin } from "../middlewares/requireSuperadmin";
import { requireFeature } from "../lib/featureFlags";
import { sensitiveLimiter } from "../middlewares/rateLimit";
import { recordAdminAction, type AdminAuditAction } from "../lib/adminAudit";
import {
  CreatorProgramError,
  applyAsCreator,
  attachCreatorCode,
  getCreatorForTenant,
  getCreatorProgramSettings,
  commissionSlabsFrom,
  pickCommissionSlab,
  issueCreatorCode,
  listCreatorCodes,
  listCreators,
  reviewCreator,
  setCreatorStatus,
  updateCreatorProgramSettings,
} from "../lib/creatorProgram";
import {
  getCreatorEarnings,
  countCreatorCommissions,
  listCreatorCommissions,
  releaseHeldCommission,
  reverseCreatorCommission,
  matureCreatorCommissions,
} from "../lib/creatorCommissions";

const router: IRouter = Router();
const integer = (min: number, max: number) => z.number().int().min(min).max(max);
const string = (max = 200) => z.string().trim().min(1).max(max);
const id = z.coerce.number().int().positive().safe();
const limit = z.coerce.number().int().min(1).max(200).default(100);
const status = z.enum(["applied", "approved", "rejected", "suspended", "closed"]);
const commissionState = z.enum(["pending", "held", "payable", "in_payout", "paid", "reversed", "expired"]);
const application = PromoterApplyBody.strict().refine(
  (body) => (body.channels ?? []).every((channel) => channel.followers === undefined || Number.isInteger(channel.followers)),
  "Follower count must be an integer.",
);
const attachInput = AttachCreatorCodeBody.strict();
const reviewInput = AdminReviewCreatorBody.strict();
const statusInput = AdminSetCreatorStatusBody.strict();
const codeInput = AdminIssueCreatorCodeBody.strict().refine(
  (body) => body.maxRedemptions == null || Number.isInteger(body.maxRedemptions),
  "Maximum redemptions must be an integer.",
);
const settingsInput = AdminUpdateCreatorSettingsBody.strict().refine(
  (changes) => Object.keys(changes).length > 0 && (
    changes.commissionSlabs == null ||
    (changes.commissionSlabs[0]?.minReferrals === 0 && changes.commissionSlabs.every((row, i) =>
      Number.isInteger(row.minReferrals) && Number.isInteger(row.commissionBps) &&
      (i === 0 || row.minReferrals > changes.commissionSlabs![i - 1]!.minReferrals)))
  ) && Object.entries(changes).every(([key, value]) =>
    value == null || key === "commissionSlabs" || typeof value !== "number" || Number.isInteger(value)
  ), "Supply a setting; slabs start at 0 and strictly increase.",
);

function parse<T>(schema: z.ZodType<T>, value: unknown, res: Response): T | null {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
  return null;
}
function fail(req: Request, res: Response, error: unknown) {
  if (error instanceof CreatorProgramError) {
    const httpStatus = error.code === "program_disabled" ? 403
      : error.code === "not_found" ? 404
      : error.code === "duplicate_application" || error.code === "bad_state" ? 409 : 400;
    res.status(httpStatus).json({ error: error.message, code: error.code });
    return;
  }
  req.log.error({ err: error }, "Creator program route failed");
  res.status(500).json({ error: "Creator program operation failed. Try again later." });
}
function run(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response) => {
    void handler(req, res).catch((error) => fail(req, res, error));
  };
}
async function audit(req: Request, action: AdminAuditAction, oldValue: unknown, newValue: unknown, targetTenantId: number | null = null) {
  try {
    await recordAdminAction({
      action, actorTenantId: req.tenantId, actorEmail: null, targetTenantId,
      targetEmail: null, oldValue: oldValue === null ? null : JSON.stringify(oldValue),
      newValue: newValue === null ? null : JSON.stringify(newValue),
    });
  } catch (error) {
    req.log.error({ err: error, action }, "Creator admin audit failed after successful mutation");
  }
}

router.use("/promoter", requireFeature("creatorProgram"));
router.use("/promoter/apply", sensitiveLimiter);
router.use("/credits/creator-code", sensitiveLimiter, requireFeature("creatorProgram"));
router.post("/promoter/apply", run(async (req, res) => {
  const body = parse(application, req.body, res);
  if (!body) return;
  const result = await applyAsCreator({ ...body, tenantId: req.tenantId });
  res.status(201).json({ status: result.creator.status, code: result.code?.code ?? null,
    message: result.creator.status === "approved" ? "Your promoter code is ready to share." : "Application received. We'll review it shortly." });
}));
router.get("/promoter/me", run(async (req, res) => {
  const creator = await getCreatorForTenant(req.tenantId);
  if (!creator) { res.status(404).json({ error: "Not a promoter", code: "not_a_promoter" }); return; }
  const settings = await getCreatorProgramSettings();
  const [codes, earnings, qualifying] = await Promise.all([
    listCreatorCodes(creator.id), getCreatorEarnings(creator.id), countCreatorCommissions(creator.id),
  ]);
  const ladder = commissionSlabsFrom(settings);
  const { slab, index } = pickCommissionSlab(ladder, qualifying);
  const next = ladder[index + 1] ?? null;
  res.json({
    status: creator.status, displayName: creator.displayName, contactEmail: creator.contactEmail,
    vertical: creator.vertical, isRegisteredPractitioner: creator.isRegisteredPractitioner,
    appliedAt: creator.appliedAt, reviewedAt: creator.reviewedAt, statusReason: creator.statusReason,
    codes: creator.status === "approved" ? codes.filter((code) => code.active).map((code) => ({
      code: code.code, label: code.label, reusePolicy: code.reusePolicy, redemptionCount: code.redemptionCount,
      maxRedemptions: code.maxRedemptions, expiresAt: code.expiresAt,
    })) : [],
    commission: {
      currentBps: creator.commissionOverrideBps ?? slab.commissionBps,
      isNegotiatedRate: creator.commissionOverrideBps !== null, slabIndex: index,
      qualifyingPurchases: qualifying, nextSlabAt: next?.minReferrals ?? null, nextSlabBps: next?.commissionBps ?? null,
    },
    earnings: {
      pending: earnings.pendingPaise / 100, held: earnings.heldPaise / 100,
      payable: earnings.payablePaise / 100, paid: earnings.paidPaise / 100, reversed: earnings.reversedPaise / 100,
      grossDriven: earnings.grossDrivenPaise / 100, totalPurchases: earnings.totalPurchases,
      awaitingActivation: earnings.awaitingActivation, inHoldWindow: earnings.inHoldWindow,
    },
    terms: {
      holdDays: settings.holdDays, consumptionThresholdBps: settings.consumptionThresholdBps,
      minPayout: settings.minPayoutPaise / 100, payoutCadence: settings.payoutCadence,
      earningExpiryDays: settings.earningExpiryDays, buyerBonusBps: settings.buyerBonusBps,
    },
  });
}));
router.get("/promoter/commissions", run(async (req, res) => {
  const query = parse(z.object({
    limit,
    state: commissionState.optional(),
  }).strict(), req.query, res);
  if (!query) return;
  const creator = await getCreatorForTenant(req.tenantId);
  if (!creator) { res.status(404).json({ error: "Not a promoter", code: "not_a_promoter" }); return; }
  const rows = await listCreatorCommissions(creator.id, query.state ? [query.state] : undefined, query.limit);
  res.json(rows.map((row) => ({
    id: row.id, workspace: `Workspace #${row.tenantId}`, purchasedOn: row.createdAt,
    gross: row.grossPaise / 100, commission: row.commissionPaise / 100,
    commissionBps: row.commissionBps, state: row.state, holdUntil: row.holdUntil,
    consumptionBps: row.consumptionBps, maturedAt: row.maturedAt,
    reason: row.state === "held" ? "Under review" : row.state === "reversed" ? "Reversed" : null,
  })));
}));
router.post("/credits/creator-code", run(async (req, res) => {
  const body = parse(attachInput, req.body, res);
  if (!body) return;
  const result = await attachCreatorCode(req.tenantId, body.code);
  if (!result.ok) {
    res.status(result.reason === "program_disabled" ? 403 : result.reason === "already_attributed" ? 409 : 400)
      .json({ error: result.message, code: result.reason });
    return;
  }
  const settings = await getCreatorProgramSettings();
  res.json({ ok: true, code: result.code.code, promoter: result.creator.displayName,
    bonusBps: settings.buyerBonusBps,
    message: `Code applied. You'll get ${settings.buyerBonusBps / 100}% bonus credits on your next credit purchase.` });
}));

router.use("/admin/creators", requireSuperadmin);
router.use("/admin/commissions", requireSuperadmin);
router.use("/admin/promoter", requireSuperadmin);
router.use("/admin/creator-program", requireSuperadmin);
router.get("/admin/creators", run(async (req, res) => {
  const query = parse(z.object({ status: status.optional(), limit }).strict(), req.query, res);
  if (!query) return;
  const creators = await listCreators(query.status, query.limit);
  res.json(await Promise.all(creators.map(async (creator) => {
    const [workspace] = await db.select({
      name: tenantsTable.name, email: tenantsTable.email, plan: tenantsTable.plan, createdAt: tenantsTable.createdAt,
    }).from(tenantsTable).where(eq(tenantsTable.id, creator.tenantId)).limit(1);
    return { ...creator, workspace: workspace ?? null };
  })));
}));
router.post("/admin/creators/:id/review", run(async (req, res) => {
  const creatorId = parse(id, req.params.id, res);
  const body = parse(reviewInput, req.body, res);
  if (!creatorId || !body) return;
  const result = await reviewCreator(creatorId, body.decision, req.tenantId, body.reason);
  await audit(req, "creator_review", null, { id: creatorId, decision: body.decision, reason: body.reason }, result.creator.tenantId);
  res.json({ status: result.creator.status, code: result.code?.code ?? null });
}));
router.post("/admin/creators/:id/status", run(async (req, res) => {
  const creatorId = parse(id, req.params.id, res);
  const body = parse(statusInput, req.body, res);
  if (!creatorId || !body) return;
  const creator = await setCreatorStatus(creatorId, body.status, req.tenantId, body.reason);
  await audit(req, "creator_status_change", null, { id: creatorId, status: body.status, reason: body.reason }, creator.tenantId);
  res.json({ status: creator.status });
}));
router.post("/admin/creators/:id/codes", run(async (req, res) => {
  const creatorId = parse(id, req.params.id, res);
  const body = parse(codeInput, req.body ?? {}, res);
  if (!creatorId || !body) return;
  const code = await issueCreatorCode(creatorId, { ...body, expiresAt: body.expiresAt ?? null });
  await audit(req, "creator_code_change", null, { creatorId, codeId: code.id });
  res.status(201).json({ code: code.code, id: code.id });
}));
router.get("/admin/commissions", run(async (req, res) => {
  const query = parse(z.object({ state: commissionState.optional(), limit }).strict(), req.query, res);
  if (!query) return;
  const rows = await db.select().from(creatorCommissionsTable)
    .where(query.state ? eq(creatorCommissionsTable.state, query.state) : undefined)
    .orderBy(desc(creatorCommissionsTable.createdAt)).limit(query.limit ?? 100);
  res.json({ commissions: rows });
}));
router.post("/admin/commissions/:id/release", run(async (req, res) => {
  const commissionId = parse(id, req.params.id, res);
  const body = parse(z.object({ reason: string(1000).optional() }).strict(), req.body ?? {}, res);
  if (!commissionId || !body) return;
  const reason = body.reason ?? "Cleared by admin";
  const commission = await releaseHeldCommission(commissionId, reason);
  if (!commission) { res.status(409).json({ error: "Commission not found or not held", code: "bad_state" }); return; }
  await audit(req, "creator_commission_release", { id: commissionId, state: "held" }, { id: commissionId, state: "pending", reason }, commission.tenantId);
  res.json({ state: commission.state });
}));
router.get("/admin/commissions/held", run(async (_req, res) => {
  const rows = await db.select().from(creatorCommissionsTable).where(eq(creatorCommissionsTable.state, "held"))
    .orderBy(desc(creatorCommissionsTable.riskScore), desc(creatorCommissionsTable.createdAt)).limit(200);
  res.json(rows);
}));
router.post("/admin/commissions/:id/reverse", run(async (req, res) => {
  const commissionId = parse(id, req.params.id, res);
  const body = parse(z.object({ reason: string(1000).optional() }).strict(), req.body ?? {}, res);
  if (!commissionId || !body) return;
  const [row] = await db.select().from(creatorCommissionsTable).where(eq(creatorCommissionsTable.id, commissionId)).limit(1);
  if (!row) { res.status(404).json({ error: "Commission not found", code: "not_found" }); return; }
  const result = await reverseCreatorCommission(row.purchaseKind, row.purchaseRefId, body.reason ?? "Reversed by admin");
  if (!result.reversed) {
    const paid = result.state === "paid" || result.state === "in_payout";
    res.status(409).json({
      error: paid ? "Already entered payout; reserve offset required" : "Commission is not reversible",
      code: paid ? "already_paid" : "bad_state", state: result.state,
    });
    return;
  }
  await audit(req, "creator_commission_reverse", { id: commissionId, state: row.state }, { id: commissionId, state: "reversed", reason: body.reason }, row.tenantId);
  res.json({ state: "reversed" });
}));
router.post("/admin/promoter/mature", run(async (req, res) => {
  const summary = await matureCreatorCommissions();
  await audit(req, "creator_commission_mature", null, summary);
  res.json(summary);
}));
router.get("/admin/promoter/metrics", run(async (_req, res) => {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [byState, recent] = await Promise.all([
    db.select({ state: creatorCommissionsTable.state, count: sql<number>`count(*)::int`,
      commissionPaise: sql<string>`coalesce(sum(${creatorCommissionsTable.commissionPaise}), 0)::bigint`,
    }).from(creatorCommissionsTable).groupBy(creatorCommissionsTable.state),
    db.select({ sum: sql<string>`coalesce(sum(${creatorCommissionsTable.commissionPaise}), 0)::bigint` })
      .from(creatorCommissionsTable).where(and(gte(creatorCommissionsTable.createdAt, since), eq(creatorCommissionsTable.state, "payable"))),
  ]);
  res.json({ byState: byState.map((row) => ({
    state: row.state, count: row.count, commission: Number(row.commissionPaise) / 100,
  })), payableLast30d: Number(recent[0]?.sum ?? 0) / 100 });
}));
router.get("/admin/creator-program/settings", run(async (_req, res) => { res.json(await getCreatorProgramSettings()); }));
router.get("/admin/promoter/settings", run(async (_req, res) => { res.json(await getCreatorProgramSettings()); }));
const saveSettings = run(async (req, res) => {
  const changes = parse(settingsInput, req.body, res);
  if (!changes) return;
  const old = await getCreatorProgramSettings();
  const updated = await updateCreatorProgramSettings(changes);
  await audit(req, "creator_program_settings_change", old, updated);
  res.json(updated);
});
router.put("/admin/creator-program/settings", saveSettings);
router.put("/admin/promoter/settings", saveSettings);

export default router;