import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";
import {
  applyAsCreator,
  attachCreatorCode,
  commissionSlabsFrom,
  CreatorProgramError,
  getCreatorForTenant,
  getCreatorProgramSettings,
  listCreatorCodes,
  pickCommissionSlab,
} from "../lib/creatorProgram";
import {
  countCreatorCommissions,
  getCreatorEarnings,
  listCreatorCommissions,
  type CommissionState,
} from "../lib/creatorCommissions";

/**
 * Promoter-facing routes.
 *
 * A promoter is an ordinary KOKAO tenant who has been approved to promote, so
 * every route here is a normal authenticated tenant route — the session gives
 * the workspace, `getCreatorForTenant` gives the promoter account. There is no
 * separate promoter login.
 *
 * NOTE ON VALIDATION: these schemas are declared locally so the router compiles
 * before the OpenAPI contract is updated. Once the paths are added to
 * lib/api-spec/openapi.yaml and `pnpm --filter @workspace/api-spec run codegen`
 * has run, replace them with the generated bodies from @workspace/api-zod, the
 * way routes/gamification.ts imports ClaimGamificationRewardBody.
 */

const router: IRouter = Router();

const ApplyBody = z.object({
  displayName: z.string().trim().min(2).max(120),
  contactEmail: z.string().trim().email().max(200).optional(),
  phone: z.string().trim().max(32).nullish(),
  vertical: z.string().trim().max(64).nullish(),
  isRegisteredPractitioner: z.boolean().optional(),
  agreementAccepted: z.literal(true),
  channels: z
    .array(
      z.object({
        platform: z.string().trim().min(1).max(40),
        handle: z.string().trim().min(1).max(120),
        url: z.string().trim().url().max(500).optional(),
        followers: z.number().int().nonnegative().max(1_000_000_000).optional(),
      }),
    )
    .max(10)
    .optional(),
});

const AttachCodeBody = z.object({
  code: z.string().trim().min(3).max(64),
});

