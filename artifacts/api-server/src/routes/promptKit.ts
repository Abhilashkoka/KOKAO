import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  promptCaseTypesTable,
  promptTemplatesTable,
  promptTemplateVersionsTable,
  userPromptCustomizationsTable,
  type PromptCaseType,
  type UserPromptCustomization,
} from "@workspace/db";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import {
  CreatePromptCustomizationBody,
  UpdatePromptCustomizationBody,
  PreviewPromptCustomizationBody,
} from "@workspace/api-zod";

/**
 * Prompt Template Kit — end-user routes. Any signed-in workspace user (owner
 * or member) can browse the active case types, manage their OWN customization
 * variants, and preview the merged prompt. Users can never read the full
 * admin prompt internals (only block titles), and nothing here can mutate
 * admin-owned rows — customizations live in their own table, keyed by
 * tenant + clerkUserId.
 */
const router: IRouter = Router();

function serializeCustomization(row: UserPromptCustomization) {
  return {
    id: row.id,
    caseTypeId: row.caseTypeId,
    title: row.title,
    instructionBlock: row.instructionBlock,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function loadLiveTemplateSummary(
  caseType: PromptCaseType,
): Promise<{ hasLive: boolean; summary: string | null; mandatoryTitles: string[] }> {
  const template = (
    await db
      .select()
      .from(promptTemplatesTable)
      .where(
        and(
          eq(promptTemplatesTable.caseTypeId, caseType.id),
          eq(promptTemplatesTable.status, "active"),
        ),
      )
      .orderBy(promptTemplatesTable.id)
      .limit(1)
  )[0];
  if (!template?.activeProductionVersionId) {
    return { hasLive: false, summary: null, mandatoryTitles: [] };
  }
  const version = (
    await db
      .select()
      .from(promptTemplateVersionsTable)
      .where(
        eq(promptTemplateVersionsTable.id, template.activeProductionVersionId),
      )
      .limit(1)
  )[0];
  if (!version || version.lifecycleState !== "production") {
    return { hasLive: false, summary: null, mandatoryTitles: [] };
  }
  const mandatoryTitles = version.contentSnapshot
    .filter((b) => b.mandatory)
    .sort((a, b) => a.order - b.order)
    .map((b) => b.title);
  return {
    hasLive: true,
    summary: template.description ?? template.title,
    mandatoryTitles,
  };
}

router.get("/prompt-kit/cases", async (_req: Request, res: Response) => {
  const cases = await db
    .select()
    .from(promptCaseTypesTable)
    .where(eq(promptCaseTypesTable.status, "active"))
    .orderBy(promptCaseTypesTable.name);
  const out = [];
  for (const caseType of cases) {
    const live = await loadLiveTemplateSummary(caseType);
    out.push({
      id: caseType.id,
      name: caseType.name,
      slug: caseType.slug,
      description: caseType.description,
      flowKey: caseType.flowKey,
      hasLiveTemplate: live.hasLive,
      adminSummary: live.summary,
    });
  }
  res.json(out);
});

router.get("/prompt-kit/customizations", async (req: Request, res: Response) => {
  const rows = await db
    .select()
    .from(userPromptCustomizationsTable)
    .where(
      and(
        eq(userPromptCustomizationsTable.tenantId, req.tenantId),
        eq(userPromptCustomizationsTable.clerkUserId, req.clerkUserId),
        ne(userPromptCustomizationsTable.status, "archived"),
      ),
    )
    .orderBy(desc(userPromptCustomizationsTable.updatedAt));
  res.json(rows.map(serializeCustomization));
});

router.post("/prompt-kit/customizations", async (req: Request, res: Response) => {
  const parsed = CreatePromptCustomizationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }
  const body = parsed.data;
  const caseType = (
    await db
      .select({ id: promptCaseTypesTable.id })
      .from(promptCaseTypesTable)
      .where(
        and(
          eq(promptCaseTypesTable.id, body.caseTypeId),
          eq(promptCaseTypesTable.status, "active"),
        ),
      )
      .limit(1)
  )[0];
  if (!caseType) {
    res.status(400).json({ error: "Case type not found" });
    return;
  }
  const row = (
    await db
      .insert(userPromptCustomizationsTable)
      .values({
        tenantId: req.tenantId,
        clerkUserId: req.clerkUserId,
        caseTypeId: body.caseTypeId,
        title: body.title,
        instructionBlock: body.instructionBlock,
      })
      .returning()
  )[0]!;
  res.json(serializeCustomization(row));
});

router.patch(
  "/prompt-kit/customizations/:customizationId",
  async (req: Request, res: Response) => {
    const id = Number(req.params.customizationId);
    const parsed = UpdatePromptCustomizationBody.safeParse(req.body);
    if (!Number.isInteger(id) || !parsed.success) {
      res.status(400).json({ error: "Invalid request" });
      return;
    }
    // Strict owner scoping: id + tenant + user in the WHERE, so a foreign id
    // 404s instead of leaking or mutating someone else's variant.
    const before = (
      await db
        .select()
        .from(userPromptCustomizationsTable)
        .where(
          and(
            eq(userPromptCustomizationsTable.id, id),
            eq(userPromptCustomizationsTable.tenantId, req.tenantId),
            eq(userPromptCustomizationsTable.clerkUserId, req.clerkUserId),
          ),
        )
        .limit(1)
    )[0];
    if (!before) {
      res.status(404).json({ error: "Customization not found" });
      return;
    }
    const body = parsed.data;
    const row = (
      await db
        .update(userPromptCustomizationsTable)
        .set({
          ...(body.title !== undefined ? { title: body.title } : {}),
          ...(body.instructionBlock !== undefined
            ? { instructionBlock: body.instructionBlock }
            : {}),
          ...(body.status !== undefined ? { status: body.status } : {}),
        })
        .where(eq(userPromptCustomizationsTable.id, before.id))
        .returning()
    )[0]!;
    res.json(serializeCustomization(row));
  },
);

/**
 * Merged preview: shows the layer structure with the admin's mandatory block
 * TITLES (never their full internals) plus the caller's amendment verbatim,
 * so users understand what is applied without exposing governed prompt text.
 */
router.post("/prompt-kit/preview", async (req: Request, res: Response) => {
  const parsed = PreviewPromptCustomizationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }
  const body = parsed.data;
  const caseType = (
    await db
      .select()
      .from(promptCaseTypesTable)
      .where(
        and(
          eq(promptCaseTypesTable.id, body.caseTypeId),
          eq(promptCaseTypesTable.status, "active"),
        ),
      )
      .limit(1)
  )[0];
  if (!caseType) {
    res.status(404).json({ error: "Case type not found" });
    return;
  }
  const live = await loadLiveTemplateSummary(caseType);

  let amendment = body.instructionBlock ?? null;
  if (!amendment && body.customizationId) {
    const rows = await db
      .select()
      .from(userPromptCustomizationsTable)
      .where(
        and(
          inArray(userPromptCustomizationsTable.id, [body.customizationId]),
          eq(userPromptCustomizationsTable.tenantId, req.tenantId),
          eq(userPromptCustomizationsTable.clerkUserId, req.clerkUserId),
        ),
      )
      .limit(1);
    amendment = rows[0]?.instructionBlock ?? null;
  }

  const lines: string[] = [];
  lines.push("## System rules (always applied)");
  lines.push("Platform safety and consistency rules.");
  lines.push("");
  if (live.hasLive) {
    lines.push("## Admin template (always applied)");
    if (live.summary) lines.push(live.summary);
    for (const title of live.mandatoryTitles) lines.push(`- ${title}`);
  } else {
    lines.push("## Admin template");
    lines.push(
      "No live admin template for this case yet - generations use the app's built-in prompts.",
    );
  }
  lines.push("");
  lines.push("## Your customization (added after the admin layers)");
  lines.push(amendment?.trim() || "(none selected)");
  if (body.sampleInput?.trim()) {
    lines.push("");
    lines.push("## Your request");
    lines.push(body.sampleInput.trim());
  }
  res.json({ preview: lines.join("\n"), missingPlaceholders: [] });
});

export default router;
