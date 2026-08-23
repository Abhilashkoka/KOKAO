import { Router, type IRouter, type Request, type Response } from "express";
import { db, videoStyleProfilesTable } from "@workspace/db";
import type {
  VideoStyleProfile as DbVideoStyleProfile,
  VideoStyleProfilePayload,
} from "@workspace/db";
import { and, asc, eq } from "drizzle-orm";
import {
  AdminCreateVideoTemplateBody,
  AdminSetVideoTemplatePublishedBody,
  AdminUpdateVideoTemplateBody,
  type VideoStyleProfile as ApiVideoStyleProfile,
} from "@workspace/api-zod";
import { recordAdminAction } from "../lib/adminAudit";
import {
  assertTemplateSafe,
  estimateVideoUnits,
  TEMPLATE_JOB_DEFAULT_KEYS,
  UnsafeTemplateError,
} from "../lib/videoGen/videoTemplates";
import { requireSuperadmin } from "../middlewares/requireSuperadmin";

const router: IRouter = Router();
router.use(requireSuperadmin);

function unsupportedRawDefaultKeys(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const jobDefaults = (body as { jobDefaults?: unknown }).jobDefaults;
  if (!jobDefaults || typeof jobDefaults !== "object" || Array.isArray(jobDefaults)) return [];
  return Object.keys(jobDefaults).filter(
    (key) => !(TEMPLATE_JOB_DEFAULT_KEYS as readonly string[]).includes(key),
  );
}

function serializeTemplate(profile: DbVideoStyleProfile) {
  return {
    id: profile.id,
    name: profile.name,
    summary: profile.summary,
    scope: profile.scope,
    sourceKind: profile.sourceKind,
    published: profile.published,
    slots: profile.slots,
    jobDefaults: profile.jobDefaults,
    estimatedUnits: estimateVideoUnits(profile.jobDefaults),
    sourceVideoPath: profile.sourceVideoPath,
    payload: profile.payload,
    createdAt: profile.createdAt.toISOString(),
    updatedAt: profile.updatedAt.toISOString(),
  };
}

function templateId(req: Request): number | null {
  const raw = Array.isArray(req.params.templateId) ? req.params.templateId[0] : req.params.templateId;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function safeTemplateInput(
  input: {
    name: string;
    summary?: string | null;
    slots: DbVideoStyleProfile["slots"];
    jobDefaults: Record<string, unknown>;
    payload: ApiVideoStyleProfile["payload"];
  },
) {
  const name = input.name.trim();
  if (!name) return { error: "Give the template a name." } as const;
  const kinds = input.slots.map((slot) => slot.kind);
  if (new Set(kinds).size !== kinds.length) {
    return { error: "A template can only declare each required input once." } as const;
  }
  const hasRequiredScript = input.slots.some(
    (slot) => slot.required && slot.kind === "script",
  );
  const hasRequiredPresenter = input.slots.some(
    (slot) => slot.required && slot.kind === "presenter_video",
  );
  const hasOptionalPresenter = input.slots.some(
    (slot) => !slot.required && slot.kind === "presenter_video",
  );
  if (hasOptionalPresenter) {
    return {
      error: "A presenter recording must be required whenever it is part of a template.",
    } as const;
  }
  if (!hasRequiredScript && !hasRequiredPresenter) {
    return {
      error:
        "A video template must require a topic or script; presenter formats may require a presenter recording instead.",
    } as const;
  }
  const durationSec = input.jobDefaults.durationSec;
  if (
    typeof durationSec === "number" &&
    durationSec > 30 &&
    !hasRequiredPresenter
  ) {
    return {
      error: "Formats longer than 30 seconds must require a presenter recording.",
    } as const;
  }
  if (hasRequiredPresenter && input.jobDefaults.visualsSource === "character") {
    return {
      error: "Presenter formats cannot also use a saved character.",
    } as const;
  }
  if (input.payload.version !== 1) {
    return { error: "This template uses an unsupported profile version." } as const;
  }
  const value = {
    tenantId: null,
    scope: "platform" as const,
    sourceKind: "curated" as const,
    sourceVideoPath: null,
    name,
    summary: input.summary?.trim() || null,
    slots: input.slots,
    jobDefaults: input.jobDefaults,
    payload: input.payload as VideoStyleProfilePayload,
  };
  try {
    assertTemplateSafe(value);
  } catch (error) {
    if (error instanceof UnsafeTemplateError) return { error: error.message } as const;
    throw error;
  }
  return { value } as const;
}

async function auditTemplateChange(
  req: Request,
  oldValue: unknown,
  newValue: unknown,
): Promise<void> {
  await recordAdminAction({
    action: "video_template_change",
    actorTenantId: req.tenantId,
    actorEmail: req.tenantEmail ?? null,
    targetTenantId: null,
    targetEmail: null,
    oldValue: oldValue == null ? null : JSON.stringify(oldValue),
    newValue: JSON.stringify(newValue),
  }).catch((err) => req.log.error({ err }, "Failed to audit video template change"));
}

router.get("/admin/video-templates", async (_req: Request, res: Response): Promise<void> => {
  const templates = await db
    .select()
    .from(videoStyleProfilesTable)
    .where(
      and(
        eq(videoStyleProfilesTable.scope, "platform"),
        eq(videoStyleProfilesTable.sourceKind, "curated"),
      ),
    )
    .orderBy(asc(videoStyleProfilesTable.id));
  res.json(templates.map(serializeTemplate));
});

router.post("/admin/video-templates", async (req: Request, res: Response): Promise<void> => {
  const unsupportedKeys = unsupportedRawDefaultKeys(req.body);
  if (unsupportedKeys.length > 0) {
    res.status(400).json({
      error: `Template carries unsafe or unsupported defaults (${unsupportedKeys.join(", ")}).`,
    });
    return;
  }
  const parsed = AdminCreateVideoTemplateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid template input." });
    return;
  }
  const safe = safeTemplateInput(parsed.data);
  if ("error" in safe) {
    res.status(400).json({ error: safe.error });
    return;
  }
  const [created] = await db
    .insert(videoStyleProfilesTable)
    .values({ ...safe.value, published: false })
    .returning();
  await auditTemplateChange(req, null, created);
  res.status(201).json(serializeTemplate(created!));
});

