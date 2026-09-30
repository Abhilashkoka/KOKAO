import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import { db, creatorCommissionsTable, tenantsTable } from "@workspace/db";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { requireSuperadmin } from "../middlewares/requireSuperadmin";
import {
  CreatorProgramError,
  getCreatorProgramSettings,
  issueCreatorCode,
  listCreators,
  reviewCreator,
  setCreatorStatus,
  updateCreatorProgramSettings,
  type CreatorStatus,
} from "../lib/creatorProgram";
import {
  matureCreatorCommissions,
  releaseHeldCommission,
  reverseCreatorCommission,
} from "../lib/creatorCommissions";

/**
 * Superadmin routes for the promoter program: the review queue, the risk
 * queue, code issuance and program settings.
 *
 * Mounted under requireSuperadmin, which also keeps it outside the feature
 * kill switch — so a disabled program can always be re-enabled from here,
 * matching how routes/admin.ts is treated.
 *
 * Local zod schemas for now; move them to the OpenAPI contract and regenerate
 * (see SETUP.md).
 */

const router: IRouter = Router();
router.use("/admin/promoter", requireSuperadmin);
router.use("/admin/creators", requireSuperadmin);
router.use("/admin/commissions", requireSuperadmin);

const ReviewBody = z.object({
  decision: z.enum(["approved", "rejected"]),
  reason: z.string().trim().max(500).optional(),
});

const StatusBody = z.object({
  status: z.enum(["approved", "suspended", "closed"]),
  reason: z.string().trim().max(500).optional(),
});

const IssueCodeBody = z.object({
  label: z.string().trim().max(120).optional(),
  reusePolicy: z.enum(["single_use", "multi_use"]).optional(),
  maxRedemptions: z.number().int().positive().max(1_000_000).nullish(),
  expiresAt: z.coerce.date().nullish(),
});

const SlabSchema = z.object({
  minReferrals: z.number().int().min(0).max(100_000),
  commissionBps: z.number().int().min(0).max(10_000),
});

const SettingsBody = z.object({
  commissionSlabs: z.array(SlabSchema).min(1).max(10).optional(),
  buyerBonusBps: z.number().int().min(0).max(10_000).optional(),
  buyerBonusExpiryDays: z.number().int().min(1).max(3650).optional(),
  holdDays: z.number().int().min(0).max(365).optional(),
  consumptionThresholdBps: z.number().int().min(0).max(10_000).optional(),
  reserveBps: z.number().int().min(0).max(10_000).optional(),
  reserveReleaseDays: z.number().int().min(0).max(3650).optional(),
  minPayoutPaise: z.number().int().min(0).optional(),
  earningExpiryDays: z.number().int().min(1).max(3650).optional(),
  attributionDays: z.number().int().min(1).max(3650).optional(),
  triggerMode: z.enum(["first_purchase", "every_purchase"]).optional(),
  payoutCadence: z.enum(["monthly", "fortnightly", "on_request"]).optional(),
  tdsRateBps: z.number().int().min(0).max(10_000).optional(),
  autoApproveCreators: z.boolean().optional(),
  riskHoldThreshold: z.number().int().min(0).max(100).optional(),
  newCreatorReviewCount: z.number().int().min(0).max(100).optional(),
  programEnabled: z.boolean().optional(),
});

