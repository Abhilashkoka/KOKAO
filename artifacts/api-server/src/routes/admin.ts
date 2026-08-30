import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  tenantsTable,
  contentItemsTable,
  brandKitsTable,
  scheduledPostsTable,
  connectedAccountsTable,
  usageEventsTable,
  campaignsTable,
  adminAuditLogsTable,
  sweepStatusTable,
  subscriptionsTable,
  walletBalancesTable,
  creditBalancesTable,
} from "@workspace/db";
import {
  getWalletConfig,
  setWalletConfig,
  getWalletBalancePaise,
  adminAdjustWallet,
  listPendingPricedModels,
  listVideoWalletReconciliationReport,
  listWalletSettlementRetries,
  reconcilePendingModel,
  trueUpModel,
} from "../lib/wallet";
import { eq, sql, desc, gte, lt, lte, and, or, ilike, inArray, isNotNull } from "drizzle-orm";
import { requireSuperadmin } from "../middlewares/requireSuperadmin";
import {
  syncActivatedModelPricing,
  syncModelPricingBestEffort,
  missingPricingError,
  crossSourcePricingWarning,
} from "../lib/modelPricingSync";
import {
  recordAdminAction,
  sweepAbandonedEmailTestSends,
} from "../lib/adminAudit";
import {
  ASR_PROVIDERS,
  getProviderDef,
  isProviderConfigured,
  getSelectedAsrProviderId,
  setSelectedAsrProviderId,
  getAsrKeySource,
  setStoredAsrKey,
  clearStoredAsrKey,
} from "../lib/asr";
import {
  VOICE_CLONE_PROVIDERS,
  getVoiceCloneProviderDef,
  getSelectedVoiceCloneProviderId,
  setSelectedVoiceCloneProviderId,
  setStoredVoiceCloneKey,
  clearStoredVoiceCloneKey,
  resolveVoiceCloneApiKey,
  isVoiceCloneProviderConfigured,
  getVoiceCloneKeySource,
} from "../lib/voiceClone";
import {
  SARVAM_PROVIDER_ID,
  SARVAM_ENV_KEY,
  setStoredSarvamKey,
  clearStoredSarvamKey,
  getSarvamKeySource,
  resolveSarvamCredentialSnapshot,
  isSarvamConfigured,
  testSarvamKey,
  getSarvamTestStatus,
  persistSarvamTestStatusForCredential,
} from "../lib/sarvamTts";
import {
  IMAGE_GEN_PROVIDERS,
  IMAGE_GEN_AUTO,
  getImageGenProviderDef,
  isImageGenProviderConfigured,
  getImageGenSelection,
  setImageGenSelection,
  getImageGenKeySource,
  setStoredImageGenKey,
  clearStoredImageGenKey,
  rankImageGenProviders,
  resolveImageGenProviderDef,
  customImageGenDef,
} from "../lib/imageGen";
import {
  VIDEO_GEN_PROVIDERS,
  getVideoGenProviderDef,
  isVideoGenProviderConfigured,
  getVideoGenSelection,
  setVideoGenSelection,
  getVideoGenKeySource,
  setStoredVideoGenKey,
  clearStoredVideoGenKey,
  resolveVideoGenProviderDef,
  availableVideoModels,
} from "../lib/videoGen";
import {
  VIDEO_MODEL_CATALOG,
  TIER_UNIT_MULTIPLIER,
  isVideoModelId,
} from "../lib/videoGen/modelCatalog";
import {
  listReplicateVideoPricingTargets,
  syncReplicateVideoPricing,
} from "../lib/replicateVideoPricing";
import { buildProviderHealthReport } from "../lib/providerHealthReport";
import { buildAdminAiFallbackReport } from "../lib/adminAiFallbacks";
import {
  STOCK_SOURCES,
  getStockSourceDef,
  isStockSourceConfigured,
  getStockKeySource,
  setStoredStockKey,
  clearStoredStockKey,
} from "../lib/videoGen/topicVideo";
import {
  TEXT_GEN_PROVIDERS,
  getTextGenSelection,
  setTextGenSelection,
  getOpenRouterKeySource,
  getReplicateTextKeySource,
  setStoredOpenRouterKey,
  clearStoredOpenRouterKey,
  isBatchOnlyTextModel,
  type TextGenProvider,
} from "../lib/textGen";
import {
  listCustomAiProviders,
  getCustomAiProvider,
  createCustomAiProvider,
  updateCustomAiProvider,
  deleteCustomAiProvider,
  customProviderView,
  customProviderRef,
  parseCustomProviderId,
  resolveCustomProvider,
  validateCustomBaseUrl,
  validateVideoApiMapping,
} from "../lib/customAiProviders";
import { testCustomAiProvider } from "../lib/customAiProviderTest";
import { lookupOpenRouterPricing } from "../lib/openrouterCatalog";
import {
  formatPriceEntries,
  lookupReplicateTokenPricing,
  lookupReplicateUnitPricing,
} from "../lib/replicateCatalog";
import {
  parseOfficialModelPriceUrl,
  previewModelPriceImport,
  type ModelPriceKind,
} from "../lib/modelPriceUrlImport";
import {
  AdminUpdateTenantPlanBody,
  AdminUpdateTenantSuperadminBody,
  AdminUpdateTenantDesignSkillBody,
  AdminUpdateDesignSkillBody,
  AdminUpdateFeatureFlagBody,
  AdminUpdateAsrSettingsBody,
  AdminSetAsrProviderKeyBody,
  AdminUpdateVoiceCloneSettingsBody,
  AdminSetVoiceCloneProviderKeyBody,
  AdminSetSarvamTtsKeyBody,
  AdminUpdateImageGenSettingsBody,
  AdminSetImageGenProviderKeyBody,
  AdminUpdateVideoGenSettingsBody,
  AdminSetVideoGenProviderKeyBody,
  AdminUpdateGamificationPlanBody,
  AdminUpdateTextGenSettingsBody,
  AdminCreateCustomAiProviderBody,
  AdminUpdateCustomAiProviderBody,
  AdminSetTextGenKeyBody,
  AdminUpdateAiSpendSettingsBody,
  AdminUpdateAiCostRateBody,
  AdminUpdateAiCostMarkupBody,
  AdminUpdateElevenLabsCreditRateBody,
  AdminUpsertAiModelPriceBody,
  AdminPreviewAiModelPriceImportBody,
  AdminPreviewAiModelPriceImportResponse,
  AdminConfirmAiModelPriceImportBody,
  AdminUpdateNotificationPoliciesBody,
  AdminUpdatePlanBody,
  AdminCreatePlanBody,
  AdminDecideSeatRequestBody,
  AdminCreateCreditPackBody,
  AdminUpdateCreditPackBody,
  AdminGrantCreditsBody,
  AdminCreatePromoCodesBody,
  AdminUpdatePromoCodeBody,
  AdminUpdateSignupCreditSettingsBody,
  AdminUpdateWalletSettingsBody,
  AdminUpdateTenantBillingModeBody,
  AdminAdjustTenantWalletBody,
  AdminReconcileWalletPendingPricesBody,
  AdminResolveSupportRequestBody,
  AdminSetNvidiaHostedKeyBody,
  AdminSetNvidiaDeploymentBody,
} from "@workspace/api-zod";
import {
  NVIDIA_CAPABILITIES,
  clearNvidiaDeployment,
  clearNvidiaHostedKey,
  discoverNvidiaModels,
  getNvidiaAdminSettings,
  getNvidiaHostedKeySource,
  setNvidiaDeployment,
  setNvidiaHostedKey,
  testNvidiaDeployment,
  testNvidiaHosted,
  validateNvidiaTextActivation,
  type NvidiaCapability,
} from "../lib/nvidiaAdmin";
import { isNvidiaCoreDeploymentActivatable } from "../lib/nvidiaCore";
import {
  notificationPoliciesTable,
  planSettingsTable,
  seatRequestsTable,
  supportRequestsTable,
} from "@workspace/db";
import {
  notifySeatRequestDecided,
  notifySupportRequestResolved,
  resolveFxRateStaleNotifications,
  resolveSeatRequestSubmittedNotifications,
} from "../lib/notifications";
import { serializeSupportRequest } from "./support";
import {
  serializeSeatRequest,
  getEffectiveSeatLimit,
  getSeatsUsed,
} from "../lib/team";
import {
  creditPacksTable,
  promoCodesTable,
  gamificationPlanSettingsTable,
  type PromoCode,
} from "@workspace/db";
import {
  DEFAULT_PLAN_GAMIFICATION,
  rowToPlanGamification,
} from "../lib/gamification";
import { grantCredits, getCreditBalances } from "../lib/credits";
import {
  normalizePromoCode,
  generatePromoCode,
  getPromoMetrics,
  listPromoFailures,
} from "../lib/promoCodes";
import { isRazorpayConfigured, createRazorpayPlan } from "../lib/razorpay";
import { isCashfreeConfigured, createCashfreePlan } from "../lib/cashfree";
import { getActiveGateway } from "../lib/paymentGateway";
import {
  DEFAULT_PLAN_IDS,
  FALLBACK_PLAN_ID,
  listPlans,
  invalidatePlanCache,
  applyPlanBillingMode,
} from "../lib/plans";
import { isSuperadminEmail } from "../lib/superadmins";
import {
  getGlobalDesignSkillEnabled,
  loadDesignSkillRow,
} from "../lib/designSkill";
import { getAiSpendConfig, setAiSpendConfig, getAiSpendRates } from "../lib/aiSpend";
import {
  getSignupCreditSettings,
  updateSignupCreditSettings,
} from "../lib/signupCredits";
import {
  getAiCostConfig,
  setAiCostConfig,
  setAiCostMarkup,
  setElevenLabsCreditRate,
  refreshUsdInrRate,
  listModelPrices,
  upsertModelPrice,
  deleteModelPrice,
  dedupeModelPrices,
  countDuplicateModelPriceGroups,
  duplicateModelPriceKeys,
  modelPriceGroupKey,
  isImageModelPriced,
  isVideoModelPriced,
} from "../lib/aiCost";
import {
  FEATURES,
  getFeatureFlags,
  isKnownFeature,
  invalidateFeatureFlagCache,
  requireFeature,
} from "../lib/featureFlags";
import { featureFlagsTable } from "@workspace/db";
import { designSkillSettingsTable } from "@workspace/db";
import { fetchVerifiedEmail } from "../lib/clerkUser";
import { currentPeriodStart } from "../lib/usage";
import {
  triggerSweepNow,
  checkSweepStaleness,
  isSweepRunning,
  SWEEP_FAIL_RATIO_ALERT_THRESHOLD,
} from "../lib/connectionSweep";
import {
  NOTIFICATION_TYPES,
  NOTIFICATION_TYPE_SET,
} from "../lib/notificationCatalog";
import { defaultPolicy, getPolicyMap } from "../lib/notificationSettings";
import type { Tenant } from "@workspace/db";

const router: IRouter = Router();

// Every admin route requires superadmin privileges.
router.use("/admin", requireSuperadmin);

// Actual-cost tracking has its own platform kill switch: when it is off the
// cost admin endpoints 403 like any other gated module. The feature-flag
// toggle route itself stays reachable so the switch can be re-enabled.
router.use("/admin/ai-cost", requireFeature("aiCostTracking"));

router.param("id", (req, res, next, value) => {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  next();
});

/**
 * User-facing message when a payment gateway rejects a plan mint. Surfaces
 * the gateway's own reason (e.g. Cashfree's "Profile is inactive.") so the
 * admin isn't told to check API keys when the account itself is the problem.
 */
function gatewayPlanError(gateway: "Cashfree" | "Razorpay", error: unknown): string {
  const reason =
    error instanceof Error && error.message.trim() ? error.message.trim() : null;
  return reason
    ? `${gateway} rejected the plan: ${reason}`
    : `${gateway} rejected the plan price. Check the API keys and try again.`;
}

function serializeAdminTenant(t: Tenant, walletBalancePaise = 0) {
  const isAllowlisted = isSuperadminEmail(t.email);
  return {
    id: t.id,
    email: t.email ?? null,
    name: t.name,
    plan: t.plan,
    aiModel: t.aiModel,
    // Effective: granted in-app OR allowlisted by email.
    isSuperadmin: t.isSuperadmin || isAllowlisted,
    isAllowlisted,
    designSkillEnabled: t.designSkillEnabled ?? null,
    // Wallet billing: which rail funds this workspace, and what it holds.
    // Only consulted while the platform `wallet` switch is on.
    billingMode: t.billingMode === "wallet" ? "wallet" : "quota",
    walletBalancePaise,
    createdAt: t.createdAt.toISOString(),
  };
}

/** Wallet balance per tenant, for the admin tenants table. */
async function walletBalancesByTenant(): Promise<Map<number, number>> {
  const rows = await db.select().from(walletBalancesTable);
  return new Map(rows.map((r) => [r.tenantId, r.balancePaise]));
}

/** Prepaid credit balances per tenant, for the admin tenants table Credits column. */
async function creditBalancesByTenant(): Promise<
  Map<number, { captionCredits: number; imageCredits: number; videoCredits: number }>
> {
  const rows = await db.select().from(creditBalancesTable);
  return new Map(
    rows.map((r) => [
      r.tenantId,
      {
        captionCredits: r.captionCredits ?? 0,
        imageCredits: r.imageCredits ?? 0,
        videoCredits: r.videoCredits ?? 0,
      },
    ]),
  );
}

async function countByTenant(
  table:
    | typeof contentItemsTable
    | typeof brandKitsTable
    | typeof scheduledPostsTable
    | typeof connectedAccountsTable,
): Promise<Map<number, number>> {
  const rows = await db
    .select({
      tenantId: table.tenantId,
      count: sql<number>`count(*)::int`,
    })
    .from(table)
    .groupBy(table.tenantId);
  return new Map(rows.map((r) => [r.tenantId, r.count]));
}

/**
 * GET /admin/tenants
 * List every tenant in the platform with usage and resource counts.
 */
router.get("/admin/tenants", async (_req: Request, res: Response) => {
  const periodStart = currentPeriodStart();

  const [
    tenants,
    contentCounts,
    brandKitCounts,
    scheduleCounts,
    accountCounts,
    usageRows,
    walletBalances,
    creditBalances,
  ] = await Promise.all([
    db.select().from(tenantsTable).orderBy(desc(tenantsTable.createdAt)),
    countByTenant(contentItemsTable),
    countByTenant(brandKitsTable),
    countByTenant(scheduledPostsTable),
    countByTenant(connectedAccountsTable),
    db
      .select({
        tenantId: usageEventsTable.tenantId,
        kind: usageEventsTable.kind,
        count: sql<number>`count(*)::int`,
      })
      .from(usageEventsTable)
      .where(gte(usageEventsTable.createdAt, periodStart))
      .groupBy(usageEventsTable.tenantId, usageEventsTable.kind),
    walletBalancesByTenant(),
    creditBalancesByTenant(),
  ]);

  const captionUsage = new Map<number, number>();
  const imageUsage = new Map<number, number>();
  for (const row of usageRows) {
    if (row.kind === "caption") captionUsage.set(row.tenantId, row.count);
    else if (row.kind === "image") imageUsage.set(row.tenantId, row.count);
  }

  res.json(
    tenants.map((t) => ({
      ...serializeAdminTenant(t, walletBalances.get(t.id) ?? 0),
      counts: {
        content: contentCounts.get(t.id) ?? 0,
        brandKits: brandKitCounts.get(t.id) ?? 0,
        scheduledPosts: scheduleCounts.get(t.id) ?? 0,
        connectedAccounts: accountCounts.get(t.id) ?? 0,
      },
      usage: {
        captions: captionUsage.get(t.id) ?? 0,
        images: imageUsage.get(t.id) ?? 0,
        periodStart: periodStart.toISOString(),
      },
      credits: creditBalances.get(t.id) ?? {
        captionCredits: 0,
        imageCredits: 0,
        videoCredits: 0,
      },
    })),
  );
});

/**
 * GET /admin/stats
 * Platform-wide aggregate stats.
 */
router.get("/admin/stats", async (_req: Request, res: Response) => {
  // Piggyback the sweep-staleness watchdog on admin traffic (self-throttled,
  // fire-and-forget) so a stalled sweep is reported even if this process's
  // background timers were never started or died.
  void checkSweepStaleness();
  const [tenantRows, contentRow, scheduleRow, accountRow, sweepRow] = await Promise.all([
    db
      .select({ plan: tenantsTable.plan, count: sql<number>`count(*)::int` })
      .from(tenantsTable)
      .groupBy(tenantsTable.plan),
    db.select({ count: sql<number>`count(*)::int` }).from(contentItemsTable),
    db.select({ count: sql<number>`count(*)::int` }).from(scheduledPostsTable),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(connectedAccountsTable),
    db
      .select()
      .from(sweepStatusTable)
      .where(eq(sweepStatusTable.id, 1))
      .limit(1),
  ]);

  // Include every catalog plan (even those with zero tenants) plus any plan
  // ids still referenced by tenants but no longer in the catalog.
  const byPlan: Record<string, number> = {};
  for (const p of await listPlans()) byPlan[p.id] = 0;
  let totalTenants = 0;
  for (const row of tenantRows) {
    byPlan[row.plan] = (byPlan[row.plan] ?? 0) + row.count;
    totalTenants += row.count;
  }

  // Resolve workspace names for the sweep's recent offenders so the admin
  // card can show "which tenant" without a second lookup. Best-effort: a
  // deleted tenant just falls back to its numeric id.
  const recentFailures = sweepRow[0]?.recentFailures ?? [];
  const failureTenantIds = [...new Set(recentFailures.map((f) => f.tenantId))];
  const nameById = new Map<number, string | null>();
  if (failureTenantIds.length > 0) {
    const nameRows = await db
      .select({ id: tenantsTable.id, name: tenantsTable.name })
      .from(tenantsTable)
      .where(inArray(tenantsTable.id, failureTenantIds));
    for (const r of nameRows) nameById.set(r.id, r.name);
  }

  res.json({
    totalTenants,
    tenantsByPlan: byPlan,
    totalContent: contentRow[0]?.count ?? 0,
    totalScheduledPosts: scheduleRow[0]?.count ?? 0,
    totalConnectedAccounts: accountRow[0]?.count ?? 0,
    sweepRunning: isSweepRunning(),
    connectionSweep: sweepRow[0]
      ? {
          lastRunAt: sweepRow[0].lastRunAt.toISOString(),
          durationMs: sweepRow[0].durationMs,
          accountsChecked: sweepRow[0].accountsChecked,
          errorCount: sweepRow[0].errorCount,
          failRatioAlertThreshold: SWEEP_FAIL_RATIO_ALERT_THRESHOLD,
          lastError: sweepRow[0].lastError,
          // Rows persisted before dropped-streak tracking lack the column
          // default in old JSON reads; coalesce to 0 (no trimming known).
          droppedStreaks: sweepRow[0].droppedStreaks ?? 0,
          recentFailures: recentFailures.map((f) => ({
            tenantId: f.tenantId,
            tenantName: nameById.get(f.tenantId) ?? null,
            platform: f.platform,
            error: f.error,
            at: f.at,
            // Rows persisted before streak tracking lack the field; a lone
            // failure is by definition a streak of 1.
            consecutiveFailures: f.consecutiveFailures ?? 1,
            // Rows persisted before firstFailedAt tracking fall back to the
            // failure's own timestamp (a streak of 1 started when it failed).
            firstFailedAt: f.firstFailedAt ?? f.at,
          })),
        }
      : null,
  });
});

/**
 * POST /admin/sweep/run
 * Kick off a connection sweep immediately (admin "Run now"). The sweep runs
 * in the background — this responds as soon as it is started, so a sweep
 * that takes minutes never leaves the request (or the admin UI) hanging.
 * Respects the in-process overlap guard: if a sweep is already in flight the
 * request is a no-op and returns started=false. The dashboard polls
 * /admin/stats (which reports sweepRunning) until the run completes.
 */
router.post("/admin/sweep/run", async (req: Request, res: Response) => {
  const started = triggerSweepNow();
  try {
    await recordAdminAction({
      action: "sweep_run",
      actorTenantId: req.tenantId,
      actorEmail: req.tenantEmail,
      targetTenantId: null,
      targetEmail: null,
      oldValue: null,
      newValue: JSON.stringify({ started }),
    });
  } catch (error) {
    req.log.error({ err: error }, "Failed to write sweep-run audit log");
  }
  res.json({ started });
});

/**
 * PATCH /admin/tenants/:id
 * Superadmin override of a tenant's subscription plan.
 */
router.patch("/admin/tenants/:id", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const parsed = AdminUpdateTenantPlanBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }

  // Plans are dynamic; validate against the live catalog rather than an enum.
  const catalog = await listPlans();
  if (!catalog.some((p) => p.id === parsed.data.plan)) {
    res.status(400).json({ error: "Unknown plan" });
    return;
  }

  const previous = (
    await db.select().from(tenantsTable).where(eq(tenantsTable.id, id))
  )[0];

  if (!previous) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  // Overriding a tenant who is actively PAYING for a subscription is easy to
  // do by accident — require an explicit confirmation flag so the admin UI
  // can warn first. The override wins once confirmed: planOverriddenAt stops
  // Razorpay webhooks from syncing the plan back.
  if (parsed.data.plan !== previous.plan) {
    const activeSub = (
      await db
        .select()
        .from(subscriptionsTable)
        .where(
          and(
            eq(subscriptionsTable.tenantId, id),
            inArray(subscriptionsTable.status, ["active", "authenticated"]),
          ),
        )
        .limit(1)
    )[0];
    if (activeSub && parsed.data.confirmActiveSubscription !== true) {
      res.status(409).json({
        error:
          "This tenant has an active paid subscription. Overriding the plan will not cancel or refund it, and renewals will no longer change the plan. Confirm to override anyway.",
      });
      return;
    }
  }

  const updated = (
    await db
      .update(tenantsTable)
      .set({
        plan: parsed.data.plan,
        planOverriddenAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(tenantsTable.id, id))
      .returning()
  )[0];
  if (updated) await applyPlanBillingMode(id, parsed.data.plan);

  if (!updated) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  if (previous.plan !== updated.plan) {
    try {
      await recordAdminAction({
        action: "plan_change",
        actorTenantId: req.tenantId,
        actorEmail: req.tenantEmail,
        targetTenantId: updated.id,
        targetEmail: updated.email ?? null,
        oldValue: previous.plan,
        newValue: updated.plan,
      });
    } catch (error) {
      req.log.error({ err: error }, "Failed to write plan-change audit log");
    }
  }

  res.json(
    serializeAdminTenant(updated, await getWalletBalancePaise(updated.id)),
  );
});

