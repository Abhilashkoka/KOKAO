import { Router, type IRouter, type Request, type Response } from "express";
import { db, tenantsTable, brandKitsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { openai, generateImageBuffer } from "@workspace/integrations-openai-ai-server";
import { GenerateCaptionBody, GenerateImageBody } from "@workspace/api-zod";
import { ObjectStorageService } from "../lib/objectStorage";
import { getPlanLimits } from "../lib/plans";
import { getUsage, recordUsage } from "../lib/usage";

const router: IRouter = Router();

const objectStorageService = new ObjectStorageService();

async function loadTenant(tenantId: number) {
  return (
    await db.select().from(tenantsTable).where(eq(tenantsTable.id, tenantId)).limit(1)
  )[0];
}

async function loadBrandKit(tenantId: number, brandKitId: number | null | undefined) {
  if (!brandKitId) return undefined;
  return (
    await db
      .select()
      .from(brandKitsTable)
      .where(and(eq(brandKitsTable.id, brandKitId), eq(brandKitsTable.tenantId, tenantId)))
      .limit(1)
  )[0];
}

router.post("/ai/generate-caption", async (req: Request, res: Response) => {
  const parsed = GenerateCaptionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }

  const tenant = await loadTenant(req.tenantId);
  if (!tenant) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const limits = getPlanLimits(tenant.plan);
  const usage = await getUsage(req.tenantId);
  if (limits.captions !== -1 && usage.captions >= limits.captions) {
    res.status(402).json({ error: "Monthly caption quota reached. Upgrade your plan to continue." });
    return;
  }

  const brandKit = await loadBrandKit(req.tenantId, parsed.data.brandKitId ?? null);
  const platform = parsed.data.platform ?? "instagram";
  const tone = parsed.data.tone ?? brandKit?.voice ?? "friendly and engaging";

  const guidance: string[] = [
    `You are an expert social media copywriter. Write a ${platform} caption.`,
    `Tone/voice: ${tone}.`,
  ];
  if (brandKit) {
    guidance.push(`Brand name: ${brandKit.name}.`);
    if (brandKit.hashtags.length > 0) {
      guidance.push(`Prefer these brand hashtags when relevant: ${brandKit.hashtags.join(", ")}.`);
    }
  }
  guidance.push(
    'Respond ONLY with strict JSON of the form {"caption": string, "hashtags": string[]}. ' +
      "Hashtags must not include the # symbol. Provide 5-12 relevant hashtags.",
  );

  try {
    const completion = await openai.chat.completions.create({
      model: tenant.aiModel,
      messages: [
        { role: "system", content: guidance.join(" ") },
        { role: "user", content: parsed.data.prompt },
      ],
      max_completion_tokens: 8192,
      response_format: { type: "json_object" },
    });

    const raw = completion.choices[0]?.message?.content ?? "{}";
    let caption = "";
    let hashtags: string[] = [];
    try {
      const obj = JSON.parse(raw) as { caption?: string; hashtags?: unknown };
      caption = typeof obj.caption === "string" ? obj.caption : "";
      hashtags = Array.isArray(obj.hashtags)
        ? obj.hashtags.map((h) => String(h).replace(/^#/, "")).filter(Boolean)
        : [];
    } catch {
      caption = raw;
    }

    await recordUsage(req.tenantId, "caption");
    res.json({ caption, hashtags });
  } catch (error) {
    req.log.error({ err: error }, "Caption generation failed");
    res.status(500).json({ error: "Failed to generate caption" });
  }
});

router.post("/ai/generate-image", async (req: Request, res: Response) => {
  const parsed = GenerateImageBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }

  const tenant = await loadTenant(req.tenantId);
  if (!tenant) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const limits = getPlanLimits(tenant.plan);
  const usage = await getUsage(req.tenantId);
  if (limits.images !== -1 && usage.images >= limits.images) {
    res.status(402).json({ error: "Monthly image quota reached. Upgrade your plan to continue." });
    return;
  }

  const brandKit = await loadBrandKit(req.tenantId, parsed.data.brandKitId ?? null);
  const size = parsed.data.size ?? "1024x1024";

  let prompt = parsed.data.prompt;
  if (brandKit) {
    prompt += `. Brand palette: ${brandKit.primaryColor}, ${brandKit.secondaryColor}, ${brandKit.accentColor}. Cohesive with a ${brandKit.voice || "modern"} brand aesthetic.`;
  }

  try {
    const buffer = await generateImageBuffer(prompt, size);

    const uploadURL = await objectStorageService.getObjectEntityUploadURL();
    const putRes = await fetch(uploadURL, {
      method: "PUT",
      headers: { "Content-Type": "image/png" },
      body: new Uint8Array(buffer),
    });
    if (!putRes.ok) {
      throw new Error(`Upload failed with status ${putRes.status}`);
    }
    const imagePath = objectStorageService.normalizeObjectEntityPath(uploadURL);

    await recordUsage(req.tenantId, "image");
    res.json({ imagePath, b64Json: buffer.toString("base64") });
  } catch (error) {
    req.log.error({ err: error }, "Image generation failed");
    res.status(500).json({ error: "Failed to generate image" });
  }
});

export default router;
