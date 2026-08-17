import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  tenantsTable,
  promptCaseTypesTable,
  promptTemplatesTable,
  promptTemplateVersionsTable,
  promptReviewsTable,
  promptTestCasesTable,
  promptTestRunsTable,
  compiledPromptLogsTable,
  promptKitExportLogTable,
  type PromptBlock,
  type PromptCaseType,
  type PromptTemplate,
  type PromptTemplateVersion,
  type PromptTestCase,
  type PromptTestRun,
  type PromptReview,
  type PromptVersionLifecycle,
  type PromptKitExportedPromotion,
} from "@workspace/db";
import { and, desc, eq, gt, inArray, isNotNull, ne, sql } from "drizzle-orm";
import {
  CreatePromptCaseBody,
  UpdatePromptCaseBody,
  CreatePromptTemplateBody,
  UpdatePromptTemplateBody,
  CreatePromptVersionBody,
  TransitionPromptVersionBody,
  AddPromptReviewCommentBody,
  CreatePromptTestCaseBody,
  UpdatePromptTestCaseBody,
  RunPromptPlaygroundBody,
  JudgePromptTestRunBody,
  ImportPromptKitBody,
} from "@workspace/api-zod";
import { requireSuperadmin } from "../middlewares/requireSuperadmin";
import { recordAdminAction, type AdminAuditAction } from "../lib/adminAudit";
import {
  canTransition,
  compilePromptLayers,
  productionPromotionBlocked,
  promoteVersionToProduction,
  extractPlaceholders,
} from "../lib/promptKit";
import { getTextGenClient, TextGenNotConfiguredError } from "../lib/textGen";

/**
 * Prompt Template Kit — superadmin governance routes. Everything here is
 * platform-wide (case types and templates apply to all tenants), so every
 * route sits behind requireSuperadmin and every mutation is audited
 * best-effort to the append-only admin audit trail.
 *
 * Deletes are soft everywhere: case types and templates archive via status,
 * versions archive via lifecycle state, test cases via archivedAt.
 */
const router: IRouter = Router();
router.use("/admin/prompt-kit", requireSuperadmin);

// ---------------------------------------------------------------------------
// serializers
// ---------------------------------------------------------------------------

function serializeCase(row: PromptCaseType) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    riskLevel: row.riskLevel,
    approvalRequired: row.approvalRequired,
    flowKey: row.flowKey,
    tags: row.tags ?? [],
    ownerEmail: row.ownerEmail,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function serializeTemplate(
  row: PromptTemplate,
  extra?: {
    latestVersionNo?: number | null;
    productionVersionNo?: number | null;
    usageRequests?: number | null;
    usageTenants?: number | null;
  },
) {
  return {
    id: row.id,
    caseTypeId: row.caseTypeId,
    title: row.title,
    description: row.description,
    status: row.status,
    activeProductionVersionId: row.activeProductionVersionId,
    activeStagingVersionId: row.activeStagingVersionId,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    latestVersionNo: extra?.latestVersionNo ?? null,
    productionVersionNo: extra?.productionVersionNo ?? null,
    usageRequests: extra?.usageRequests ?? null,
    usageTenants: extra?.usageTenants ?? null,
  };
}

function serializeVersion(row: PromptTemplateVersion) {
  return {
    id: row.id,
    templateId: row.templateId,
    caseTypeId: row.caseTypeId,
    versionNo: row.versionNo,
    parentVersionId: row.parentVersionId,
    blocks: row.contentSnapshot,
    config: row.configSnapshot ?? {},
    changeNotes: row.changeNotes,
    lifecycleState: row.lifecycleState,
    evalStatus: row.evalStatus,
    submittedBy: row.submittedBy,
    submittedAt: row.submittedAt?.toISOString() ?? null,
    approvedBy: row.approvedBy,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

function serializeReview(row: PromptReview) {
  return {
    id: row.id,
    promptVersionId: row.promptVersionId,
    reviewerEmail: row.reviewerEmail,
    decision: row.decision,
    comments: row.comments,
    createdAt: row.createdAt.toISOString(),
  };
}

function serializeTestCase(row: PromptTestCase) {
  return {
    id: row.id,
    caseTypeId: row.caseTypeId,
    title: row.title,
    input: row.inputJson ?? {},
    expectedNotes: row.expectedNotes,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    archivedAt: row.archivedAt?.toISOString() ?? null,
  };
}

function serializeTestRun(row: PromptTestRun) {
  return {
    id: row.id,
    promptVersionId: row.promptVersionId,
    testCaseId: row.testCaseId,
    input: row.inputJson ?? {},
    outputText: row.outputText,
    compiledPrompt: row.compiledPrompt,
    score: row.score,
    passFail: row.passFail,
    latencyMs: row.latencyMs,
    estimatedCostPaise: row.estimatedCostPaise,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

async function audit(
  req: Request,
  action: AdminAuditAction,
  oldValue: unknown,
  newValue: unknown,
): Promise<void> {
  try {
    await recordAdminAction({
      action,
      actorTenantId: req.tenantId,
      actorEmail: req.tenantEmail,
      targetTenantId: null,
      targetEmail: null,
      oldValue: oldValue == null ? null : JSON.stringify(oldValue),
      newValue: newValue == null ? null : JSON.stringify(newValue),
    });
  } catch (error) {
    req.log.error({ err: error, action }, "Failed to write prompt-kit audit log");
  }
}

async function loadVersion(id: number): Promise<PromptTemplateVersion | undefined> {
  return (
    await db
      .select()
      .from(promptTemplateVersionsTable)
      .where(eq(promptTemplateVersionsTable.id, id))
      .limit(1)
  )[0];
}

// ---------------------------------------------------------------------------
// Case types
// ---------------------------------------------------------------------------

router.get("/admin/prompt-kit/cases", async (req: Request, res: Response) => {
  const includeArchived = req.query.includeArchived === "true";
  const rows = await db
    .select()
    .from(promptCaseTypesTable)
    .where(includeArchived ? undefined : eq(promptCaseTypesTable.status, "active"))
    .orderBy(promptCaseTypesTable.name);
  res.json(rows.map(serializeCase));
});

router.post("/admin/prompt-kit/cases", async (req: Request, res: Response) => {
  const parsed = CreatePromptCaseBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }
  const body = parsed.data;
  const existing = (
    await db
      .select({ id: promptCaseTypesTable.id })
      .from(promptCaseTypesTable)
      .where(eq(promptCaseTypesTable.slug, body.slug))
      .limit(1)
  )[0];
  if (existing) {
    res.status(400).json({ error: "A case type with this slug already exists" });
    return;
  }
  // One active case per generation flow: the compiler resolves a flow to a
  // single case, so a second binding would silently shadow the first.
  if (body.flowKey) {
    const clash = (
      await db
        .select({ id: promptCaseTypesTable.id })
        .from(promptCaseTypesTable)
        .where(
          and(
            eq(promptCaseTypesTable.flowKey, body.flowKey),
            eq(promptCaseTypesTable.status, "active"),
          ),
        )
        .limit(1)
    )[0];
    if (clash) {
      res.status(400).json({
        error: "Another active case type is already bound to this generation flow",
      });
      return;
    }
  }
  const row = (
    await db
      .insert(promptCaseTypesTable)
      .values({
        name: body.name,
        slug: body.slug,
        description: body.description ?? null,
        riskLevel: body.riskLevel ?? "low",
        approvalRequired: body.approvalRequired ?? false,
        flowKey: body.flowKey ?? null,
        tags: body.tags ?? [],
        ownerEmail: req.tenantEmail,
      })
      .returning()
  )[0]!;
  await audit(req, "prompt_case_change", null, serializeCase(row));
  res.json(serializeCase(row));
});

router.patch(
  "/admin/prompt-kit/cases/:caseId",
  async (req: Request, res: Response) => {
    const caseId = Number(req.params.caseId);
    const parsed = UpdatePromptCaseBody.safeParse(req.body);
    if (!Number.isInteger(caseId) || !parsed.success) {
      res.status(400).json({ error: "Invalid request" });
      return;
    }
    const before = (
      await db
        .select()
        .from(promptCaseTypesTable)
        .where(eq(promptCaseTypesTable.id, caseId))
        .limit(1)
    )[0];
    if (!before) {
      res.status(404).json({ error: "Case type not found" });
      return;
    }
    const body = parsed.data;
    if (body.flowKey && body.flowKey !== before.flowKey) {
      const clash = (
        await db
          .select({ id: promptCaseTypesTable.id })
          .from(promptCaseTypesTable)
          .where(
            and(
              eq(promptCaseTypesTable.flowKey, body.flowKey),
              eq(promptCaseTypesTable.status, "active"),
              ne(promptCaseTypesTable.id, caseId),
            ),
          )
          .limit(1)
      )[0];
      if (clash) {
        res.status(400).json({
          error:
            "Another active case type is already bound to this generation flow",
        });
        return;
      }
    }
    const row = (
      await db
        .update(promptCaseTypesTable)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.description !== undefined
            ? { description: body.description }
            : {}),
          ...(body.riskLevel !== undefined ? { riskLevel: body.riskLevel } : {}),
          ...(body.approvalRequired !== undefined
            ? { approvalRequired: body.approvalRequired }
            : {}),
          ...(body.flowKey !== undefined ? { flowKey: body.flowKey } : {}),
          ...(body.tags !== undefined ? { tags: body.tags } : {}),
          ...(body.status !== undefined
            ? {
                status: body.status,
                archivedAt: body.status === "archived" ? new Date() : null,
              }
            : {}),
        })
        .where(eq(promptCaseTypesTable.id, caseId))
        .returning()
    )[0]!;
    await audit(req, "prompt_case_change", serializeCase(before), serializeCase(row));
    res.json(serializeCase(row));
  },
);

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

