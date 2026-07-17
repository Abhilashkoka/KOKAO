import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  memberNotificationPreferencesTable,
  notificationPreferencesTable,
} from "@workspace/db";
import { UpdateNotificationSettingsBody } from "@workspace/api-zod";
import { isEmailConfigured } from "../lib/email";
import {
  NOTIFICATION_TYPES,
  NOTIFICATION_TYPE_SET,
} from "../lib/notificationCatalog";
import {
  defaultPolicy,
  defaultPreference,
  getMemberPreferenceMap,
  getPolicyMap,
  getPreferenceMap,
  resolveEffective,
} from "../lib/notificationSettings";

const router: IRouter = Router();

/**
 * Whether the request comes from a team member (admin/member) working inside
 * someone ELSE's workspace. Their notification choices are member-scoped —
 * stored per (workspace, clerkUserId) — so they never touch the owner's
 * tenant-scoped preferences.
 */
function isMemberScoped(req: Request): boolean {
  return req.memberRole !== undefined && req.memberRole !== "owner";
}

/**
 * Assemble the notification settings: for each catalog type, fold the global
 * policy with the stored preference (tenant-scoped for owners, member-scoped
 * for team members) and expose both the raw preference (what the toggles show)
 * and the effective channels.
 */
async function buildSettings(req: Request) {
  const memberScoped = isMemberScoped(req);
  const [emailConfigured, policyMap, prefMap] = await Promise.all([
    isEmailConfigured(),
    getPolicyMap(),
    memberScoped
      ? getMemberPreferenceMap(req.tenantId, req.clerkUserId)
      : getPreferenceMap(req.tenantId),
  ]);

  const types = NOTIFICATION_TYPES.map((def) => {
    const policy = policyMap.get(def.type) ?? defaultPolicy();
    const preference = prefMap.get(def.type) ?? defaultPreference();
    const effective = resolveEffective(policy, preference);
    return {
      type: def.type,
      label: def.label,
      description: def.description,
      enabled: policy.enabled,
      emailPolicy: policy.emailPolicy,
      preference,
      effective,
    };
  });

  return {
    emailConfigured,
    scope: memberScoped ? ("member" as const) : ("workspace" as const),
    types,
  };
}

router.get(
  "/notification-settings",
  async (req: Request, res: Response) => {
    res.json(await buildSettings(req));
  },
);

router.put(
  "/notification-settings",
  async (req: Request, res: Response) => {
    const parsed = UpdateNotificationSettingsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }

    // Hard-fail on any unknown type so client bugs / forged payloads surface
    // instead of silently producing partial writes.
    const unknown = parsed.data.preferences
      .map((p) => p.type)
      .filter((t) => !NOTIFICATION_TYPE_SET.has(t));
    if (unknown.length > 0) {
      res
        .status(400)
        .json({ error: `Unknown notification type(s): ${unknown.join(", ")}` });
      return;
    }

    const tenantId = req.tenantId;
    if (isMemberScoped(req)) {
      // Member-scoped write: the member's own rows only. Never touches the
      // owner's tenant-scoped preferences.
      const clerkUserId = req.clerkUserId;
      for (const pref of parsed.data.preferences) {
        await db
          .insert(memberNotificationPreferencesTable)
          .values({
            tenantId,
            clerkUserId,
            type: pref.type,
            inApp: pref.inApp,
            email: pref.email,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [
              memberNotificationPreferencesTable.tenantId,
              memberNotificationPreferencesTable.clerkUserId,
              memberNotificationPreferencesTable.type,
            ],
            set: {
              inApp: pref.inApp,
              email: pref.email,
              updatedAt: new Date(),
            },
          });
      }
    } else {
      for (const pref of parsed.data.preferences) {
        await db
          .insert(notificationPreferencesTable)
          .values({
            tenantId,
            type: pref.type,
            inApp: pref.inApp,
            email: pref.email,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [
              notificationPreferencesTable.tenantId,
              notificationPreferencesTable.type,
            ],
            set: {
              inApp: pref.inApp,
              email: pref.email,
              updatedAt: new Date(),
            },
          });
      }
    }

    res.json(await buildSettings(req));
  },
);

export default router;
