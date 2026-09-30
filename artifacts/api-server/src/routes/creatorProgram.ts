import { Router, type IRouter, type Request, type Response } from "express";
import { db, creatorCommissionsTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { requireSuperadmin } from "../middlewares/requireSuperadmin";
import { recordAdminAction, type AdminAuditAction } from "../lib/adminAudit";
import {
  CreatorProgramError,
  applyAsCreator,
  attachCreatorCode,
  getCreatorForTenant,
  getCreatorProgramSettings,
  issueCreatorCode,
  listCreatorCodes,
  listCreators,
  reviewCreator,
  setCreatorStatus,
  updateCreatorProgramSettings,
} from "../lib/creatorProgram";
import {
  getCreatorEarnings,
  listCreatorCommissions,
  releaseHeldCommission,
} from "../lib/creatorCommissions";

const router: IRouter = Router();
const integer = (min: number, max: number) => z.number().int().min(min).max(max);
const string = (max = 200) => z.string().trim().min(1).max(max);
const id = z.coerce.number().int().positive().safe();
const limit = z.coerce.number().int().min(1).max(200).default(100);
const status = z.enum(["applied", "approved", "rejected", "suspended", "closed"]);
const commissionState = z.enum(["pending", "held", "payable", "in_payout", "paid", "reversed", "expired"]);
const application = z.object({
  displayName: string(120),
  contactEmail: z.string().trim().email().max(320).optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  channels: z.array(z.object({
    platform: string(60),
    handle: string(160),
    url: z.string().trim().url().max(2048).optional(),
    followers: integer(0, 100_000_000).optional(),
  }).strict()).max(20).optional(),
  vertical: z.string().trim().max(120).nullable().optional(),
  isRegisteredPractitioner: z.boolean().optional(),
  agreementAccepted: z.literal(true),
}).strict();
const slabs = z.array(z.object({
  minReferrals: integer(0, 1_000_000),
  commissionBps: integer(0, 10_000),
}).strict()).min(1).max(20).refine(
  (rows) => rows[0]?.minReferrals === 0 && rows.every((row, i) => i === 0 || row.minReferrals > rows[i - 1]!.minReferrals),
  "The first slab must start at 0 and thresholds must strictly increase.",
);
const settingsInput = z.object({
  programEnabled: z.boolean(),
  commissionSlabs: slabs.nullable(),
  buyerBonusBps: integer(0, 10_000),
  buyerBonusExpiryDays: integer(1, 3650),
  holdDays: integer(0, 3650),
  consumptionThresholdBps: integer(0, 10_000),
  reserveBps: integer(0, 10_000),
  reserveReleaseDays: integer(0, 3650),
  minPayoutPaise: integer(0, 2_000_000_000),
  earningExpiryDays: integer(1, 3650),
  attributionDays: integer(1, 3650),
  triggerMode: z.enum(["first_purchase", "every_purchase"]),
  payoutCadence: z.enum(["monthly"]),
  tdsRateBps: integer(0, 10_000),
  autoApproveCreators: z.boolean(),
  riskHoldThreshold: integer(0, 1000),
  newCreatorReviewCount: integer(0, 1000),
}).strict().partial().refine((changes) => Object.keys(changes).length > 0, "Supply at least one setting.");

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

router.post("/promoter/apply", run(async (req, res) => {
  const body = parse(application, req.body, res);
  if (!body) return;
  const result = await applyAsCreator({ ...body, tenantId: req.tenantId });
  res.status(201).json(result);
}));
router.get("/promoter/me", run(async (req, res) => {
  const creator = await getCreatorForTenant(req.tenantId);
  if (!creator) { res.status(404).json({ error: "No promoter application found" }); return; }
  res.json({ creator, earnings: await getCreatorEarnings(creator.id), codes: await listCreatorCodes(creator.id) });
}));
router.get("/promoter/commissions", run(async (req, res) => {
  const query = parse(z.object({
    limit,
    state: commissionState.optional(),
  }).strict(), req.query, res);
  if (!query) return;
  const creator = await getCreatorForTenant(req.tenantId);
  if (!creator) { res.status(404).json({ error: "No promoter application found" }); return; }
  res.json({ commissions: await listCreatorCommissions(creator.id, query.state ? [query.state] : undefined, query.limit) });
}));
router.post("/credits/creator-code", run(async (req, res) => {
  const body = parse(z.object({ code: string(80) }).strict(), req.body, res);
  if (!body) return;
  const result = await attachCreatorCode(req.tenantId, body.code);
  if (!result.ok) { res.status(result.reason === "program_disabled" ? 403 : result.reason === "invalid_code" ? 404 : 409).json(result); return; }
  res.json({ attached: true, code: result.code.code, message: "Code applied. Bonus credits arrive after your next eligible credit purchase." });
}));

router.use("/admin", requireSuperadmin);
router.get("/admin/creators", run(async (req, res) => {
  const query = parse(z.object({ status: status.optional(), limit }).strict(), req.query, res);
  if (!query) return;
  res.json({ creators: await listCreators(query.status, query.limit) });
}));
router.post("/admin/creators/:id/review", run(async (req, res) => {
  const creatorId = parse(id, req.params.id, res);
  const body = parse(z.object({ decision: z.enum(["approved", "rejected"]), reason: string(1000).optional() }).strict(), req.body, res);
  if (!creatorId || !body) return;
  const result = await reviewCreator(creatorId, body.decision, req.tenantId, body.reason);
  await audit(req, "creator_review", null, { id: creatorId, decision: body.decision, reason: body.reason }, result.creator.tenantId);
  res.json(result);
}));
router.post("/admin/creators/:id/status", run(async (req, res) => {
  const creatorId = parse(id, req.params.id, res);
  const body = parse(z.object({ status: z.enum(["approved", "suspended", "closed"]), reason: string(1000).optional() }).strict(), req.body, res);
  if (!creatorId || !body) return;
  const creator = await setCreatorStatus(creatorId, body.status, req.tenantId, body.reason);
  await audit(req, "creator_status_change", null, { id: creatorId, status: body.status, reason: body.reason }, creator.tenantId);
  res.json({ creator });
}));
router.post("/admin/creators/:id/codes", run(async (req, res) => {
  const creatorId = parse(id, req.params.id, res);
  const body = parse(z.object({
    label: string(160).optional(),
    reusePolicy: z.enum(["single_use", "multi_use"]).optional(),
    maxRedemptions: integer(1, 1_000_000).nullable().optional(),
    expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
  }).strict(), req.body, res);
  if (!creatorId || !body) return;
  const code = await issueCreatorCode(creatorId, { ...body, expiresAt: body.expiresAt ? new Date(body.expiresAt) : null });
  await audit(req, "creator_code_change", null, { creatorId, codeId: code.id });
  res.status(201).json({ code });
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
  const body = parse(z.object({ reason: string(1000) }).strict(), req.body, res);
  if (!commissionId || !body) return;
  const commission = await releaseHeldCommission(commissionId, body.reason);
  if (!commission) { res.status(409).json({ error: "Commission not found or not held" }); return; }
  await audit(req, "creator_commission_release", { id: commissionId, state: "held" }, { id: commissionId, state: "pending", reason: body.reason }, commission.tenantId);
  res.json({ commission });
}));
router.get("/admin/creator-program/settings", run(async (_req, res) => { res.json(await getCreatorProgramSettings()); }));
router.put("/admin/creator-program/settings", run(async (req, res) => {
  const changes = parse(settingsInput, req.body, res);
  if (!changes) return;
  const old = await getCreatorProgramSettings();
  const updated = await updateCreatorProgramSettings(changes);
  await audit(req, "creator_program_settings_change", old, updated);
  res.json(updated);
}));

export default router;