/**
 * PATCH /admin/tenants/:id/superadmin
 * Grant or revoke the in-app superadmin role for a tenant.
 *
 * Authorization: restricted to allowlisted (root) OWNERS — a merely granted
 * superadmin must not be able to mint or remove other superadmins. The actor's
 * LIVE verified Clerk email is resolved here so a stale cached flag can never
 * authorize role management; it fails closed.
 *
 * Allowlisted owners are permanent: their access derives from the email
 * allowlist, not this flag, so writes against an allowlisted target (including
 * self) are rejected to keep the DB state semantically clean and to prevent
 * self-lockout.
 */
router.patch(
  "/admin/tenants/:id/superadmin",
  async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const parsed = AdminUpdateTenantSuperadminBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }

    const actorEmail = await fetchVerifiedEmail(req.clerkUserId);
    if (!isSuperadminEmail(actorEmail)) {
      res
        .status(403)
        .json({ error: "Only owners can change superadmin roles" });
      return;
    }

    const target = (
      await db.select().from(tenantsTable).where(eq(tenantsTable.id, id))
    )[0];
    if (!target) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    if (isSuperadminEmail(target.email)) {
      res.status(400).json({ error: "Allowlisted owners cannot be modified" });
      return;
    }

    const updated = (
      await db
        .update(tenantsTable)
        .set({ isSuperadmin: parsed.data.isSuperadmin, updatedAt: new Date() })
        .where(eq(tenantsTable.id, id))
        .returning()
    )[0];

    if (!updated) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    if (target.isSuperadmin !== updated.isSuperadmin) {
      try {
        await recordAdminAction({
          action: updated.isSuperadmin
            ? "superadmin_grant"
            : "superadmin_revoke",
          actorTenantId: req.tenantId,
          actorEmail: actorEmail ?? req.tenantEmail,
          targetTenantId: updated.id,
          targetEmail: updated.email ?? null,
          oldValue: String(target.isSuperadmin),
          newValue: String(updated.isSuperadmin),
        });
      } catch (error) {
        req.log.error(
          { err: error },
          "Failed to write superadmin-change audit log",
        );
      }
    }

    res.json(
    serializeAdminTenant(updated, await getWalletBalancePaise(updated.id)),
  );
  },
);

/**
 * PATCH /admin/tenants/:id/design-skill
 * Set (true/false) or clear (null) a tenant's design-skill override.
 */
router.patch(
  "/admin/tenants/:id/design-skill",
  async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const parsed = AdminUpdateTenantDesignSkillBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }

    const previous = (
      await db.select().from(tenantsTable).where(eq(tenantsTable.id, id))
    )[0];
    if (!previous) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const updated = (
      await db
        .update(tenantsTable)
        .set({ designSkillEnabled: parsed.data.enabled, updatedAt: new Date() })
        .where(eq(tenantsTable.id, id))
        .returning()
    )[0];
    if (!updated) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    if (previous.designSkillEnabled !== updated.designSkillEnabled) {
      try {
        await recordAdminAction({
          action: "design_skill_change",
          actorTenantId: req.tenantId,
          actorEmail: req.tenantEmail,
          targetTenantId: updated.id,
          targetEmail: updated.email ?? null,
          oldValue: String(previous.designSkillEnabled),
          newValue: String(updated.designSkillEnabled),
        });
      } catch (error) {
        req.log.error({ err: error }, "Failed to write design-skill audit log");
      }
    }

    res.json(
    serializeAdminTenant(updated, await getWalletBalancePaise(updated.id)),
  );
  },
);

/** Serialize the ASR settings view (selected provider + catalog). */
async function serializeAsrSettings() {
  const provider = await getSelectedAsrProviderId();
  return {
    provider,
    providers: await Promise.all(
      ASR_PROVIDERS.map(async (p) => ({
        id: p.id,
        label: p.label,
        model: p.model,
        configured: await isProviderConfigured(p),
        envKey: p.envKey,
        keySource: await getAsrKeySource(p),
      })),
    ),
  };
}

/**
 * GET /admin/asr-settings
 * The platform-wide speech-to-text provider selection.
 */
router.get("/admin/asr-settings", async (_req: Request, res: Response) => {
  res.json(await serializeAsrSettings());
});

/**
 * PUT /admin/asr-settings
 * Select which speech-to-text provider /ai/transcribe uses.
 */
router.put("/admin/asr-settings", async (req: Request, res: Response) => {
  const parsed = AdminUpdateAsrSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const def = getProviderDef(parsed.data.provider);
  if (!def) {
    res.status(400).json({ error: "Unknown speech-to-text provider" });
    return;
  }
  // NVIDIA ASR is a self-hosted Speech NIM and, unlike key-based ASR
  // providers, must be explicitly enabled, successfully tested, and confirmed
  // as zero external cost before it can receive global traffic. Never persist
  // an unusable global selection merely because the provider id is valid.
  if (
    def.id === "nvidia" &&
    !(await isNvidiaCoreDeploymentActivatable("asr"))
  ) {
    res.status(400).json({
      error:
        "NVIDIA ASR requires an enabled self-hosted Speech NIM deployment that has passed its connection test and has an explicit USD 0 external provider cost confirmation.",
    });
    return;
  }

  const before = await getSelectedAsrProviderId();
  await setSelectedAsrProviderId(def.id);

  if (before !== def.id) {
    try {
      await recordAdminAction({
        action: "asr_provider_change",
        actorTenantId: req.tenantId,
        actorEmail: req.tenantEmail,
        targetTenantId: null,
        targetEmail: null,
        oldValue: before,
        newValue: def.id,
      });
    } catch (error) {
      req.log.error({ err: error }, "Failed to write ASR settings audit log");
    }
  }

  res.json(await serializeAsrSettings());
});

/**
 * PUT /admin/asr-providers/:providerId/key
 * Save a provider's API key (encrypted at rest). Superadmin only.
 */
router.put("/admin/asr-providers/:providerId/key", async (req: Request, res: Response) => {
  const def = getProviderDef(req.params.providerId as string);
  if (!def) {
    res.status(404).json({ error: "Unknown speech-to-text provider" });
    return;
  }
  if (def.envKey === null) {
    res.status(400).json({ error: "This provider is built in and does not take an API key" });
    return;
  }
  const parsed = AdminSetAsrProviderKeyBody.safeParse(req.body);
  const apiKey = parsed.success ? parsed.data.apiKey.trim() : "";
  if (!apiKey) {
    res.status(400).json({ error: "API key is required" });
    return;
  }
  await setStoredAsrKey(def.id, apiKey);
  try {
    await recordAdminAction({
      action: "asr_key_change",
      actorTenantId: req.tenantId,
      actorEmail: req.tenantEmail,
      targetTenantId: null,
      targetEmail: null,
      oldValue: null,
      newValue: `${def.id}:set`,
    });
  } catch (error) {
    req.log.error({ err: error }, "Failed to write ASR key audit log");
  }
  res.json(await serializeAsrSettings());
});

/**
 * DELETE /admin/asr-providers/:providerId/key
 * Remove the saved API key (the env secret, if set, becomes the fallback).
 */
router.delete("/admin/asr-providers/:providerId/key", async (req: Request, res: Response) => {
  const def = getProviderDef(req.params.providerId as string);
  if (!def) {
    res.status(404).json({ error: "Unknown speech-to-text provider" });
    return;
  }
  await clearStoredAsrKey(def.id);
  try {
    await recordAdminAction({
      action: "asr_key_change",
      actorTenantId: req.tenantId,
      actorEmail: req.tenantEmail,
      targetTenantId: null,
      targetEmail: null,
      oldValue: null,
      newValue: `${def.id}:cleared`,
    });
  } catch (error) {
    req.log.error({ err: error }, "Failed to write ASR key audit log");
  }
  res.json(await serializeAsrSettings());
});

/** Serialize the voice-cloning settings view (selected provider + catalog). */
async function serializeVoiceCloneSettings() {
  const provider = await getSelectedVoiceCloneProviderId();
  return {
    provider,
    providers: await Promise.all(
      VOICE_CLONE_PROVIDERS.map(async (p) => ({
        id: p.id,
        label: p.label,
        configured: await isVoiceCloneProviderConfigured(p),
        envKey: p.envKey,
        keySource: await getVoiceCloneKeySource(p),
      })),
    ),
  };
}

/**
 * GET /admin/voice-clone-settings
 * The platform-wide voice-cloning (brand voice) provider selection.
 */
router.get("/admin/voice-clone-settings", async (_req: Request, res: Response) => {
  res.json(await serializeVoiceCloneSettings());
});

/**
 * PUT /admin/voice-clone-settings
 * Select which voice-cloning provider the Brand Voice feature uses.
 */
router.put("/admin/voice-clone-settings", async (req: Request, res: Response) => {
  const parsed = AdminUpdateVoiceCloneSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const def = getVoiceCloneProviderDef(parsed.data.provider);
  if (!def) {
    res.status(400).json({ error: "Unknown voice-cloning provider" });
    return;
  }

  const before = await getSelectedVoiceCloneProviderId();
  await setSelectedVoiceCloneProviderId(def.id);

  if (before !== def.id) {
    try {
      await recordAdminAction({
        action: "voice_clone_provider_change",
        actorTenantId: req.tenantId,
        actorEmail: req.tenantEmail,
        targetTenantId: null,
        targetEmail: null,
        oldValue: before,
        newValue: def.id,
      });
    } catch (error) {
      req.log.error({ err: error }, "Failed to write voice-clone settings audit log");
    }
  }

  res.json(await serializeVoiceCloneSettings());
});

/**
 * PUT /admin/voice-clone-providers/:providerId/key
 * Save a voice-cloning provider's API key (encrypted at rest). Superadmin only.
 */
router.put(
  "/admin/voice-clone-providers/:providerId/key",
  async (req: Request, res: Response) => {
    const def = getVoiceCloneProviderDef(req.params.providerId as string);
    if (!def) {
      res.status(404).json({ error: "Unknown voice-cloning provider" });
      return;
    }
    const parsed = AdminSetVoiceCloneProviderKeyBody.safeParse(req.body);
    const apiKey = parsed.success ? parsed.data.apiKey.trim() : "";
    if (!apiKey) {
      res.status(400).json({ error: "API key is required" });
      return;
    }
    await setStoredVoiceCloneKey(def.id, apiKey);
    try {
      await recordAdminAction({
        action: "voice_clone_key_change",
        actorTenantId: req.tenantId,
        actorEmail: req.tenantEmail,
        targetTenantId: null,
        targetEmail: null,
        oldValue: null,
        newValue: `${def.id}:set`,
      });
    } catch (error) {
      req.log.error({ err: error }, "Failed to write voice-clone key audit log");
    }
    res.json(await serializeVoiceCloneSettings());
  },
);

/**
 * DELETE /admin/voice-clone-providers/:providerId/key
 * Remove the saved API key (the env secret, if set, becomes the fallback).
 */
router.delete(
  "/admin/voice-clone-providers/:providerId/key",
  async (req: Request, res: Response) => {
    const def = getVoiceCloneProviderDef(req.params.providerId as string);
    if (!def) {
      res.status(404).json({ error: "Unknown voice-cloning provider" });
      return;
    }
    await clearStoredVoiceCloneKey(def.id);
    try {
      await recordAdminAction({
        action: "voice_clone_key_change",
        actorTenantId: req.tenantId,
        actorEmail: req.tenantEmail,
        targetTenantId: null,
        targetEmail: null,
        oldValue: null,
        newValue: `${def.id}:cleared`,
      });
    } catch (error) {
      req.log.error({ err: error }, "Failed to write voice-clone key audit log");
    }
    res.json(await serializeVoiceCloneSettings());
  },
);

/**
 * POST /admin/voice-clone-providers/:providerId/test
 * Connectivity test: a cheap authenticated call with the effective key.
 */
router.post(
  "/admin/voice-clone-providers/:providerId/test",
  async (req: Request, res: Response) => {
    const def = getVoiceCloneProviderDef(req.params.providerId as string);
    if (!def) {
      res.status(404).json({ error: "Unknown voice-cloning provider" });
      return;
    }
    const apiKey = await resolveVoiceCloneApiKey(def);
    if (!apiKey) {
      res.json({ ok: false, message: "No API key is configured for this provider." });
      return;
    }
    try {
      await def.test(apiKey);
      res.json({ ok: true, message: "The API key works." });
    } catch (error) {
      res.json({
        ok: false,
        message: error instanceof Error ? error.message : "The connectivity test failed.",
      });
    }
  },
);

/** Serialize the image generation settings view (selection + catalog). */
async function serializeImageGenSettings() {
  const selection = await getImageGenSelection();
  // The ranking the router would use RIGHT NOW, from the same function the
  // router calls. Shown whether or not auto is on, so an admin can see what
  // switching to it would pick before committing to it.
  const ranking = await rankImageGenProviders().catch(() => []);
  return {
    provider: selection.provider,
    model: selection.model,
    customBaseUrl: selection.customBaseUrl,
    autoRanking: ranking.map((r) => ({
      id: r.id,
      label: getImageGenProviderDef(r.id)?.label ?? r.id,
      score: r.score,
      reason: r.reason,
      healthy: r.healthy,
    })),
    providers: [
      ...(await Promise.all(
        IMAGE_GEN_PROVIDERS.map(async (p) => ({
          id: p.id,
          label: p.label,
          defaultModel: p.defaultModel,
          configured: await isImageGenProviderConfigured(p),
          supportsModelOverride: p.supportsModelOverride,
          requiresBaseUrl: p.requiresBaseUrl,
          modelOptions: p.modelOptions ? [...p.modelOptions] : [],
          envKey: p.envKey,
          keySource: await getImageGenKeySource(p),
        })),
      )),
      // Admin-added OpenAI-compatible providers with image use enabled show
      // up in the same dropdown; base URL and key live on their own card.
      ...(await listCustomAiProviders())
        .filter((row) => row.imageEnabled)
        .map((row) => {
          const def = customImageGenDef(row);
          return {
            id: def.id,
            label: def.label,
            defaultModel: "",
            configured: true,
            supportsModelOverride: true,
            requiresBaseUrl: false,
            modelOptions: [] as { value: string; label: string }[],
            envKey: null as string | null,
            keySource: (row.encryptedApiKey ? "database" : null) as "database" | "env" | null,
          };
        }),
    ],
  };
}

/**
 * GET /admin/image-gen-settings
 * The platform-wide image generation provider selection.
 */
router.get("/admin/image-gen-settings", async (_req: Request, res: Response) => {
  res.json(await serializeImageGenSettings());
});

/**
 * PUT /admin/image-gen-settings
 * Select which provider (and optional model override) /ai/generate-image uses.
 */
router.put("/admin/image-gen-settings", async (req: Request, res: Response) => {
  const parsed = AdminUpdateImageGenSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  // Automatic routing is a valid choice but not a catalog entry: it has no
  // model to override and no base URL to enter, so both are forced to null
  // rather than trusting the client to omit them.
  if (parsed.data.provider === IMAGE_GEN_AUTO) {
    // Auto routing can serve ANY provider's default model, so sync catalog
    // prices for all of them best-effort (no gate: builtin providers have no
    // public catalog and refusing auto until each is hand-priced would make
    // it unusable — unpriced generations record NULL cost, visibly).
    await syncModelPricingBestEffort(
      IMAGE_GEN_PROVIDERS.map((p) => ({
        kind: "image" as const,
        provider: p.id,
        model: p.defaultModel,
      })),
    );
    const before = await getImageGenSelection();
    await setImageGenSelection({ provider: IMAGE_GEN_AUTO, model: null, customBaseUrl: null });
    if (before.provider !== IMAGE_GEN_AUTO) {
      try {
        await recordAdminAction({
          action: "imagegen_provider_change",
          actorTenantId: req.tenantId,
          actorEmail: req.tenantEmail,
          targetTenantId: null,
          targetEmail: null,
          oldValue: `${before.provider}${before.model ? `:${before.model}` : ""}`,
          newValue: IMAGE_GEN_AUTO,
        });
      } catch (error) {
        req.log.error({ err: error }, "Failed to write image-gen settings audit log");
      }
    }
    res.json(await serializeImageGenSettings());
    return;
  }
  const def = await resolveImageGenProviderDef(parsed.data.provider);
  if (!def) {
    res.status(400).json({ error: "Unknown image generation provider" });
    return;
  }
  const isCustomRef = parseCustomProviderId(def.id) !== null;
  const model = parsed.data.model?.trim() || null;
  const customBaseUrl = parsed.data.customBaseUrl?.trim() || null;
  if (
    def.id === "nvidia" &&
    !(await isImageGenProviderConfigured(def))
  ) {
    res.status(400).json({
      error:
        "NVIDIA image generation requires an enabled deployment that has passed its model test and has an explicit NVIDIA provider price.",
    });
    return;
  }
  if (customBaseUrl && !/^https:\/\//i.test(customBaseUrl)) {
    res.status(400).json({ error: "The custom provider base URL must start with https://" });
    return;
  }
  if (def.requiresBaseUrl && !customBaseUrl) {
    res.status(400).json({ error: "This provider needs a base URL" });
    return;
  }
  if ((def.requiresBaseUrl || isCustomRef) && !model) {
    res.status(400).json({ error: "This provider needs a model name" });
    return;
  }

  // Activation gate: the model that will actually serve generations must
  // have a price row (live catalog when available, else a manual entry) so
  // actual-cost tracking never runs blind.
  let pricingWarning: string | null = null;
  {
    const effectiveModel = (def.supportsModelOverride && model) || def.defaultModel;
    const { missing, crossSourced } = await syncActivatedModelPricing({
      kind: "image",
      provider: def.id,
      models: [effectiveModel],
    });
    if (missing.length > 0) {
      res.status(400).json({
        error: missingPricingError(missing.map((m) => ({ model: m, kind: "image" as const }))),
      });
      return;
    }
    // NVIDIA does not publish an authoritative flat image price through the
    // catalog sync. Do not let an unrelated provider's same-model row satisfy
    // activation: this must be an explicit NVIDIA per-image price.
    if (
      def.requiresPrice &&
      !(await isImageModelPriced({ provider: def.id, model: effectiveModel }))
    ) {
      res.status(400).json({
        error: `Image model ${def.id}/${effectiveModel} needs an explicit provider price before activation.`,
      });
      return;
    }
    pricingWarning = crossSourcePricingWarning(def.id, crossSourced);
  }

  const before = await getImageGenSelection();
  await setImageGenSelection({
    provider: def.id,
    model: def.supportsModelOverride ? model : null,
    customBaseUrl,
  });

  const changed =
    before.provider !== def.id ||
    before.model !== model ||
    before.customBaseUrl !== customBaseUrl;
  if (changed) {
    try {
      await recordAdminAction({
        action: "imagegen_provider_change",
        actorTenantId: req.tenantId,
        actorEmail: req.tenantEmail,
        targetTenantId: null,
        targetEmail: null,
        oldValue: `${before.provider}${before.model ? `:${before.model}` : ""}`,
        newValue: `${def.id}${model ? `:${model}` : ""}`,
      });
    } catch (error) {
      req.log.error({ err: error }, "Failed to write image-gen settings audit log");
    }
  }

  res.json({ ...(await serializeImageGenSettings()), pricingWarning });
});

/**
 * PUT /admin/image-gen-providers/:providerId/key
 * Save a provider's API key (encrypted at rest). Superadmin only.
 */
router.put(
  "/admin/image-gen-providers/:providerId/key",
  async (req: Request, res: Response) => {
    const def = getImageGenProviderDef(req.params.providerId as string);
    if (!def) {
      res.status(404).json({ error: "Unknown image generation provider" });
      return;
    }
    if (def.envKey === null) {
      res.status(400).json({ error: "This provider is built in and does not take an API key" });
      return;
    }
    const parsed = AdminSetImageGenProviderKeyBody.safeParse(req.body);
    const apiKey = parsed.success ? parsed.data.apiKey.trim() : "";
    if (!apiKey) {
      res.status(400).json({ error: "API key is required" });
      return;
    }
    await setStoredImageGenKey(def.id, apiKey);
    try {
      await recordAdminAction({
        action: "imagegen_key_change",
        actorTenantId: req.tenantId,
        actorEmail: req.tenantEmail,
        targetTenantId: null,
        targetEmail: null,
        oldValue: null,
        newValue: `${def.id}:set`,
      });
    } catch (error) {
      req.log.error({ err: error }, "Failed to write image-gen key audit log");
    }
    res.json(await serializeImageGenSettings());
  },
);

/**
 * DELETE /admin/image-gen-providers/:providerId/key
 * Remove the saved API key (the env secret, if set, becomes the fallback).
 */
router.delete(
  "/admin/image-gen-providers/:providerId/key",
  async (req: Request, res: Response) => {
    const def = getImageGenProviderDef(req.params.providerId as string);
    if (!def) {
      res.status(404).json({ error: "Unknown image generation provider" });
      return;
    }
    await clearStoredImageGenKey(def.id);
    try {
      await recordAdminAction({
        action: "imagegen_key_change",
        actorTenantId: req.tenantId,
        actorEmail: req.tenantEmail,
        targetTenantId: null,
        targetEmail: null,
        oldValue: null,
        newValue: `${def.id}:cleared`,
      });
    } catch (error) {
      req.log.error({ err: error }, "Failed to write image-gen key audit log");
    }
    res.json(await serializeImageGenSettings());
  },
);