const CommissionQuery = z.object({
  state: z
    .enum([
      "pending",
      "payable",
      "held",
      "in_payout",
      "paid",
      "reversed",
      "expired",
    ])
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const paise = (n: number) => n / 100;

/**
 * The promoter's own state. 404 is meaningful: it is how the web app knows to
 * show the "Become a promoter" entry point rather than a dashboard.
 */
router.get("/promoter/me", async (req: Request, res: Response) => {
  const creator = await getCreatorForTenant(req.tenantId);
  if (!creator) {
    res.status(404).json({ error: "Not a promoter", code: "not_a_promoter" });
    return;
  }

  const settings = await getCreatorProgramSettings();
  const [codes, earnings, qualifying] = await Promise.all([
    listCreatorCodes(creator.id),
    getCreatorEarnings(creator.id),
    countCreatorCommissions(creator.id),
  ]);

  const slabs = commissionSlabsFrom(settings);
  const { slab, index } = pickCommissionSlab(slabs, qualifying);
  const next = slabs[index + 1] ?? null;

  res.json({
    status: creator.status,
    displayName: creator.displayName,
    contactEmail: creator.contactEmail,
    vertical: creator.vertical,
    isRegisteredPractitioner: creator.isRegisteredPractitioner,
    appliedAt: creator.appliedAt,
    reviewedAt: creator.reviewedAt,
    statusReason: creator.statusReason,
    // Only an approved promoter has live codes.
    codes:
      creator.status === "approved"
        ? codes
            .filter((c) => c.active)
            .map((c) => ({
              code: c.code,
              label: c.label,
              reusePolicy: c.reusePolicy,
              redemptionCount: c.redemptionCount,
              maxRedemptions: c.maxRedemptions,
              expiresAt: c.expiresAt,
            }))
        : [],
    commission: {
      currentBps: creator.commissionOverrideBps ?? slab.commissionBps,
      isNegotiatedRate: creator.commissionOverrideBps !== null,
      slabIndex: index,
      qualifyingPurchases: qualifying,
      nextSlabAt: next ? next.minReferrals : null,
      nextSlabBps: next ? next.commissionBps : null,
    },
    earnings: {
      pending: paise(earnings.pendingPaise),
      held: paise(earnings.heldPaise),
      payable: paise(earnings.payablePaise),
      paid: paise(earnings.paidPaise),
      reversed: paise(earnings.reversedPaise),
      grossDriven: paise(earnings.grossDrivenPaise),
      totalPurchases: earnings.totalPurchases,
      // The "why is my money pending" explainer. Show this — promoters
      // tolerate delay they can see and churn from delay they can't.
      awaitingActivation: earnings.awaitingActivation,
      inHoldWindow: earnings.inHoldWindow,
    },
    terms: {
      holdDays: settings.holdDays,
      consumptionThresholdBps: settings.consumptionThresholdBps,
      minPayout: paise(settings.minPayoutPaise),
      payoutCadence: settings.payoutCadence,
      earningExpiryDays: settings.earningExpiryDays,
      buyerBonusBps: settings.buyerBonusBps,
    },
  });
});

/** Apply to become a promoter. The session is the applicant. */
router.post("/promoter/apply", async (req: Request, res: Response) => {
  const parsed = ApplyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  try {
    const { creator, code } = await applyAsCreator({
      tenantId: req.tenantId,
      ...parsed.data,
    });
    res.status(201).json({
      status: creator.status,
      code: code?.code ?? null,
      message:
        creator.status === "approved"
          ? "You're in. Your promoter code is ready to share."
          : "Application received. We'll review it shortly.",
    });
  } catch (error) {
    if (error instanceof CreatorProgramError) {
      const status =
        error.code === "duplicate_application"
          ? 409
          : error.code === "program_disabled"
            ? 403
            : error.code === "not_found"
              ? 404
              : 400;
      res.status(status).json({ error: error.message, code: error.code });
      return;
    }
    req.log.error({ err: error }, "Promoter application failed");
    res
      .status(500)
      .json({ error: "Could not submit the application. Please try again." });
  }
});

/** The promoter's commission rows, newest first. */
router.get("/promoter/commissions", async (req: Request, res: Response) => {
  const creator = await getCreatorForTenant(req.tenantId);
  if (!creator) {
    res.status(404).json({ error: "Not a promoter", code: "not_a_promoter" });
    return;
  }
  const parsed = CommissionQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid query" });
    return;
  }
  const rows = await listCreatorCommissions(
    creator.id,
    parsed.data.state ? [parsed.data.state as CommissionState] : undefined,
    parsed.data.limit ?? 100,
  );
  res.json(
    rows.map((r) => ({
      id: r.id,
      // Referred workspaces are masked — a promoter never sees who their
      // referrals are. Protects the customer and removes a data-leak surface.
      workspace: `Workspace #${r.tenantId}`,
      purchasedOn: r.createdAt,
      gross: paise(r.grossPaise),
      commission: paise(r.commissionPaise),
      commissionBps: r.commissionBps,
      state: r.state,
      holdUntil: r.holdUntil,
      consumptionBps: r.consumptionBps,
      maturedAt: r.maturedAt,
      // Risk detail is deliberately NOT exposed — a held row reads as "under
      // review", never as a description of which check tripped.
      reason:
        r.state === "held"
          ? "Under review"
          : r.state === "reversed"
            ? "Reversed — the purchase was refunded"
            : null,
    })),
  );
});

/**
 * Apply a promoter code to this workspace. Grants nothing now — the bonus
 * credits arrive with the next credit purchase.
 */
router.post("/credits/creator-code", async (req: Request, res: Response) => {
  const parsed = AttachCodeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const result = await attachCreatorCode(req.tenantId, parsed.data.code);
  if (!result.ok) {
    const status =
      result.reason === "already_attributed"
        ? 409
        : result.reason === "program_disabled"
          ? 403
          : 400;
    res.status(status).json({ error: result.message, code: result.reason });
    return;
  }
  const settings = await getCreatorProgramSettings();
  res.json({
    ok: true,
    code: result.code.code,
    promoter: result.creator.displayName,
    bonusBps: settings.buyerBonusBps,
    message: `Code applied. You'll get ${settings.buyerBonusBps / 100}% bonus credits on your next credit purchase.`,
  });
});

export default router;