router.get("/admin/prompt-kit/templates", async (req: Request, res: Response) => {
  const caseTypeId = req.query.caseTypeId ? Number(req.query.caseTypeId) : null;
  const includeArchived = req.query.includeArchived === "true";
  const conditions = [];
  if (caseTypeId) conditions.push(eq(promptTemplatesTable.caseTypeId, caseTypeId));
  if (!includeArchived) conditions.push(ne(promptTemplatesTable.status, "archived"));
  const rows = await db
    .select()
    .from(promptTemplatesTable)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(promptTemplatesTable.updatedAt));

  const ids = rows.map((r) => r.id);
  const latest = new Map<number, number>();
  const prodNos = new Map<number, number>();
  const usage = new Map<number, { requests: number; tenants: Set<number> }>();
  if (ids.length > 0) {
    const versions = await db
      .select({
        templateId: promptTemplateVersionsTable.templateId,
        id: promptTemplateVersionsTable.id,
        versionNo: promptTemplateVersionsTable.versionNo,
      })
      .from(promptTemplateVersionsTable)
      .where(inArray(promptTemplateVersionsTable.templateId, ids));
    const prodIds = new Set(
      rows.map((r) => r.activeProductionVersionId).filter(Boolean),
    );
    for (const v of versions) {
      if ((latest.get(v.templateId) ?? 0) < v.versionNo)
        latest.set(v.templateId, v.versionNo);
      if (prodIds.has(v.id)) prodNos.set(v.templateId, v.versionNo);
    }
    const logs = await db
      .select({
        templateId: compiledPromptLogsTable.templateId,
        tenantId: compiledPromptLogsTable.tenantId,
      })
      .from(compiledPromptLogsTable)
      .where(inArray(compiledPromptLogsTable.templateId, ids));
    for (const log of logs) {
      if (log.templateId == null) continue;
      let entry = usage.get(log.templateId);
      if (!entry) usage.set(log.templateId, (entry = { requests: 0, tenants: new Set() }));
      entry.requests += 1;
      entry.tenants.add(log.tenantId);
    }
  }
  res.json(
    rows.map((r) =>
      serializeTemplate(r, {
        latestVersionNo: latest.get(r.id) ?? null,
        productionVersionNo: prodNos.get(r.id) ?? null,
        usageRequests: usage.get(r.id)?.requests ?? 0,
        usageTenants: usage.get(r.id)?.tenants.size ?? 0,
      }),
    ),
  );
});

router.post("/admin/prompt-kit/templates", async (req: Request, res: Response) => {
  const parsed = CreatePromptTemplateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request" });
    return;
  }
  const body = parsed.data;
  const caseType = (
    await db
      .select()
      .from(promptCaseTypesTable)
      .where(eq(promptCaseTypesTable.id, body.caseTypeId))
      .limit(1)
  )[0];
  if (!caseType || caseType.status !== "active") {
    res.status(400).json({ error: "Case type not found or archived" });
    return;
  }
  const hasMandatoryContent = body.blocks.some(
    (b) => b.mandatory && b.content.trim().length > 0,
  );
  if (!hasMandatoryContent) {
    res.status(400).json({ error: "At least one non-empty mandatory block is required" });
    return;
  }
  // One ACTIVE template per case type: the compiler resolves a case to a
  // single template, so a second active one could silently receive (or steal)
  // promotions meant for the other.
  const activeClash = (
    await db
      .select({ id: promptTemplatesTable.id })
      .from(promptTemplatesTable)
      .where(
        and(
          eq(promptTemplatesTable.caseTypeId, body.caseTypeId),
          eq(promptTemplatesTable.status, "active"),
        ),
      )
      .limit(1)
  )[0];
  if (activeClash) {
    res.status(400).json({
      error:
        "An active template already exists for this case type. Archive it first or edit it with a new version.",
    });
    return;
  }
  const template = (
    await db
      .insert(promptTemplatesTable)
      .values({
        caseTypeId: body.caseTypeId,
        title: body.title,
        description: body.description ?? null,
        status: "active",
        createdBy: req.tenantEmail,
      })
      .returning()
  )[0]!;
  await db.insert(promptTemplateVersionsTable).values({
    templateId: template.id,
    caseTypeId: body.caseTypeId,
    versionNo: 1,
    contentSnapshot: body.blocks as PromptBlock[],
    configSnapshot: {
      ...(body.config ?? {}),
      placeholders: extractPlaceholders(body.blocks as PromptBlock[]),
    },
    changeNotes: body.changeNotes ?? "Initial version",
    lifecycleState: "draft",
    createdBy: req.tenantEmail,
  });
  await audit(req, "prompt_template_change", null, serializeTemplate(template));
  res.json(serializeTemplate(template, { latestVersionNo: 1 }));
});

router.patch(
  "/admin/prompt-kit/templates/:templateId",
  async (req: Request, res: Response) => {
    const templateId = Number(req.params.templateId);
    const parsed = UpdatePromptTemplateBody.safeParse(req.body);
    if (!Number.isInteger(templateId) || !parsed.success) {
      res.status(400).json({ error: "Invalid request" });
      return;
    }
    const before = (
      await db
        .select()
        .from(promptTemplatesTable)
        .where(eq(promptTemplatesTable.id, templateId))
        .limit(1)
    )[0];
    if (!before) {
      res.status(404).json({ error: "Template not found" });
      return;
    }
    const body = parsed.data;
    // Archiving a template that is live in production is a high-impact act:
    // require production to be vacated first (deprecate or rollback).
    if (body.status === "archived" && before.activeProductionVersionId) {
      res.status(400).json({
        error:
          "This template is live in production. Deprecate or roll back its production version before archiving.",
      });
      return;
    }
    // Re-activating a template must not create a second ACTIVE template for
    // the same case type (promotions could target the wrong one).
    if (body.status === "active" && before.status !== "active") {
      const activeClash = (
        await db
          .select({ id: promptTemplatesTable.id })
          .from(promptTemplatesTable)
          .where(
            and(
              eq(promptTemplatesTable.caseTypeId, before.caseTypeId),
              eq(promptTemplatesTable.status, "active"),
              ne(promptTemplatesTable.id, templateId),
            ),
          )
          .limit(1)
      )[0];
      if (activeClash) {
        res.status(400).json({
          error:
            "Another active template already exists for this case type. Archive it before activating this one.",
        });
        return;
      }
    }
    const row = (
      await db
        .update(promptTemplatesTable)
        .set({
          ...(body.title !== undefined ? { title: body.title } : {}),
          ...(body.description !== undefined
            ? { description: body.description }
            : {}),
          ...(body.status !== undefined
            ? {
                status: body.status,
                archivedAt: body.status === "archived" ? new Date() : null,
              }
            : {}),
        })
        .where(eq(promptTemplatesTable.id, templateId))
        .returning()
    )[0]!;
    await audit(
      req,
      "prompt_template_change",
      serializeTemplate(before),
      serializeTemplate(row),
    );
    res.json(serializeTemplate(row));
  },
);

