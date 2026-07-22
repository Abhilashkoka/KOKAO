import { Router, type IRouter, type Request, type Response } from "express";
import { db, tenantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { UpdateSettingsBody } from "@workspace/api-zod";
import { serializeTenant } from "../lib/serializers";
import { getPlanLimits, listPlans } from "../lib/plans";
import { getUsage } from "../lib/usage";
import { getCreditBalances } from "../lib/credits";
import { isSuperadminEmail } from "../lib/superadmins";
import { getEffectiveSeatLimit, getMembershipDetails } from "../lib/team";
import { requireWorkspaceAdmin } from "../middlewares/requireWorkspaceAdmin";
import { getPendingInviteHint } from "../lib/teamInviteEmail";
import { isFeatureEnabled } from "../lib/featureFlags";
import { isAllowedTenantModel } from "../lib/textGen";

const router: IRouter = Router();

async function loadTenant(tenantId: number) {
  return (
    await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId)).limit(1)
  )[0];
}

router.get("/me", async (req: Request, res: Response) => {
  const tenant = await loadTenant(req.tenantId);
  if (!tenant) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const usage = await getUsage(req.tenantId);
  const seatLimit = await getEffectiveSeatLimit(tenant);
  // For invited members/admins, surface who invited them and when they
  // joined so the UI can explain which workspace they are in.
  const membership =
    req.memberRole !== "owner"
      ? await getMembershipDetails(tenant, req.clerkUserId)
      : { invitedByEmail: null, joinedAt: null };
  // Owners only: surface a pending team invite that sits on one of the
  // user's verified emails so a missed invite isn't silently lost (invites
  // only auto-accept on FIRST sign-in with the invited address). Best-effort
  // and briefly cached inside the helper.
  const pendingInvite =
    req.memberRole === "owner"
      ? await getPendingInviteHint(req.clerkUserId, req.tenantId)
      : null;
  res.json({
    tenant: serializeTenant(tenant),
    usage: {
      captions: usage.captions,
      images: usage.images,
      videos: usage.videos,
      periodStart: usage.periodStart.toISOString(),
    },
    limits: await getPlanLimits(tenant.plan),
    credits: await getCreditBalances(req.tenantId),
    isSuperadmin: req.isSuperadmin,
    // UI hint only: role-management authorization is enforced server-side
    // against the live verified email in the admin route.
    isOwner: isSuperadminEmail(tenant.email),
    brandOnboardingComplete: tenant.brandOnboardingComplete,
    team: {
      enabled: seatLimit > 0,
      role: req.memberRole,
      seatLimit,
      workspaceName: tenant.name,
      invitedByEmail: membership.invitedByEmail,
      joinedAt: membership.joinedAt,
    },
    pendingInvite,
  });
});

// Workspace settings (name, plan, AI model) are owner/admin-only; plain
// members read them via /me but cannot change them.
router.patch("/me/settings", requireWorkspaceAdmin, async (req: Request, res: Response) => {
  const parsed = UpdateSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }

  // Only models the AI provider actually serves may be stored; anything else
  // would make every AI call fail with an "unsupported model" error.
  if (parsed.data.aiModel !== undefined && !(await isAllowedTenantModel(parsed.data.aiModel))) {
    res.status(400).json({ error: "Unsupported AI model" });
    return;
  }

  // The plan catalog is dynamic (superadmins can add/delete plans), so the
  // requested plan must be validated against the live catalog, not an enum.
  if (parsed.data.plan !== undefined) {
    // Plan changes are billing functionality: blocked when the billing
    // module is disabled platform-wide by a superadmin.
    if (!(await isFeatureEnabled("billing"))) {
      res.status(403).json({
        error: "This feature is currently disabled by the administrator",
        code: "feature_disabled",
      });
      return;
    }
    const plans = await listPlans();
    if (!plans.some((p) => p.id === parsed.data.plan)) {
      res.status(400).json({ error: "Unknown plan" });
      return;
    }
  }

  const updated = (
    await db
      .update(tenantsTable)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(tenantsTable.id, req.tenantId))
      .returning()
  )[0];

  if (!updated) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  res.json(serializeTenant(updated));
});

export default router;