/** Serialize the video generation settings view (selection + catalog). */
async function serializeVideoGenSettings() {
  const selection = await getVideoGenSelection();
  const operationalModelIds = new Set(
    (await availableVideoModels({ ignoreAllowlist: true })).map((model) => model.id),
  );
  const activeReplicateOverrides =
    selection.provider === "replicate"
      ? [selection.textToVideoModel, selection.imageToVideoModel].filter(
          (model): model is string => Boolean(model),
        )
      : [];
  return {
    provider: selection.provider,
    textToVideoModel: selection.textToVideoModel,
    imageToVideoModel: selection.imageToVideoModel,
    // null = the whole catalog is offered to tenants (the default).
    enabledModelIds: selection.enabledModelIds,
    // null = portrait lip sync is off; video-mode lip sync needs nothing here.
    lipSyncPortraitModel: selection.lipSyncPortraitModel,
    // The full catalog, so the admin screen can render checkboxes without a
    // second request — including which provider each model needs and what it
    // costs a tenant in video units.
    modelCatalog: VIDEO_MODEL_CATALOG.map((m) => ({
      id: m.id,
      label: m.label,
      blurb: m.blurb,
      provider: m.provider,
      providerModels: { ...m.models },
      pricingAvailable: operationalModelIds.has(m.id),
      tier: m.tier,
      unitMultiplier: TIER_UNIT_MULTIPLIER[m.tier],
      modes: (["text", "image"] as const).filter((mode) => Boolean(m.models[mode])),
      aspects: [...m.aspects],
      durations: [...m.durations],
      resolutions: [...m.resolutions],
      hasQuality: m.hasQuality,
      canGenerateAudio: m.canGenerateAudio,
      supportsEndFrame: m.supportsEndFrame === true,
    })),
    replicatePricingModels: listReplicateVideoPricingTargets(activeReplicateOverrides),
    providers: [
      ...(await Promise.all(
        VIDEO_GEN_PROVIDERS.map(async (p) => ({
          id: p.id,
          label: p.label,
          defaultTextToVideoModel: p.defaultTextToVideoModel,
          defaultImageToVideoModel: p.defaultImageToVideoModel,
          configured: await isVideoGenProviderConfigured(p),
          supportsModelOverride: p.supportsModelOverride,
          textModelOptions: p.textModelOptions ? [...p.textModelOptions] : [],
          imageModelOptions: p.imageModelOptions ? [...p.imageModelOptions] : [],
          envKey: p.envKey,
          keySource: await getVideoGenKeySource(p),
        })),
      )),
      // Admin-added OpenAI-compatible providers with video use enabled
      // (OpenRouter-shaped async video API); key lives on their own card.
      ...(await listCustomAiProviders())
        .filter((row) => row.videoEnabled)
        .map((row) => ({
          id: customProviderRef(row.id),
          label: `${row.name} (custom)`,
          defaultTextToVideoModel: "",
          defaultImageToVideoModel: "",
          configured: true,
          supportsModelOverride: true,
          textModelOptions: [] as { value: string; label: string }[],
          imageModelOptions: [] as { value: string; label: string }[],
          envKey: "",
          keySource: (row.encryptedApiKey ? "database" : null) as "database" | "env" | null,
        })),
    ],
    stockSources: await Promise.all(
      STOCK_SOURCES.map(async (s) => ({
        id: s.id,
        label: s.label,
        configured: await isStockSourceConfigured(s),
        envKey: s.envKey,
        keySource: await getStockKeySource(s),
      })),
    ),
  };
}

/**
 * PUT /admin/stock-sources/:sourceId/key
 * Save a stock footage source's API key (encrypted at rest). Superadmin only.
 * Stock sources feed the Topic to Video engine.
 */
router.put("/admin/stock-sources/:sourceId/key", async (req: Request, res: Response) => {
  const def = getStockSourceDef(req.params.sourceId as string);
  if (!def) {
    res.status(404).json({ error: "Unknown stock footage source" });
    return;
  }
  const parsed = AdminSetVideoGenProviderKeyBody.safeParse(req.body);
  const apiKey = parsed.success ? parsed.data.apiKey.trim() : "";
  if (!apiKey) {
    res.status(400).json({ error: "API key is required" });
    return;
  }
  await setStoredStockKey(def.id, apiKey);
  try {
    await recordAdminAction({
      action: "videogen_key_change",
      actorTenantId: req.tenantId,
      actorEmail: req.tenantEmail,
      targetTenantId: null,
      targetEmail: null,
      oldValue: null,
      newValue: `stock_${def.id}:set`,
    });
  } catch (error) {
    req.log.error({ err: error }, "Failed to write stock-source key audit log");
  }
  res.json(await serializeVideoGenSettings());
});

/**
 * DELETE /admin/stock-sources/:sourceId/key
 * Remove the saved key (the env secret, if set, becomes the fallback).
 */
router.delete("/admin/stock-sources/:sourceId/key", async (req: Request, res: Response) => {
  const def = getStockSourceDef(req.params.sourceId as string);
  if (!def) {
    res.status(404).json({ error: "Unknown stock footage source" });
    return;
  }
  await clearStoredStockKey(def.id);
  try {
    await recordAdminAction({
      action: "videogen_key_change",
      actorTenantId: req.tenantId,
      actorEmail: req.tenantEmail,
      targetTenantId: null,
      targetEmail: null,
      oldValue: null,
      newValue: `stock_${def.id}:cleared`,
    });
  } catch (error) {
    req.log.error({ err: error }, "Failed to write stock-source key audit log");
  }
  res.json(await serializeVideoGenSettings());
});

/**
 * GET /admin/video-gen-settings
 * The platform-wide video generation provider selection.
 */
router.get("/admin/video-gen-settings", async (_req: Request, res: Response) => {
  res.json(await serializeVideoGenSettings());
});

/**
 * PUT /admin/video-gen-settings
 * Select which provider (and optional per-engine model overrides) the AI
 * video engines use.
 */
router.put("/admin/video-gen-settings", async (req: Request, res: Response) => {
  const parsed = AdminUpdateVideoGenSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const before0 = await getVideoGenSelection();
  const def = await resolveVideoGenProviderDef(parsed.data.provider);
  if (!def) {
    res.status(400).json({ error: "Unknown video generation provider" });
    return;
  }
  const textToVideoModel = parsed.data.textToVideoModel?.trim() || null;
  const imageToVideoModel = parsed.data.imageToVideoModel?.trim() || null;
  // Custom providers have no default models — both engines must be set.
  if (parseCustomProviderId(def.id) !== null && (!textToVideoModel || !imageToVideoModel)) {
    res.status(400).json({
      error: "Custom providers need both a text-to-video and an image-to-video model id",
    });
    return;
  }

  // Activation gate: both engines' effective models must be priceable.
  let pricingWarning: string | null = null;
  {
    const effectiveTextToVideo = (
      (def.supportsModelOverride && textToVideoModel) ||
      def.defaultTextToVideoModel
    ).trim();
    const effectiveImageToVideo = (
      (def.supportsModelOverride && imageToVideoModel) ||
      def.defaultImageToVideoModel
    ).trim();
    // Self-hosted NVIDIA has no public catalog price to synchronize. Its
    // deployment activation gate proves the exact NVIDIA usdPerSecond row,
    // successful /v1/models test, and enabled switch. Never cross-source a
    // same-named hosted model's price into that explicit admin-owned rate.
    if (def.id === "nvidia" && !(await isVideoGenProviderConfigured(def))) {
      res.status(400).json({
        error:
          "NVIDIA video requires an enabled self-hosted WAN 2.2 deployment that has passed its model test and has an explicit NVIDIA USD-per-second price.",
      });
      return;
    }
    const pricing =
      def.id === "nvidia"
        ? { missing: [] as string[], crossSourced: [] as Array<{ model: string; source: string }> }
        : await syncActivatedModelPricing({
            kind: "video",
            provider: def.id,
            models: [effectiveTextToVideo, effectiveImageToVideo],
          });
    pricingWarning = crossSourcePricingWarning(def.id, pricing.crossSourced);
    if (pricing.missing.length > 0) {
      // Name the engine(s) each unpriced model serves so the admin knows
      // exactly which cost-card row to add.
      const entries = pricing.missing.flatMap((m) => {
        const engines: Array<"text-to-video" | "image-to-video"> = [];
        if (m === effectiveTextToVideo) engines.push("text-to-video");
        if (m === effectiveImageToVideo) engines.push("image-to-video");
        return engines.length > 0
          ? engines.map((engine) => ({ model: m, kind: "video" as const, engine }))
          : [{ model: m, kind: "video" as const }];
      });
      res.status(400).json({ error: missingPricingError(entries) });
      return;
    }
    if (def.id !== "nvidia") {
      const unpriced = [];
      for (const model of [effectiveTextToVideo, effectiveImageToVideo]) {
        if (!(await isVideoModelPriced({
          provider: def.id,
          model,
          durationSec: 5,
          variantCriteria: {},
        }).catch(() => false))) {
          unpriced.push(model);
        }
      }
      if (unpriced.length) {
        res.status(400).json({
          error: `The selected provider needs its own authoritative video price configuration for: ${[...new Set(unpriced)].join(", ")}`,
        });
        return;
      }
    }
  }

  // Per-generation model allowlist. Omitted leaves it as it is (this route is
  // a full PUT of the provider selection, but the allowlist is a separate
  // concern and an older admin client must not silently wipe it); an explicit
  // null re-opens the whole catalog; an array narrows it. Unknown ids are
  // dropped rather than rejected, so removing a model from the catalog in a
  // later release cannot brick this screen.
  let enabledModelIds =
    parsed.data.enabledModelIds === undefined
      ? before0.enabledModelIds
      : parsed.data.enabledModelIds === null
        ? null
        : parsed.data.enabledModelIds;
  if (Array.isArray(enabledModelIds)) {
    const invalid = enabledModelIds.filter((id) => !isVideoModelId(id));
    if (invalid.length) {
      res.status(400).json({
        error: `Unknown video model id: ${invalid.join(", ")}`,
      });
      return;
    }
    const operational = new Set(
      (await availableVideoModels({ ignoreAllowlist: true })).map((model) => model.id),
    );
    const unavailable = enabledModelIds.filter((id) => !operational.has(id));
    if (unavailable.length) {
      res.status(400).json({
        error: `Video models cannot be enabled without their own provider credential and authoritative prices for every supported variant: ${unavailable.join(", ")}`,
      });
      return;
    }
  }

  const before = before0;
  await setVideoGenSelection({
    provider: def.id,
    textToVideoModel: def.supportsModelOverride ? textToVideoModel : null,
    imageToVideoModel: def.supportsModelOverride ? imageToVideoModel : null,
    enabledModelIds,
    // Omitted leaves it alone, for the same reason as the allowlist: an older
    // admin client changing the provider must not silently turn portrait lip
    // sync off. An explicit null (or empty string) turns it off.
    ...(parsed.data.lipSyncPortraitModel === undefined
      ? {}
      : { lipSyncPortraitModel: parsed.data.lipSyncPortraitModel }),
  });

  const changed =
    before.provider !== def.id ||
    before.textToVideoModel !== textToVideoModel ||
    before.imageToVideoModel !== imageToVideoModel;
  if (changed) {
    try {
      await recordAdminAction({
        action: "videogen_provider_change",
        actorTenantId: req.tenantId,
        actorEmail: req.tenantEmail,
        targetTenantId: null,
        targetEmail: null,
        oldValue: `${before.provider}${before.textToVideoModel ? `:${before.textToVideoModel}` : ""}`,
        newValue: `${def.id}${textToVideoModel ? `:${textToVideoModel}` : ""}`,
      });
    } catch (error) {
      req.log.error({ err: error }, "Failed to write video-gen settings audit log");
    }
  }

  res.json({ ...(await serializeVideoGenSettings()), pricingWarning });
});

/**
 * PUT /admin/video-gen-providers/:providerId/key
 * Save a provider's API key (encrypted at rest). Superadmin only.
 */
router.put(
  "/admin/video-gen-providers/:providerId/key",
  async (req: Request, res: Response) => {
    const def = getVideoGenProviderDef(req.params.providerId as string);
    if (!def) {
      res.status(404).json({ error: "Unknown video generation provider" });
      return;
    }
    const parsed = AdminSetVideoGenProviderKeyBody.safeParse(req.body);
    const apiKey = parsed.success ? parsed.data.apiKey.trim() : "";
    if (!apiKey) {
      res.status(400).json({ error: "API key is required" });
      return;
    }
    await setStoredVideoGenKey(def.id, apiKey);
    try {
      await recordAdminAction({
        action: "videogen_key_change",
        actorTenantId: req.tenantId,
        actorEmail: req.tenantEmail,
        targetTenantId: null,
        targetEmail: null,
        oldValue: null,
        newValue: `${def.id}:set`,
      });
    } catch (error) {
      req.log.error({ err: error }, "Failed to write video-gen key audit log");
    }
    res.json(await serializeVideoGenSettings());
  },
);

/**
 * DELETE /admin/video-gen-providers/:providerId/key
 * Remove the saved API key (the env secret, if set, becomes the fallback).
 */
router.delete(
  "/admin/video-gen-providers/:providerId/key",
  async (req: Request, res: Response) => {
    const def = getVideoGenProviderDef(req.params.providerId as string);
    if (!def) {
      res.status(404).json({ error: "Unknown video generation provider" });
      return;
    }
    await clearStoredVideoGenKey(def.id);
    try {
      await recordAdminAction({
        action: "videogen_key_change",
        actorTenantId: req.tenantId,
        actorEmail: req.tenantEmail,
        targetTenantId: null,
        targetEmail: null,
        oldValue: null,
        newValue: `${def.id}:cleared`,
      });
    } catch (error) {
      req.log.error({ err: error }, "Failed to write video-gen key audit log");
    }
    res.json(await serializeVideoGenSettings());
  },
);

/** Serialize the text-gen routing state for admin responses (never the key itself). */
async function serializeTextGenSettings() {
  const selection = await getTextGenSelection();
  const replicateSelected = selection.provider === "replicate";
  const nvidiaSelected = selection.provider === "nvidia";
  const customSelected = parseCustomProviderId(selection.provider) !== null;
  return {
    provider: selection.provider,
    models: selection.models,
    defaultModel: selection.defaultModel,
    // Replicate deliberately shares the video-generation key. Custom
    // providers keep their (optional) key on their own row.
    keySource: customSelected
      ? ("database" as const)
      : replicateSelected
        ? await getReplicateTextKeySource()
        : nvidiaSelected
          ? await getNvidiaHostedKeySource()
          : await getOpenRouterKeySource(),
    envKey: customSelected
      ? ""
      : replicateSelected
        ? "REPLICATE_API_TOKEN"
        : nvidiaSelected
          ? "NVIDIA_API_KEY"
          : "OPENROUTER_API_KEY",
    // Admin-added OpenAI-compatible providers with text use enabled, so the
    // text card can offer them in its provider dropdown.
    customProviders: (await listCustomAiProviders())
      .filter((row) => row.textEnabled)
      .map((row) => ({ id: customProviderRef(row.id), name: row.name })),
  };
}

/**
 * GET /admin/ai-spend-settings
 * The "AI amount spent" display configuration (base costs + platform fee).
 */
router.get("/admin/ai-spend-settings", async (_req: Request, res: Response) => {
  res.json(await getAiSpendConfig());
});

/**
 * PUT /admin/ai-spend-settings
 * Set the base AI cost per caption/image (paise) and the platform fee
 * percentage folded into the tenant-facing "AI amount spent" number.
 */
router.put("/admin/ai-spend-settings", async (req: Request, res: Response) => {
  const parsed = AdminUpdateAiSpendSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const before = await getAiSpendConfig();
  const after = await setAiSpendConfig(parsed.data);
  const changed =
    before.captionCostPaise !== after.captionCostPaise ||
    before.imageCostPaise !== after.imageCostPaise ||
    before.videoCostPaise !== after.videoCostPaise ||
    before.feePercent !== after.feePercent ||
    before.displayMode !== after.displayMode ||
    before.marginPercent !== after.marginPercent;
  if (changed) {
    try {
      await recordAdminAction({
        action: "ai_spend_settings_change",
        actorTenantId: req.tenantId,
        actorEmail: req.tenantEmail,
        targetTenantId: null,
        targetEmail: null,
        oldValue: `caption=${before.captionCostPaise} image=${before.imageCostPaise} video=${before.videoCostPaise} fee=${before.feePercent}% mode=${before.displayMode} margin=${before.marginPercent}%`,
        newValue: `caption=${after.captionCostPaise} image=${after.imageCostPaise} video=${after.videoCostPaise} fee=${after.feePercent}% mode=${after.displayMode} margin=${after.marginPercent}%`,
      });
    } catch (error) {
      req.log?.error({ err: error }, "Failed to audit AI spend settings change");
    }
  }
  res.json(after);
});

/** Serialize the actual-cost configuration (rate + price catalog). */
async function serializeAiCostConfig() {
  const [config, prices] = await Promise.all([getAiCostConfig(), listModelPrices()]);
  const duplicateKeys = duplicateModelPriceKeys(prices);
  return {
    usdToInrPaise: config.usdToInrPaise,
    rateMarkupPaise: config.rateMarkupPaise,
    marketRatePaise: config.marketRatePaise,
    rateAutoUpdatedAt: config.rateAutoUpdatedAt?.toISOString() ?? null,
    elevenLabsInrPerCredit: config.elevenLabsInrPerCredit,
    // Case/whitespace duplicate groups lurking in the catalog (the exact
    // groups the Deduplicate action would merge). Lets the UI surface a
    // proactive hint instead of relying on the admin to click and check.
    duplicateGroups: countDuplicateModelPriceGroups(prices),
    prices: prices.map((p) => ({
      id: p.id,
      // Row-level flag: this row's normalized key collides with another row
      // (exactly what the Deduplicate action would merge). Lets the UI
      // outline the conflicting rows, not just show a count.
      isDuplicate: duplicateKeys.has(modelPriceGroupKey(p)),
      kind: p.kind,
      provider: p.provider,
      model: p.model,
      variantKey: p.variantKey,
      variant: p.variantCriteria,
      inputUsdPerMtok: p.inputUsdPerMtok,
      outputUsdPerMtok: p.outputUsdPerMtok,
      usdPerImage: p.usdPerImage,
      usdPerSecond: p.usdPerSecond,
      usdPerVideo: p.usdPerVideo,
    })),
  };
}

/** Best-effort audit write for actual-cost pricing changes. */
async function auditAiCostChange(
  req: Request,
  oldValue: string | null,
  newValue: string | null,
) {
  try {
    await recordAdminAction({
      action: "ai_cost_change",
      actorTenantId: req.tenantId,
      actorEmail: req.tenantEmail,
      targetTenantId: null,
      targetEmail: null,
      oldValue,
      newValue,
    });
  } catch (error) {
    req.log?.error({ err: error }, "Failed to audit AI cost change");
  }
}

/**
 * GET /admin/ai-cost/config
 * Actual-cost settings: USD→INR rate + the admin-maintained model price
 * catalog used to compute real per-generation costs.
 */
router.get("/admin/ai-cost/config", async (_req: Request, res: Response) => {
  res.json(await serializeAiCostConfig());
});

/**
 * PUT /admin/ai-cost/rate
 * Set the USD→INR conversion rate (paise per 1 USD; 0 = unset, costs stay
 * unknown).
 */
router.put("/admin/ai-cost/rate", async (req: Request, res: Response) => {
  const parsed = AdminUpdateAiCostRateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const before = await getAiCostConfig();
  const after = await setAiCostConfig({ usdToInrPaise: parsed.data.usdToInrPaise });
  if (before.usdToInrPaise !== after.usdToInrPaise) {
    await auditAiCostChange(
      req,
      `rate=${before.usdToInrPaise}`,
      `rate=${after.usdToInrPaise}`,
    );
  }
  res.json(await serializeAiCostConfig());
});

/**
 * PUT /admin/ai-cost/markup
 * Set the markup (paise) added on top of the fetched market rate on each
 * auto-refresh. Applies on the next refresh (or an immediate manual one).
 */
router.put("/admin/ai-cost/markup", async (req: Request, res: Response) => {
  const parsed = AdminUpdateAiCostMarkupBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const before = await getAiCostConfig();
  const after = await setAiCostMarkup(parsed.data.rateMarkupPaise);
  if (before.rateMarkupPaise !== after.rateMarkupPaise) {
    await auditAiCostChange(
      req,
      `markup=${before.rateMarkupPaise}`,
      `markup=${after.rateMarkupPaise}`,
    );
  }
  res.json(await serializeAiCostConfig());
});

/**
 * PUT /admin/ai-cost/elevenlabs-credit-rate
 * Set the exact rupees charged for one ElevenLabs credit, or clear the rate.
 * This remains a decimal string so currency precision is never lost to JS
 * floating-point conversion.
 */
router.put("/admin/ai-cost/elevenlabs-credit-rate", async (req: Request, res: Response) => {
  const parsed = AdminUpdateElevenLabsCreditRateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const rate = parsed.data.elevenLabsInrPerCredit;
  if (rate !== null && !/[1-9]/.test(rate)) {
    res.status(400).json({ error: "ElevenLabs rupees per credit must be greater than zero." });
    return;
  }
  const before = await getAiCostConfig();
  const after = await setElevenLabsCreditRate(rate);
  if (before.elevenLabsInrPerCredit !== after.elevenLabsInrPerCredit) {
    await auditAiCostChange(
      req,
      `elevenlabs_inr_per_credit=${before.elevenLabsInrPerCredit ?? "unset"}`,
      `elevenlabs_inr_per_credit=${after.elevenLabsInrPerCredit ?? "unset"}`,
    );
  }
  res.json(await serializeAiCostConfig());
});

/**
 * POST /admin/ai-cost/rate/refresh
 * Fetch the live USD→INR market rate now, add the markup, and save it. On
 * fetch failure the stored rate stays untouched and this responds 502.
 */
router.post("/admin/ai-cost/rate/refresh", async (req: Request, res: Response) => {
  const before = await getAiCostConfig();
  try {
    const after = await refreshUsdInrRate();
    if (before.usdToInrPaise !== after.usdToInrPaise) {
      await auditAiCostChange(
        req,
        `rate=${before.usdToInrPaise}`,
        `rate=${after.usdToInrPaise} (auto: market ${after.marketRatePaise} + markup ${after.rateMarkupPaise})`,
      );
    }
    // A successful manual refresh also clears any outstanding stale-rate
    // alert (and re-arms its dedupe), same as the daily sweep's success path.
    await resolveFxRateStaleNotifications();
    res.json(await serializeAiCostConfig());
  } catch (error) {
    req.log.error({ err: error }, "Manual USD→INR rate refresh failed");
    res.status(502).json({
      error: "Could not fetch the current USD→INR rate. The saved rate is unchanged.",
    });
  }
});

interface ModelPriceFields {
  kind: ModelPriceKind;
  provider: string;
  model: string;
  inputUsdPerMtok?: number | null;
  outputUsdPerMtok?: number | null;
  usdPerImage?: number | null;
  usdPerSecond?: number | null;
  usdPerVideo?: number | null;
  variant?: Record<string, string | number | boolean> | null;
}