router.delete(
  "/admin/prompt-kit/templates/:templateId",
  async (req: Request, res: Response) => {
    const templateId = Number(req.params.templateId);
    if (!Number.isInteger(templateId)) {
      res.status(400).json({ error: "Invalid request" });
      return;
    }
    // Guards + deletion in ONE transaction with the template row locked so a
    // concurrent promotion can't make the template live mid-delete.
    const outcome = await db.transaction(async (tx) => {
      const template = (
        await tx
          .select()
          .from(promptTemplatesTable)
          .where(eq(promptTemplatesTable.id, templateId))
          .limit(1)
          .for("update")
      )[0];
      if (!template) {
        return { status: 404 as const, error: "Template not found" };
      }
      if (template.activeProductionVersionId) {
        return {
          status: 400 as const,
          error:
            "This template is live in production. Deprecate or roll back its production version before deleting.",
        };
      }
      const versionIds = (
        await tx
          .select({ id: promptTemplateVersionsTable.id })
          .from(promptTemplateVersionsTable)
          .where(eq(promptTemplateVersionsTable.templateId, templateId))
      ).map((v) => v.id);
      if (versionIds.length) {
        await tx
          .delete(promptReviewsTable)
          .where(inArray(promptReviewsTable.promptVersionId, versionIds));
        await tx
          .delete(promptTestRunsTable)
          .where(inArray(promptTestRunsTable.promptVersionId, versionIds));
        await tx
          .delete(promptTemplateVersionsTable)
          .where(eq(promptTemplateVersionsTable.templateId, templateId));
      }
      await tx
        .delete(promptTemplatesTable)
        .where(eq(promptTemplatesTable.id, templateId));
      return { status: 200 as const, template, versionCount: versionIds.length };
    });

    if (outcome.status !== 200) {
      res.status(outcome.status).json({ error: outcome.error });
      return;
    }
    await audit(req, "prompt_template_change", serializeTemplate(outcome.template), {
      deleted: true,
      templateId: outcome.template.id,
      versionsDeleted: outcome.versionCount,
    });
    res.json({ ok: true });
  },
);

router.post(
  "/admin/prompt-kit/templates/:templateId/clone",
  async (req: Request, res: Response) => {
    const templateId = Number(req.params.templateId);
    const source = (
      await db
        .select()
        .from(promptTemplatesTable)
        .where(eq(promptTemplatesTable.id, templateId))
        .limit(1)
    )[0];
    if (!source) {
      res.status(404).json({ error: "Template not found" });
      return;
    }
    const latestVersion = (
      await db
        .select()
        .from(promptTemplateVersionsTable)
        .where(eq(promptTemplateVersionsTable.templateId, templateId))
        .orderBy(desc(promptTemplateVersionsTable.versionNo))
        .limit(1)
    )[0];
    const clone = (
      await db
        .insert(promptTemplatesTable)
        .values({
          caseTypeId: source.caseTypeId,
          title: `${source.title} (copy)`,
          description: source.description,
          status: "draft",
          createdBy: req.tenantEmail,
        })
        .returning()
    )[0]!;
    if (latestVersion) {
      await db.insert(promptTemplateVersionsTable).values({
        templateId: clone.id,
        caseTypeId: source.caseTypeId,
        versionNo: 1,
        contentSnapshot: latestVersion.contentSnapshot,
        configSnapshot: latestVersion.configSnapshot,
        changeNotes: `Cloned from "${source.title}" v${latestVersion.versionNo}`,
        lifecycleState: "draft",
        createdBy: req.tenantEmail,
      });
    }
    await audit(req, "prompt_template_change", null, serializeTemplate(clone));
    res.json(serializeTemplate(clone, { latestVersionNo: latestVersion ? 1 : null }));
  },
);

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

router.get(
  "/admin/prompt-kit/templates/:templateId/versions",
  async (req: Request, res: Response) => {
    const templateId = Number(req.params.templateId);
    const template = (
      await db
        .select({ id: promptTemplatesTable.id })
        .from(promptTemplatesTable)
        .where(eq(promptTemplatesTable.id, templateId))
        .limit(1)
    )[0];
    if (!template) {
      res.status(404).json({ error: "Template not found" });
      return;
    }
    const rows = await db
      .select()
      .from(promptTemplateVersionsTable)
      .where(eq(promptTemplateVersionsTable.templateId, templateId))
      .orderBy(desc(promptTemplateVersionsTable.versionNo));
    res.json(rows.map(serializeVersion));
  },
);

router.post(
  "/admin/prompt-kit/templates/:templateId/versions",
  async (req: Request, res: Response) => {
    const templateId = Number(req.params.templateId);
    const parsed = CreatePromptVersionBody.safeParse(req.body);
    if (!Number.isInteger(templateId) || !parsed.success) {
      res.status(400).json({ error: "Invalid request" });
      return;
    }
    const template = (
      await db
        .select()
        .from(promptTemplatesTable)
        .where(eq(promptTemplatesTable.id, templateId))
        .limit(1)
    )[0];
    if (!template) {
      res.status(404).json({ error: "Template not found" });
      return;
    }
    if (template.status === "archived") {
      res.status(400).json({ error: "Restore the template before editing it" });
      return;
    }
    const body = parsed.data;
    const hasMandatoryContent = body.blocks.some(
      (b) => b.mandatory && b.content.trim().length > 0,
    );
    if (!hasMandatoryContent) {
      res
        .status(400)
        .json({ error: "At least one non-empty mandatory block is required" });
      return;
    }
    // Immutable versioning under concurrency: claim the next version number
    // atomically; retry once on the unique constraint.
    for (let attempt = 0; attempt < 2; attempt++) {
      const maxRow = (
        await db
          .select({
            max: sql<number>`coalesce(max(${promptTemplateVersionsTable.versionNo}), 0)`,
          })
          .from(promptTemplateVersionsTable)
          .where(eq(promptTemplateVersionsTable.templateId, templateId))
      )[0];
      try {
        const row = (
          await db
            .insert(promptTemplateVersionsTable)
            .values({
              templateId,
              caseTypeId: template.caseTypeId,
              versionNo: (maxRow?.max ?? 0) + 1,
              parentVersionId: body.parentVersionId ?? null,
              contentSnapshot: body.blocks as PromptBlock[],
              configSnapshot: {
                ...(body.config ?? {}),
                placeholders: extractPlaceholders(body.blocks as PromptBlock[]),
              },
              changeNotes: body.changeNotes ?? null,
              lifecycleState: "draft",
              createdBy: req.tenantEmail,
            })
            .returning()
        )[0]!;
        await audit(req, "prompt_version_change", null, {
          templateId,
          versionNo: row.versionNo,
          changeNotes: row.changeNotes,
        });
        res.json(serializeVersion(row));
        return;
      } catch (error) {
        if (attempt === 1) throw error;
      }
    }
  },
);

router.delete(
  "/admin/prompt-kit/versions/:versionId",
  async (req: Request, res: Response) => {
    const versionId = Number(req.params.versionId);
    if (!Number.isInteger(versionId)) {
      res.status(400).json({ error: "Invalid request" });
      return;
    }
    // All guards run INSIDE one transaction with the version and template
    // rows locked, so a concurrent promotion can't slip in between the
    // check and the delete and leave a dangling live pointer.
    const outcome = await db.transaction(async (tx) => {
      const version = (
        await tx
          .select()
          .from(promptTemplateVersionsTable)
          .where(eq(promptTemplateVersionsTable.id, versionId))
          .limit(1)
          .for("update")
      )[0];
      if (!version) return { status: 404 as const, error: "Version not found" };
      if (version.lifecycleState !== "draft" && version.lifecycleState !== "staging") {
        return {
          status: 400 as const,
          error: `Only draft or staging versions can be deleted (this one is ${version.lifecycleState.replace("_", " ")})`,
        };
      }
      const template = (
        await tx
          .select()
          .from(promptTemplatesTable)
          .where(eq(promptTemplatesTable.id, version.templateId))
          .limit(1)
          .for("update")
      )[0];
      // Safety net: never delete a version any live pointer still references.
      if (template?.activeProductionVersionId === version.id) {
        return {
          status: 400 as const,
          error: "This version is live in production and cannot be deleted",
        };
      }

      if (template?.activeStagingVersionId === version.id) {
        await tx
          .update(promptTemplatesTable)
          .set({ activeStagingVersionId: null })
          .where(eq(promptTemplatesTable.id, template.id));
      }
      // Detach children so their lineage pointer doesn't dangle.
      await tx
        .update(promptTemplateVersionsTable)
        .set({ parentVersionId: null })
        .where(eq(promptTemplateVersionsTable.parentVersionId, version.id));
      await tx
        .delete(promptReviewsTable)
        .where(eq(promptReviewsTable.promptVersionId, version.id));
      await tx
        .delete(promptTestRunsTable)
        .where(eq(promptTestRunsTable.promptVersionId, version.id));
      await tx
        .delete(promptTemplateVersionsTable)
        .where(eq(promptTemplateVersionsTable.id, version.id));
      return { status: 200 as const, version };
    });

    if (outcome.status !== 200) {
      res.status(outcome.status).json({ error: outcome.error });
      return;
    }
    await audit(req, "prompt_version_change", serializeVersion(outcome.version), {
      deleted: true,
      versionId: outcome.version.id,
      templateId: outcome.version.templateId,
    });
    res.json({ ok: true });
  },
);

/**
 * Lifecycle transitions, including review decisions and promotion/rollback.
 * Production promotion atomically demotes the currently-live version and
 * repoints the template pointer; promoting an OLDER version than the current
 * production one is recorded as a rollback.
 */
