import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  tenantsTable,
  contentItemsTable,
  brandKitsTable,
  scheduledPostsTable,
  connectedAccountsTable,
  usageEventsTable,
  adminAuditLogsTable,
  sweepStatusTable,
  subscriptionsTable,
} from "@workspace/db";
import { eq, sql, desc, gte, lt, lte, and, or, ilike, inArray } from "drizzle-orm";
import { requireSuperadmin } from "../middlewares/requireSuperadmin";
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
  IMAGE_GEN_PROVIDERS,
  getImageGenProviderDef,
  isImageGenProviderConfigured,
  getImageGenSelection,
  setImageGenSelection,
  getImageGenKeySource,
  setStoredImageGenKey,
  clearStoredImageGenKey,
} from "../lib/imageGen";
import {
  TEXT_GEN_PROVIDERS,
  getTextGenSelection,
  setTextGenSelection,
  getOpenRouterKeySource,
  setStoredOpenRouterKey,
  clearStoredOpenRouterKey,
  type TextGenProvider,
} from "../lib/textGen";
import {
  AdminUpdateTenantPlanBody,
  AdminUpdateTenantSuperadminBody,
  AdminUpdateTenantDesignSkillBody,
  AdminUpdateDesignSkillBody,
  AdminUpdateFeatureFlagBody,
  AdminUpdateAsrSettingsBody,
  AdminSetAsrProviderKeyBody,
  AdminUpdateImageGenSettingsBody,
  AdminSetImageGenProviderKeyBody,
  AdminUpdateTextGenSettingsBody,
  AdminSetTextGenKeyBody,
  AdminUpdateAiSpendSettingsBody,
  AdminUpdateAiCostRateBody,
  AdminUpsertAiModelPriceBody,
  AdminUpdateNotificationPoliciesBody,
  AdminUpdatePlanBody,
  AdminCreatePlanBody,
  AdminDecideSeatRequestBody,
  AdminCreateCreditPackBody,
  AdminUpdateCreditPackBody,
  AdminGrantCreditsBody,
  AdminCreatePromoCodesBody,
  AdminUpdatePromoCodeBody,
} from "@workspace/api-zod";
import {
  notificationPoliciesTable,
  planSettingsTable,
  seatRequestsTable,
} from "@workspace/db";
import {
  notifySeatRequestDecided,
  resolveSeatRequestSubmittedNotifications,
} from "../lib/notifications";
import {
  serializeSeatRequest,
  getEffectiveSeatLimit,
  getSeatsUsed,
} from "../lib/team";
import { creditPacksTable, promoCodesTable, type PromoCode } from "@workspace/db";
import { grantCredits, getCreditBalances } from "../lib/credits";
import {
  normalizePromoCode,
  generatePromoCode,
  getPromoMetrics,
  listPromoFailures,
} from "../lib/promoCodes";
import { isRazorpayConfigured, createRazorpayPlan } from "../lib/razorpay";
import {
  DEFAULT_PLAN_IDS,
  FALLBACK_PLAN_ID,
  listPlans,
  invalidatePlanCache,
} from "../lib/plans";
import { isSuperadminEmail } from "../lib/superadmins";
import {
  getGlobalDesignSkillEnabled,
  loadDesignSkillRow,
} from "../lib/designSkill";
import { getAiSpendConfig, setAiSpendConfig, getAiSpendRates } from "../lib/aiSpend";
import {
  getAiCostConfig,
  setAiCostConfig,
  listModelPrices,
  upsertModelPrice,
  deleteModelPrice,
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

function serializeAdminTenant(t: Tenant) {
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
    createdAt: t.createdAt.toISOString(),
  };
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
  ]);

  const captionUsage = new Map<number, number>();
  const imageUsage = new Map<number, number>();
  for (const row of usageRows) {
    if (row.kind === "caption") captionUsage.set(row.tenantId, row.count);
    else if (row.kind === "image") imageUsage.set(row.tenantId, row.count);
  }

  res.json(
    tenants.map((t) => ({
      ...serializeAdminTenant(t),
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

  res.json(serializeAdminTenant(updated));
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

    res.json(serializeAdminTenant(updated));
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

    res.json(serializeAdminTenant(updated));
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

/** Serialize the image generation settings view (selection + catalog). */
async function serializeImageGenSettings() {
  const selection = await getImageGenSelection();
  return {
    provider: selection.provider,
    model: selection.model,
    customBaseUrl: selection.customBaseUrl,
    providers: await Promise.all(
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
    ),
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
  const def = getImageGenProviderDef(parsed.data.provider);
  if (!def) {
    res.status(400).json({ error: "Unknown image generation provider" });
    return;
  }
  const model = parsed.data.model?.trim() || null;
  const customBaseUrl = parsed.data.customBaseUrl?.trim() || null;
  if (customBaseUrl && !/^https:\/\//i.test(customBaseUrl)) {
    res.status(400).json({ error: "The custom provider base URL must start with https://" });
    return;
  }
  if (def.requiresBaseUrl && !customBaseUrl) {
    res.status(400).json({ error: "This provider needs a base URL" });
    return;
  }
  if (def.requiresBaseUrl && !model) {
    res.status(400).json({ error: "This provider needs a model name" });
    return;
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

  res.json(await serializeImageGenSettings());
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

/** Serialize the text-gen routing state for admin responses (never the key itself). */
async function serializeTextGenSettings() {
  const selection = await getTextGenSelection();
  return {
    provider: selection.provider,
    models: selection.models,
    defaultModel: selection.defaultModel,
    keySource: await getOpenRouterKeySource(),
    envKey: "OPENROUTER_API_KEY",
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
    before.feePercent !== after.feePercent;
  if (changed) {
    try {
      await recordAdminAction({
        action: "ai_spend_settings_change",
        actorTenantId: req.tenantId,
        actorEmail: req.tenantEmail,
        targetTenantId: null,
        targetEmail: null,
        oldValue: `caption=${before.captionCostPaise} image=${before.imageCostPaise} fee=${before.feePercent}%`,
        newValue: `caption=${after.captionCostPaise} image=${after.imageCostPaise} fee=${after.feePercent}%`,
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
  return {
    usdToInrPaise: config.usdToInrPaise,
    prices: prices.map((p) => ({
      id: p.id,
      kind: p.kind,
      provider: p.provider,
      model: p.model,
      inputUsdPerMtok: p.inputUsdPerMtok,
      outputUsdPerMtok: p.outputUsdPerMtok,
      usdPerImage: p.usdPerImage,
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
 * PUT /admin/ai-cost/prices
 * Add or update one model price row (upsert on kind+provider+model).
 */
router.put("/admin/ai-cost/prices", async (req: Request, res: Response) => {
  const parsed = AdminUpsertAiModelPriceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const data = parsed.data;
  if (data.kind === "text" && (data.inputUsdPerMtok == null || data.outputUsdPerMtok == null)) {
    res.status(400).json({ error: "Text model prices need both input and output USD per 1M tokens." });
    return;
  }
  // Image rows may be flat-priced (usdPerImage), token-priced (both token
  // prices, for OpenAI/Gemini image models that report usage), or both.
  const hasTokenPair = data.inputUsdPerMtok != null && data.outputUsdPerMtok != null;
  if (data.kind === "image" && data.usdPerImage == null && !hasTokenPair) {
    res.status(400).json({
      error:
        "Image model prices need a USD per image amount, or both input and output USD per 1M tokens.",
    });
    return;
  }
  const row = await upsertModelPrice({
    kind: data.kind,
    provider: data.provider.trim(),
    model: data.model.trim(),
    inputUsdPerMtok: hasTokenPair ? (data.inputUsdPerMtok ?? null) : null,
    outputUsdPerMtok: hasTokenPair ? (data.outputUsdPerMtok ?? null) : null,
    usdPerImage: data.kind === "image" ? (data.usdPerImage ?? null) : null,
  });
  await auditAiCostChange(
    req,
    null,
    `${row.kind}:${row.provider}/${row.model} in=${row.inputUsdPerMtok ?? "-"} out=${row.outputUsdPerMtok ?? "-"} img=${row.usdPerImage ?? "-"}`,
  );
  res.json(await serializeAiCostConfig());
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
          inArray(usageEventsTable.kind, ["caption", "image"]),
        ),
      )
      .groupBy(usageEventsTable.tenantId, usageEventsTable.kind),
    db
      .select({
        month: sql<string>`to_char(${usageEventsTable.createdAt} at time zone 'UTC', 'YYYY-MM')`,
        captionCount: sql<number>`count(*) filter (where ${usageEventsTable.kind} = 'caption')::int`,
        imageCount: sql<number>`count(*) filter (where ${usageEventsTable.kind} = 'image')::int`,
        knownCostPaise: sql<number>`coalesce(sum(${usageEventsTable.costPaise}) filter (where ${usageEventsTable.kind} in ('caption', 'image')), 0)::int`,
        unknownCount: sql<number>`count(*) filter (where ${usageEventsTable.kind} in ('caption', 'image') and ${usageEventsTable.costPaise} is null)::int`,
        snapshotDisplayPaise: sql<number>`coalesce(sum(${usageEventsTable.displayPaise}) filter (where ${usageEventsTable.kind} in ('caption', 'image')), 0)::int`,
        noSnapshotCaptionCount: sql<number>`count(*) filter (where ${usageEventsTable.kind} = 'caption' and ${usageEventsTable.displayPaise} is null)::int`,
        noSnapshotImageCount: sql<number>`count(*) filter (where ${usageEventsTable.kind} = 'image' and ${usageEventsTable.displayPaise} is null)::int`,
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
      captionCostPaise: number;
      imageCostPaise: number;
      unknownCaptionCount: number;
      unknownImageCount: number;
      snapshotDisplayPaise: number;
      noSnapshotCaptionCount: number;
      noSnapshotImageCount: number;
    }
  >();
  for (const row of rows) {
    const agg =
      byTenant.get(row.tenantId) ??
      {
        captionCount: 0,
        imageCount: 0,
        captionCostPaise: 0,
        imageCostPaise: 0,
        unknownCaptionCount: 0,
        unknownImageCount: 0,
        snapshotDisplayPaise: 0,
        noSnapshotCaptionCount: 0,
        noSnapshotImageCount: 0,
      };
    if (row.kind === "caption") {
      agg.captionCount = row.count;
      agg.captionCostPaise = row.knownCostPaise;
      agg.unknownCaptionCount = row.unknownCount;
      agg.noSnapshotCaptionCount = row.noSnapshotCount;
    } else {
      agg.imageCount = row.count;
      agg.imageCostPaise = row.knownCostPaise;
      agg.unknownImageCount = row.unknownCount;
      agg.noSnapshotImageCount = row.noSnapshotCount;
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
        ...agg
      } = byTenant.get(tenantId)!;
      const info = tenantInfo.get(tenantId);
      return {
        tenantId,
        name: info?.name ?? null,
        email: info?.email ?? null,
        ...agg,
        totalCostPaise: agg.captionCostPaise + agg.imageCostPaise,
        // Snapshotted amounts (rates in effect at event time) plus a
        // current-rate fallback for rows that predate snapshotting.
        displaySpendPaise:
          snapshotDisplayPaise +
          noSnapshotCaptionCount * displayRates.captionPaise +
          noSnapshotImageCount * displayRates.imagePaise,
      };
    })
    .sort((a, b) => b.totalCostPaise - a.totalCostPaise);

  const toMonthTotal = (r: {
    month: string;
    captionCount: number;
    imageCount: number;
    knownCostPaise: number;
    unknownCount: number;
    snapshotDisplayPaise: number;
    noSnapshotCaptionCount: number;
    noSnapshotImageCount: number;
  }) => ({
    month: r.month,
    captionCount: r.captionCount,
    imageCount: r.imageCount,
    totalCostPaise: r.knownCostPaise,
    // Historical months keep the rates in effect at the time (per-event
    // snapshots); only pre-snapshot rows fall back to current rates.
    displaySpendPaise:
      r.snapshotDisplayPaise +
      r.noSnapshotCaptionCount * displayRates.captionPaise +
      r.noSnapshotImageCount * displayRates.imagePaise,
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
 * GET /admin/text-gen-settings
 * The platform-wide text generation provider selection.
 */
router.get("/admin/text-gen-settings", async (_req: Request, res: Response) => {
  res.json(await serializeTextGenSettings());
});

/**
 * PUT /admin/text-gen-settings
 * Route caption/topic/campaign text through the built-in provider or
 * OpenRouter. Switching back to "builtin" is the rollback path.
 */
router.put("/admin/text-gen-settings", async (req: Request, res: Response) => {
  const parsed = AdminUpdateTextGenSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const provider = parsed.data.provider as TextGenProvider;
  if (!TEXT_GEN_PROVIDERS.includes(provider)) {
    res.status(400).json({ error: "Unknown text generation provider" });
    return;
  }
  const models = (parsed.data.models ?? [])
    .map((m) => m.trim())
    .filter((m, i, all) => m.length > 0 && all.indexOf(m) === i)
    .slice(0, 20);
  const defaultModel = parsed.data.defaultModel?.trim() || null;
  if (provider === "openrouter") {
    if (models.length === 0) {
      res.status(400).json({ error: "Add at least one OpenRouter model id" });
      return;
    }
    if (defaultModel && !models.includes(defaultModel)) {
      res.status(400).json({ error: "The default model must be one of the listed models" });
      return;
    }
    if (!(await getOpenRouterKeySource())) {
      res.status(400).json({
        error: "Save an OpenRouter API key before switching text generation to OpenRouter",
      });
      return;
    }
  }

  const before = await getTextGenSelection();
  await setTextGenSelection({
    provider,
    models: provider === "openrouter" ? models : [],
    defaultModel: provider === "openrouter" ? (defaultModel ?? models[0] ?? null) : null,
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

  res.json(await serializeTextGenSettings());
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
  brandKits: number;
  scheduledPosts: number;
}): boolean {
  return (
    invalidLimit(limits.captions) ||
    invalidLimit(limits.images) ||
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

  const { name, priceLabel, limits, features, teamSeats, priceInr, priceInrYearly } =
    parsed.data;
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
  let nextRazorpayPlanId = previous.razorpayPlanId;
  let nextRazorpayPlanIdYearly = previous.razorpayPlanIdYearly;
  const needsMonthlyMint =
    nextPriceInr !== null &&
    (nextPriceInr !== previous.priceInr || !nextRazorpayPlanId);
  const needsYearlyMint =
    nextPriceInrYearly !== null &&
    (nextPriceInrYearly !== previous.priceInrYearly || !nextRazorpayPlanIdYearly);
  if (nextPriceInr === null) {
    nextRazorpayPlanId = null;
  }
  if (nextPriceInrYearly === null) {
    nextRazorpayPlanIdYearly = null;
  }
  if (needsMonthlyMint || needsYearlyMint) {
    if (!(await isRazorpayConfigured())) {
      res.status(400).json({
        error:
          "Add Razorpay API keys before setting plan prices (see the Razorpay card).",
      });
      return;
    }
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
      res.status(502).json({
        error: "Razorpay rejected the plan price. Check the API keys and try again.",
      });
      return;
    }
  }

  const values = {
    id: planId,
    name: name.trim(),
    priceLabel: priceLabel.trim(),
    priceInr: nextPriceInr,
    razorpayPlanId: nextRazorpayPlanId,
    priceInrYearly: nextPriceInrYearly,
    razorpayPlanIdYearly: nextRazorpayPlanIdYearly,
    teamSeats: teamSeats ?? previous.teamSeats,
    captions: limits.captions,
    images: limits.images,
    brandKits: limits.brandKits,
    scheduledPosts: limits.scheduledPosts,
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
      oldValue: JSON.stringify(previous.limits),
      newValue: JSON.stringify(limits),
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

  const { name, priceLabel, limits, features, teamSeats, priceInr, priceInrYearly } =
    parsed.data;
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
  if (newPriceInr !== null) {
    if (!(await isRazorpayConfigured())) {
      res.status(400).json({
        error:
          "Add Razorpay API keys before setting plan prices (see the Razorpay card).",
      });
      return;
    }
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
      res.status(502).json({
        error: "Razorpay rejected the plan price. Check the API keys and try again.",
      });
      return;
    }
  }

  await db.insert(planSettingsTable).values({
    id,
    name: name.trim(),
    priceLabel: priceLabel.trim(),
    priceInr: newPriceInr,
    razorpayPlanId: newRazorpayPlanId,
    priceInrYearly: newPriceInrYearly,
    razorpayPlanIdYearly: newRazorpayPlanIdYearly,
    teamSeats: teamSeats ?? 0,
    captions: limits.captions,
    images: limits.images,
    brandKits: limits.brandKits,
    scheduledPosts: limits.scheduledPosts,
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
      newValue: JSON.stringify({ id, name: name.trim(), limits }),
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
// Billing: credit packs (superadmin-defined) + manual credit grants
// ---------------------------------------------------------------------------

function serializeCreditPack(p: typeof creditPacksTable.$inferSelect) {
  return {
    id: p.id,
    name: p.name,
    pricePaise: p.pricePaise,
    captionCredits: p.captionCredits,
    imageCredits: p.imageCredits,
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
}) =>
  !b.name.trim() ||
  !Number.isInteger(b.pricePaise) ||
  b.pricePaise <= 0 ||
  !Number.isInteger(b.captionCredits) ||
  b.captionCredits < 0 ||
  !Number.isInteger(b.imageCredits) ||
  b.imageCredits < 0 ||
  (b.captionCredits === 0 && b.imageCredits === 0);

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
  if ((b.captionCredits ?? 0) <= 0 && (b.imageCredits ?? 0) <= 0) {
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
  if (nextCaptions <= 0 && nextImages <= 0) {
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
  if (
    !Number.isInteger(captionCredits) ||
    !Number.isInteger(imageCredits) ||
    (captionCredits === 0 && imageCredits === 0)
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
      newValue: JSON.stringify({ captionCredits, imageCredits }),
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
  "email_settings_change",
  "email_test_send",
  "sweep_run",
  "credit_pack_change",
  "credit_grant",
  "promo_code_change",
  "textgen_provider_change",
  "textgen_key_change",
  "ai_spend_settings_change",
  "ai_cost_change",
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

export default router;