/** Apply the one authoritative kind-specific price rule before any save. */
function normalizeModelPrice(data: ModelPriceFields) {
  if (data.kind === "text" && (data.inputUsdPerMtok == null || data.outputUsdPerMtok == null)) {
    return { error: "Text model prices need both input and output USD per 1M tokens." };
  }
  // Image rows may be flat-priced (usdPerImage), token-priced (both token
  // prices, for OpenAI/Gemini image models that report usage), or both.
  const hasTokenPair = data.inputUsdPerMtok != null && data.outputUsdPerMtok != null;
  if (data.kind === "image" && data.usdPerImage == null && !hasTokenPair) {
    return {
      error: "Image model prices need a USD per image amount, or both input and output USD per 1M tokens.",
    };
  }
  // Video rows may be per-second (most Replicate video models), flat
  // per-video, or both.
  if (data.kind === "video" && data.usdPerSecond == null && data.usdPerVideo == null) {
    return {
      error: "Video model prices need a USD per second amount, a USD per video amount, or both.",
    };
  }
  return {
    value: {
    kind: data.kind,
    provider: data.provider.trim(),
    model: data.model.trim(),
    inputUsdPerMtok: (data.kind === "text" || data.kind === "image") && hasTokenPair ? (data.inputUsdPerMtok ?? null) : null,
    outputUsdPerMtok: (data.kind === "text" || data.kind === "image") && hasTokenPair ? (data.outputUsdPerMtok ?? null) : null,
    usdPerImage: data.kind === "image" ? (data.usdPerImage ?? null) : null,
    usdPerSecond: data.kind === "video" ? (data.usdPerSecond ?? null) : null,
    usdPerVideo: data.kind === "video" ? (data.usdPerVideo ?? null) : null,
    variant: data.kind === "video" ? (data.variant ?? null) : null,
    },
  };
}

async function runModelPriceTrueUp(
  req: Request,
  row: Awaited<ReturnType<typeof upsertModelPrice>>,
): Promise<void> {
  // Wallet true-up: generations already charged at the display-rate fallback
  // for this model now have a real price, so collect (or refund) the difference.
  try {
    const result = await trueUpModel({
      kind: row.kind as "text" | "image" | "video",
      provider: row.provider,
      model: row.model,
    });
    if (result.rowsTruedUp > 0) {
      req.log.info({ model: row.model, ...result }, "Trued up wallet charges after a price was added");
    }
  } catch (error) {
    // A true-up failure must not roll back or hide the price that was already
    // saved; the boot/interval/manual retry paths will safely try again.
    req.log.error({ err: error, model: row.model }, "Wallet true-up failed");
  }
}

function triggerModelPriceTrueUp(req: Request, row: Awaited<ReturnType<typeof upsertModelPrice>>): void {
  void runModelPriceTrueUp(req, row);
}

/**
 * PUT /admin/ai-cost/prices
 * Add or update one model price row (upsert on kind+provider+model).
 */
router.put("/admin/ai-cost/prices", async (req: Request, res: Response) => {
  const parsed = AdminUpsertAiModelPriceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const normalized = normalizeModelPrice(parsed.data);
  if ("error" in normalized) {
    res.status(400).json({ error: normalized.error });
    return;
  }
  const row = await upsertModelPrice(normalized.value);
  await auditAiCostChange(
    req,
    null,
    `${row.kind}:${row.provider}/${row.model} variant=${row.variantKey || "default"} in=${row.inputUsdPerMtok ?? "-"} out=${row.outputUsdPerMtok ?? "-"} img=${row.usdPerImage ?? "-"} sec=${row.usdPerSecond ?? "-"} vid=${row.usdPerVideo ?? "-"}`,
  );
  triggerModelPriceTrueUp(req, row);
  res.json(await serializeAiCostConfig());
});

/**
 * POST /admin/ai-cost/prices/import/preview
 * Resolve an official provider model URL through our fixed-host catalogs only.
 * This is deliberately read-only.
 */
router.post("/admin/ai-cost/prices/import/preview", async (req: Request, res: Response) => {
  const parsed = AdminPreviewAiModelPriceImportBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  try {
    const preview = await previewModelPriceImport(parsed.data.sourceUrl, parsed.data.kind);
    res.json(
      AdminPreviewAiModelPriceImportResponse.parse({
        ...preview,
        variants: preview.variants ?? [],
      }),
    );
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Unable to import a price from this URL.",
    });
  }
});

/**
 * POST /admin/ai-cost/prices/import/confirm
 * Revalidate the official source URL and persist the admin-reviewed proposal.
 */
router.post("/admin/ai-cost/prices/import/confirm", async (req: Request, res: Response) => {
  const parsed = AdminConfirmAiModelPriceImportBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  let urlModel: { provider: "replicate" | "openrouter" | "openai" | "gemini"; model: string };
  try {
    urlModel = parseOfficialModelPriceUrl(parsed.data.sourceUrl);
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Unable to import a price from this URL.",
    });
    return;
  }
  const submittedModel = parsed.data.model.trim();
  const sameModel =
    urlModel.model === submittedModel ||
    (urlModel.provider === "openrouter" &&
      !submittedModel.includes("/") &&
      urlModel.model.endsWith(`/${submittedModel}`));
  if (urlModel.provider !== parsed.data.provider || !sameModel) {
    res.status(400).json({ error: "The source URL does not match the submitted provider and model." });
    return;
  }
  const variantInputs =
    parsed.data.kind === "video" && (parsed.data.variants?.length ?? 0) > 0
      ? parsed.data.variants!.map((variant) => ({
          ...parsed.data,
          ...variant,
          variant: variant.criteria,
        }))
      : [parsed.data];
  const normalizedRows = variantInputs.map((input) => normalizeModelPrice(input));
  const invalid = normalizedRows.find((normalized) => "error" in normalized);
  if (invalid && "error" in invalid) {
    res.status(400).json({ error: invalid.error });
    return;
  }
  const rows = [];
  for (const normalized of normalizedRows) {
    if ("error" in normalized) continue;
    rows.push(await upsertModelPrice(normalized.value));
  }
  const row = rows[0]!;
  await auditAiCostChange(
    req,
    null,
    `imported ${rows.length} ${row.kind} price row(s):${row.provider}/${row.model} from ${parsed.data.sourceUrl}`,
  );
  // The import flow is commonly opened from a specific pending wallet row.
  // Wait for its first true-up attempt so the confirmation response and
  // subsequent UI invalidation observe fresh state.
  await runModelPriceTrueUp(req, row);
  res.json(await serializeAiCostConfig());
});

/**
 * POST /admin/ai-cost/prices/dedupe
 * Merge duplicate price rows (same kind+provider+model up to case and
 * whitespace) on demand — the same sweep that runs at boot, but available to
 * an admin who just imported or hand-edited prices. Each merged group is
 * audited with the requesting admin as actor.
 */
router.post("/admin/ai-cost/prices/dedupe", async (req: Request, res: Response) => {
  const merges = await dedupeModelPrices();
  for (const merge of merges) {
    await auditAiCostChange(
      req,
      merge.removed
        .map((r) => `duplicate #${r.id} ${merge.kind}:${r.provider}/${r.model}`)
        .join(", "),
      `merged into #${merge.keptId} ${merge.kind}:${merge.keptProvider}/${merge.keptModel} (prices from #${merge.pricesTakenFromId})`,
    );
  }
  res.json({ merged: merges.length, config: await serializeAiCostConfig() });
});

/**
 * DELETE /admin/ai-cost/prices/:priceId
 * Remove a price row; the affected model's future costs become unknown.
 */
router.delete("/admin/ai-cost/prices/:priceId", async (req: Request, res: Response) => {
  const priceId = Number(req.params.priceId);
  if (!Number.isInteger(priceId) || priceId <= 0) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const removed = await deleteModelPrice(priceId);
  if (!removed) {
    res.status(404).json({ error: "Unknown price row" });
    return;
  }
  await auditAiCostChange(req, `price #${priceId}`, "deleted");
  res.json(await serializeAiCostConfig());
});

/**
 * GET /admin/ai-cost/report?month=YYYY-MM
 * Per-tenant actual AI cost for one month with the tenant-facing display
 * amount alongside for margin comparison. Costs are sums of the per-event
 * costPaise values; events with NULL cost are counted separately so unknown
 * coverage is visible instead of silently under-reporting.
 */
router.get("/admin/ai-cost/report", async (req: Request, res: Response) => {
  const monthParam = typeof req.query.month === "string" ? req.query.month : "";
  const now = new Date();
  const defaultMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const month = monthParam || defaultMonth;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    res.status(400).json({ error: "Invalid month; use YYYY-MM" });
    return;
  }
  const [yearStr, monthStr] = month.split("-");
  const start = new Date(Date.UTC(Number(yearStr), Number(monthStr) - 1, 1));
  const end = new Date(Date.UTC(Number(yearStr), Number(monthStr), 1));

  const [rows, monthRows, displayRates] = await Promise.all([
    db
      .select({
        tenantId: usageEventsTable.tenantId,
        kind: usageEventsTable.kind,
        count: sql<number>`count(*)::int`,
        knownCostPaise: sql<number>`coalesce(sum(${usageEventsTable.costPaise}), 0)::int`,
        unknownCount: sql<number>`count(*) filter (where ${usageEventsTable.costPaise} is null)::int`,
        // Snapshotted tenant-facing display spend (rates in effect at event
        // time). Rows predating snapshotting fall back to current rates.
        snapshotDisplayPaise: sql<number>`coalesce(sum(${usageEventsTable.displayPaise}), 0)::int`,
        noSnapshotCount: sql<number>`count(*) filter (where ${usageEventsTable.displayPaise} is null)::int`,
      })
      .from(usageEventsTable)
      .where(
        and(
          gte(usageEventsTable.createdAt, start),
          lt(usageEventsTable.createdAt, end),
          inArray(usageEventsTable.kind, ["caption", "image", "video"]),
        ),
      )
      .groupBy(usageEventsTable.tenantId, usageEventsTable.kind),
    db
      .select({
        month: sql<string>`to_char(${usageEventsTable.createdAt} at time zone 'UTC', 'YYYY-MM')`,
        captionCount: sql<number>`count(*) filter (where ${usageEventsTable.kind} = 'caption')::int`,
        imageCount: sql<number>`count(*) filter (where ${usageEventsTable.kind} = 'image')::int`,
        videoCount: sql<number>`count(*) filter (where ${usageEventsTable.kind} = 'video')::int`,
        knownCostPaise: sql<number>`coalesce(sum(${usageEventsTable.costPaise}) filter (where ${usageEventsTable.kind} in ('caption', 'image', 'video')), 0)::int`,
        unknownCount: sql<number>`count(*) filter (where ${usageEventsTable.kind} in ('caption', 'image', 'video') and ${usageEventsTable.costPaise} is null)::int`,
        snapshotDisplayPaise: sql<number>`coalesce(sum(${usageEventsTable.displayPaise}) filter (where ${usageEventsTable.kind} in ('caption', 'image', 'video')), 0)::int`,
        noSnapshotCaptionCount: sql<number>`count(*) filter (where ${usageEventsTable.kind} = 'caption' and ${usageEventsTable.displayPaise} is null)::int`,
        noSnapshotImageCount: sql<number>`count(*) filter (where ${usageEventsTable.kind} = 'image' and ${usageEventsTable.displayPaise} is null)::int`,
        noSnapshotVideoCount: sql<number>`count(*) filter (where ${usageEventsTable.kind} = 'video' and ${usageEventsTable.displayPaise} is null)::int`,
      })
      .from(usageEventsTable)
      .groupBy(sql`1`)
      .orderBy(sql`1 desc`),
    getAiSpendRates(),
  ]);

  const byTenant = new Map<
    number,
    {
      captionCount: number;
      imageCount: number;
      videoCount: number;
      captionCostPaise: number;
      imageCostPaise: number;
      videoCostPaise: number;
      unknownCaptionCount: number;
      unknownImageCount: number;
      unknownVideoCount: number;
      snapshotDisplayPaise: number;
      noSnapshotCaptionCount: number;
      noSnapshotImageCount: number;
      noSnapshotVideoCount: number;
    }
  >();
  for (const row of rows) {
    const agg =
      byTenant.get(row.tenantId) ??
      {
        captionCount: 0,
        imageCount: 0,
        videoCount: 0,
        captionCostPaise: 0,
        imageCostPaise: 0,
        videoCostPaise: 0,
        unknownCaptionCount: 0,
        unknownImageCount: 0,
        unknownVideoCount: 0,
        snapshotDisplayPaise: 0,
        noSnapshotCaptionCount: 0,
        noSnapshotImageCount: 0,
        noSnapshotVideoCount: 0,
      };
    if (row.kind === "caption") {
      agg.captionCount = row.count;
      agg.captionCostPaise = row.knownCostPaise;
      agg.unknownCaptionCount = row.unknownCount;
      agg.noSnapshotCaptionCount = row.noSnapshotCount;
    } else if (row.kind === "image") {
      agg.imageCount = row.count;
      agg.imageCostPaise = row.knownCostPaise;
      agg.unknownImageCount = row.unknownCount;
      agg.noSnapshotImageCount = row.noSnapshotCount;
    } else {
      agg.videoCount = row.count;
      agg.videoCostPaise = row.knownCostPaise;
      agg.unknownVideoCount = row.unknownCount;
      agg.noSnapshotVideoCount = row.noSnapshotCount;
    }
    agg.snapshotDisplayPaise += row.snapshotDisplayPaise;
    byTenant.set(row.tenantId, agg);
  }

  const tenantIds = [...byTenant.keys()];
  const tenantRows = tenantIds.length
    ? await db
        .select({
          id: tenantsTable.id,
          name: tenantsTable.name,
          email: tenantsTable.email,
        })
        .from(tenantsTable)
        .where(inArray(tenantsTable.id, tenantIds))
    : [];
  const tenantInfo = new Map(tenantRows.map((t) => [t.id, t]));

  const tenants = tenantIds
    .map((tenantId) => {
      const {
        snapshotDisplayPaise,
        noSnapshotCaptionCount,
        noSnapshotImageCount,
        noSnapshotVideoCount,
        ...agg
      } = byTenant.get(tenantId)!;
      const info = tenantInfo.get(tenantId);
      return {
        tenantId,
        name: info?.name ?? null,
        email: info?.email ?? null,
        ...agg,
        totalCostPaise: agg.captionCostPaise + agg.imageCostPaise + agg.videoCostPaise,
        // Snapshotted amounts (rates in effect at event time) plus a
        // current-rate fallback for rows that predate snapshotting.
        displaySpendPaise:
          snapshotDisplayPaise +
          noSnapshotCaptionCount * displayRates.captionPaise +
          noSnapshotImageCount * displayRates.imagePaise +
          noSnapshotVideoCount * displayRates.videoPaise,
      };
    })
    .sort((a, b) => b.totalCostPaise - a.totalCostPaise);

  const toMonthTotal = (r: {
    month: string;
    captionCount: number;
    imageCount: number;
    videoCount: number;
    knownCostPaise: number;
    unknownCount: number;
    snapshotDisplayPaise: number;
    noSnapshotCaptionCount: number;
    noSnapshotImageCount: number;
    noSnapshotVideoCount: number;
  }) => ({
    month: r.month,
    captionCount: r.captionCount,
    imageCount: r.imageCount,
    videoCount: r.videoCount,
    totalCostPaise: r.knownCostPaise,
    // Historical months keep the rates in effect at the time (per-event
    // snapshots); only pre-snapshot rows fall back to current rates.
    displaySpendPaise:
      r.snapshotDisplayPaise +
      r.noSnapshotCaptionCount * displayRates.captionPaise +
      r.noSnapshotImageCount * displayRates.imagePaise +
      r.noSnapshotVideoCount * displayRates.videoPaise,
    unknownCount: r.unknownCount,
  });
  const trend = monthRows.slice(0, 12).map(toMonthTotal);
  const selectedRow = monthRows.find((r) => r.month === month);
  const summary = selectedRow
    ? toMonthTotal(selectedRow)
    : {
        month,
        captionCount: 0,
        imageCount: 0,
        videoCount: 0,
        totalCostPaise: 0,
        displaySpendPaise: 0,
        unknownCount: 0,
      };

  res.json({
    month,
    months: monthRows.map((r) => r.month),
    displayRates,
    summary,
    trend,
    tenants,
  });
});

/**
 * GET /admin/ai-cost/campaigns?month=YYYY-MM
 * Per-campaign actual AI cost for one month, across all tenants. Only usage
 * events tagged with a campaign are included; events with NULL cost are
 * counted separately (unknownCount) so coverage gaps stay visible.
 */
router.get("/admin/ai-cost/campaigns", async (req: Request, res: Response) => {
  const monthParam = typeof req.query.month === "string" ? req.query.month : "";
  const now = new Date();
  const defaultMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const month = monthParam || defaultMonth;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    res.status(400).json({ error: "Invalid month; use YYYY-MM" });
    return;
  }
  const [yearStr, monthStr] = month.split("-");
  const start = new Date(Date.UTC(Number(yearStr), Number(monthStr) - 1, 1));
  const end = new Date(Date.UTC(Number(yearStr), Number(monthStr), 1));

  const rows = await db
    .select({
      tenantId: usageEventsTable.tenantId,
      campaignId: usageEventsTable.campaignId,
      captionCount: sql<number>`count(*) filter (where ${usageEventsTable.kind} = 'caption')::int`,
      imageCount: sql<number>`count(*) filter (where ${usageEventsTable.kind} = 'image')::int`,
      videoCount: sql<number>`count(*) filter (where ${usageEventsTable.kind} = 'video')::int`,
      totalCostPaise: sql<number>`coalesce(sum(${usageEventsTable.costPaise}), 0)::int`,
      unknownCount: sql<number>`count(*) filter (where ${usageEventsTable.costPaise} is null)::int`,
    })
    .from(usageEventsTable)
    .where(
      and(
        gte(usageEventsTable.createdAt, start),
        lt(usageEventsTable.createdAt, end),
        inArray(usageEventsTable.kind, ["caption", "image", "video"]),
        isNotNull(usageEventsTable.campaignId),
      ),
    )
    .groupBy(usageEventsTable.tenantId, usageEventsTable.campaignId);

  const tenantIds = [...new Set(rows.map((r) => r.tenantId))];
  // usage_events.campaign_id is text; campaigns.id is numeric. Only numeric
  // ids can resolve to a live campaign row — others (or deleted campaigns)
  // simply show without a name.
  const numericCampaignIds = [
    ...new Set(
      rows
        .map((r) => r.campaignId)
        .filter((id): id is string => id !== null && /^\d+$/.test(id))
        .map((id) => Number(id)),
    ),
  ];
  const [tenantRows, campaignRows] = await Promise.all([
    tenantIds.length
      ? db
          .select({ id: tenantsTable.id, name: tenantsTable.name, email: tenantsTable.email })
          .from(tenantsTable)
          .where(inArray(tenantsTable.id, tenantIds))
      : Promise.resolve([]),
    numericCampaignIds.length
      ? db
          .select({
            id: campaignsTable.id,
            tenantId: campaignsTable.tenantId,
            name: campaignsTable.name,
          })
          .from(campaignsTable)
          .where(inArray(campaignsTable.id, numericCampaignIds))
      : Promise.resolve([]),
  ]);
  const tenantInfo = new Map(tenantRows.map((t) => [t.id, t]));
  // Key campaign names by tenant too, so a campaign id from one tenant can
  // never pick up another tenant's campaign name.
  const campaignName = new Map(campaignRows.map((c) => [`${c.tenantId}:${c.id}`, c.name]));

  const campaigns = rows
    .map((r) => {
      const info = tenantInfo.get(r.tenantId);
      return {
        tenantId: r.tenantId,
        tenantName: info?.name ?? null,
        tenantEmail: info?.email ?? null,
        campaignId: r.campaignId as string,
        campaignName: campaignName.get(`${r.tenantId}:${r.campaignId}`) ?? null,
        captionCount: r.captionCount,
        imageCount: r.imageCount,
        videoCount: r.videoCount,
        totalCostPaise: r.totalCostPaise,
        unknownCount: r.unknownCount,
      };
    })
    .sort((a, b) => b.totalCostPaise - a.totalCostPaise);

  res.json({ month, campaigns });
});

/**
 * GET /admin/provider-health
 * Live breaker state per provider key + whether text requests are currently
 * being diverted to the failover provider. Read-only diagnostic snapshot.
 */
router.get("/admin/provider-health", async (_req: Request, res: Response) => {
  res.json(await buildProviderHealthReport());
});

function parseNvidiaCapability(value: unknown): NvidiaCapability | null {
  return typeof value === "string" &&
    (NVIDIA_CAPABILITIES as readonly string[]).includes(value)
    ? (value as NvidiaCapability)
    : null;
}

router.get("/admin/nvidia", async (_req: Request, res: Response) => {
  res.json(await getNvidiaAdminSettings());
});

router.put("/admin/nvidia/hosted-key", async (req: Request, res: Response) => {
  const parsed = AdminSetNvidiaHostedKeyBody.safeParse(req.body);
  if (!parsed.success || !parsed.data.apiKey.trim()) {
    res.status(400).json({ error: "NVIDIA API key is required" });
    return;
  }
  res.json(await setNvidiaHostedKey(parsed.data.apiKey.trim()));
});

router.delete("/admin/nvidia/hosted-key", async (_req: Request, res: Response) => {
  res.json(await clearNvidiaHostedKey());
});

router.post("/admin/nvidia/hosted-test", async (_req: Request, res: Response) => {
  try {
    res.json(await testNvidiaHosted());
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Test failed" });
  }
});

router.put("/admin/nvidia/deployments/:capability", async (req: Request, res: Response) => {
  const capability = parseNvidiaCapability(req.params.capability);
  const parsed = AdminSetNvidiaDeploymentBody.safeParse(req.body);
  if (!capability || !parsed.success) {
    res.status(400).json({ error: "Invalid NVIDIA deployment configuration" });
    return;
  }
  try {
    res.json(await setNvidiaDeployment(capability, parsed.data));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Invalid configuration" });
  }
});

router.delete("/admin/nvidia/deployments/:capability", async (req: Request, res: Response) => {
  const capability = parseNvidiaCapability(req.params.capability);
  if (!capability) {
    res.status(400).json({ error: "Unknown NVIDIA capability" });
    return;
  }
  res.json(await clearNvidiaDeployment(capability));
});