router.post(
  "/admin/prompt-kit/versions/:versionId/transition",
  async (req: Request, res: Response) => {
    const versionId = Number(req.params.versionId);
    const parsed = TransitionPromptVersionBody.safeParse(req.body);
    if (!Number.isInteger(versionId) || !parsed.success) {
      res.status(400).json({ error: "Invalid request" });
      return;
    }
    const { to, comments } = parsed.data;
    const version = await loadVersion(versionId);
    if (!version) {
      res.status(404).json({ error: "Version not found" });
      return;
    }
    const template = (
      await db
        .select()
        .from(promptTemplatesTable)
        .where(eq(promptTemplatesTable.id, version.templateId))
        .limit(1)
    )[0];
    const caseType = (
      await db
        .select()
        .from(promptCaseTypesTable)
        .where(eq(promptCaseTypesTable.id, version.caseTypeId))
        .limit(1)
    )[0];
    if (!template || !caseType) {
      res.status(404).json({ error: "Template or case type not found" });
      return;
    }

    if (!canTransition(version.lifecycleState, to as PromptVersionLifecycle)) {
      res.status(400).json({
        error: `Cannot move a ${version.lifecycleState.replace("_", " ")} version to ${to.replace("_", " ")}`,
      });
      return;
    }

    const actor = req.tenantEmail;

    if (to === "approved" || to === "rejected") {
      // Any superadmin's Approve is final — including the author's own.
      // Superadmin access to this router is itself the approval mandate.
      await db.insert(promptReviewsTable).values({
        promptVersionId: versionId,
        reviewerEmail: actor,
        decision: to,
        comments: comments ?? null,
      });
      await audit(req, "prompt_review_decision", { versionId, from: version.lifecycleState }, { decision: to, comments: comments ?? null });
    }

    if (to === "production") {
      const blocked = productionPromotionBlocked(caseType, version);
      if (blocked) {
        res.status(400).json({ error: blocked });
        return;
      }
      // Demotion of the previous version, pointer repoint, and the lifecycle
      // flip run in ONE transaction — a mid-promotion failure leaves the
      // previous production state fully intact.
      const result = await promoteVersionToProduction(template.id, versionId);
      await audit(
        req,
        result.isRollback ? "prompt_rollback" : "prompt_promotion",
        {
          templateId: template.id,
          previousProductionVersionId: result.previousProductionVersionId,
        },
        { versionId, versionNo: version.versionNo },
      );
      await audit(
        req,
        "prompt_version_change",
        { versionId, from: version.lifecycleState },
        { to },
      );
      res.json(serializeVersion(result.updated));
      return;
    }

    if (to === "staging") {
      await db
        .update(promptTemplatesTable)
        .set({ activeStagingVersionId: versionId })
        .where(eq(promptTemplatesTable.id, template.id));
    }

    if (to === "archived" && template.activeProductionVersionId === versionId) {
      res.status(400).json({ error: "The live production version cannot be archived" });
      return;
    }

    if (to === "deprecated" && template.activeProductionVersionId === versionId) {
      await db
        .update(promptTemplatesTable)
        .set({ activeProductionVersionId: null })
        .where(eq(promptTemplatesTable.id, template.id));
    }

    const updated = (
      await db
        .update(promptTemplateVersionsTable)
        .set({
          lifecycleState: to as PromptVersionLifecycle,
          ...(to === "pending_review"
            ? { submittedBy: actor, submittedAt: new Date() }
            : {}),
          ...(to === "approved" ? { approvedBy: actor, approvedAt: new Date() } : {}),
        })
        .where(eq(promptTemplateVersionsTable.id, versionId))
        .returning()
    )[0]!;
    await audit(
      req,
      "prompt_version_change",
      { versionId, from: version.lifecycleState },
      { to },
    );
    res.json(serializeVersion(updated));
  },
);

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

router.get(
  "/admin/prompt-kit/versions/:versionId/reviews",
  async (req: Request, res: Response) => {
    const versionId = Number(req.params.versionId);
    const version = await loadVersion(versionId);
    if (!version) {
      res.status(404).json({ error: "Version not found" });
      return;
    }
    const rows = await db
      .select()
      .from(promptReviewsTable)
      .where(eq(promptReviewsTable.promptVersionId, versionId))
      .orderBy(desc(promptReviewsTable.createdAt));
    res.json(rows.map(serializeReview));
  },
);

router.post(
  "/admin/prompt-kit/versions/:versionId/reviews",
  async (req: Request, res: Response) => {
    const versionId = Number(req.params.versionId);
    const parsed = AddPromptReviewCommentBody.safeParse(req.body);
    if (!Number.isInteger(versionId) || !parsed.success) {
      res.status(400).json({ error: "Invalid request" });
      return;
    }
    const version = await loadVersion(versionId);
    if (!version) {
      res.status(404).json({ error: "Version not found" });
      return;
    }
    const row = (
      await db
        .insert(promptReviewsTable)
        .values({
          promptVersionId: versionId,
          reviewerEmail: req.tenantEmail,
          decision: "comment",
          comments: parsed.data.comments,
        })
        .returning()
    )[0]!;
    res.json(serializeReview(row));
  },
);

// ---------------------------------------------------------------------------
// Test cases + playground
// ---------------------------------------------------------------------------

router.get(
  "/admin/prompt-kit/cases/:caseId/test-cases",
  async (req: Request, res: Response) => {
    const caseId = Number(req.params.caseId);
    const rows = await db
      .select()
      .from(promptTestCasesTable)
      .where(eq(promptTestCasesTable.caseTypeId, caseId))
      .orderBy(desc(promptTestCasesTable.createdAt));
    res.json(rows.filter((r) => !r.archivedAt).map(serializeTestCase));
  },
);

router.post(
  "/admin/prompt-kit/cases/:caseId/test-cases",
  async (req: Request, res: Response) => {
    const caseId = Number(req.params.caseId);
    const parsed = CreatePromptTestCaseBody.safeParse(req.body);
    if (!Number.isInteger(caseId) || !parsed.success) {
      res.status(400).json({ error: "Invalid request" });
      return;
    }
    const caseType = (
      await db
        .select({ id: promptCaseTypesTable.id })
        .from(promptCaseTypesTable)
        .where(eq(promptCaseTypesTable.id, caseId))
        .limit(1)
    )[0];
    if (!caseType) {
      res.status(404).json({ error: "Case type not found" });
      return;
    }
    const row = (
      await db
        .insert(promptTestCasesTable)
        .values({
          caseTypeId: caseId,
          title: parsed.data.title,
          inputJson: parsed.data.input as Record<string, unknown>,
          expectedNotes: parsed.data.expectedNotes ?? null,
          createdBy: req.tenantEmail,
        })
        .returning()
    )[0]!;
    res.json(serializeTestCase(row));
  },
);

router.patch(
  "/admin/prompt-kit/test-cases/:testCaseId",
  async (req: Request, res: Response) => {
    const testCaseId = Number(req.params.testCaseId);
    const parsed = UpdatePromptTestCaseBody.safeParse(req.body);
    if (!Number.isInteger(testCaseId) || !parsed.success) {
      res.status(400).json({ error: "Invalid request" });
      return;
    }
    const before = (
      await db
        .select()
        .from(promptTestCasesTable)
        .where(eq(promptTestCasesTable.id, testCaseId))
        .limit(1)
    )[0];
    if (!before) {
      res.status(404).json({ error: "Test case not found" });
      return;
    }
    const body = parsed.data;
    const row = (
      await db
        .update(promptTestCasesTable)
        .set({
          ...(body.title !== undefined ? { title: body.title } : {}),
          ...(body.input !== undefined
            ? { inputJson: body.input as Record<string, unknown> }
            : {}),
          ...(body.expectedNotes !== undefined
            ? { expectedNotes: body.expectedNotes }
            : {}),
          ...(body.archived !== undefined
            ? { archivedAt: body.archived ? new Date() : null }
            : {}),
        })
        .where(eq(promptTestCasesTable.id, testCaseId))
        .returning()
    )[0]!;
    res.json(serializeTestCase(row));
  },
);

