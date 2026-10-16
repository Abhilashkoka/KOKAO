import { Router, type IRouter, type Request, type Response } from "express";
import { db, quickCreatePresetsTable, type QuickCreatePreset } from "@workspace/db";
import { asc, eq } from "drizzle-orm";
import {
  AdminCreateQuickCreatePresetBody,
  AdminUpdateQuickCreatePresetBody,
} from "@workspace/api-zod";
import { recordAdminAction } from "../lib/adminAudit";
import { requireSuperadmin } from "../middlewares/requireSuperadmin";

/**
 * Quick Create starters.
 *
 * Tenants read the published list; superadmins manage every row. A starter
 * only pre-fills a form (prompt, length, shape, music), so it carries no
 * tenant assets and needs no per-workspace scoping.
 */
const router: IRouter = Router();
// Mounted at the API root after requireTenant; gate only the admin paths.
router.use("/admin/quick-create-presets", requireSuperadmin);

export function serializeQuickCreatePreset(row: QuickCreatePreset) {
  return {
    id: row.id,
    label: row.label,
    vertical: row.vertical,
    prompt: row.prompt,
    durationSec: row.durationSec,
    aspect: row.aspect,
    photoHint: row.photoHint,
    musicPrompt: row.musicPrompt,
    published: row.published,
    sortOrder: row.sortOrder,
  };
}

function presetId(req: Request): number | null {
  const raw = Array.isArray(req.params.presetId) ? req.params.presetId[0] : req.params.presetId;
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Trim free text and turn blanks into null so the form never stores "". */
export function normalizeQuickCreatePresetInput(input: {
  label: string;
  vertical: QuickCreatePreset["vertical"];
  prompt: string;
  durationSec: number;
  aspect: QuickCreatePreset["aspect"];
  photoHint?: string | null;
  musicPrompt?: string | null;
  published?: boolean;
  sortOrder?: number;
}) {
  const label = input.label.trim();
  const prompt = input.prompt.trim();
  if (!label) return { error: "Give the starter a name." } as const;
  if (!prompt) return { error: "Give the starter a prompt." } as const;
  return {
    value: {
      label,
      vertical: input.vertical,
      prompt,
      durationSec: input.durationSec,
      aspect: input.aspect,
      photoHint: input.photoHint?.trim() || null,
      musicPrompt: input.musicPrompt?.trim() || null,
      published: input.published ?? false,
      sortOrder: input.sortOrder ?? 0,
    },
  } as const;
}

async function audit(req: Request, oldValue: unknown, newValue: unknown): Promise<void> {
  await recordAdminAction({
    action: "quick_create_preset_change",
    actorTenantId: req.tenantId,
    actorEmail: req.tenantEmail ?? null,
    targetTenantId: null,
    targetEmail: null,
    oldValue: oldValue == null ? null : JSON.stringify(oldValue),
    newValue: newValue == null ? null : JSON.stringify(newValue),
  }).catch((err) => req.log.error({ err }, "Failed to audit Quick Create preset change"));
}

router.get("/quick-create/presets", async (_req: Request, res: Response): Promise<void> => {
  const rows = await db
    .select()
    .from(quickCreatePresetsTable)
    .where(eq(quickCreatePresetsTable.published, true))
    .orderBy(asc(quickCreatePresetsTable.sortOrder), asc(quickCreatePresetsTable.id));
  res.json(rows.map(serializeQuickCreatePreset));
});

router.get("/admin/quick-create-presets", async (_req: Request, res: Response): Promise<void> => {
  const rows = await db
    .select()
    .from(quickCreatePresetsTable)
    .orderBy(asc(quickCreatePresetsTable.sortOrder), asc(quickCreatePresetsTable.id));
  res.json(rows.map(serializeQuickCreatePreset));
});

router.post("/admin/quick-create-presets", async (req: Request, res: Response): Promise<void> => {
  const parsed = AdminCreateQuickCreatePresetBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid starter input." });
    return;
  }
  const normalized = normalizeQuickCreatePresetInput(parsed.data);
  if ("error" in normalized) {
    res.status(400).json({ error: normalized.error });
    return;
  }
  const [created] = await db.insert(quickCreatePresetsTable).values(normalized.value).returning();
  await audit(req, null, created);
  res.status(201).json(serializeQuickCreatePreset(created!));
});

router.patch(
  "/admin/quick-create-presets/:presetId",
  async (req: Request, res: Response): Promise<void> => {
    const id = presetId(req);
    if (id === null) {
      res.status(400).json({ error: "Invalid starter id." });
      return;
    }
    const parsed = AdminUpdateQuickCreatePresetBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid starter input." });
      return;
    }
    const normalized = normalizeQuickCreatePresetInput(parsed.data);
    if ("error" in normalized) {
      res.status(400).json({ error: normalized.error });
      return;
    }
    const [existing] = await db
      .select()
      .from(quickCreatePresetsTable)
      .where(eq(quickCreatePresetsTable.id, id))
      .limit(1);
    if (!existing) {
      res.status(404).json({ error: "Starter not found." });
      return;
    }
    const [updated] = await db
      .update(quickCreatePresetsTable)
      .set(normalized.value)
      .where(eq(quickCreatePresetsTable.id, id))
      .returning();
    await audit(req, existing, updated);
    res.json(serializeQuickCreatePreset(updated!));
  },
);

router.delete(
  "/admin/quick-create-presets/:presetId",
  async (req: Request, res: Response): Promise<void> => {
    const id = presetId(req);
    if (id === null) {
      res.status(400).json({ error: "Invalid starter id." });
      return;
    }
    const [deleted] = await db
      .delete(quickCreatePresetsTable)
      .where(eq(quickCreatePresetsTable.id, id))
      .returning();
    if (!deleted) {
      res.status(404).json({ error: "Starter not found." });
      return;
    }
    await audit(req, deleted, null);
    res.status(204).end();
  },
);

export default router;