router.patch("/admin/video-templates/:templateId", async (req: Request, res: Response): Promise<void> => {
  const id = templateId(req);
  if (id === null) {
    res.status(400).json({ error: "Invalid template id." });
    return;
  }
  const unsupportedKeys = unsupportedRawDefaultKeys(req.body);
  if (unsupportedKeys.length > 0) {
    res.status(400).json({
      error: `Template carries unsafe or unsupported defaults (${unsupportedKeys.join(", ")}).`,
    });
    return;
  }
  const parsed = AdminUpdateVideoTemplateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid template input." });
    return;
  }
  const safe = safeTemplateInput(parsed.data);
  if ("error" in safe) {
    res.status(400).json({ error: safe.error });
    return;
  }
  const [existing] = await db
    .select()
    .from(videoStyleProfilesTable)
    .where(
      and(
        eq(videoStyleProfilesTable.id, id),
        eq(videoStyleProfilesTable.scope, "platform"),
        eq(videoStyleProfilesTable.sourceKind, "curated"),
      ),
    )
    .limit(1);
  if (!existing) {
    res.status(404).json({ error: "Template not found." });
    return;
  }
  const [updated] = await db
    .update(videoStyleProfilesTable)
    .set(safe.value)
    .where(eq(videoStyleProfilesTable.id, id))
    .returning();
  await auditTemplateChange(req, existing, updated);
  res.json(serializeTemplate(updated!));
});

router.put(
  "/admin/video-templates/:templateId/published",
  async (req: Request, res: Response): Promise<void> => {
    const id = templateId(req);
    if (id === null) {
      res.status(400).json({ error: "Invalid template id." });
      return;
    }
    const parsed = AdminSetVideoTemplatePublishedBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid publication state." });
      return;
    }
    const [existing] = await db
      .select()
      .from(videoStyleProfilesTable)
      .where(
        and(
          eq(videoStyleProfilesTable.id, id),
          eq(videoStyleProfilesTable.scope, "platform"),
          eq(videoStyleProfilesTable.sourceKind, "curated"),
        ),
      )
      .limit(1);
    if (!existing) {
      res.status(404).json({ error: "Template not found." });
      return;
    }
    const unsupportedKeys = unsupportedRawDefaultKeys({
      jobDefaults: existing.jobDefaults,
    });
    if (unsupportedKeys.length > 0) {
      res.status(400).json({
        error: `Template carries unsafe or unsupported defaults (${unsupportedKeys.join(", ")}).`,
      });
      return;
    }
    const safe = safeTemplateInput({
      name: existing.name,
      summary: existing.summary,
      slots: existing.slots,
      jobDefaults: existing.jobDefaults,
      payload: existing.payload,
    });
    if ("error" in safe) {
      res.status(400).json({ error: safe.error });
      return;
    }
    const [updated] = await db
      .update(videoStyleProfilesTable)
      .set({ published: parsed.data.published })
      .where(eq(videoStyleProfilesTable.id, id))
      .returning();
    await auditTemplateChange(req, existing, updated);
    res.json(serializeTemplate(updated!));
  },
);

router.delete(
  "/admin/video-templates/:templateId",
  async (req: Request, res: Response): Promise<void> => {
    const id = templateId(req);
    if (id === null) {
      res.status(400).json({ error: "Invalid template id." });
      return;
    }
    const [deleted] = await db
      .delete(videoStyleProfilesTable)
      .where(
        and(
          eq(videoStyleProfilesTable.id, id),
          eq(videoStyleProfilesTable.scope, "platform"),
          eq(videoStyleProfilesTable.sourceKind, "curated"),
        ),
      )
      .returning();
    if (!deleted) {
      res.status(404).json({ error: "Template not found." });
      return;
    }
    await auditTemplateChange(req, deleted, null);
    res.status(204).end();
  },
);

export default router;