router.post(
  "/admin/prompt-kit/playground/run",
  async (req: Request, res: Response) => {
    const parsed = RunPromptPlaygroundBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request" });
      return;
    }
    const body = parsed.data;
    const version = await loadVersion(body.versionId);
    if (!version) {
      res.status(404).json({ error: "Version not found" });
      return;
    }
    let input: Record<string, unknown> = (body.input ?? {}) as Record<
      string,
      unknown
    >;
    if (body.testCaseId) {
      const testCase = (
        await db
          .select()
          .from(promptTestCasesTable)
          .where(eq(promptTestCasesTable.id, body.testCaseId))
          .limit(1)
      )[0];
      if (!testCase || testCase.caseTypeId !== version.caseTypeId) {
        res.status(404).json({ error: "Test case not found for this case type" });
        return;
      }
      input = testCase.inputJson ?? {};
    }

    const userInput = typeof input.userInput === "string" ? input.userInput : "";
    const placeholders =
      input.placeholders && typeof input.placeholders === "object"
        ? Object.fromEntries(
            Object.entries(input.placeholders as Record<string, unknown>).map(
              ([k, v]) => [k, String(v)],
            ),
          )
        : {};

    const compiled = compilePromptLayers({
      blocks: version.contentSnapshot,
      customization: body.customizationText ?? null,
      userInput,
      placeholderValues: placeholders,
    });

    try {
      const tenant = (
        await db
          .select({ aiModel: tenantsTable.aiModel })
          .from(tenantsTable)
          .where(eq(tenantsTable.id, req.tenantId))
          .limit(1)
      )[0];
      // No failover here: the playground exists to show admins how the
      // SELECTED provider behaves, so a masked outage would defeat it.
      const textGen = await getTextGenClient(tenant?.aiModel ?? "", { failover: false });
      const started = Date.now();
      const completion = await textGen.client.chat.completions.create({
        model: textGen.model,
        messages: [{ role: "user", content: compiled.text }],
        max_completion_tokens: 2048,
      });
      const latencyMs = Date.now() - started;
      const outputText = completion.choices[0]?.message?.content ?? "";
      const usage = completion.usage
        ? {
            promptTokens: completion.usage.prompt_tokens ?? 0,
            completionTokens: completion.usage.completion_tokens ?? 0,
            totalTokens: completion.usage.total_tokens ?? 0,
          }
        : null;
      const row = (
        await db
          .insert(promptTestRunsTable)
          .values({
            promptVersionId: version.id,
            testCaseId: body.testCaseId ?? null,
            inputJson: input,
            outputText,
            compiledPrompt: compiled.text.slice(0, 20000),
            latencyMs,
            tokenUsage: usage,
            createdBy: req.tenantEmail,
          })
          .returning()
      )[0]!;
      res.json(serializeTestRun(row));
    } catch (error) {
      if (error instanceof TextGenNotConfiguredError) {
        res.status(503).json({ error: error.message });
        return;
      }
      req.log.error({ err: error }, "Prompt playground run failed");
      res.status(500).json({ error: "Playground run failed" });
    }
  },
);

router.get(
  "/admin/prompt-kit/versions/:versionId/test-runs",
  async (req: Request, res: Response) => {
    const versionId = Number(req.params.versionId);
    const version = await loadVersion(versionId);
    if (!version) {
      res.status(404).json({ error: "Version not found" });
      return;
    }
    const rows = await db
      .select()
      .from(promptTestRunsTable)
      .where(eq(promptTestRunsTable.promptVersionId, versionId))
      .orderBy(desc(promptTestRunsTable.createdAt))
      .limit(50);
    res.json(rows.map(serializeTestRun));
  },
);

router.patch(
  "/admin/prompt-kit/test-runs/:runId",
  async (req: Request, res: Response) => {
    const runId = Number(req.params.runId);
    const parsed = JudgePromptTestRunBody.safeParse(req.body);
    if (!Number.isInteger(runId) || !parsed.success) {
      res.status(400).json({ error: "Invalid request" });
      return;
    }
    const before = (
      await db
        .select()
        .from(promptTestRunsTable)
        .where(eq(promptTestRunsTable.id, runId))
        .limit(1)
    )[0];
    if (!before) {
      res.status(404).json({ error: "Run not found" });
      return;
    }
    const row = (
      await db
        .update(promptTestRunsTable)
        .set({
          ...(parsed.data.passFail !== undefined
            ? { passFail: parsed.data.passFail }
            : {}),
          ...(parsed.data.score !== undefined ? { score: parsed.data.score } : {}),
        })
        .where(eq(promptTestRunsTable.id, runId))
        .returning()
    )[0]!;

    // Recompute the version's eval status from the LATEST judged run per test
    // case: any failing latest run = failed; otherwise 1+ passing = passed.
    const judged = await db
      .select({
        testCaseId: promptTestRunsTable.testCaseId,
        passFail: promptTestRunsTable.passFail,
        createdAt: promptTestRunsTable.createdAt,
      })
      .from(promptTestRunsTable)
      .where(
        and(
          eq(promptTestRunsTable.promptVersionId, before.promptVersionId),
          isNotNull(promptTestRunsTable.passFail),
        ),
      )
      .orderBy(desc(promptTestRunsTable.createdAt));
    const latestPerCase = new Map<number | string, string>();
    for (const r of judged) {
      const key = r.testCaseId ?? "adhoc";
      if (!latestPerCase.has(key)) latestPerCase.set(key, r.passFail!);
    }
    const values = [...latestPerCase.values()];
    const evalStatus = values.includes("fail")
      ? "failed"
      : values.includes("pass")
        ? "passed"
        : "none";
    await db
      .update(promptTemplateVersionsTable)
      .set({ evalStatus })
      .where(eq(promptTemplateVersionsTable.id, before.promptVersionId));

    res.json(serializeTestRun(row));
  },
);

// ---------------------------------------------------------------------------
// Export / import (environment replication)
// ---------------------------------------------------------------------------

const BUNDLE_FORMAT = "kokao-prompt-kit";
const BUNDLE_FORMAT_VERSION = 1;

/**
 * Legacy data can hold multiple "active" templates for one case, but the
 * pipeline only ever resolves ONE (active + production pointer, lowest id).
 * Bundles enforce the one-active invariant, so export normalizes: the
 * governing template keeps "active" and legacy duplicates travel as "draft".
 */
function normalizeActiveTemplates(
  templates: PromptTemplate[],
): { template: PromptTemplate; status: "draft" | "active" | "archived" }[] {
  const actives = templates.filter((t) => t.status === "active");
  let governingId: number | null = null;
  if (actives.length > 1) {
    const governing =
      actives
        .filter((t) => t.activeProductionVersionId != null)
        .sort((a, b) => a.id - b.id)[0] ?? actives.sort((a, b) => a.id - b.id)[0]!;
    governingId = governing.id;
  }
  return templates.map((t) => ({
    template: t,
    status:
      governingId != null && t.status === "active" && t.id !== governingId
        ? "draft"
        : (t.status as "draft" | "active" | "archived"),
  }));
}

/**
 * Full-kit export: every case type (including archived) with all its
 * templates and immutable version snapshots plus production/staging
 * promotion pointers, keyed by natural identifiers (case slug, template
 * title, version number) so the bundle is portable across environments with
 * different serial ids. Compiled-prompt logs and per-user customizations are
 * deliberately NOT part of the bundle — they are environment-local history.
 */