router.post("/admin/nvidia/deployments/:capability/test", async (req: Request, res: Response) => {
  const capability = parseNvidiaCapability(req.params.capability);
  if (!capability) {
    res.status(400).json({ error: "Unknown NVIDIA capability" });
    return;
  }
  try {
    res.json(await testNvidiaDeployment(capability));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Test failed" });
  }
});

router.get("/admin/nvidia/models", async (req: Request, res: Response) => {
  const parsedCapability =
    req.query.capability === undefined
      ? undefined
      : parseNvidiaCapability(req.query.capability);
  if (req.query.capability !== undefined && !parsedCapability) {
    res.status(400).json({ error: "Unknown NVIDIA capability" });
    return;
  }
  const capability = parsedCapability ?? undefined;
  try {
    res.json(await discoverNvidiaModels(capability));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Discovery failed" });
  }
});

/** Read-only explanation of current AI fallback eligibility and pricing. */
router.get("/admin/ai-fallbacks", async (_req: Request, res: Response) => {
  res.json(await buildAdminAiFallbackReport());
});

/**
 * GET /admin/text-gen-settings
 * The platform-wide text generation provider selection.
 */
router.get("/admin/text-gen-settings", async (_req: Request, res: Response) => {
  res.json(await serializeTextGenSettings());
});

/**
 * GET /admin/text-gen-model-pricing?models=a,b&provider=openrouter|replicate
 * Live catalog pricing for the model ids being edited in the admin
 * dashboard (works for unsaved drafts, unlike GET /ai/models).
 */
router.get("/admin/text-gen-model-pricing", async (req: Request, res: Response) => {
  const raw = typeof req.query.models === "string" ? req.query.models : "";
  const provider = req.query.provider === "replicate" ? "replicate" : "openrouter";
  // Every submitted id gets an entry back (null prices when unknown) so the
  // UI never shows a permanent "loading" placeholder for a skipped model.
  const models = [...new Set(raw.split(",").map((m) => m.trim()).filter(Boolean))];
  if (models.length === 0) {
    res.status(400).json({ error: "Provide at least one model id in ?models=" });
    return;
  }
  const capped = models.slice(0, 200);
  const looked =
    provider === "replicate"
      ? await lookupReplicateTokenPricing(capped)
      : await lookupOpenRouterPricing(capped);
  // Ids past the abuse cap still get explicit null-priced entries.
  const rest = models
    .slice(200)
    .map((model) => ({ model, inputPerMTokens: null, outputPerMTokens: null }));
  res.json([...looked, ...rest]);
});

/**
 * GET /admin/video-model-pricing?models=owner/name,owner/name
 * Live Replicate pricing (scraped from public model pages) for the video
 * model dropdowns. Every submitted slug gets an entry (null when unknown).
 */
router.get("/admin/video-model-pricing", async (req: Request, res: Response) => {
  const raw = typeof req.query.models === "string" ? req.query.models : "";
  const models = [...new Set(raw.split(",").map((m) => m.trim()).filter(Boolean))];
  if (models.length === 0) {
    res.status(400).json({ error: "Provide at least one model slug in ?models=" });
    return;
  }
  const looked = (await lookupReplicateUnitPricing(models.slice(0, 50))).map((price) => ({
    model: price.model,
    price: formatPriceEntries(price.entries),
    variants: price.entries.map((entry) => {
      const value = Number(entry.price.replace(/[^0-9.]/g, ""));
      return {
        price: entry.price,
        title: entry.title,
        criteria: entry.criteria,
        usdPerSecond: /per second/i.test(entry.title) && Number.isFinite(value) ? value : null,
        usdPerVideo:
          /per (?:output )?video(?! second)|per run/i.test(entry.title) && Number.isFinite(value)
            ? value
            : null,
      };
    }),
  }));
  const rest = models.slice(50).map((model) => ({ model, price: null, variants: [] }));
  res.json([...looked, ...rest]);
});

/**
 * POST /admin/video-model-pricing
 * Refresh every KOKAO-owned Replicate video/lip-sync price from Replicate's
 * public model pages. Unknown pages remain unavailable; existing manual rows
 * are preserved and reported rather than overwritten with a guess.
 */
router.post("/admin/video-model-pricing", async (req: Request, res: Response) => {
  const result = await syncReplicateVideoPricing();
  try {
    await recordAdminAction({
      action: "ai_cost_change",
      actorTenantId: req.tenantId,
      actorEmail: req.tenantEmail,
      targetTenantId: null,
      targetEmail: null,
      oldValue: null,
      newValue: `replicate_video_bulk:${result.synced.length}:${result.manual.length}:${result.unavailable.length}`,
    });
  } catch (error) {
    req.log.error({ err: error }, "Failed to write Replicate video price sync audit log");
  }
  res.json(result);
});

/**
 * PUT /admin/text-gen-settings
 * Route caption/topic/campaign text through the built-in provider or
 * OpenRouter. Switching back to "builtin" is the rollback path.
 */
async function serializeCustomAiProviders() {
  return { providers: (await listCustomAiProviders()).map(customProviderView) };
}

/** Parse a route param that may be "3" or "custom:3". */
function customProviderIdParam(raw: string): number | null {
  const direct = Number(raw);
  if (Number.isInteger(direct) && direct > 0) return direct;
  return parseCustomProviderId(raw);
}

/** Use cases (text/image/video) the provider currently serves, by label. */
async function customProviderActiveUses(ref: string): Promise<string[]> {
  const [text, image, video] = await Promise.all([
    getTextGenSelection(),
    getImageGenSelection(),
    getVideoGenSelection(),
  ]);
  const uses: string[] = [];
  if (text.provider === ref) uses.push("text generation");
  if (image.provider === ref) uses.push("image generation");
  if (video.provider === ref) uses.push("video generation");
  return uses;
}

async function auditCustomProviderChange(
  req: Request,
  oldValue: string | null,
  newValue: string | null,
) {
  try {
    await recordAdminAction({
      action: "custom_ai_provider_change",
      actorTenantId: req.tenantId,
      actorEmail: req.tenantEmail,
      targetTenantId: null,
      targetEmail: null,
      oldValue,
      newValue,
    });
  } catch (error) {
    req.log.error({ err: error }, "Failed to write custom AI provider audit log");
  }
}

/**
 * GET /admin/custom-ai-providers
 * List admin-added OpenAI-compatible providers. Superadmin only.
 */
router.get("/admin/custom-ai-providers", async (_req: Request, res: Response) => {
  res.json(await serializeCustomAiProviders());
});

/**
 * POST /admin/custom-ai-providers
 * Add a custom provider. The base URL must be https and pass the shared
 * SSRF guard (public hosts only). Superadmin only.
 */
router.post("/admin/custom-ai-providers", async (req: Request, res: Response) => {
  const parsed = AdminCreateCustomAiProviderBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const name = parsed.data.name.trim();
  if (!name) {
    res.status(400).json({ error: "Name is required" });
    return;
  }
  let baseUrl: string;
  try {
    baseUrl = await validateCustomBaseUrl(parsed.data.baseUrl);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Invalid base URL" });
    return;
  }
  let videoApi;
  try {
    videoApi = validateVideoApiMapping(parsed.data.videoApi);
  } catch (error) {
    res
      .status(400)
      .json({ error: error instanceof Error ? error.message : "Invalid video API mapping" });
    return;
  }
  const row = await createCustomAiProvider({
    name,
    baseUrl,
    apiKey: parsed.data.apiKey?.trim() || null,
    textEnabled: parsed.data.textEnabled ?? false,
    imageEnabled: parsed.data.imageEnabled ?? false,
    videoEnabled: parsed.data.videoEnabled ?? false,
    videoApi,
  });
  await auditCustomProviderChange(req, null, `${customProviderRef(row.id)}:${row.name}`);
  res.json(await serializeCustomAiProviders());
});

/**
 * PUT /admin/custom-ai-providers/:providerId
 * Update a custom provider. Disabling a use case the provider currently
 * serves is refused — switch that use case away first. Superadmin only.
 */
router.put("/admin/custom-ai-providers/:providerId", async (req: Request, res: Response) => {
  const id = customProviderIdParam(req.params.providerId as string);
  const existing = id === null ? null : await getCustomAiProvider(id);
  if (!existing) {
    res.status(404).json({ error: "Unknown custom provider" });
    return;
  }
  const parsed = AdminUpdateCustomAiProviderBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const name = parsed.data.name.trim();
  if (!name) {
    res.status(400).json({ error: "Name is required" });
    return;
  }
  let baseUrl: string;
  try {
    baseUrl = await validateCustomBaseUrl(parsed.data.baseUrl);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Invalid base URL" });
    return;
  }
  const ref = customProviderRef(existing.id);
  const uses = await customProviderActiveUses(ref);
  const disabling = uses.filter(
    (use) =>
      (use === "text generation" && !(parsed.data.textEnabled ?? false)) ||
      (use === "image generation" && !(parsed.data.imageEnabled ?? false)) ||
      (use === "video generation" && !(parsed.data.videoEnabled ?? false)),
  );
  if (disabling.length > 0) {
    res.status(400).json({
      error: `This provider is currently selected for ${disabling.join(" and ")}. Switch that use case to another provider first.`,
    });
    return;
  }
  // undefined = keep the stored mapping; a value replaces it (validated —
  // template "openrouter" normalizes to null, the stored default).
  let videoApi;
  try {
    videoApi =
      parsed.data.videoApi === undefined
        ? undefined
        : validateVideoApiMapping(parsed.data.videoApi);
  } catch (error) {
    res
      .status(400)
      .json({ error: error instanceof Error ? error.message : "Invalid video API mapping" });
    return;
  }
  const row = await updateCustomAiProvider(existing.id, {
    name,
    baseUrl,
    // undefined = keep the stored key; null/"" clears it; a value replaces it.
    apiKey: parsed.data.apiKey === undefined ? undefined : parsed.data.apiKey?.trim() || null,
    textEnabled: parsed.data.textEnabled ?? false,
    imageEnabled: parsed.data.imageEnabled ?? false,
    videoEnabled: parsed.data.videoEnabled ?? false,
    videoApi,
  });
  if (row) {
    await auditCustomProviderChange(
      req,
      `${ref}:${existing.name}`,
      `${ref}:${row.name}`,
    );
  }
  res.json(await serializeCustomAiProviders());
});

/**
 * POST /admin/custom-ai-providers/:providerId/test
 * Run one cheap live request per enabled use case against the saved base
 * URL/key and report per-use-case pass/fail with the provider's own error
 * message. Superadmin only.
 */
router.post(
  "/admin/custom-ai-providers/:providerId/test",
  async (req: Request, res: Response) => {
    const id = customProviderIdParam(req.params.providerId as string);
    const existing = id === null ? null : await getCustomAiProvider(id);
    if (!existing) {
      res.status(404).json({ error: "Unknown custom provider" });
      return;
    }
    if (!existing.textEnabled && !existing.imageEnabled && !existing.videoEnabled) {
      res.status(400).json({
        error: "No use cases are enabled for this provider. Enable at least one, then test.",
      });
      return;
    }
    const results = await testCustomAiProvider(existing);
    res.json({ results });
  },
);

/**
 * DELETE /admin/custom-ai-providers/:providerId
 * Delete a custom provider, unless a use case still points at it. Superadmin only.
 */
router.delete("/admin/custom-ai-providers/:providerId", async (req: Request, res: Response) => {
  const id = customProviderIdParam(req.params.providerId as string);
  const existing = id === null ? null : await getCustomAiProvider(id);
  if (!existing) {
    res.status(404).json({ error: "Unknown custom provider" });
    return;
  }
  const ref = customProviderRef(existing.id);
  const uses = await customProviderActiveUses(ref);
  if (uses.length > 0) {
    res.status(400).json({
      error: `This provider is currently selected for ${uses.join(" and ")}. Switch that use case to another provider first.`,
    });
    return;
  }
  await deleteCustomAiProvider(existing.id);
  await auditCustomProviderChange(req, `${ref}:${existing.name}`, null);
  res.json(await serializeCustomAiProviders());
});

router.put("/admin/text-gen-settings", async (req: Request, res: Response) => {
  const parsed = AdminUpdateTextGenSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const provider = parsed.data.provider as TextGenProvider;
  const customTextRow =
    parseCustomProviderId(provider) !== null ? await resolveCustomProvider(provider) : null;
  if (!(TEXT_GEN_PROVIDERS as readonly string[]).includes(provider) && !customTextRow) {
    res.status(400).json({ error: "Unknown text generation provider" });
    return;
  }
  if (customTextRow && !customTextRow.textEnabled) {
    res.status(400).json({
      error: "This custom provider is not enabled for text generation. Enable it on its card first.",
    });
    return;
  }
  const models = (parsed.data.models ?? [])
    .map((m) => m.trim())
    .filter((m, i, all) => m.length > 0 && all.indexOf(m) === i)
    .slice(0, 20);
  const defaultModel = parsed.data.defaultModel?.trim() || null;
  if (provider !== "builtin") {
    const label =
      provider === "openrouter"
        ? "OpenRouter"
        : provider === "replicate"
          ? "Replicate"
          : provider === "nvidia"
            ? "NVIDIA"
          : (customTextRow?.name ?? "custom provider");
    if (models.length === 0) {
      res.status(400).json({ error: `Add at least one ${label} model id` });
      return;
    }
    if (defaultModel && !models.includes(defaultModel)) {
      res.status(400).json({ error: "The default model must be one of the listed models" });
      return;
    }
    if (provider === "openrouter" && models.some(isBatchOnlyTextModel)) {
      res.status(400).json({
        error:
          "Batch-only OpenRouter models cannot be used for live text generation. Remove the :batch variant or choose a real-time model.",
      });
      return;
    }
    if (provider === "replicate" && models.some((m) => !/^[^/\s]+\/[^/\s]+$/.test(m))) {
      res.status(400).json({ error: "Replicate models must be owner/name slugs" });
      return;
    }
    if (provider === "nvidia") {
      // Do not route NVIDIA through the Replicate-key/catalog activation path.
      // This checks only the canonical NVIDIA text deployment and its exact
      // NVIDIA pricing record. Multimodal is selected per image-part request.
      const nvidiaError = await validateNvidiaTextActivation(models);
      if (nvidiaError) {
        res.status(400).json({ error: nvidiaError });
        return;
      }
    } else {
      // Custom providers keep their (optional) key on their own row — no key
      // gate here, keyless self-hosted endpoints are allowed.
      const keySource = customTextRow
        ? "database"
        : provider === "openrouter"
          ? await getOpenRouterKeySource()
          : await getReplicateTextKeySource();
      if (!keySource) {
        res.status(400).json({
          error:
            provider === "openrouter"
              ? "Save an OpenRouter API key before switching text generation to OpenRouter"
              : "Save a Replicate API key (under Video Generation) before switching text generation to Replicate",
        });
        return;
      }
    }
  }

  // Activation gate: every model must have a price (live catalog or manual
  // row) so actual-cost tracking never runs blind. Catalog hits are synced
  // into ai_model_prices as part of this call.
  let pricingWarning: string | null = null;
  if (provider !== "builtin" && provider !== "nvidia") {
    const { missing, crossSourced } = await syncActivatedModelPricing({ kind: "text", provider, models });
    if (missing.length > 0) {
      res.status(400).json({
        error: missingPricingError(missing.map((m) => ({ model: m, kind: "text" as const }))),
      });
      return;
    }
    pricingWarning = crossSourcePricingWarning(provider, crossSourced);
  }

  const before = await getTextGenSelection();
  await setTextGenSelection({
    provider,
    models: provider !== "builtin" ? models : [],
    defaultModel: provider !== "builtin" ? (defaultModel ?? models[0] ?? null) : null,
  });

  const after = await getTextGenSelection();
  const changed =
    before.provider !== after.provider ||
    before.defaultModel !== after.defaultModel ||
    before.models.join(",") !== after.models.join(",");
  if (changed) {
    try {
      await recordAdminAction({
        action: "textgen_provider_change",
        actorTenantId: req.tenantId,
        actorEmail: req.tenantEmail,
        targetTenantId: null,
        targetEmail: null,
        oldValue: `${before.provider}${before.defaultModel ? `:${before.defaultModel}` : ""}`,
        newValue: `${after.provider}${after.defaultModel ? `:${after.defaultModel}` : ""}`,
      });
    } catch (error) {
      req.log.error({ err: error }, "Failed to write text-gen settings audit log");
    }
  }

  res.json({ ...(await serializeTextGenSettings()), pricingWarning });
});

/**
 * PUT /admin/text-gen-key
 * Save the OpenRouter API key (encrypted at rest). Superadmin only.
 */
router.put("/admin/text-gen-key", async (req: Request, res: Response) => {
  const parsed = AdminSetTextGenKeyBody.safeParse(req.body);
  const apiKey = parsed.success ? parsed.data.apiKey.trim() : "";
  if (!apiKey) {
    res.status(400).json({ error: "API key is required" });
    return;
  }
  await setStoredOpenRouterKey(apiKey);
  try {
    await recordAdminAction({
      action: "textgen_key_change",
      actorTenantId: req.tenantId,
      actorEmail: req.tenantEmail,
      targetTenantId: null,
      targetEmail: null,
      oldValue: null,
      newValue: "openrouter:set",
    });
  } catch (error) {
    req.log.error({ err: error }, "Failed to write text-gen key audit log");
  }
  res.json(await serializeTextGenSettings());
});

/**
 * DELETE /admin/text-gen-key
 * Remove the saved key (the env secret, if set, becomes the fallback).
 */
router.delete("/admin/text-gen-key", async (req: Request, res: Response) => {
  await clearStoredOpenRouterKey();
  try {
    await recordAdminAction({
      action: "textgen_key_change",
      actorTenantId: req.tenantId,
      actorEmail: req.tenantEmail,
      targetTenantId: null,
      targetEmail: null,
      oldValue: null,
      newValue: "openrouter:cleared",
    });
  } catch (error) {
    req.log.error({ err: error }, "Failed to write text-gen key audit log");
  }
  res.json(await serializeTextGenSettings());
});

/**
 * GET /admin/features
 * Platform-wide feature switches with labels, for the admin toggle card.
 */
router.get("/admin/features", async (_req: Request, res: Response) => {
  const flags = await getFeatureFlags();
  res.json(
    FEATURES.map((f) => ({
      feature: f.id,
      label: f.label,
      description: f.description,
      enabled: flags[f.id],
    })),
  );
});

/**
 * PUT /admin/features/:feature
 * Turn an app module on or off for every tenant on the platform.
 */
router.put(
  "/admin/features/:feature",
  async (req: Request, res: Response) => {
    const feature = String(req.params.feature);
    if (!isKnownFeature(feature)) {
      res.status(400).json({ error: "Unknown feature" });
      return;
    }
    const parsed = AdminUpdateFeatureFlagBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }

    const before = (await getFeatureFlags())[feature];
    await db
      .insert(featureFlagsTable)
      .values({ feature, enabled: parsed.data.enabled })
      .onConflictDoUpdate({
        target: featureFlagsTable.feature,
        set: { enabled: parsed.data.enabled, updatedAt: new Date() },
      });
    invalidateFeatureFlagCache();

    if (before !== parsed.data.enabled) {
      try {
        await recordAdminAction({
          action: "feature_flag_change",
          actorTenantId: req.tenantId,
          actorEmail: req.tenantEmail,
          targetTenantId: null,
          targetEmail: null,
          oldValue: `${feature}:${before ? "enabled" : "disabled"}`,
          newValue: `${feature}:${parsed.data.enabled ? "enabled" : "disabled"}`,
        });
      } catch (error) {
        req.log.error({ err: error }, "Failed to write feature-flag audit log");
      }
    }

    const def = FEATURES.find((f) => f.id === feature)!;
    res.json({
      feature,
      label: def.label,
      description: def.description,
      enabled: parsed.data.enabled,
    });
  },
);

/**
 * GET /admin/design-skill
 * The global switch for the canvas-design image prompt skill.
 */
router.get("/admin/design-skill", async (_req: Request, res: Response) => {
  res.json({ enabled: await getGlobalDesignSkillEnabled() });
});

/**
 * PUT /admin/design-skill
 * Enable or disable the design skill platform-wide (tenant overrides still win).
 */
router.put("/admin/design-skill", async (req: Request, res: Response) => {
  const parsed = AdminUpdateDesignSkillBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }

  const before = await getGlobalDesignSkillEnabled();
  const row = await loadDesignSkillRow();
  if (row) {
    await db
      .update(designSkillSettingsTable)
      .set({ enabled: parsed.data.enabled })
      .where(eq(designSkillSettingsTable.id, row.id));
  } else {
    await db.insert(designSkillSettingsTable).values({ enabled: parsed.data.enabled });
  }

  if (before !== parsed.data.enabled) {
    try {
      await recordAdminAction({
        action: "design_skill_change",
        actorTenantId: req.tenantId,
        actorEmail: req.tenantEmail,
        targetTenantId: null,
        targetEmail: null,
        oldValue: String(before),
        newValue: String(parsed.data.enabled),
      });
    } catch (error) {
      req.log.error({ err: error }, "Failed to write design-skill audit log");
    }
  }

  res.json({ enabled: parsed.data.enabled });
});

const invalidLimit = (n: number) =>
  !Number.isInteger(n) || (n < 0 && n !== -1);

function invalidLimits(limits: {
  captions: number;
  images: number;
  /** Optional so pre-video admin clients keep working. */
  videos?: number;
  brandKits: number;
  scheduledPosts: number;
}): boolean {
  return (
    invalidLimit(limits.captions) ||
    invalidLimit(limits.images) ||
    (limits.videos !== undefined && invalidLimit(limits.videos)) ||
    invalidLimit(limits.brandKits) ||
    invalidLimit(limits.scheduledPosts)
  );
}

/**
 * PUT /admin/plans/:planId
 * Superadmin edit of a subscription plan's name, price label, limits, and
 * feature list. Works for both built-in and custom plans; the row in
 * plan_settings overrides or defines the plan. Returns the full catalog.
 */
