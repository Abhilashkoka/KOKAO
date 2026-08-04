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
  type PromptBlock,
  type PromptCaseType,
  type PromptTemplate,
  type PromptTemplateVersion,
  type PromptTestCase,
  type PromptTestRun,
  type PromptReview,
  type PromptVersionLifecycle,
} from "@workspace/db";
import { and, desc, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
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
} from "@workspace/api-zod";
import { requireSuperadmin } from "../middlewares/requireSuperadmin";
import { recordAdminAction, type AdminAuditAction } from "../lib/adminAudit";
import {
  canTransition,
  compilePromptLayers,
  productionPromotionBlocked,
  extractPlaceholders,
} from "../lib/promptKit";
import { otherAllowlistedSuperadminExists } from "../lib/superadmins";
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
  // Exactly one active template per case type: the pipeline resolves the live
  // prompt per case, so a second active template would make promotion ambiguous.
  const existingActive = (
    await db
      .select({ id: promptTemplatesTable.id, title: promptTemplatesTable.title })
      .from(promptTemplatesTable)
      .where(
        and(
          eq(promptTemplatesTable.caseTypeId, body.caseTypeId),
          eq(promptTemplatesTable.status, "active"),
          isNull(promptTemplatesTable.archivedAt),
        ),
      )
      .limit(1)
  )[0];
  if (existingActive) {
    res.status(400).json({
      error: `This case already has an active template ("${existingActive.title}"). Archive it first, or add a new version to it instead.`,
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
    // Reactivating must not create a second active template for the case.
    if (body.status === "active" && before.status !== "active") {
      const otherActive = (
        await db
          .select({ id: promptTemplatesTable.id, title: promptTemplatesTable.title })
          .from(promptTemplatesTable)
          .where(
            and(
              eq(promptTemplatesTable.caseTypeId, before.caseTypeId),
              eq(promptTemplatesTable.status, "active"),
              isNull(promptTemplatesTable.archivedAt),
              ne(promptTemplatesTable.id, templateId),
            ),
          )
          .limit(1)
      )[0];
      if (otherActive) {
        res.status(400).json({
          error: `This case already has an active template ("${otherActive.title}"). Archive it first.`,
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
      // Four-eyes: when the platform has more than one superadmin, an author
      // may not approve their own version.
      if (to === "approved" && version.createdBy && actor && version.createdBy === actor) {
        const grantedOther = (
          await db
            .select({ id: tenantsTable.id })
            .from(tenantsTable)
            .where(
              and(
                eq(tenantsTable.isSuperadmin, true),
                isNotNull(tenantsTable.email),
                ne(sql`lower(${tenantsTable.email})`, actor.toLowerCase()),
              ),
            )
            .limit(1)
        )[0];
        if (grantedOther || otherAllowlistedSuperadminExists(actor)) {
          res.status(400).json({
            error: "Another admin must approve this version (you authored it)",
          });
          return;
        }
      }
      await db.insert(promptReviewsTable).values({
        promptVersionId: versionId,
        reviewerEmail: actor,
        decision: to,
        comments: comments ?? null,
      });
      await audit(req, "prompt_review_decision", { versionId, from: version.lifecycleState }, { decision: to, comments: comments ?? null });
    }

    if (to === "archived" && template.activeProductionVersionId === versionId) {
      res.status(400).json({ error: "The live production version cannot be archived" });
      return;
    }
    if (to === "production") {
      const blocked = productionPromotionBlocked(caseType, version);
      if (blocked) {
        res.status(400).json({ error: blocked });
        return;
      }
    }

    // All lifecycle + pointer writes happen in one transaction so a partial
    // failure can never leave the template pointer and version state split.
    const previousProductionId = template.activeProductionVersionId;
    let isRollback = false;
    const updated = await db.transaction(async (tx) => {
      if (to === "production") {
        if (previousProductionId && previousProductionId !== versionId) {
          const prev = await loadVersion(previousProductionId);
          if (prev) {
            isRollback = version.versionNo < prev.versionNo;
            await tx
              .update(promptTemplateVersionsTable)
              .set({ lifecycleState: "deprecated" })
              .where(
                and(
                  eq(promptTemplateVersionsTable.id, previousProductionId),
                  eq(promptTemplateVersionsTable.lifecycleState, "production"),
                ),
              );
          }
        }
        await tx
          .update(promptTemplatesTable)
          .set({
            activeProductionVersionId: versionId,
            activeStagingVersionId:
              template.activeStagingVersionId === versionId
                ? null
                : template.activeStagingVersionId,
            status: "active",
          })
          .where(eq(promptTemplatesTable.id, template.id));
      }

      if (to === "staging") {
        await tx
          .update(promptTemplatesTable)
          .set({ activeStagingVersionId: versionId })
          .where(eq(promptTemplatesTable.id, template.id));
      }

      if (to === "deprecated" && template.activeProductionVersionId === versionId) {
        await tx
          .update(promptTemplatesTable)
          .set({ activeProductionVersionId: null })
          .where(eq(promptTemplatesTable.id, template.id));
      }

      return (
        await tx
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
    });

    if (to === "production") {
      await audit(
        req,
        isRollback ? "prompt_rollback" : "prompt_promotion",
        { templateId: template.id, previousProductionVersionId: previousProductionId },
        { versionId, versionNo: version.versionNo },
      );
    }
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
      const textGen = await getTextGenClient(tenant?.aiModel ?? "");
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
