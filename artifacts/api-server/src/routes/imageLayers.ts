import { Router, type IRouter, type Request, type Response } from "express";
import { db, tenantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { PlanImageLayersBody } from "@workspace/api-zod";
import { compileImagePrompt } from "../lib/imageGen/promptCompiler";
import { isFeatureEnabled } from "../lib/featureFlags";
import { TextGenNotConfiguredError } from "../lib/textGen";
import { estimateChargePaise } from "../lib/wallet";
import { planImageLayers, LayerPlanError } from "../lib/imageLayers/planner";
import { planUnits } from "../lib/imageLayers/types";
import type { ImageSize } from "../lib/imageGen";

const router: IRouter = Router();

/**
 * Quote-before-charge for layered generation.
 *
 * Planning is a text-model call costing a fraction of a paisa, so it runs
 * BEFORE any funding is reserved and takes nothing from the user. That is the
 * whole point of the endpoint: the client can say "this will be six layers,
 * six credits" and offer a cheaper choice, instead of the user discovering the
 * multiplier on their statement. The plan comes back to the client and is
 * posted straight to /ai/generate-image-async, so the quoted layer count and
 * the billed layer count are the same object.
 *
 * Costs no image credit, and deliberately does not touch the wallet at all.
 */
router.post("/ai/layer-plan", async (req: Request, res: Response) => {
  const parsed = PlanImageLayersBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const tenant = (
    await db.select().from(tenantsTable).where(eq(tenantsTable.id, req.tenantId)).limit(1)
  )[0];
  if (!tenant) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const plan = await planImageLayers({
      tenantId: req.tenantId,
      tenant,
      // Same compilation the generation route applies, so the plan is built
      // against the prompt that will actually be rendered.
      brief: compileImagePrompt(
        parsed.data.prompt,
        (await isFeatureEnabled("imageLooks").catch(() => true))
          ? parsed.data.promptRecipe
          : undefined,
      ),
      size: (parsed.data.size ?? "1024x1024") as ImageSize,
      brandKitId: parsed.data.brandKitId ?? null,
    });

    const units = planUnits(plan);
    // Best-effort: the wallet rate is display-only here, and a workspace on
    // the quota rail has no paise figure to show at all.
    const unitPaise = await estimateChargePaise("image").catch(() => 0);

    res.json({
      plan,
      units,
      estimatedPaise: unitPaise > 0 ? unitPaise * units : null,
    });
  } catch (error) {
    if (error instanceof LayerPlanError || error instanceof TextGenNotConfiguredError) {
      res.status(400).json({ error: error.message });
      return;
    }
    req.log.error({ err: error }, "Layer planning failed");
    res.status(500).json({ error: "Failed to plan image layers" });
  }
});

export default router;
