import { Router, type IRouter, type Request, type Response } from "express";
import { db, notificationPreferencesTable } from "@workspace/db";
import { UpdateNotificationSettingsBody } from "@workspace/api-zod";
import { isEmailConfigured } from "../lib/email";
import {
  NOTIFICATION_TYPES,
  NOTIFICATION_TYPE_SET,
} from "../lib/notificationCatalog";
import {
  defaultPolicy,
  defaultPreference,
  getPolicyMap,
  getPreferenceMap,
  resolveEffective,
} from "../lib/notificationSettings";

const router: IRouter = Router();

/**
 * Assemble the tenant-facing notification settings: for each catalog type,
 * fold the global policy with the tenant's stored preference and expose both
 * the raw preference (what the toggles show) and the effective channels.
 */
async function buildSettings(tenantId: number) {
  const [emailConfigured, policyMap, prefMap] = await Promise.all([
    isEmailConfigured(),
    getPolicyMap(),
    getPreferenceMap(tenantId),
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

  return { emailConfigured, types };
}

router.get(
  "/notification-settings",
  async (req: Request, res: Response) => {
    res.json(await buildSettings(req.tenantId));
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

    res.json(await buildSettings(tenantId));
  },
);

export default router;
