import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  type TemplateSlot,
  type VideoStyleProfile,
  type VideoStyleProfilePayload,
  videoStyleProfilesTable,
} from "@workspace/db";
import { asc, and, eq } from "drizzle-orm";
import { z } from "zod";
import { requireSuperadmin } from "../middlewares/requireSuperadmin";
import { recordAdminAction } from "../lib/adminAudit";
import {
  assertTemplateSafe,
  estimateVideoUnits,
  TENANT_SCOPED_OPTION_KEYS,
  type TemplateJobDefaults,
} from "../lib/videoGen/videoTemplates";

/**
 * Platform-wide video formats are deliberately administered separately from a
 * workspace's reference styles. The only mutations here are create and delete:
 * formats are published on creation, and changing one means replacing it so a
 * format never silently changes beneath a workspace that selected it.
 */
const router: IRouter = Router();
router.use("/admin/video-templates", requireSuperadmin);

const CreateAdminVideoTemplateBody = z.object({
  name: z.string().min(1).max(80),
  summary: z.string().max(240).nullable().optional(),
  slots: z.array(z.object({
    kind: z.enum(["presenter_video", "script", "brand_kit", "character", "music", "logo"]),
    required: z.boolean(),
    label: z.string(),
    hint: z.string().optional(),
  })).max(6).optional(),
  jobDefaults: z.object({
    aspectRatio: z.enum(["16:9", "9:16", "1:1"]).optional(),
    shotCount: z.number().int().min(1).max(10).optional(),
    subtitles: z.boolean().optional(),
    captionStyle: z.enum(["classic", "dynamic"]).optional(),
    paragraphCount: z.number().int().min(1).max(3).optional(),
    visualsSource: z.enum(["stock", "ai", "ai_video", "character"]).optional(),
    stockSource: z.enum(["auto", "pexels", "pixabay", "wikimedia"]).optional(),
    reviewStoryboard: z.boolean().optional(),
  }).strict().optional(),
});

const ALLOWED_DEFAULT_KEYS = new Set([
  "aspectRatio",
  "shotCount",
  "subtitles",
  "captionStyle",
  "paragraphCount",
  "visualsSource",
  "stockSource",
  "reviewStoryboard",
]);

function serializeTemplate(profile: VideoStyleProfile) {
  return {
    id: profile.id,
    name: profile.name,
    summary: profile.summary,
    scope: profile.scope,
    sourceKind: profile.sourceKind,
    slots: profile.slots,
    jobDefaults: profile.jobDefaults,
    estimatedUnits: estimateVideoUnits(profile.jobDefaults),
    sourceVideoPath: profile.sourceVideoPath,
    payload: profile.payload,
    createdAt: profile.createdAt.toISOString(),
    updatedAt: profile.updatedAt.toISOString(),
  };
}

async function audit(
  req: Request,
  oldValue: unknown,
  newValue: unknown,
): Promise<void> {
  try {
    await recordAdminAction({
      action: "video_template_change",
      actorTenantId: req.tenantId,
      actorEmail: req.tenantEmail,
      targetTenantId: null,
      targetEmail: null,
      oldValue: oldValue == null ? null : JSON.stringify(oldValue),
      newValue: newValue == null ? null : JSON.stringify(newValue),
    });
  } catch (error) {
    req.log.error({ err: error }, "Failed to write video-template audit log");
  }
}

function buildPayload(
  summary: string | null,
  jobDefaults: TemplateJobDefaults,
): VideoStyleProfilePayload {
  const shotCount =
    typeof jobDefaults.shotCount === "number" && jobDefaults.shotCount > 0
      ? jobDefaults.shotCount
      : 1;
  const captionStyle =
    jobDefaults.captionStyle === "classic" || jobDefaults.captionStyle === "none"
      ? jobDefaults.captionStyle
      : "dynamic";

  return {
    version: 1,
    hookShape: "Curated KOKAO format",
    pacing: { sceneCount: shotCount, avgSceneSec: 0, wordsPerMinute: 0 },
    captionStyle,
    energy: "balanced",
    visualNotes: [],
    scriptGuidance: summary || "Follow this curated KOKAO video format.",
    sourceDurationSec: 0,
    // A platform format is never based on a workspace's transcript.
    transcriptExcerpt: "",
  };
}

router.get("/admin/video-templates", async (_req: Request, res: Response) => {
  const templates = await db
    .select()
    .from(videoStyleProfilesTable)
    .where(
      and(
        eq(videoStyleProfilesTable.scope, "platform"),
        eq(videoStyleProfilesTable.sourceKind, "curated"),
        eq(videoStyleProfilesTable.published, true),
      ),
    )
    .orderBy(asc(videoStyleProfilesTable.name));

  res.json(templates.map(serializeTemplate));
});

router.post("/admin/video-templates", async (req: Request, res: Response) => {
  const rawDefaults = req.body?.jobDefaults;
  if (
    rawDefaults !== undefined &&
    (typeof rawDefaults !== "object" || rawDefaults === null || Array.isArray(rawDefaults))
  ) {
    res.status(400).json({ error: "Template defaults must be an object." });
    return;
  }
  const unsupportedKeys = rawDefaults
    ? Object.keys(rawDefaults).filter((key) => !ALLOWED_DEFAULT_KEYS.has(key))
    : [];
  if (unsupportedKeys.length > 0) {
    const workspaceKeys = unsupportedKeys.filter((key) =>
      (TENANT_SCOPED_OPTION_KEYS as readonly string[]).includes(key),
    );
    res.status(400).json({
      error:
        workspaceKeys.length > 0
          ? `Platform templates cannot include workspace fields: ${workspaceKeys.join(", ")}.`
          : `Unsupported template defaults: ${unsupportedKeys.join(", ")}.`,
    });
    return;
  }

  const parsed = CreateAdminVideoTemplateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid template" });
    return;
  }

  const name = parsed.data.name.trim();
  if (!name) {
    res.status(400).json({ error: "Give this template a name." });
    return;
  }

  const summary = parsed.data.summary?.trim() || null;
  const slots = (parsed.data.slots ?? []) as TemplateSlot[];
  const jobDefaults = (parsed.data.jobDefaults ?? {}) as TemplateJobDefaults;
  const candidate = {
    scope: "platform" as const,
    tenantId: null,
    sourceKind: "curated" as const,
    name,
    sourceVideoPath: null,
    jobDefaults,
    payload: buildPayload(summary, jobDefaults),
  };

  try {
    assertTemplateSafe(candidate);
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Invalid platform template.",
    });
    return;
  }

  const [created] = await db
    .insert(videoStyleProfilesTable)
    .values({
      ...candidate,
      published: true,
      summary,
      slots,
    })
    .returning();

  await audit(req, null, serializeTemplate(created!));
  res.status(201).json(serializeTemplate(created!));
});

router.delete(
  "/admin/video-templates/:templateId",
  async (req: Request, res: Response) => {
    const templateId = Number(req.params.templateId);
    if (!Number.isInteger(templateId) || templateId <= 0) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }

    const [deleted] = await db
      .delete(videoStyleProfilesTable)
      .where(
        and(
          eq(videoStyleProfilesTable.id, templateId),
          eq(videoStyleProfilesTable.scope, "platform"),
          eq(videoStyleProfilesTable.sourceKind, "curated"),
        ),
      )
      .returning();
    if (!deleted) {
      res.status(404).json({ error: "Template not found" });
      return;
    }

    await audit(req, serializeTemplate(deleted), null);
    res.status(204).end();
  },
);

export default router;