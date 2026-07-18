import { Router, type IRouter, type Request, type Response } from "express";
import { db, userConsentsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { z } from "zod/v4";
import { loadConsent, toConsentFlags } from "../lib/analytics";

/**
 * Per-USER data-collection consent (keyed by Clerk user id — a team member's
 * consent follows them across workspaces). All categories default OFF.
 * Mounted behind requireTenant.
 */
const router: IRouter = Router();

const ConsentInput = z.object({
  analytics: z.boolean().optional(),
  deviceDetails: z.boolean().optional(),
  locationCoarse: z.boolean().optional(),
  locationPrecise: z.boolean().optional(),
  carrier: z.boolean().optional(),
});

router.get("/consent", async (req: Request, res: Response) => {
  try {
    const row = await loadConsent(req.clerkUserId);
    res.json({ ...toConsentFlags(row), responded: Boolean(row?.respondedAt) });
  } catch (error) {
    req.log.error({ err: error }, "Failed to load consent");
    res.status(500).json({ error: "Failed to load consent" });
  }
});

router.put("/consent", async (req: Request, res: Response) => {
  const parsed = ConsentInput.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  try {
    const now = new Date();
    const values = {
      clerkUserId: req.clerkUserId,
      ...parsed.data,
      respondedAt: now,
      updatedAt: now,
    };
    await db
      .insert(userConsentsTable)
      .values(values)
      .onConflictDoUpdate({
        target: userConsentsTable.clerkUserId,
        set: { ...parsed.data, respondedAt: now, updatedAt: now },
      });
    const row = await db
      .select()
      .from(userConsentsTable)
      .where(eq(userConsentsTable.clerkUserId, req.clerkUserId))
      .limit(1);
    res.json({
      ...toConsentFlags(row[0]),
      responded: Boolean(row[0]?.respondedAt),
    });
  } catch (error) {
    req.log.error({ err: error }, "Failed to save consent");
    res.status(500).json({ error: "Failed to save consent" });
  }
});

export default router;
