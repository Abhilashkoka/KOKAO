import { Router, type IRouter, type Request, type Response } from "express";
import { db, pushTokensTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import {
  RegisterPushTokenBody,
  UnregisterPushTokenBody,
} from "@workspace/api-zod";
import { looksLikeExpoToken } from "../lib/push";

const router: IRouter = Router();

/**
 * POST /push-tokens — register (or re-bind) this device's Expo push token.
 *
 * Tokens are keyed by the TOKEN itself (a device has exactly one) and bound
 * to the signed-in user: re-registering an existing token moves it to the
 * CURRENT signer, so a handed-over or re-signed-in device never keeps
 * pushing to its previous user. Idempotent.
 */
router.post("/push-tokens", async (req: Request, res: Response) => {
  const parsed = RegisterPushTokenBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const { token } = parsed.data;
  if (!looksLikeExpoToken(token)) {
    res.status(400).json({ error: "Not a valid Expo push token" });
    return;
  }
  const platform = parsed.data.platform ?? "unknown";

  await db
    .insert(pushTokensTable)
    .values({
      clerkUserId: req.clerkUserId,
      token,
      platform,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: pushTokensTable.token,
      set: {
        clerkUserId: req.clerkUserId,
        platform,
        updatedAt: new Date(),
      },
    });

  res.json({ ok: true });
});

/**
 * POST /push-tokens/unregister — stop pushing to this device. Only removes
 * the row when it belongs to the signed-in user (a forged request cannot
 * silence someone else's device). Idempotent — succeeds when nothing matched.
 */
router.post("/push-tokens/unregister", async (req: Request, res: Response) => {
  const parsed = UnregisterPushTokenBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }

  await db
    .delete(pushTokensTable)
    .where(
      and(
        eq(pushTokensTable.token, parsed.data.token),
        eq(pushTokensTable.clerkUserId, req.clerkUserId),
      ),
    );

  res.json({ ok: true });
});

export default router;