router.get("/admin/prompt-kit/export", async (req: Request, res: Response) => {
  const _req = req;
  const cases = await db
    .select()
    .from(promptCaseTypesTable)
    .orderBy(promptCaseTypesTable.slug);
  const caseIds = cases.map((c) => c.id);
  const templates = caseIds.length
    ? await db
        .select()
        .from(promptTemplatesTable)
        .where(inArray(promptTemplatesTable.caseTypeId, caseIds))
        .orderBy(promptTemplatesTable.id)
    : [];
  const templateIds = templates.map((t) => t.id);
  const versions = templateIds.length
    ? await db
        .select()
        .from(promptTemplateVersionsTable)
        .where(inArray(promptTemplateVersionsTable.templateId, templateIds))
        .orderBy(promptTemplateVersionsTable.versionNo)
    : [];

  const versionById = new Map(versions.map((v) => [v.id, v]));
  const versionsByTemplate = new Map<number, PromptTemplateVersion[]>();
  for (const v of versions) {
    const list = versionsByTemplate.get(v.templateId) ?? [];
    list.push(v);
    versionsByTemplate.set(v.templateId, list);
  }
  const templatesByCase = new Map<number, PromptTemplate[]>();
  for (const t of templates) {
    const list = templatesByCase.get(t.caseTypeId) ?? [];
    list.push(t);
    templatesByCase.set(t.caseTypeId, list);
  }

  const exportedAt = new Date();
  const bundle = {
    format: BUNDLE_FORMAT,
    formatVersion: BUNDLE_FORMAT_VERSION,
    exportedAt: exportedAt.toISOString(),
    cases: cases.map((c) => ({
      slug: c.slug,
      name: c.name,
      description: c.description,
      riskLevel: c.riskLevel as "low" | "high",
      approvalRequired: c.approvalRequired,
      flowKey: c.flowKey,
      tags: c.tags ?? [],
      status: c.status as "active" | "archived",
      templates: normalizeActiveTemplates(templatesByCase.get(c.id) ?? []).map(({ template: t, status }) => {
        const tVersions = versionsByTemplate.get(t.id) ?? [];
        const versionNoById = new Map(tVersions.map((v) => [v.id, v.versionNo]));
        return {
          title: t.title,
          description: t.description,
          status,
          productionVersionNo: t.activeProductionVersionId
            ? (versionNoById.get(t.activeProductionVersionId) ?? null)
            : null,
          stagingVersionNo: t.activeStagingVersionId
            ? (versionNoById.get(t.activeStagingVersionId) ?? null)
            : null,
          createdBy: t.createdBy,
          versions: tVersions.map((v) => ({
            versionNo: v.versionNo,
            // Lineage travels as a version NUMBER within the same template;
            // cross-template parents (from clones) do not survive export.
            parentVersionNo:
              v.parentVersionId != null &&
              versionById.get(v.parentVersionId)?.templateId === v.templateId
                ? versionById.get(v.parentVersionId)!.versionNo
                : null,
            blocks: v.contentSnapshot,
            config: v.configSnapshot ?? {},
            changeNotes: v.changeNotes,
            lifecycleState: v.lifecycleState,
            evalStatus: v.evalStatus as "none" | "passed" | "failed",
            submittedBy: v.submittedBy,
            submittedAt: v.submittedAt?.toISOString() ?? null,
            approvedBy: v.approvedBy,
            approvedAt: v.approvedAt?.toISOString() ?? null,
            createdBy: v.createdBy,
          })),
        };
      }),
    })),
  };

  // Record a snapshot of the currently-promoted versions so the drift
  // endpoint can later compare the live state against what was last exported.
  const promotedSnapshot: PromptKitExportedPromotion[] = [];
  for (const c of cases) {
    const caseTemplates = templatesByCase.get(c.id) ?? [];
    for (const t of caseTemplates) {
      const tVersions = versionsByTemplate.get(t.id) ?? [];
      const versionNoById = new Map(tVersions.map((v) => [v.id, v.versionNo]));
      promotedSnapshot.push({
        caseSlug: c.slug,
        caseName: c.name,
        templateId: t.id,
        templateTitle: t.title,
        promotedVersionNo: t.activeProductionVersionId
          ? (versionNoById.get(t.activeProductionVersionId) ?? null)
          : null,
      });
    }
  }
  // Best-effort — never block the download if the log write fails.
  try {
    await db.insert(promptKitExportLogTable).values({
      exportedAt,
      exportedBy: _req.tenantEmail ?? null,
      promotedSnapshot,
    });
    await audit(_req, "prompt_kit_export", null, {
      exportedAt: exportedAt.toISOString(),
      cases: cases.map((c) => c.slug),
    });
  } catch (err) {
    _req.log.error({ err }, "Failed to write prompt-kit export log");
  }

  res.json(bundle);
});

// ---------------------------------------------------------------------------
// Drift detection
// ---------------------------------------------------------------------------

/**
 * Compares the current promoted production versions against what was recorded
 * at last-export time. Returns a per-template diff so the superadmin knows
 * exactly which cases have diverged and need a fresh export → import cycle.
 *
 * The comparison is purely within this environment's own DB — no
 * cross-environment reads — so it works even when dev and prod are separate
 * databases. The signal is: "your last export is stale; production may not
 * have these promotions yet."
 */
router.get("/admin/prompt-kit/drift", async (_req: Request, res: Response) => {
  // Fetch the most recent export log row.
  const lastLog = (
    await db
      .select()
      .from(promptKitExportLogTable)
      .orderBy(desc(promptKitExportLogTable.id))
      .limit(1)
  )[0];

  if (!lastLog) {
    // Nothing has ever been exported from this environment.
    res.json({
      hasDrift: false,
      neverExported: true,
      lastExportedAt: null,
      lastExportedBy: null,
      dismissedAt: null,
      snoozedUntil: null,
      driftItems: [],
    });
    return;
  }

  // Build a lookup from templateId → snapshotted promotedVersionNo.
  const snapshotByTemplateId = new Map<number, PromptKitExportedPromotion>(
    (lastLog.promotedSnapshot ?? []).map((e) => [e.templateId, e]),
  );

  // Load all current templates that appear in the snapshot (by templateId).
  const snapshotTemplateIds = [...snapshotByTemplateId.keys()];
  const currentTemplates = snapshotTemplateIds.length
    ? await db
        .select({
          id: promptTemplatesTable.id,
          title: promptTemplatesTable.title,
          status: promptTemplatesTable.status,
          activeProductionVersionId: promptTemplatesTable.activeProductionVersionId,
          caseTypeId: promptTemplatesTable.caseTypeId,
        })
        .from(promptTemplatesTable)
        .where(inArray(promptTemplatesTable.id, snapshotTemplateIds))
    : [];

  // Resolve current production versionNos for each template.
  const allProdVersionIds = currentTemplates
    .map((t) => t.activeProductionVersionId)
    .filter((id): id is number => id != null);
  const prodVersionNos = allProdVersionIds.length
    ? new Map(
        (
          await db
            .select({
              id: promptTemplateVersionsTable.id,
              versionNo: promptTemplateVersionsTable.versionNo,
            })
            .from(promptTemplateVersionsTable)
            .where(inArray(promptTemplateVersionsTable.id, allProdVersionIds))
        ).map((v) => [v.id, v.versionNo]),
      )
    : new Map<number, number>();

  // Also detect newly-added templates (in DB but not in last snapshot).
  const allCurrentTemplates = await db
    .select({
      id: promptTemplatesTable.id,
      title: promptTemplatesTable.title,
      activeProductionVersionId: promptTemplatesTable.activeProductionVersionId,
      caseTypeId: promptTemplatesTable.caseTypeId,
    })
    .from(promptTemplatesTable)
    .where(ne(promptTemplatesTable.status, "archived"));

  const allCurrentCaseIds = [...new Set(allCurrentTemplates.map((t) => t.caseTypeId))];
  const caseNameById = allCurrentCaseIds.length
    ? new Map(
        (
          await db
            .select({ id: promptCaseTypesTable.id, name: promptCaseTypesTable.name, slug: promptCaseTypesTable.slug })
            .from(promptCaseTypesTable)
            .where(inArray(promptCaseTypesTable.id, allCurrentCaseIds))
        ).map((c) => [c.id, c]),
      )
    : new Map<number, { name: string; slug: string }>();

  // Gather any NEW production version ids not already in prodVersionNos map.
  const missingVersionIds = allCurrentTemplates
    .map((t) => t.activeProductionVersionId)
    .filter((id): id is number => id != null && !prodVersionNos.has(id));
  if (missingVersionIds.length) {
    const extra = await db
      .select({ id: promptTemplateVersionsTable.id, versionNo: promptTemplateVersionsTable.versionNo })
      .from(promptTemplateVersionsTable)
      .where(inArray(promptTemplateVersionsTable.id, missingVersionIds));
    for (const v of extra) prodVersionNos.set(v.id, v.versionNo);
  }

  const driftItems: {
    caseSlug: string;
    caseName: string;
    templateId: number;
    templateTitle: string;
    lastExportedVersionNo: number | null;
    currentVersionNo: number | null;
    reason: "promoted" | "new_template" | "removed";
  }[] = [];

  // Drift type 1: templates in the snapshot whose production version has
  // advanced since the last export, OR that have since been archived/removed.
  for (const t of currentTemplates) {
    const snap = snapshotByTemplateId.get(t.id);
    if (!snap) continue;
    // A template must vacate its production version before being archived, so
    // an archived template always has activeProductionVersionId = null here.
    if (t.status === "archived") {
      driftItems.push({
        caseSlug: snap.caseSlug,
        caseName: snap.caseName,
        templateId: t.id,
        templateTitle: t.title,
        lastExportedVersionNo: snap.promotedVersionNo,
        currentVersionNo: null,
        reason: "removed",
      });
      continue;
    }
    const currentVersionNo = t.activeProductionVersionId
      ? (prodVersionNos.get(t.activeProductionVersionId) ?? null)
      : null;
    if (currentVersionNo !== snap.promotedVersionNo) {
      driftItems.push({
        caseSlug: snap.caseSlug,
        caseName: snap.caseName,
        templateId: t.id,
        templateTitle: t.title,
        lastExportedVersionNo: snap.promotedVersionNo,
        currentVersionNo,
        reason: "promoted",
      });
    }
  }

  // Drift type 2: active templates that were created AFTER the last export
  // (not in the snapshot at all) and already have a production promotion.
  for (const t of allCurrentTemplates) {
    if (snapshotByTemplateId.has(t.id)) continue; // already covered above
    if (!t.activeProductionVersionId) continue; // no production version → not a drift yet
    const currentVersionNo = prodVersionNos.get(t.activeProductionVersionId) ?? null;
    const caseInfo = caseNameById.get(t.caseTypeId);
    driftItems.push({
      caseSlug: caseInfo?.slug ?? "",
      caseName: caseInfo?.name ?? "",
      templateId: t.id,
      templateTitle: t.title,
      lastExportedVersionNo: null,
      currentVersionNo,
      reason: "new_template",
    });
  }

  const hasDrift = driftItems.length > 0;
  // Suppress if snoozed and the snooze window hasn't expired.
  const nowTs = new Date();
  const snoozedUntil = lastLog.snoozedUntil;
  const isSnoozed = snoozedUntil != null && snoozedUntil > nowTs;

  res.json({
    hasDrift,
    neverExported: false,
    lastExportedAt: lastLog.exportedAt.toISOString(),
    lastExportedBy: lastLog.exportedBy,
    dismissedAt: lastLog.dismissedAt?.toISOString() ?? null,
    snoozedUntil: snoozedUntil?.toISOString() ?? null,
    isSnoozed,
    driftItems,
  });
});