const ListQuery = z.object({
  status: z
    .enum(["applied", "approved", "rejected", "suspended", "closed"])
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/** The review queue. Defaults to everything, newest application first. */
router.get("/admin/creators", async (req: Request, res: Response) => {
  const parsed = ListQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query" });
    return;
  }
  const rows = await listCreators(
    parsed.data.status as CreatorStatus | undefined,
    parsed.data.limit ?? 100,
  );
  // Join the promoter's own workspace so a reviewer can see who they are.
  const withTenant = await Promise.all(
    rows.map(async (c) => {
      const [t] = await db
        .select({
          name: tenantsTable.name,
          email: tenantsTable.email,
          plan: tenantsTable.plan,
          createdAt: tenantsTable.createdAt,
        })
        .from(tenantsTable)
        .where(eq(tenantsTable.id, c.tenantId))
        .limit(1);
      return { ...c, workspace: t ?? null };
    }),
  );
  res.json(withTenant);
});

router.post(
  "/admin/creators/:id/review",
  async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const parsed = ReviewBody.safeParse(req.body);
    if (!Number.isInteger(id) || !parsed.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    try {
      const { creator, code } = await reviewCreator(
        id,
        parsed.data.decision,
        req.tenantId,
        parsed.data.reason,
      );
      res.json({ status: creator.status, code: code?.code ?? null });
    } catch (error) {
      if (error instanceof CreatorProgramError) {
        res
          .status(error.code === "not_found" ? 404 : 409)
          .json({ error: error.message, code: error.code });
        return;
      }
      req.log.error({ err: error }, "Promoter review failed");
      res.status(500).json({ error: "Could not record the decision." });
    }
  },
);

/**
 * Suspend, restore or close a promoter. Suspension deactivates their codes so
 * nothing new attaches; it deliberately leaves accrued commissions alone —
 * what happens to pending earnings is a separate, explicit decision.
 */
router.post(
  "/admin/creators/:id/status",
  async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const parsed = StatusBody.safeParse(req.body);
    if (!Number.isInteger(id) || !parsed.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    try {
      const creator = await setCreatorStatus(
        id,
        parsed.data.status,
        req.tenantId,
        parsed.data.reason,
      );
      res.json({ status: creator.status });
    } catch (error) {
      if (error instanceof CreatorProgramError) {
        res.status(404).json({ error: error.message, code: error.code });
        return;
      }
      req.log.error({ err: error }, "Promoter status change failed");
      res.status(500).json({ error: "Could not change the status." });
    }
  },
);

router.post("/admin/creators/:id/codes", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const parsed = IssueCodeBody.safeParse(req.body);
  if (!Number.isInteger(id) || !parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const code = await issueCreatorCode(id, {
    label: parsed.data.label,
    reusePolicy: parsed.data.reusePolicy,
    maxRedemptions: parsed.data.maxRedemptions ?? null,
    expiresAt: parsed.data.expiresAt ?? null,
  });
  res.status(201).json({ code: code.code, id: code.id });
});

/** The risk queue: held commissions, worst score first. */
router.get("/admin/commissions/held", async (req: Request, res: Response) => {
  const rows = await db
    .select()
    .from(creatorCommissionsTable)
    .where(eq(creatorCommissionsTable.state, "held"))
    .orderBy(
      desc(creatorCommissionsTable.riskScore),
      desc(creatorCommissionsTable.createdAt),
    )
    .limit(200);
  res.json(rows);
});

router.post(
  "/admin/commissions/:id/release",
  async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const reason = z
      .string()
      .trim()
      .max(500)
      .safeParse(req.body?.reason ?? "Cleared by admin");
    if (!Number.isInteger(id) || !reason.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    const updated = await releaseHeldCommission(id, reason.data);
    if (!updated) {
      res
        .status(409)
        .json({ error: "That commission is not held.", code: "bad_state" });
      return;
    }
    res.json({ state: updated.state });
  },
);

/** Manual reversal — for a refund the automatic path hasn't covered. */
router.post(
  "/admin/commissions/:id/reverse",
  async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    const [row] = await db
      .select()
      .from(creatorCommissionsTable)
      .where(eq(creatorCommissionsTable.id, id))
      .limit(1);
    if (!row) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const result = await reverseCreatorCommission(
      row.purchaseKind,
      row.purchaseRefId,
      typeof req.body?.reason === "string"
        ? req.body.reason.slice(0, 500)
        : "Reversed by admin",
    );
    if (!result.reversed) {
      res.status(409).json({
        error:
          "This commission has already entered a payout and needs a reserve offset instead.",
        code: "already_paid",
        state: result.state,
      });
      return;
    }
    res.json({ state: "reversed" });
  },
);

/** Run maturation on demand — the scheduled job does this hourly anyway. */
router.post("/admin/promoter/mature", async (req: Request, res: Response) => {
  const summary = await matureCreatorCommissions();
  res.json(summary);
});

/** Program-wide numbers for the admin dashboard. */
router.get("/admin/promoter/metrics", async (req: Request, res: Response) => {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [byState, recent] = await Promise.all([
    db
      .select({
        state: creatorCommissionsTable.state,
        count: sql<number>`count(*)::int`,
        commissionPaise: sql<number>`coalesce(sum(${creatorCommissionsTable.commissionPaise}), 0)::bigint`,
      })
      .from(creatorCommissionsTable)
      .groupBy(creatorCommissionsTable.state),
    db
      .select()
      .from(creatorCommissionsTable)
      .where(
        and(
          gte(creatorCommissionsTable.createdAt, since),
          eq(creatorCommissionsTable.state, "payable"),
        ),
      )
      .limit(500),
  ]);
  res.json({
    byState: byState.map((r) => ({
      state: r.state,
      count: r.count,
      commission: Number(r.commissionPaise) / 100,
    })),
    payableLast30d: recent.reduce((sum, r) => sum + r.commissionPaise, 0) / 100,
  });
});

router.get("/admin/promoter/settings", async (_req, res: Response) => {
  res.json(await getCreatorProgramSettings());
});

router.put("/admin/promoter/settings", async (req: Request, res: Response) => {
  const parsed = SettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  res.json(await updateCreatorProgramSettings(parsed.data));
});

export default router;