router.put("/admin/plans/:planId", async (req: Request, res: Response) => {
  const planId = String(req.params.planId);
  const catalog = await listPlans();
  const previous = catalog.find((p) => p.id === planId);
  if (!previous) {
    res.status(404).json({ error: "Unknown plan" });
    return;
  }

  const parsed = AdminUpdatePlanBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }

  const {
    name,
    priceLabel,
    limits,
    features,
    teamSeats,
    priceInr,
    priceInrYearly,
    watermark,
    billingMode,
  } = parsed.data;
  if (invalidLimits(limits)) {
    res
      .status(400)
      .json({ error: "Limits must be whole numbers (use -1 for unlimited)" });
    return;
  }
  if (teamSeats !== undefined && !Number.isInteger(teamSeats)) {
    res.status(400).json({ error: "Team seats must be a whole number" });
    return;
  }
  if (
    (priceInr !== undefined &&
      priceInr !== null &&
      (!Number.isInteger(priceInr) || priceInr <= 0)) ||
    (priceInrYearly !== undefined &&
      priceInrYearly !== null &&
      (!Number.isInteger(priceInrYearly) || priceInrYearly <= 0))
  ) {
    res
      .status(400)
      .json({ error: "Price must be a positive whole number of paise" });
    return;
  }

  // Razorpay sync: a new or changed INR price mints a fresh Razorpay Plan
  // (Razorpay plans are immutable, so price changes always create a new one).
  // Clearing the price detaches the plan from online purchase.
  const nextPriceInr = priceInr === undefined ? previous.priceInr : priceInr;
  const nextPriceInrYearly =
    priceInrYearly === undefined ? previous.priceInrYearly : priceInrYearly;
  if (nextPriceInrYearly !== null && nextPriceInr === null) {
    res.status(400).json({
      error: "Set a monthly price before adding a yearly price.",
    });
    return;
  }
  // The current gateway plan ids live on the DB row (the Plan catalog only
  // exposes Razorpay ids), so read the row to know the existing Cashfree ids.
  const previousRow = (
    await db
      .select()
      .from(planSettingsTable)
      .where(eq(planSettingsTable.id, planId))
      .limit(1)
  )[0];
  const activeGateway = await getActiveGateway();

  let nextRazorpayPlanId = previous.razorpayPlanId;
  let nextRazorpayPlanIdYearly = previous.razorpayPlanIdYearly;
  let nextCashfreePlanId = previousRow?.cashfreePlanId ?? null;
  let nextCashfreePlanIdYearly = previousRow?.cashfreePlanIdYearly ?? null;
  const needsMonthlyMint =
    nextPriceInr !== null &&
    (nextPriceInr !== previous.priceInr ||
      (activeGateway === "razorpay" ? !nextRazorpayPlanId : !nextCashfreePlanId));
  const needsYearlyMint =
    nextPriceInrYearly !== null &&
    (nextPriceInrYearly !== previous.priceInrYearly ||
      (activeGateway === "razorpay"
        ? !nextRazorpayPlanIdYearly
        : !nextCashfreePlanIdYearly));
  const monthlyPriceChanged = nextPriceInr !== previous.priceInr;
  const yearlyPriceChanged = nextPriceInrYearly !== previous.priceInrYearly;
  // A price change (or a cleared price) makes BOTH gateways' ids for that
  // cycle stale — the old immutable plan would charge the old price. Drop
  // them; the active gateway re-mints a fresh id below, the inactive gateway
  // stays null and is minted lazily at first purchase on that gateway.
  if (nextPriceInr === null || monthlyPriceChanged) {
    nextRazorpayPlanId = null;
    nextCashfreePlanId = null;
  }
  if (nextPriceInrYearly === null || yearlyPriceChanged) {
    nextRazorpayPlanIdYearly = null;
    nextCashfreePlanIdYearly = null;
  }
  // Without the active gateway's keys the plan still saves — the price is
  // stored and the plan is minted lazily (next priced save with keys, or at
  // first purchase attempt). Crucially, a cycle that NEEDS a fresh mint must
  // drop its stale id: keeping the old plan would charge the old price.
  if (needsMonthlyMint || needsYearlyMint) {
    if (activeGateway === "cashfree") {
      if (!(await isCashfreeConfigured())) {
        if (needsMonthlyMint) nextCashfreePlanId = null;
        if (needsYearlyMint) nextCashfreePlanIdYearly = null;
      } else {
        try {
          if (needsMonthlyMint) {
            const cfPlan = await createCashfreePlan({
              planId,
              name: name.trim(),
              amountPaise: nextPriceInr!,
              intervalType: "MONTH",
            });
            nextCashfreePlanId = cfPlan.plan_id;
          }
          if (needsYearlyMint) {
            const cfPlanYearly = await createCashfreePlan({
              planId,
              name: name.trim(),
              amountPaise: nextPriceInrYearly!,
              intervalType: "YEAR",
            });
            nextCashfreePlanIdYearly = cfPlanYearly.plan_id;
          }
        } catch (error) {
          req.log.error({ err: error }, "Failed to create Cashfree plan");
          res.status(502).json({ error: gatewayPlanError("Cashfree", error) });
          return;
        }
      }
    } else if (!(await isRazorpayConfigured())) {
      if (needsMonthlyMint) nextRazorpayPlanId = null;
      if (needsYearlyMint) nextRazorpayPlanIdYearly = null;
    } else {
      try {
        if (needsMonthlyMint) {
          const rzpPlan = await createRazorpayPlan(name.trim(), nextPriceInr!);
          nextRazorpayPlanId = rzpPlan.id;
        }
        if (needsYearlyMint) {
          const rzpPlanYearly = await createRazorpayPlan(
            name.trim(),
            nextPriceInrYearly!,
            "yearly",
          );
          nextRazorpayPlanIdYearly = rzpPlanYearly.id;
        }
      } catch (error) {
        req.log.error({ err: error }, "Failed to create Razorpay plan");
        res.status(502).json({ error: gatewayPlanError("Razorpay", error) });
        return;
      }
    }
  }

  const values = {
    id: planId,
    name: name.trim(),
    priceLabel: priceLabel.trim(),
    priceInr: nextPriceInr,
    razorpayPlanId: nextRazorpayPlanId,
    cashfreePlanId: nextCashfreePlanId,
    priceInrYearly: nextPriceInrYearly,
    razorpayPlanIdYearly: nextRazorpayPlanIdYearly,
    cashfreePlanIdYearly: nextCashfreePlanIdYearly,
    teamSeats: teamSeats ?? previous.teamSeats,
    captions: limits.captions,
    images: limits.images,
    // Omitted by older admin clients: keep the plan's current video limit.
    videos: limits.videos ?? previous.limits.videos,
    brandKits: limits.brandKits,
    scheduledPosts: limits.scheduledPosts,
    // Omitted by older admin clients: keep the plan's current setting.
    watermark: watermark ?? previous.watermark,
    billingMode: billingMode ?? previous.billingMode,
    features: features.map((f) => f.trim()).filter(Boolean),
    sortOrder: catalog.findIndex((p) => p.id === planId),
    archived: false,
    updatedAt: new Date(),
  };

  await db
    .insert(planSettingsTable)
    .values(values)
    .onConflictDoUpdate({ target: planSettingsTable.id, set: values });

  invalidatePlanCache();

  try {
    await recordAdminAction({
      action: "plan_edit",
      actorTenantId: req.tenantId,
      actorEmail: req.tenantEmail,
      targetTenantId: null,
      targetEmail: null,
      oldValue: JSON.stringify({
        ...previous.limits,
        watermark: previous.watermark,
        billingMode: previous.billingMode,
      }),
      newValue: JSON.stringify({
        ...limits,
        watermark: watermark ?? previous.watermark,
        billingMode: billingMode ?? previous.billingMode,
      }),
    });
  } catch (error) {
    req.log.error({ err: error }, "Failed to write plan-edit audit log");
  }

  res.json(await listPlans());
});

/**
 * POST /admin/plans
 * Superadmin creation of a new custom subscription plan. The id is either
 * provided (url-safe) or derived from the name; it must not collide with an
 * existing catalog plan or a built-in default id (even a deleted one keeps
 * its id reserved to avoid resurrecting defaults unexpectedly).
 */
router.post("/admin/plans", async (req: Request, res: Response) => {
  const parsed = AdminCreatePlanBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }

  const {
    name,
    priceLabel,
    limits,
    features,
    teamSeats,
    priceInr,
    priceInrYearly,
    watermark,
    billingMode,
  } = parsed.data;
  if (teamSeats !== undefined && !Number.isInteger(teamSeats)) {
    res.status(400).json({ error: "Team seats must be a whole number" });
    return;
  }
  if (invalidLimits(limits)) {
    res
      .status(400)
      .json({ error: "Limits must be whole numbers (use -1 for unlimited)" });
    return;
  }
  if (
    (priceInr !== undefined &&
      priceInr !== null &&
      (!Number.isInteger(priceInr) || priceInr <= 0)) ||
    (priceInrYearly !== undefined &&
      priceInrYearly !== null &&
      (!Number.isInteger(priceInrYearly) || priceInrYearly <= 0))
  ) {
    res
      .status(400)
      .json({ error: "Price must be a positive whole number of paise" });
    return;
  }

  const id =
    parsed.data.id ??
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
  if (!id) {
    res.status(400).json({ error: "Plan name must contain letters or digits" });
    return;
  }

  const catalog = await listPlans();
  const existingRow = (
    await db
      .select({ id: planSettingsTable.id })
      .from(planSettingsTable)
      .where(eq(planSettingsTable.id, id))
  )[0];
  if (
    catalog.some((p) => p.id === id) ||
    DEFAULT_PLAN_IDS.includes(id) ||
    existingRow
  ) {
    res.status(409).json({ error: "A plan with this id already exists" });
    return;
  }

  // Razorpay sync: a plan created WITH a price is purchasable immediately —
  // mint the matching Razorpay Plan before inserting the row, exactly like
  // a price change on update does.
  const newPriceInr = priceInr ?? null;
  const newPriceInrYearly = priceInrYearly ?? null;
  if (newPriceInrYearly !== null && newPriceInr === null) {
    res.status(400).json({
      error: "Set a monthly price before adding a yearly price.",
    });
    return;
  }
  let newRazorpayPlanId: string | null = null;
  let newRazorpayPlanIdYearly: string | null = null;
  let newCashfreePlanId: string | null = null;
  let newCashfreePlanIdYearly: string | null = null;
  const activeGateway = await getActiveGateway();
  // Like plan updates: missing keys for the active gateway never block the
  // save; the plan is minted lazily once keys exist. Only the ACTIVE gateway
  // mints on save — the other is left null and minted at first purchase.
  if (newPriceInr !== null && activeGateway === "cashfree") {
    if (await isCashfreeConfigured()) {
      try {
        const cfPlan = await createCashfreePlan({
          planId: id,
          name: name.trim(),
          amountPaise: newPriceInr,
          intervalType: "MONTH",
        });
        newCashfreePlanId = cfPlan.plan_id;
        if (newPriceInrYearly !== null) {
          const cfPlanYearly = await createCashfreePlan({
            planId: id,
            name: name.trim(),
            amountPaise: newPriceInrYearly,
            intervalType: "YEAR",
          });
          newCashfreePlanIdYearly = cfPlanYearly.plan_id;
        }
      } catch (error) {
        req.log.error({ err: error }, "Failed to create Cashfree plan");
        res.status(502).json({ error: gatewayPlanError("Cashfree", error) });
        return;
      }
    }
  } else if (newPriceInr !== null && (await isRazorpayConfigured())) {
    try {
      const rzpPlan = await createRazorpayPlan(name.trim(), newPriceInr);
      newRazorpayPlanId = rzpPlan.id;
      if (newPriceInrYearly !== null) {
        const rzpPlanYearly = await createRazorpayPlan(
          name.trim(),
          newPriceInrYearly,
          "yearly",
        );
        newRazorpayPlanIdYearly = rzpPlanYearly.id;
      }
    } catch (error) {
      req.log.error({ err: error }, "Failed to create Razorpay plan");
      res.status(502).json({ error: gatewayPlanError("Razorpay", error) });
      return;
    }
  }

  await db.insert(planSettingsTable).values({
    id,
    name: name.trim(),
    priceLabel: priceLabel.trim(),
    priceInr: newPriceInr,
    razorpayPlanId: newRazorpayPlanId,
    cashfreePlanId: newCashfreePlanId,
    priceInrYearly: newPriceInrYearly,
    razorpayPlanIdYearly: newRazorpayPlanIdYearly,
    cashfreePlanIdYearly: newCashfreePlanIdYearly,
    teamSeats: teamSeats ?? 0,
    captions: limits.captions,
    images: limits.images,
    videos: limits.videos ?? 0,
    brandKits: limits.brandKits,
    scheduledPosts: limits.scheduledPosts,
    watermark: watermark ?? false,
    billingMode: billingMode ?? "quota",
    features: features.map((f) => f.trim()).filter(Boolean),
    sortOrder: catalog.length,
    archived: false,
  });

  invalidatePlanCache();

  try {
    await recordAdminAction({
      action: "plan_create",
      actorTenantId: req.tenantId,
      actorEmail: req.tenantEmail,
      targetTenantId: null,
      targetEmail: null,
      oldValue: null,
      newValue: JSON.stringify({
        id,
        name: name.trim(),
        limits,
        watermark: watermark ?? false,
        billingMode: billingMode ?? "quota",
      }),
    });
  } catch (error) {
    req.log.error({ err: error }, "Failed to write plan-create audit log");
  }

  res.json(await listPlans());
});

/**
 * DELETE /admin/plans/:planId
 * Superadmin deletion of a subscription plan. Guarded: the fallback plan
 * (new signups land there) cannot be deleted, and a plan still assigned to
 * any workspace cannot be deleted until those workspaces are moved. Built-in
 * defaults are removed via an archived marker row; custom plans are deleted
 * outright.
 */
router.delete("/admin/plans/:planId", async (req: Request, res: Response) => {
  const planId = String(req.params.planId);

  if (planId === FALLBACK_PLAN_ID) {
    res.status(400).json({
      error: "The Free plan is the default for new signups and cannot be deleted",
    });
    return;
  }

  const catalog = await listPlans();
  const existing = catalog.find((p) => p.id === planId);
  if (!existing) {
    res.status(404).json({ error: "Unknown plan" });
    return;
  }

  const inUse = (
    await db
      .select({ count: sql<number>`count(*)::int` })
      .from(tenantsTable)
      .where(eq(tenantsTable.plan, planId))
  )[0];
  if ((inUse?.count ?? 0) > 0) {
    res.status(400).json({
      error: `Cannot delete: ${inUse!.count} workspace(s) are on this plan. Move them to another plan first.`,
    });
    return;
  }

  if (DEFAULT_PLAN_IDS.includes(planId)) {
    // Built-in default: mark as archived so it stays deleted.
    const values = {
      id: planId,
      name: existing.name,
      priceLabel: existing.priceLabel,
      teamSeats: existing.teamSeats,
      captions: existing.limits.captions,
      images: existing.limits.images,
      brandKits: existing.limits.brandKits,
      scheduledPosts: existing.limits.scheduledPosts,
      features: existing.features,
      archived: true,
      updatedAt: new Date(),
    };
    await db
      .insert(planSettingsTable)
      .values(values)
      .onConflictDoUpdate({ target: planSettingsTable.id, set: values });
  } else {
    await db.delete(planSettingsTable).where(eq(planSettingsTable.id, planId));
  }

  invalidatePlanCache();

  try {
    await recordAdminAction({
      action: "plan_delete",
      actorTenantId: req.tenantId,
      actorEmail: req.tenantEmail,
      targetTenantId: null,
      targetEmail: null,
      oldValue: JSON.stringify({ id: planId, name: existing.name }),
      newValue: null,
    });
  } catch (error) {
    req.log.error({ err: error }, "Failed to write plan-delete audit log");
  }

  res.json(await listPlans());
});

// ---------------------------------------------------------------------------
// Gamification: per-plan quest/streak/referral configuration
// ---------------------------------------------------------------------------

/** One list shape shared by GET and both mutations: every catalog plan with
 * its effective settings (stored row or the defaults) and whether a row
 * exists. Custom plans created later appear here automatically. */
async function listGamificationPlans() {
  const plans = await listPlans();
  const rows = await db.select().from(gamificationPlanSettingsTable);
  const byId = new Map(rows.map((r) => [r.planId, r]));
  return plans.map((p) => {
    const row = byId.get(p.id);
    return {
      planId: p.id,
      planName: p.name,
      customized: !!row,
      settings: row ? rowToPlanGamification(row) : { ...DEFAULT_PLAN_GAMIFICATION },
    };
  });
}

router.get("/admin/gamification-plans", async (_req: Request, res: Response) => {
  res.json(await listGamificationPlans());
});

/**
 * PUT /admin/gamification-plans/:planId
 * Upsert one plan's gamification settings (toggles, reward multiplier,
 * referral amounts). The plan id is validated against the live catalog.
 */
router.put("/admin/gamification-plans/:planId", async (req: Request, res: Response) => {
  const planId = String(req.params.planId);
  const catalog = await listPlans();
  if (!catalog.some((p) => p.id === planId)) {
    res.status(404).json({ error: "Unknown plan" });
    return;
  }
  const parsed = AdminUpdateGamificationPlanBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const s = parsed.data;
  const nonNegative = [
    s.referrerCaptionCredits,
    s.referrerImageCredits,
    s.refereeCaptionCredits,
    s.refereeImageCredits,
  ];
  if (
    nonNegative.some((n) => !Number.isInteger(n) || n < 0) ||
    !Number.isInteger(s.rewardMultiplierPercent) ||
    s.rewardMultiplierPercent < 0 ||
    s.rewardMultiplierPercent > 1000 ||
    !Number.isInteger(s.referralMaxRedemptions) ||
    s.referralMaxRedemptions < 1 ||
    s.referralMaxRedemptions > 10000
  ) {
    res.status(400).json({
      error:
        "Credits must be whole numbers >= 0, the multiplier 0-1000%, and the referral cap 1-10000.",
    });
    return;
  }

  const values = {
    planId,
    questsEnabled: s.questsEnabled,
    streaksEnabled: s.streaksEnabled,
    referralsEnabled: s.referralsEnabled,
    progressMeterEnabled: s.progressMeterEnabled,
    rewardMultiplierPercent: s.rewardMultiplierPercent,
    referrerCaptionCredits: s.referrerCaptionCredits,
    referrerImageCredits: s.referrerImageCredits,
    refereeCaptionCredits: s.refereeCaptionCredits,
    refereeImageCredits: s.refereeImageCredits,
    referralMaxRedemptions: s.referralMaxRedemptions,
    updatedAt: new Date(),
  };
  await db
    .insert(gamificationPlanSettingsTable)
    .values(values)
    .onConflictDoUpdate({ target: gamificationPlanSettingsTable.planId, set: values });

  try {
    await recordAdminAction({
      action: "gamification_plan_change",
      actorTenantId: req.tenantId,
      actorEmail: req.tenantEmail,
      targetTenantId: null,
      targetEmail: null,
      oldValue: null,
      newValue: JSON.stringify({ planId, ...s }),
    });
  } catch (error) {
    req.log.error({ err: error }, "Failed to write gamification audit log");
  }

  res.json(await listGamificationPlans());
});

/**
 * DELETE /admin/gamification-plans/:planId
 * Remove the plan's custom row so the built-in defaults apply again.
 */
router.delete(
  "/admin/gamification-plans/:planId",
  async (req: Request, res: Response) => {
    const planId = String(req.params.planId);
    await db
      .delete(gamificationPlanSettingsTable)
      .where(eq(gamificationPlanSettingsTable.planId, planId));
    try {
      await recordAdminAction({
        action: "gamification_plan_change",
        actorTenantId: req.tenantId,
        actorEmail: req.tenantEmail,
        targetTenantId: null,
        targetEmail: null,
        oldValue: planId,
        newValue: "reset_to_defaults",
      });
    } catch (error) {
      req.log.error({ err: error }, "Failed to write gamification audit log");
    }
    res.json(await listGamificationPlans());
  },
);

// ---------------------------------------------------------------------------
// Billing: credit packs (superadmin-defined) + manual credit grants
// ---------------------------------------------------------------------------

function serializeCreditPack(p: typeof creditPacksTable.$inferSelect) {
  return {
    id: p.id,
    name: p.name,
    pricePaise: p.pricePaise,
    captionCredits: p.captionCredits,
    imageCredits: p.imageCredits,
    videoCredits: p.videoCredits,
    active: p.active,
    sortOrder: p.sortOrder,
  };
}

async function listAllCreditPacks() {
  const rows = await db
    .select()
    .from(creditPacksTable)
    .orderBy(creditPacksTable.sortOrder, creditPacksTable.id);
  return rows.map(serializeCreditPack);
}

const invalidPack = (b: {
  name: string;
  pricePaise: number;
  captionCredits: number;
  imageCredits: number;
  videoCredits?: number;
}) =>
  !b.name.trim() ||
  !Number.isInteger(b.pricePaise) ||
  b.pricePaise <= 0 ||
  !Number.isInteger(b.captionCredits) ||
  b.captionCredits < 0 ||
  !Number.isInteger(b.imageCredits) ||
  b.imageCredits < 0 ||
  (b.videoCredits !== undefined &&
    (!Number.isInteger(b.videoCredits) || b.videoCredits < 0)) ||
  (b.captionCredits === 0 && b.imageCredits === 0 && (b.videoCredits ?? 0) === 0);

/** GET /admin/credit-packs — all packs, including inactive. */
router.get("/admin/credit-packs", async (_req: Request, res: Response) => {
  res.json(await listAllCreditPacks());
});

/** POST /admin/credit-packs — create a purchasable credit pack. */
router.post("/admin/credit-packs", async (req: Request, res: Response) => {
  const parsed = AdminCreateCreditPackBody.safeParse(req.body);
  if (!parsed.success || invalidPack(parsed.data)) {
    res.status(400).json({
      error:
        "A pack needs a name, a positive price in paise, and at least one credit.",
    });
    return;
  }
  const count = (
    await db.select({ count: sql<number>`count(*)::int` }).from(creditPacksTable)
  )[0];
  const created = (
    await db
      .insert(creditPacksTable)
      .values({
        name: parsed.data.name.trim(),
        pricePaise: parsed.data.pricePaise,
        captionCredits: parsed.data.captionCredits,
        imageCredits: parsed.data.imageCredits,
        videoCredits: parsed.data.videoCredits ?? 0,
        active: parsed.data.active ?? true,
        sortOrder: count?.count ?? 0,
      })
      .returning()
  )[0];
  try {
    await recordAdminAction({
      action: "credit_pack_change",
      actorTenantId: req.tenantId,
      actorEmail: req.tenantEmail,
      targetTenantId: null,
      targetEmail: null,
      oldValue: null,
      newValue: JSON.stringify(created ? serializeCreditPack(created) : null),
    });
  } catch (error) {
    req.log.error({ err: error }, "Failed to write credit-pack audit log");
  }
  res.json(await listAllCreditPacks());
});