/**
 * Dismiss or snooze the drift banner. Both operations update the most
 * recent export-log row so the decision travels with the export record.
 *
 * Body: { snoozeUntil?: string (ISO date) }
 * Omitting snoozeUntil dismisses permanently (until the next export resets it).
 */
router.post("/admin/prompt-kit/drift/dismiss", async (req: Request, res: Response) => {
  const lastLog = (
    await db
      .select({ id: promptKitExportLogTable.id })
      .from(promptKitExportLogTable)
      .orderBy(desc(promptKitExportLogTable.id))
      .limit(1)
  )[0];

  if (!lastLog) {
    res.status(404).json({ error: "No export log found" });
    return;
  }

  const snoozeUntilRaw = req.body?.snoozeUntil;
  const snoozeUntil = snoozeUntilRaw ? parseDate(snoozeUntilRaw) : null;
  const dismissedAt = new Date();

  await db
    .update(promptKitExportLogTable)
    .set({ dismissedAt, snoozedUntil: snoozeUntil })
    .where(eq(promptKitExportLogTable.id, lastLog.id));

  await audit(req, "prompt_kit_export", null, {
    action: snoozeUntil ? "snoozed" : "dismissed",
    snoozeUntil: snoozeUntil?.toISOString() ?? null,
  });

  res.json({ ok: true });
});

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Idempotent bundle import. Matching is by natural keys — case slug,
 * template title (the bundle's ACTIVE template also matches the local active
 * template regardless of title, preserving the one-active-template-per-case
 * invariant), and version number. Re-importing the same bundle updates rows
 * in place and never duplicates. Each case is applied in ITS OWN
 * transaction, so one bad case cannot roll back the others; per-case
 * failures surface as warnings. Excludes compiled-prompt logs and per-user
 * customizations by design.
 */
router.post("/admin/prompt-kit/import", async (req: Request, res: Response) => {
  const parsed = ImportPromptKitBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid Prompt Kit bundle" });
    return;
  }
  const bundle = parsed.data;
  if (bundle.format !== BUNDLE_FORMAT || bundle.formatVersion !== BUNDLE_FORMAT_VERSION) {
    res.status(400).json({ error: "Unsupported bundle format or version" });
    return;
  }
  const seenSlugs = new Set<string>();
  for (const c of bundle.cases) {
    if (seenSlugs.has(c.slug)) {
      res.status(400).json({ error: `Duplicate case slug in bundle: ${c.slug}` });
      return;
    }
    seenSlugs.add(c.slug);
    const activeCount = c.templates.filter((t) => t.status === "active").length;
    if (activeCount > 1) {
      res.status(400).json({
        error: `Case "${c.slug}" has ${activeCount} active templates; only one is allowed`,
      });
      return;
    }
    for (const t of c.templates) {
      const nos = t.versions.map((v) => v.versionNo);
      if (new Set(nos).size !== nos.length) {
        res.status(400).json({
          error: `Template "${t.title}" in case "${c.slug}" repeats a version number`,
        });
        return;
      }
      if (
        t.productionVersionNo != null &&
        !nos.includes(t.productionVersionNo)
      ) {
        res.status(400).json({
          error: `Template "${t.title}" in case "${c.slug}" promotes missing version ${t.productionVersionNo}`,
        });
        return;
      }
      if (t.stagingVersionNo != null && !nos.includes(t.stagingVersionNo)) {
        res.status(400).json({
          error: `Template "${t.title}" in case "${c.slug}" stages missing version ${t.stagingVersionNo}`,
        });
        return;
      }
    }
  }

  const result = {
    casesCreated: 0,
    casesUpdated: 0,
    templatesCreated: 0,
    templatesUpdated: 0,
    versionsCreated: 0,
    versionsUpdated: 0,
    promotionsApplied: 0,
    warnings: [] as string[],
  };

  for (const bundleCase of bundle.cases) {
    try {
      await db.transaction(async (tx) => {
        // -- case type (matched by slug) --------------------------------
        const existingCase = (
          await tx
            .select()
            .from(promptCaseTypesTable)
            .where(eq(promptCaseTypesTable.slug, bundleCase.slug))
            .limit(1)
            .for("update")
        )[0];

        // One active case per flow: if a DIFFERENT case already binds this
        // flow, import without the binding and warn instead of silently
        // shadowing the existing one.
        let flowKey = bundleCase.flowKey ?? null;
        if (flowKey && bundleCase.status !== "archived") {
          const clash = (
            await tx
              .select({ id: promptCaseTypesTable.id, slug: promptCaseTypesTable.slug })
              .from(promptCaseTypesTable)
              .where(
                and(
                  eq(promptCaseTypesTable.flowKey, flowKey),
                  eq(promptCaseTypesTable.status, "active"),
                  ne(promptCaseTypesTable.slug, bundleCase.slug),
                ),
              )
              .limit(1)
          )[0];
          if (clash) {
            result.warnings.push(
              `Case "${bundleCase.slug}": flow "${flowKey}" is already bound to case "${clash.slug}"; imported without the flow binding`,
            );
            flowKey = null;
          }
        }

        const caseValues = {
          name: bundleCase.name,
          description: bundleCase.description ?? null,
          riskLevel: bundleCase.riskLevel ?? "low",
          approvalRequired: bundleCase.approvalRequired ?? false,
          flowKey,
          tags: bundleCase.tags ?? [],
          status: bundleCase.status,
          archivedAt: bundleCase.status === "archived" ? new Date() : null,
        };
        let caseRow: PromptCaseType;
        if (existingCase) {
          caseRow = (
            await tx
              .update(promptCaseTypesTable)
              .set({
                ...caseValues,
                archivedAt:
                  bundleCase.status === "archived"
                    ? (existingCase.archivedAt ?? new Date())
                    : null,
              })
              .where(eq(promptCaseTypesTable.id, existingCase.id))
              .returning()
          )[0]!;
          result.casesUpdated += 1;
        } else {
          caseRow = (
            await tx
              .insert(promptCaseTypesTable)
              .values({
                ...caseValues,
                slug: bundleCase.slug,
                ownerEmail: req.tenantEmail,
              })
              .returning()
          )[0]!;
          result.casesCreated += 1;
        }

        const localTemplates = await tx
          .select()
          .from(promptTemplatesTable)
          .where(eq(promptTemplatesTable.caseTypeId, caseRow.id))
          .for("update");
        const claimed = new Set<number>();

        for (const bundleTemplate of bundleCase.templates) {
          // The bundle's active template maps onto the local ACTIVE template
          // (regardless of title) so re-imports can rename it without ever
          // creating a second active template for the case.
          let target =
            bundleTemplate.status === "active"
              ? localTemplates.find(
                  (t) => t.status === "active" && !claimed.has(t.id),
                )
              : undefined;
          target ??= localTemplates.find(
            (t) => t.title === bundleTemplate.title && !claimed.has(t.id),
          );
          // Never let a non-active bundle template overwrite the local active
          // one by title match alone while the bundle also carries an active
          // template that already claimed it (claimed guard handles this).

          const templateValues = {
            title: bundleTemplate.title,
            description: bundleTemplate.description ?? null,
            status: bundleTemplate.status,
            archivedAt: bundleTemplate.status === "archived" ? new Date() : null,
          };
          let templateRow: PromptTemplate;
          if (target) {
            templateRow = (
              await tx
                .update(promptTemplatesTable)
                .set({
                  ...templateValues,
                  archivedAt:
                    bundleTemplate.status === "archived"
                      ? (target.archivedAt ?? new Date())
                      : null,
                })
                .where(eq(promptTemplatesTable.id, target.id))
                .returning()
            )[0]!;
            result.templatesUpdated += 1;
          } else {
            templateRow = (
              await tx
                .insert(promptTemplatesTable)
                .values({
                  ...templateValues,
                  caseTypeId: caseRow.id,
                  createdBy: bundleTemplate.createdBy ?? req.tenantEmail,
                })
                .returning()
            )[0]!;
            result.templatesCreated += 1;
          }
          claimed.add(templateRow.id);

          // -- versions (matched by versionNo) --------------------------
          const localVersions = await tx
            .select()
            .from(promptTemplateVersionsTable)
            .where(eq(promptTemplateVersionsTable.templateId, templateRow.id));
          const localByNo = new Map(localVersions.map((v) => [v.versionNo, v]));
          const idByNo = new Map(localVersions.map((v) => [v.versionNo, v.id]));

          // First pass: upsert content; second pass wires parent lineage
          // (a parent may appear later in the bundle than its child).
          for (const bundleVersion of bundleTemplate.versions) {
            const values = {
              contentSnapshot: bundleVersion.blocks as PromptBlock[],
              configSnapshot: {
                ...(bundleVersion.config ?? {}),
                placeholders: extractPlaceholders(
                  bundleVersion.blocks as PromptBlock[],
                ),
              },
              changeNotes: bundleVersion.changeNotes ?? null,
              lifecycleState: (bundleVersion.lifecycleState ??
                "draft") as PromptVersionLifecycle,
              evalStatus: bundleVersion.evalStatus ?? "none",
              submittedBy: bundleVersion.submittedBy ?? null,
              submittedAt: parseDate(bundleVersion.submittedAt),
              approvedBy: bundleVersion.approvedBy ?? null,
              approvedAt: parseDate(bundleVersion.approvedAt),
            };
            const existing = localByNo.get(bundleVersion.versionNo);
            if (existing) {
              await tx
                .update(promptTemplateVersionsTable)
                .set(values)
                .where(eq(promptTemplateVersionsTable.id, existing.id));
              result.versionsUpdated += 1;
            } else {
              const inserted = (
                await tx
                  .insert(promptTemplateVersionsTable)
                  .values({
                    ...values,
                    templateId: templateRow.id,
                    caseTypeId: caseRow.id,
                    versionNo: bundleVersion.versionNo,
                    createdBy: bundleVersion.createdBy ?? req.tenantEmail,
                  })
                  .returning()
              )[0]!;
              idByNo.set(inserted.versionNo, inserted.id);
              result.versionsCreated += 1;
            }
          }
          for (const bundleVersion of bundleTemplate.versions) {
            const selfId = idByNo.get(bundleVersion.versionNo);
            if (!selfId) continue;
            const parentId =
              bundleVersion.parentVersionNo != null
                ? (idByNo.get(bundleVersion.parentVersionNo) ?? null)
                : null;
            await tx
              .update(promptTemplateVersionsTable)
              .set({ parentVersionId: parentId })
              .where(eq(promptTemplateVersionsTable.id, selfId));
          }

          // -- promotion pointers ---------------------------------------
          const productionVersionId =
            bundleTemplate.productionVersionNo != null
              ? (idByNo.get(bundleTemplate.productionVersionNo) ?? null)
              : null;
          const stagingVersionId =
            bundleTemplate.stagingVersionNo != null
              ? (idByNo.get(bundleTemplate.stagingVersionNo) ?? null)
              : null;
          if (
            templateRow.activeProductionVersionId !== productionVersionId ||
            templateRow.activeStagingVersionId !== stagingVersionId
          ) {
            if (productionVersionId) result.promotionsApplied += 1;
            await tx
              .update(promptTemplatesTable)
              .set({
                activeProductionVersionId: productionVersionId,
                activeStagingVersionId: stagingVersionId,
              })
              .where(eq(promptTemplatesTable.id, templateRow.id));
          }
          if (productionVersionId) {
            // The bundle's promoted version must actually be live, and no
            // other version of this template may keep claiming production.
            await tx
              .update(promptTemplateVersionsTable)
              .set({ lifecycleState: "production" })
              .where(eq(promptTemplateVersionsTable.id, productionVersionId));
          }
          await tx
            .update(promptTemplateVersionsTable)
            .set({ lifecycleState: "deprecated" })
            .where(
              and(
                eq(promptTemplateVersionsTable.templateId, templateRow.id),
                eq(promptTemplateVersionsTable.lifecycleState, "production"),
                ...(productionVersionId
                  ? [ne(promptTemplateVersionsTable.id, productionVersionId)]
                  : []),
              ),
            );
          // Staging pointer/lifecycle consistency mirrors production: the
          // pointed-to version must BE in "staging" (unless it is also the
          // production version), and no other version of the template may
          // linger in "staging" — leftovers demote to "deprecated" (a valid
          // exit from staging that can re-enter staging/production later).
          if (stagingVersionId && stagingVersionId !== productionVersionId) {
            await tx
              .update(promptTemplateVersionsTable)
              .set({ lifecycleState: "staging" })
              .where(eq(promptTemplateVersionsTable.id, stagingVersionId));
          }
          await tx
            .update(promptTemplateVersionsTable)
            .set({ lifecycleState: "deprecated" })
            .where(
              and(
                eq(promptTemplateVersionsTable.templateId, templateRow.id),
                eq(promptTemplateVersionsTable.lifecycleState, "staging"),
                ...(stagingVersionId
                  ? [ne(promptTemplateVersionsTable.id, stagingVersionId)]
                  : []),
              ),
            );
        }
      });
    } catch (error) {
      req.log.error(
        { err: error, slug: bundleCase.slug },
        "Prompt Kit import failed for case",
      );
      result.warnings.push(
        `Case "${bundleCase.slug}" failed to import and was rolled back`,
      );
    }
  }

  await audit(req, "prompt_kit_import", null, {
    exportedAt: bundle.exportedAt ?? null,
    cases: bundle.cases.map((c) => c.slug),
    ...result,
    warnings: result.warnings.slice(0, 20),
  });
  res.json(result);
});

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

router.get("/admin/prompt-kit/metrics", async (_req: Request, res: Response) => {
  const agg = await db
    .select({
      versionId: compiledPromptLogsTable.templateVersionId,
      requests: sql<number>`count(*)::int`,
      failures: sql<number>`count(*) filter (where ${compiledPromptLogsTable.success} = false)::int`,
      avgLatencyMs: sql<number | null>`avg(${compiledPromptLogsTable.latencyMs})::int`,
      totalCostPaise: sql<number | null>`sum(${compiledPromptLogsTable.estimatedCostPaise})::int`,
      totalTokens: sql<number | null>`sum((${compiledPromptLogsTable.tokenUsage} ->> 'totalTokens')::int)::int`,
      distinctTenants: sql<number>`count(distinct ${compiledPromptLogsTable.tenantId})::int`,
      lastUsedAt: sql<string | null>`max(${compiledPromptLogsTable.createdAt})`,
    })
    .from(compiledPromptLogsTable)
    .where(isNotNull(compiledPromptLogsTable.templateVersionId))
    .groupBy(compiledPromptLogsTable.templateVersionId);

  const versionIds = agg
    .map((a) => a.versionId)
    .filter((v): v is number => v != null);
  const versions = versionIds.length
    ? await db
        .select()
        .from(promptTemplateVersionsTable)
        .where(inArray(promptTemplateVersionsTable.id, versionIds))
    : [];
  const templateIds = [...new Set(versions.map((v) => v.templateId))];
  const templates = templateIds.length
    ? await db
        .select()
        .from(promptTemplatesTable)
        .where(inArray(promptTemplatesTable.id, templateIds))
    : [];
  const caseIds = [...new Set(versions.map((v) => v.caseTypeId))];
  const cases = caseIds.length
    ? await db
        .select()
        .from(promptCaseTypesTable)
        .where(inArray(promptCaseTypesTable.id, caseIds))
    : [];
  const versionById = new Map(versions.map((v) => [v.id, v]));
  const templateById = new Map(templates.map((t) => [t.id, t]));
  const caseById = new Map(cases.map((c) => [c.id, c]));

  const out = agg
    .filter((a) => a.versionId != null && versionById.has(a.versionId))
    .map((a) => {
      const version = versionById.get(a.versionId!)!;
      return {
        versionId: version.id,
        templateId: version.templateId,
        templateTitle: templateById.get(version.templateId)?.title ?? null,
        caseTypeId: version.caseTypeId,
        caseName: caseById.get(version.caseTypeId)?.name ?? null,
        versionNo: version.versionNo,
        lifecycleState: version.lifecycleState,
        requests: a.requests,
        failures: a.failures,
        avgLatencyMs: a.avgLatencyMs,
        totalCostPaise: a.totalCostPaise,
        totalTokens: a.totalTokens,
        distinctTenants: a.distinctTenants,
        lastUsedAt: a.lastUsedAt ? new Date(a.lastUsedAt).toISOString() : null,
      };
    })
    .sort((x, y) => y.requests - x.requests);
  res.json(out);
});

export default router;