/** PUT /admin/credit-packs/:id — edit a credit pack. */
router.put("/admin/credit-packs/:id", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const parsed = AdminUpdateCreditPackBody.safeParse(req.body);
  if (!parsed.success || invalidPack(parsed.data)) {
    res.status(400).json({
      error:
        "A pack needs a name, a positive price in paise, and at least one credit.",
    });
    return;
  }
  const previous = (
    await db.select().from(creditPacksTable).where(eq(creditPacksTable.id, id)).limit(1)
  )[0];
  if (!previous) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const updated = (
    await db
      .update(creditPacksTable)
      .set({
        name: parsed.data.name.trim(),
        pricePaise: parsed.data.pricePaise,
        captionCredits: parsed.data.captionCredits,
        imageCredits: parsed.data.imageCredits,
        videoCredits: parsed.data.videoCredits ?? previous.videoCredits,
        active: parsed.data.active ?? previous.active,
        updatedAt: new Date(),
      })
      .where(eq(creditPacksTable.id, id))
      .returning()
  )[0];
  try {
    await recordAdminAction({
      action: "credit_pack_change",
      actorTenantId: req.tenantId,
      actorEmail: req.tenantEmail,
      targetTenantId: null,
      targetEmail: null,
      oldValue: JSON.stringify(serializeCreditPack(previous)),
      newValue: JSON.stringify(updated ? serializeCreditPack(updated) : null),
    });
  } catch (error) {
    req.log.error({ err: error }, "Failed to write credit-pack audit log");
  }
  res.json(await listAllCreditPacks());
});

/**
 * DELETE /admin/credit-packs/:id — retire a credit pack. Rows are soft-
 * deactivated (never hard-deleted) so the credit ledger's pack references
 * stay resolvable.
 */
router.delete("/admin/credit-packs/:id", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const previous = (
    await db.select().from(creditPacksTable).where(eq(creditPacksTable.id, id)).limit(1)
  )[0];
  if (!previous) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  await db
    .update(creditPacksTable)
    .set({ active: false, updatedAt: new Date() })
    .where(eq(creditPacksTable.id, id));
  try {
    await recordAdminAction({
      action: "credit_pack_change",
      actorTenantId: req.tenantId,
      actorEmail: req.tenantEmail,
      targetTenantId: null,
      targetEmail: null,
      oldValue: JSON.stringify(serializeCreditPack(previous)),
      newValue: JSON.stringify({ ...serializeCreditPack(previous), active: false }),
    });
  } catch (error) {
    req.log.error({ err: error }, "Failed to write credit-pack audit log");
  }
  res.json(await listAllCreditPacks());
});

// ---------------------------------------------------------------------------
// Promo codes (superadmin-defined credit giveaways)
// ---------------------------------------------------------------------------

function serializePromoCode(p: PromoCode) {
  return {
    id: p.id,
    code: p.code,
    campaign: p.campaign,
    captionCredits: p.captionCredits,
    imageCredits: p.imageCredits,
    videoCredits: p.videoCredits,
    allowedPlans: p.allowedPlans,
    audience: p.audience as "all" | "new" | "existing",
    newTenantDays: p.newTenantDays,
    maxRedemptions: p.maxRedemptions,
    perTenantLimit: p.perTenantLimit,
    redemptionCount: p.redemptionCount,
    startsAt: p.startsAt?.toISOString() ?? null,
    expiresAt: p.expiresAt?.toISOString() ?? null,
    active: p.active,
    batchId: p.batchId,
    note: p.note,
    createdAt: p.createdAt.toISOString(),
  };
}

function parsePromoDate(
  value: string | null | undefined,
): Date | null | undefined | "invalid" {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "invalid" : d;
}

async function auditPromoChange(
  req: Request,
  oldValue: PromoCode | null,
  newValue: ReturnType<typeof serializePromoCode> | { batchId: string; count: number } | null,
) {
  try {
    await recordAdminAction({
      action: "promo_code_change",
      actorTenantId: req.tenantId,
      actorEmail: req.tenantEmail,
      targetTenantId: null,
      targetEmail: null,
      oldValue: oldValue ? JSON.stringify(serializePromoCode(oldValue)) : null,
      newValue: newValue ? JSON.stringify(newValue) : null,
    });
  } catch (error) {
    req.log.error({ err: error }, "Failed to write promo-code audit log");
  }
}

/** GET /admin/promo-codes — every code, newest first. */
router.get("/admin/promo-codes", async (_req: Request, res: Response) => {
  const rows = await db
    .select()
    .from(promoCodesTable)
    .orderBy(desc(promoCodesTable.createdAt), desc(promoCodesTable.id));
  res.json(rows.map(serializePromoCode));
});

/**
 * POST /admin/promo-codes — create one code (explicit `code`) or bulk-
 * generate a batch (`generateCount`, optional `prefix`). Returns the created
 * code(s) so a batch can be exported immediately.
 */
router.post("/admin/promo-codes", async (req: Request, res: Response) => {
  const parsed = AdminCreatePromoCodesBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const b = parsed.data;
  if (
    (b.captionCredits ?? 0) <= 0 &&
    (b.imageCredits ?? 0) <= 0 &&
    (b.videoCredits ?? 0) <= 0
  ) {
    res.status(400).json({ error: "A promo code must grant at least one credit." });
    return;
  }
  const hasCode = typeof b.code === "string" && b.code.trim().length > 0;
  const count = b.generateCount ?? 0;
  if (hasCode === (count > 0)) {
    res.status(400).json({
      error: "Provide either a specific code or a number of codes to generate.",
    });
    return;
  }
  const startsAt = parsePromoDate(b.startsAt);
  const expiresAt = parsePromoDate(b.expiresAt);
  if (startsAt === "invalid" || expiresAt === "invalid") {
    res.status(400).json({ error: "Invalid date" });
    return;
  }
  if (startsAt && expiresAt && expiresAt <= startsAt) {
    res.status(400).json({ error: "The expiry must be after the start." });
    return;
  }

  const base = {
    campaign: b.campaign?.trim() || null,
    captionCredits: b.captionCredits,
    imageCredits: b.imageCredits,
    videoCredits: b.videoCredits ?? 0,
    allowedPlans:
      b.allowedPlans && b.allowedPlans.length > 0 ? b.allowedPlans : null,
    audience: b.audience ?? "all",
    newTenantDays: b.newTenantDays ?? 30,
    maxRedemptions: b.maxRedemptions ?? null,
    perTenantLimit: b.perTenantLimit ?? 1,
    startsAt: startsAt ?? null,
    expiresAt: expiresAt ?? null,
    active: b.active ?? true,
    note: b.note?.trim() || null,
  };

  if (hasCode) {
    const code = normalizePromoCode(b.code!);
    if (!/^[A-Z0-9_-]{3,64}$/.test(code)) {
      res.status(400).json({
        error: "Codes may only use letters, numbers, hyphens, and underscores.",
      });
      return;
    }
    const created = (
      await db
        .insert(promoCodesTable)
        .values({ ...base, code })
        .onConflictDoNothing({ target: promoCodesTable.code })
        .returning()
    )[0];
    if (!created) {
      res.status(409).json({ error: "That code already exists." });
      return;
    }
    await auditPromoChange(req, null, serializePromoCode(created));
    res.json([serializePromoCode(created)]);
    return;
  }

  // Bulk generation: random codes are effectively collision-free, but
  // onConflictDoNothing + top-up keeps the batch exact even if one collides.
  const batchId = generatePromoCode(undefined, 8);
  const created: PromoCode[] = [];
  for (let attempt = 0; attempt < 10 && created.length < count; attempt++) {
    const missing = count - created.length;
    const values = Array.from({ length: missing }, () => ({
      ...base,
      code: generatePromoCode(b.prefix),
      batchId,
    }));
    const rows = await db
      .insert(promoCodesTable)
      .values(values)
      .onConflictDoNothing({ target: promoCodesTable.code })
      .returning();
    created.push(...rows);
  }
  await auditPromoChange(req, null, { batchId, count: created.length });
  res.json(created.map(serializePromoCode));
});

/** PUT /admin/promo-codes/:id — edit limits, window, targeting, or status. */
router.put("/admin/promo-codes/:id", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const parsed = AdminUpdatePromoCodeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const previous = (
    await db.select().from(promoCodesTable).where(eq(promoCodesTable.id, id)).limit(1)
  )[0];
  if (!previous) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const b = parsed.data;
  const startsAt = parsePromoDate(b.startsAt);
  const expiresAt = parsePromoDate(b.expiresAt);
  if (startsAt === "invalid" || expiresAt === "invalid") {
    res.status(400).json({ error: "Invalid date" });
    return;
  }
  const nextCaptions = b.captionCredits ?? previous.captionCredits;
  const nextImages = b.imageCredits ?? previous.imageCredits;
  const nextVideos = b.videoCredits ?? previous.videoCredits;
  if (nextCaptions <= 0 && nextImages <= 0 && nextVideos <= 0) {
    res.status(400).json({ error: "A promo code must grant at least one credit." });
    return;
  }
  const nextStarts = startsAt === undefined ? previous.startsAt : startsAt;
  const nextExpires = expiresAt === undefined ? previous.expiresAt : expiresAt;
  if (nextStarts && nextExpires && nextExpires <= nextStarts) {
    res.status(400).json({ error: "The expiry must be after the start." });
    return;
  }
  const updated = (
    await db
      .update(promoCodesTable)
      .set({
        campaign:
          b.campaign === undefined ? previous.campaign : b.campaign?.trim() || null,
        captionCredits: nextCaptions,
        imageCredits: nextImages,
        videoCredits: nextVideos,
        allowedPlans:
          b.allowedPlans === undefined
            ? previous.allowedPlans
            : b.allowedPlans && b.allowedPlans.length > 0
              ? b.allowedPlans
              : null,
        audience: b.audience ?? previous.audience,
        newTenantDays: b.newTenantDays ?? previous.newTenantDays,
        maxRedemptions:
          b.maxRedemptions === undefined ? previous.maxRedemptions : b.maxRedemptions,
        perTenantLimit: b.perTenantLimit ?? previous.perTenantLimit,
        startsAt: nextStarts,
        expiresAt: nextExpires,
        active: b.active ?? previous.active,
        note: b.note === undefined ? previous.note : b.note?.trim() || null,
        updatedAt: new Date(),
      })
      .where(eq(promoCodesTable.id, id))
      .returning()
  )[0];
  if (!updated) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  await auditPromoChange(req, previous, serializePromoCode(updated));
  res.json(serializePromoCode(updated));
});

/**
 * DELETE /admin/promo-codes/:id — instant deactivate (soft; the redemption
 * history must stay resolvable, so rows are never hard-deleted).
 */
router.delete("/admin/promo-codes/:id", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const previous = (
    await db.select().from(promoCodesTable).where(eq(promoCodesTable.id, id)).limit(1)
  )[0];
  if (!previous) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const updated = (
    await db
      .update(promoCodesTable)
      .set({ active: false, updatedAt: new Date() })
      .where(eq(promoCodesTable.id, id))
      .returning()
  )[0];
  await auditPromoChange(
    req,
    previous,
    updated ? serializePromoCode(updated) : null,
  );
  res.json(serializePromoCode(updated ?? { ...previous, active: false }));
});

// ---------------------------------------------------------------------------
// Automatic signup credit grant (superadmin-configured welcome bundle)
// ---------------------------------------------------------------------------

/** GET /admin/signup-credit-settings — current welcome-bundle configuration. */
router.get(
  "/admin/signup-credit-settings",
  async (_req: Request, res: Response) => {
    res.json(await getSignupCreditSettings());
  },
);

/** PUT /admin/signup-credit-settings — update the welcome bundle (audited). */
router.put(
  "/admin/signup-credit-settings",
  async (req: Request, res: Response) => {
    const parsed = AdminUpdateSignupCreditSettingsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    const before = await getSignupCreditSettings();
    const updated = await updateSignupCreditSettings(parsed.data);
    if (JSON.stringify(before) !== JSON.stringify(updated)) {
      try {
        await recordAdminAction({
          action: "signup_credit_settings_change",
          actorTenantId: req.tenantId,
          actorEmail: req.tenantEmail,
          targetTenantId: null,
          targetEmail: null,
          oldValue: JSON.stringify(before),
          newValue: JSON.stringify(updated),
        });
      } catch (error) {
        req.log.error(
          { err: error },
          "Failed to write signup-credit-settings audit log",
        );
      }
    }
    res.json(updated);
  },
);

/** GET /admin/promo-metrics — totals plus per-campaign and per-plan splits. */
router.get("/admin/promo-metrics", async (_req: Request, res: Response) => {
  res.json(await getPromoMetrics());
});

/** GET /admin/promo-failures — recent rejected redemption attempts. */
router.get("/admin/promo-failures", async (_req: Request, res: Response) => {
  const rows = await listPromoFailures();
  res.json(
    rows.map((r) => ({
      id: r.id,
      tenantId: r.tenantId,
      code: r.code,
      reason: r.reason,
      createdAt: r.createdAt.toISOString(),
      tenantEmail: r.tenantEmail,
    })),
  );
});

/**
 * POST /admin/tenants/:id/credits — manual credit grant (or deduction with
 * negative deltas). Audited; the ledger records it as admin_grant.
 */
router.post("/admin/tenants/:id/credits", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const parsed = AdminGrantCreditsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const { captionCredits, imageCredits, note } = parsed.data;
  const videoCredits = parsed.data.videoCredits ?? 0;
  if (
    !Number.isInteger(captionCredits) ||
    !Number.isInteger(imageCredits) ||
    !Number.isInteger(videoCredits) ||
    (captionCredits === 0 && imageCredits === 0 && videoCredits === 0)
  ) {
    res.status(400).json({ error: "Grant at least one credit (whole numbers)" });
    return;
  }
  const tenant = (
    await db.select().from(tenantsTable).where(eq(tenantsTable.id, id)).limit(1)
  )[0];
  if (!tenant) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  await grantCredits({
    tenantId: id,
    captionCredits,
    imageCredits,
    videoCredits,
    kind: "admin_grant",
    note: note?.trim() || "Granted by admin",
  });
  try {
    await recordAdminAction({
      action: "credit_grant",
      actorTenantId: req.tenantId,
      actorEmail: req.tenantEmail,
      targetTenantId: tenant.id,
      targetEmail: tenant.email ?? null,
      oldValue: null,
      newValue: JSON.stringify({ captionCredits, imageCredits, videoCredits }),
    });
  } catch (error) {
    req.log.error({ err: error }, "Failed to write credit-grant audit log");
  }
  res.json({ ok: true, credits: await getCreditBalances(id) });
});

/**
 * GET /admin/audit-logs
 * The append-only trail of privileged admin actions (plan overrides and
 * superadmin grants/revokes), most recent first. Read-only, superadmin-scoped.
 */
const AUDIT_ACTIONS = new Set([
  "plan_change",
  "superadmin_grant",
  "superadmin_revoke",
  "plan_edit",
  "plan_create",
  "plan_delete",
  "notification_policy_change",
  "credential_change",
  "app_brand_change",
  "landing_content_change",
  "email_settings_change",
  "email_test_send",
  "sweep_run",
  "credit_pack_change",
  "credit_grant",
  "promo_code_change",
  "support_request_resolved",
  "textgen_provider_change",
  "custom_ai_provider_change",
  "textgen_key_change",
  "ai_spend_settings_change",
  "signup_credit_settings_change",
  "ai_cost_change",
  "wallet_settings_change",
  "billing_mode_change",
  "wallet_adjust",
  "invoice_settings_change",
  "prompt_case_change",
  "prompt_template_change",
  "prompt_version_change",
  "prompt_review_decision",
  "prompt_promotion",
  "prompt_rollback",
  "prompt_kit_import",
]);

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function buildAuditLogWhere(
  q: Record<string, unknown>,
): { ok: true; where: ReturnType<typeof and> } | { ok: false; message: string } {
  const conditions = [];

  const action = typeof q.action === "string" ? q.action : undefined;
  if (action) {
    if (!AUDIT_ACTIONS.has(action)) {
      return { ok: false, message: `Unknown action "${action}"` };
    }
    conditions.push(eq(adminAuditLogsTable.action, action));
  }

  const actor =
    typeof q.actor === "string" && q.actor.trim() !== ""
      ? q.actor.trim().slice(0, 200)
      : undefined;
  if (actor) {
    const asId = /^\d+$/.test(actor) ? Number.parseInt(actor, 10) : null;
    const emailMatch = ilike(
      adminAuditLogsTable.actorEmail,
      `%${escapeLike(actor)}%`,
    );
    conditions.push(
      asId !== null
        ? or(emailMatch, eq(adminAuditLogsTable.actorTenantId, asId))!
        : emailMatch,
    );
  }

  const target =
    typeof q.target === "string" && q.target.trim() !== ""
      ? q.target.trim().slice(0, 200)
      : undefined;
  if (target) {
    const asId = /^\d+$/.test(target) ? Number.parseInt(target, 10) : null;
    const emailMatch = ilike(
      adminAuditLogsTable.targetEmail,
      `%${escapeLike(target)}%`,
    );
    conditions.push(
      asId !== null
        ? or(emailMatch, eq(adminAuditLogsTable.targetTenantId, asId))!
        : emailMatch,
    );
  }

  for (const [key, op] of [
    ["from", gte],
    ["to", lte],
  ] as const) {
    const raw = typeof q[key] === "string" ? (q[key] as string) : undefined;
    if (raw) {
      const date = new Date(raw);
      if (Number.isNaN(date.getTime())) {
        return { ok: false, message: `Invalid ${key} date` };
      }
      conditions.push(op(adminAuditLogsTable.createdAt, date));
    }
  }

  return {
    ok: true,
    where: conditions.length > 0 ? and(...conditions) : undefined,
  };
}

router.get("/admin/audit-logs", async (req: Request, res: Response) => {
  const q = req.query as Record<string, unknown>;

  const rawLimit = Number.parseInt(String(q.limit ?? ""), 10);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(rawLimit, 1), 200)
    : 50;
  const rawOffset = Number.parseInt(String(q.offset ?? ""), 10);
  const offset = Number.isFinite(rawOffset) ? Math.max(rawOffset, 0) : 0;

  const parsed = buildAuditLogWhere(q);
  if (!parsed.ok) {
    res.status(400).json({ error: { message: parsed.message } });
    return;
  }
  const where = parsed.where;

  // Housekeeping: finalize stale "pending" test-email reservations before
  // serving the trail, so a crashed test-send attempt never appears as
  // in-progress forever even if no further test emails are sent. Best-effort:
  // a sweep failure must never block reading the audit trail.
  try {
    await sweepAbandonedEmailTestSends();
  } catch (error) {
    req.log.error({ err: error }, "Failed to sweep stale test-email rows");
  }

  const [rows, [{ count }]] = await Promise.all([
    db
      .select()
      .from(adminAuditLogsTable)
      .where(where)
      .orderBy(desc(adminAuditLogsTable.createdAt), desc(adminAuditLogsTable.id))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(adminAuditLogsTable)
      .where(where),
  ]);

  res.json({
    items: rows.map((r) => ({
      id: r.id,
      action: r.action,
      actorTenantId: r.actorTenantId,
      actorEmail: r.actorEmail ?? null,
      targetTenantId: r.targetTenantId,
      targetEmail: r.targetEmail ?? null,
      oldValue: r.oldValue ?? null,
      newValue: r.newValue ?? null,
      createdAt: r.createdAt.toISOString(),
    })),
    total: count,
    limit,
    offset,
  });
});

/**
 * GET /admin/audit-logs/export
 * Streams ALL audit records matching the same filters as GET /admin/audit-logs
 * as a CSV download (no paging). Superadmin-scoped like the rest of /admin.
 */
function csvCell(value: string | number | null): string {
  if (value === null) return "";
  let s = String(value);
  // Neutralize spreadsheet formula injection: a leading =, +, -, @ (or a
  // tab/CR before one) would be interpreted as a formula by Excel/Sheets.
  if (/^[=+\-@\t\r]/.test(s)) {
    s = `'${s}`;
  }
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const AUDIT_EXPORT_BATCH = 500;

/**
 * HEAD /admin/audit-logs/export
 * Preflight for the CSV export: runs the same auth (router-level
 * requireSuperadmin) and filter validation as the GET, but sends no body.
 * The frontend calls this before triggering the browser-native anchor
 * download so a 401/403/400 surfaces as an in-app toast instead of the
 * browser saving a JSON error body as a .csv file.
 */
router.head("/admin/audit-logs/export", (req: Request, res: Response) => {
  const parsed = buildAuditLogWhere(req.query as Record<string, unknown>);
  if (!parsed.ok) {
    res.status(400).end();
    return;
  }
  res.status(204).end();
});

router.get(
  "/admin/audit-logs/export",
  async (req: Request, res: Response) => {
    const parsed = buildAuditLogWhere(req.query as Record<string, unknown>);
    if (!parsed.ok) {
      res.status(400).json({ error: { message: parsed.message } });
      return;
    }
    const where = parsed.where;

    // Same housekeeping as GET /admin/audit-logs: never export a stale
    // "pending" test-email reservation as in-progress. Best-effort.
    try {
      await sweepAbandonedEmailTestSends();
    } catch (error) {
      req.log.error({ err: error }, "Failed to sweep stale test-email rows");
    }

    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="audit-log-${stamp}.csv"`,
    );

    res.write(
      "id,createdAt,action,actorTenantId,actorEmail,targetTenantId,targetEmail,oldValue,newValue\r\n",
    );

    let offset = 0;
    for (;;) {
      const rows = await db
        .select()
        .from(adminAuditLogsTable)
        .where(where)
        .orderBy(
          desc(adminAuditLogsTable.createdAt),
          desc(adminAuditLogsTable.id),
        )
        .limit(AUDIT_EXPORT_BATCH)
        .offset(offset);

      for (const r of rows) {
        res.write(
          [
            csvCell(r.id),
            csvCell(r.createdAt.toISOString()),
            csvCell(r.action),
            csvCell(r.actorTenantId),
            csvCell(r.actorEmail ?? null),
            csvCell(r.targetTenantId),
            csvCell(r.targetEmail ?? null),
            csvCell(r.oldValue ?? null),
            csvCell(r.newValue ?? null),
          ].join(",") + "\r\n",
        );
      }

      if (rows.length < AUDIT_EXPORT_BATCH) break;
      offset += AUDIT_EXPORT_BATCH;
    }

    res.end();
  },
);

/**
 * GET /admin/notification-policies
 * The global per-type notification policy (enabled + email policy), merged with
 * the catalog so every known type appears even before it has a stored row.
 */
router.get(
  "/admin/notification-policies",
  async (_req: Request, res: Response) => {
    const map = await getPolicyMap();
    res.json(
      NOTIFICATION_TYPES.map((def) => {
        const policy = map.get(def.type) ?? defaultPolicy();
        return {
          type: def.type,
          label: def.label,
          description: def.description,
          enabled: policy.enabled,
          emailPolicy: policy.emailPolicy,
        };
      }),
    );
  },
);

/**
 * PUT /admin/notification-policies
 * Superadmin update of the global notification policy per type. Unknown types
 * are ignored so a stale client cannot create junk rows.
 */
router.put(
  "/admin/notification-policies",
  async (req: Request, res: Response) => {
    const parsed = AdminUpdateNotificationPoliciesBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }

    const unknown = parsed.data.policies
      .map((p) => p.type)
      .filter((t) => !NOTIFICATION_TYPE_SET.has(t));
    if (unknown.length > 0) {
      res
        .status(400)
        .json({ error: `Unknown notification type(s): ${unknown.join(", ")}` });
      return;
    }

    // Snapshot the prior policies so each real change (not no-op saves) can be
    // audited with old vs new values.
    const priorMap = await getPolicyMap();

    for (const policy of parsed.data.policies) {
      await db
        .insert(notificationPoliciesTable)
        .values({
          type: policy.type,
          enabled: policy.enabled,
          emailPolicy: policy.emailPolicy,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: notificationPoliciesTable.type,
          set: {
            enabled: policy.enabled,
            emailPolicy: policy.emailPolicy,
            updatedAt: new Date(),
          },
        });
    }

    // Best-effort audit of real changes AFTER the primary mutation succeeded:
    // one row per changed type, with old vs new enabled/emailPolicy.
    for (const policy of parsed.data.policies) {
      const prior = priorMap.get(policy.type) ?? defaultPolicy();
      if (
        prior.enabled === policy.enabled &&
        prior.emailPolicy === policy.emailPolicy
      ) {
        continue;
      }
      try {
        await recordAdminAction({
          action: "notification_policy_change",
          actorTenantId: req.tenantId,
          actorEmail: req.tenantEmail,
          targetTenantId: null,
          targetEmail: null,
          oldValue: JSON.stringify({
            type: policy.type,
            enabled: prior.enabled,
            emailPolicy: prior.emailPolicy,
          }),
          newValue: JSON.stringify({
            type: policy.type,
            enabled: policy.enabled,
            emailPolicy: policy.emailPolicy,
          }),
        });
      } catch (error) {
        req.log.error(
          { err: error },
          "Failed to write notification-policy audit log",
        );
      }
    }

    const map = await getPolicyMap();
    res.json(
      NOTIFICATION_TYPES.map((def) => {
        const policy = map.get(def.type) ?? defaultPolicy();
        return {
          type: def.type,
          label: def.label,
          description: def.description,
          enabled: policy.enabled,
          emailPolicy: policy.emailPolicy,
        };
      }),
    );
  },
);

/**
 * GET /admin/seat-requests
 * All tenant seat requests, newest first, with workspace context.
 */
router.get("/admin/seat-requests", async (req: Request, res: Response) => {
  const rows = await db
    .select({
      request: seatRequestsTable,
      tenant: tenantsTable,
    })
    .from(seatRequestsTable)
    .innerJoin(tenantsTable, eq(seatRequestsTable.tenantId, tenantsTable.id))
    .orderBy(desc(seatRequestsTable.createdAt))
    .limit(200);

  // Effective limit and usage are computed per unique workspace (not per
  // request row) so the same tenant with several requests costs one lookup.
  const byTenant = new Map<number, { limit: number; used: number }>();
  for (const r of rows) {
    if (byTenant.has(r.tenant.id)) continue;
    const [limit, used] = await Promise.all([
      getEffectiveSeatLimit(r.tenant),
      getSeatsUsed(r.tenant.id),
    ]);
    byTenant.set(r.tenant.id, { limit, used });
  }

  res.json(
    rows.map((r) => {
      const t = byTenant.get(r.tenant.id)!;
      return {
        ...serializeSeatRequest(r.request),
        tenantId: r.request.tenantId,
        tenantName: r.tenant.name,
        tenantEmail: r.tenant.email ?? null,
        tenantPlan: r.tenant.plan,
        currentSeatLimit: t.limit,
        seatsUsed: t.used,
      };
    }),
  );
});

/**
 * PATCH /admin/seat-requests/:id
 * Approve (optionally with an adjusted seat count) or deny a pending seat
 * request. Approval writes the granted count to tenants.seatLimit — the
 * per-workspace override on top of the plan's default teamSeats. Audited
 * best-effort; the tenant is notified via the notification framework.
 */
router.patch(
  "/admin/seat-requests/:id",
  async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const parsed = AdminDecideSeatRequestBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    if (
      parsed.data.seats !== undefined &&
      !Number.isInteger(parsed.data.seats)
    ) {
      res.status(400).json({ error: "Seats must be a whole number" });
      return;
    }

    const existing = (
      await db
        .select()
        .from(seatRequestsTable)
        .where(eq(seatRequestsTable.id, id))
        .limit(1)
    )[0];
    if (!existing) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (existing.status !== "pending") {
      res.status(400).json({ error: "This request was already decided" });
      return;
    }

    const approved = parsed.data.action === "approve";
    const grantedSeats = approved
      ? (parsed.data.seats ?? existing.requestedSeats)
      : null;

    const tenant = (
      await db
        .select()
        .from(tenantsTable)
        .where(eq(tenantsTable.id, existing.tenantId))
        .limit(1)
    )[0];
    if (!tenant) {
      res.status(404).json({ error: "Workspace not found" });
      return;
    }

    if (approved) {
      await db
        .update(tenantsTable)
        .set({ seatLimit: grantedSeats, updatedAt: new Date() })
        .where(eq(tenantsTable.id, existing.tenantId));
    }

    const updated = (
      await db
        .update(seatRequestsTable)
        .set({
          status: approved ? "approved" : "denied",
          grantedSeats,
          decidedByEmail: req.tenantEmail,
          decidedAt: new Date(),
        })
        .where(eq(seatRequestsTable.id, id))
        .returning()
    )[0];

    try {
      await recordAdminAction({
        action: approved ? "seat_request_approve" : "seat_request_deny",
        actorTenantId: req.tenantId,
        actorEmail: req.tenantEmail,
        targetTenantId: existing.tenantId,
        targetEmail: tenant.email ?? null,
        oldValue: JSON.stringify({
          requestedSeats: existing.requestedSeats,
          previousSeatLimit: tenant.seatLimit ?? null,
        }),
        newValue: JSON.stringify({ grantedSeats }),
      });
    } catch (error) {
      req.log.error({ err: error }, "Failed to write seat-request audit log");
    }

    await notifySeatRequestDecided(existing.tenantId, {
      approved,
      grantedSeats,
    });

    // Clear other admins' now-stale "awaiting review" alerts for THIS
    // decided request (legacy untagged rows are only swept once nothing is
    // pending).
    await resolveSeatRequestSubmittedNotifications(id);

    const decidedTenant = (
      await db
        .select()
        .from(tenantsTable)
        .where(eq(tenantsTable.id, existing.tenantId))
        .limit(1)
    )[0];
    const [currentSeatLimit, seatsUsed] = await Promise.all([
      getEffectiveSeatLimit(decidedTenant ?? tenant),
      getSeatsUsed(existing.tenantId),
    ]);

    res.json({
      ...serializeSeatRequest(updated!),
      tenantId: existing.tenantId,
      tenantName: tenant.name,
      tenantEmail: tenant.email ?? null,
      tenantPlan: tenant.plan,
      currentSeatLimit,
      seatsUsed,
    });
  },
);

/**
 * GET /admin/support-requests
 * All workspaces' help & support requests: open first, then newest.
 */
router.get("/admin/support-requests", async (_req: Request, res: Response) => {
  const rows = await db
    .select({ request: supportRequestsTable, tenant: tenantsTable })
    .from(supportRequestsTable)
    .innerJoin(tenantsTable, eq(supportRequestsTable.tenantId, tenantsTable.id))
    .orderBy(desc(supportRequestsTable.createdAt))
    .limit(300);

  const serialized = rows.map((r) => ({
    ...serializeSupportRequest(r.request),
    tenantId: r.request.tenantId,
    tenantName: r.tenant.name,
    tenantEmail: r.tenant.email ?? null,
    submitterEmail: r.request.submitterEmail ?? null,
  }));
  serialized.sort((a, b) => {
    if (a.status !== b.status) return a.status === "open" ? -1 : 1;
    return b.createdAt.localeCompare(a.createdAt);
  });
  res.json(serialized);
});

/**
 * PATCH /admin/support-requests/:id
 * Mark a support request resolved, optionally with a reply that is shown to
 * the workspace (and delivered via the notification framework). Audited
 * best-effort; already-resolved requests 400.
 */
router.patch(
  "/admin/support-requests/:id",
  async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    const parsed = AdminResolveSupportRequestBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    const reply = parsed.data.reply?.trim() ?? "";

    // Atomic conditional transition: only an OPEN row flips to resolved, so
    // two admins racing on the same request produce exactly one winner (one
    // audit entry, one notification); the loser sees "already resolved".
    const updated = (
      await db
        .update(supportRequestsTable)
        .set({
          status: "resolved",
          adminReply: reply || null,
          resolvedByEmail: req.tenantEmail,
          resolvedAt: new Date(),
        })
        .where(
          and(
            eq(supportRequestsTable.id, id),
            eq(supportRequestsTable.status, "open"),
          ),
        )
        .returning()
    )[0];
    if (!updated) {
      const exists = (
        await db
          .select({ id: supportRequestsTable.id })
          .from(supportRequestsTable)
          .where(eq(supportRequestsTable.id, id))
          .limit(1)
      )[0];
      res
        .status(exists ? 400 : 404)
        .json({
          error: exists ? "This request was already resolved" : "Not found",
        });
      return;
    }

    const tenant = (
      await db
        .select()
        .from(tenantsTable)
        .where(eq(tenantsTable.id, updated.tenantId))
        .limit(1)
    )[0];

    // Best-effort side effects: the resolution is already persisted, so an
    // audit or notification failure must not turn the response into a 500.
    try {
      await recordAdminAction({
        action: "support_request_resolved",
        actorTenantId: req.tenantId,
        actorEmail: req.tenantEmail ?? null,
        targetTenantId: updated.tenantId,
        targetEmail: updated.submitterEmail ?? tenant?.email ?? null,
        oldValue: "open",
        newValue: reply ? "resolved (with reply)" : "resolved",
      });
    } catch (err) {
      req.log?.error?.(
        { err, supportRequestId: id },
        "Failed to audit support-request resolution",
      );
    }

    await notifySupportRequestResolved(updated.tenantId, {
      supportRequestId: id,
      subject: updated.subject,
      adminReply: reply || null,
    });

    res.json({
      ...serializeSupportRequest(updated),
      tenantId: updated.tenantId,
      tenantName: tenant?.name ?? `#${updated.tenantId}`,
      tenantEmail: tenant?.email ?? null,
      submitterEmail: updated.submitterEmail ?? null,
    });
  },
);

// ---------------------------------------------------------------------------
// Prepaid rupee wallet (superadmin)
// ---------------------------------------------------------------------------

/**
 * GET /admin/wallet/settings
 * GST rate, minimum top-up, low-balance threshold, and the video display-rate
 * fallback. The platform fee and the caption/image fallback rates are NOT
 * duplicated here — they come from AI Spend Display, so one set of numbers
 * drives both what tenants see and what the wallet charges.
 */
router.get("/admin/wallet/settings", async (_req: Request, res: Response) => {
  res.json(await getWalletConfig());
});

/**
 * PUT /admin/wallet/settings
 */
router.put("/admin/wallet/settings", async (req: Request, res: Response) => {
  const parsed = AdminUpdateWalletSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const before = await getWalletConfig();
  const after = await setWalletConfig(parsed.data);
  if (before.gstPercent !== after.gstPercent) {
    try {
      await recordAdminAction({
        action: "wallet_settings_change",
        actorTenantId: req.tenantId,
        actorEmail: req.tenantEmail,
        targetTenantId: null,
        targetEmail: null,
        oldValue: `gst:${before.gstPercent}%`,
        newValue: `gst:${after.gstPercent}%`,
      });
    } catch (error) {
      req.log.error({ err: error }, "Failed to write wallet settings audit log");
    }
  }
  res.json(after);
});

/**
 * GET /admin/wallet/pending-prices
 * Models that have been charged at the display-rate fallback because they are
 * missing from the price catalog. Adding a price on the AI tab clears the
 * entry and collects the difference automatically.
 */
router.get("/admin/wallet/pending-prices", async (_req: Request, res: Response) => {
  res.json(await listPendingPricedModels());
});

/**
 * GET /admin/wallet/settlement-retries
 * Successful AI work whose final wallet settlement is still pending, currently
 * processing, or terminally failed after the automatic retry budget.
 */
router.get("/admin/wallet/settlement-retries", async (_req: Request, res: Response) => {
  res.json(await listWalletSettlementRetries());
});

/**
 * GET /admin/wallet/video-reconciliation
 * Read-only retry-chain discrepancy report. This endpoint deliberately never
 * applies a debit or refund to historical wallet balances.
 */
router.get("/admin/wallet/video-reconciliation", async (_req: Request, res: Response) => {
  res.json(await listVideoWalletReconciliationReport());
});

/**
 * POST /admin/wallet/pending-prices/reconcile
 * Run the true-up for one pending model on demand and report what settled vs
 * what is still pending (with a fresh diagnosis). Lets an admin unstick rows
 * whose price already exists without re-saving the price.
 */
router.post(
  "/admin/wallet/pending-prices/reconcile",
  async (req: Request, res: Response) => {
    const parsed = AdminReconcileWalletPendingPricesBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    const { usageKind, provider, model } = parsed.data;
    try {
      const result = await reconcilePendingModel({
        usageKind,
        provider: provider ?? null,
        model,
      });
      req.log.info(
        { usageKind, provider, model, settledRows: result.settledRows },
        "Manual wallet true-up reconcile",
      );
      res.json(result);
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : "Reconcile failed",
      });
    }
  },
);

/**
 * PUT /admin/tenants/:id/billing-mode
 * Move a workspace between quota billing and wallet billing. Takes effect
 * only while the platform `wallet` switch is on.
 */
router.put("/admin/tenants/:id/billing-mode", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const parsed = AdminUpdateTenantBillingModeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const tenant = (
    await db.select().from(tenantsTable).where(eq(tenantsTable.id, id)).limit(1)
  )[0];
  if (!tenant) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }
  const billingMode = parsed.data.billingMode;
  if (tenant.billingMode !== billingMode) {
    // Manual superadmin choice: mark it overridden so future plan changes
    // don't silently re-apply the plan's default billing mode.
    await db
      .update(tenantsTable)
      .set({ billingMode, billingModeOverriddenAt: new Date(), updatedAt: new Date() })
      .where(eq(tenantsTable.id, id));
    try {
      await recordAdminAction({
        action: "billing_mode_change",
        actorTenantId: req.tenantId,
        actorEmail: req.tenantEmail,
        targetTenantId: id,
        targetEmail: tenant.email ?? null,
        oldValue: tenant.billingMode,
        newValue: billingMode,
      });
    } catch (error) {
      req.log.error({ err: error }, "Failed to write billing-mode audit log");
    }
  }
  res.json({ tenantId: id, billingMode });
});

/**
 * POST /admin/tenants/:id/wallet
 * Manually add to (positive) or deduct from (negative) a workspace's wallet.
 * No GST — an admin grant is not a sale. A deduction larger than the balance
 * is clamped so the wallet never goes negative, and the ledger records the
 * delta that was actually applied.
 */
router.post("/admin/tenants/:id/wallet", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const parsed = AdminAdjustTenantWalletBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  if (parsed.data.amountPaise === 0) {
    res.status(400).json({ error: "Enter an amount." });
    return;
  }
  const tenant = (
    await db.select().from(tenantsTable).where(eq(tenantsTable.id, id)).limit(1)
  )[0];
  if (!tenant) {
    res.status(404).json({ error: "Tenant not found" });
    return;
  }

  const { appliedPaise, balancePaise } = await adminAdjustWallet({
    tenantId: id,
    amountPaise: parsed.data.amountPaise,
    note: parsed.data.note ?? "Adjusted by an administrator",
  });
  try {
    await recordAdminAction({
      action: "wallet_adjust",
      actorTenantId: req.tenantId,
      actorEmail: req.tenantEmail,
      targetTenantId: id,
      targetEmail: tenant.email ?? null,
      oldValue: String(balancePaise - appliedPaise),
      newValue: String(balancePaise),
    });
  } catch (error) {
    req.log.error({ err: error }, "Failed to write wallet adjustment audit log");
  }
  res.json({ ok: true, balancePaise, appliedPaise });
});

// ============================================================================
// Sarvam TTS provider (tts_sarvam) — credential management
// ============================================================================

/** Serialize the Sarvam TTS provider status (for GET and mutation responses). */
async function serializeTtsSettings() {
  const keySource = await getSarvamKeySource();
  const configured = await isSarvamConfigured();
  const testStatus = await getSarvamTestStatus();
  return {
    provider: SARVAM_PROVIDER_ID,
    label: "Sarvam AI (bulbul:v3, Indic TTS)",
    model: "bulbul:v3",
    envKey: SARVAM_ENV_KEY,
    configured,
    keySource,
    lastTestStatus: testStatus.lastTestStatus,
    lastTestedAt: testStatus.lastTestedAt?.toISOString() ?? null,
    lastTestError: testStatus.lastTestError,
  };
}

/**
 * GET /admin/tts-settings
 * Sarvam TTS provider status (key source, configured, last test result).
 * No secret is returned — only metadata.
 */
router.get("/admin/tts-settings", async (_req: Request, res: Response) => {
  res.json(await serializeTtsSettings());
});

/**
 * PUT /admin/tts-providers/sarvam/key
 * Save (or rotate) the Sarvam API subscription key (encrypted at rest).
 * Superadmin only.  Body: { apiKey: string }
 */
router.put("/admin/tts-providers/sarvam/key", async (req: Request, res: Response) => {
  const parsed = AdminSetSarvamTtsKeyBody.safeParse(req.body);
  const apiKey = parsed.success ? parsed.data.apiKey.trim() : "";
  if (!apiKey) {
    res.status(400).json({ error: "API key is required" });
    return;
  }
  await setStoredSarvamKey(apiKey);
  try {
    await recordAdminAction({
      action: "tts_key_change",
      actorTenantId: req.tenantId,
      actorEmail: req.tenantEmail,
      targetTenantId: null,
      targetEmail: null,
      oldValue: null,
      newValue: `${SARVAM_PROVIDER_ID}:set`,
    });
  } catch (error) {
    req.log.error({ err: error }, "Failed to write Sarvam TTS key audit log");
  }
  res.json(await serializeTtsSettings());
});

/**
 * DELETE /admin/tts-providers/sarvam/key
 * Remove the stored Sarvam API key (env var SARVAM_API_KEY becomes the
 * fallback if set). Superadmin only.
 */
router.delete("/admin/tts-providers/sarvam/key", async (req: Request, res: Response) => {
  await clearStoredSarvamKey();
  try {
    await recordAdminAction({
      action: "tts_key_change",
      actorTenantId: req.tenantId,
      actorEmail: req.tenantEmail,
      targetTenantId: null,
      targetEmail: null,
      oldValue: null,
      newValue: `${SARVAM_PROVIDER_ID}:cleared`,
    });
  } catch (error) {
    req.log.error({ err: error }, "Failed to write Sarvam TTS key clear audit log");
  }
  res.json(await serializeTtsSettings());
});

/**
 * POST /admin/tts-providers/sarvam/test
 * Connectivity test: call the Sarvam TTS API with a short Hindi phrase to
 * confirm the effective key (DB override or env) is accepted.
 * Persists the outcome to the app_credentials row (lastTestStatus, lastTestedAt,
 * lastTestError). Superadmin only.
 *
 * Response: { ok: boolean; message: string }
 */
router.post("/admin/tts-providers/sarvam/test", async (req: Request, res: Response) => {
  const credential = await resolveSarvamCredentialSnapshot();
  if (!credential) {
    res.json({ ok: false, message: "No Sarvam API key is configured." });
    return;
  }
  try {
    await testSarvamKey(credential.apiKey);
    await persistSarvamTestStatusForCredential(credential, "ok").catch(() => false);
    try {
      await recordAdminAction({
        action: "tts_key_test",
        actorTenantId: req.tenantId,
        actorEmail: req.tenantEmail,
        targetTenantId: null,
        targetEmail: null,
        oldValue: null,
        newValue: `${SARVAM_PROVIDER_ID}:ok`,
      });
    } catch (error) {
      req.log.error({ err: error }, "Failed to write Sarvam TTS test audit log");
    }
    res.json({ ok: true, message: "The Sarvam API key works." });
  } catch (error) {
    const rawMessage =
      error instanceof Error ? error.message : "The Sarvam TTS connectivity test failed.";
    const message = rawMessage.split(credential.apiKey).join("[redacted]");
    await persistSarvamTestStatusForCredential(credential, "error", message).catch(() => false);
    try {
      await recordAdminAction({
        action: "tts_key_test",
        actorTenantId: req.tenantId,
        actorEmail: req.tenantEmail,
        targetTenantId: null,
        targetEmail: null,
        oldValue: null,
        newValue: `${SARVAM_PROVIDER_ID}:error`,
      });
    } catch (auditError) {
      req.log.error({ err: auditError }, "Failed to write Sarvam TTS test audit log");
    }
    // Safe error — never leak the key itself in the message
    res.json({ ok: false, message });
  }
});

export default router;
