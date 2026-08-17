import {
  pgTable,
  text,
  serial,
  integer,
  boolean,
  jsonb,
  timestamp,
  unique,
  index,
} from "drizzle-orm/pg-core";

/**
 * Prompt Template Kit — governed, versioned prompt templates.
 *
 * Model (mirrors the brand-kit pointer + immutable-version pattern):
 *  - prompt_case_types: a generation scenario ("Festival post", "Video script").
 *    `flowKey` optionally binds a case to a pipeline entry point so the
 *    compiler knows where it applies ("caption" | "image" | "campaign" |
 *    "video_script"). Superadmin-managed, platform-wide.
 *  - prompt_templates: pointer + metadata per case. The actual prompt text
 *    lives in immutable versions; `activeProductionVersionId` points at the
 *    live version used by generation. Rollback = repoint.
 *  - prompt_template_versions: immutable snapshot of the template's BLOCKS
 *    (array of {title, content, mandatory, order}) + config. Every edit
 *    creates a new row; lifecycle states move forward, content never mutates.
 *  - prompt_reviews: review/approval decisions per version (who/when/why).
 *  - prompt_test_cases / prompt_test_runs: saved playground inputs and their
 *    recorded runs against specific versions.
 *  - user_prompt_customizations: tenant+user scoped additive amendments,
 *    selected at generation time. Never affect admin layers.
 *  - compiled_prompt_logs: trace of each governed generation — which version
 *    + customization produced which compiled prompt, with latency/cost.
 *
 * Deletes anywhere in this module are soft (status/archivedAt); audit entries
 * go to the shared admin_audit_logs table.
 */

/** One block of prompt text inside a version snapshot. */
export type PromptBlock = {
  /** Stable id within the template (for diffing), e.g. "blk_ab12". */
  id: string;
  title: string;
  content: string;
  /** Mandatory blocks are always compiled in; optional ones only when enabled. */
  mandatory: boolean;
  /** Ascending merge order. */
  order: number;
};

export type PromptVersionConfig = {
  language?: string | null;
  tone?: string | null;
  targetModel?: string | null;
  outputType?: string | null;
  tags?: string[];
  /** Placeholder names the template expects, e.g. ["topic", "platform"]. */
  placeholders?: string[];
};

export type PromptVersionLifecycle =
  | "draft"
  | "pending_review"
  | "approved"
  | "rejected"
  | "staging"
  | "production"
  | "deprecated"
  | "archived";

export const PROMPT_FLOW_KEYS = [
  "caption",
  "image",
  "campaign",
  "video_script",
  "video_scene_image",
  "video_motion",
  "carousel",
] as const;
export type PromptFlowKey = (typeof PROMPT_FLOW_KEYS)[number];

export const promptCaseTypesTable = pgTable(
  "prompt_case_types",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    // "low" | "high" — high-risk cases REQUIRE an approval before production.
    riskLevel: text("risk_level").notNull().default("low"),
    // Even low-risk cases can opt into requiring approval.
    approvalRequired: boolean("approval_required").notNull().default(false),
    // Which generation pipeline this case governs (null = not wired to a flow).
    flowKey: text("flow_key").$type<PromptFlowKey | null>(),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    ownerEmail: text("owner_email"),
    // "active" | "archived"
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => ({
    slugUnique: unique("prompt_case_types_slug_uniq").on(t.slug),
  }),
);

export const promptTemplatesTable = pgTable(
  "prompt_templates",
  {
    id: serial("id").primaryKey(),
    caseTypeId: integer("case_type_id").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    // "draft" | "active" | "archived" (soft delete via archived + archivedAt)
    status: text("status").notNull().default("draft"),
    // Live version compiled into generations. Null = template not in production.
    activeProductionVersionId: integer("active_production_version_id"),
    // Version currently deployed to staging (playground/testing), if any.
    activeStagingVersionId: integer("active_staging_version_id"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => ({
    caseIdx: index("prompt_templates_case_idx").on(t.caseTypeId),
  }),
);

export const promptTemplateVersionsTable = pgTable(
  "prompt_template_versions",
  {
    id: serial("id").primaryKey(),
    templateId: integer("template_id").notNull(),
    // Denormalized for case-scoped queries without a join.
    caseTypeId: integer("case_type_id").notNull(),
    versionNo: integer("version_no").notNull(),
    parentVersionId: integer("parent_version_id"),
    contentSnapshot: jsonb("content_snapshot")
      .$type<PromptBlock[]>()
      .notNull(),
    configSnapshot: jsonb("config_snapshot")
      .$type<PromptVersionConfig>()
      .notNull()
      .default({}),
    changeNotes: text("change_notes"),
    lifecycleState: text("lifecycle_state")
      .$type<PromptVersionLifecycle>()
      .notNull()
      .default("draft"),
    // "none" | "passed" | "failed" — set from evaluation runs.
    evalStatus: text("eval_status").notNull().default("none"),
    submittedBy: text("submitted_by"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    templateVersionUnique: unique("prompt_template_versions_no_uniq").on(
      t.templateId,
      t.versionNo,
    ),
    caseIdx: index("prompt_template_versions_case_idx").on(t.caseTypeId),
  }),
);

export const promptReviewsTable = pgTable(
  "prompt_reviews",
  {
    id: serial("id").primaryKey(),
    promptVersionId: integer("prompt_version_id").notNull(),
    reviewerEmail: text("reviewer_email"),
    // "approved" | "rejected" | "comment"
    decision: text("decision").notNull(),
    comments: text("comments"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    versionIdx: index("prompt_reviews_version_idx").on(t.promptVersionId),
  }),
);

export const promptTestCasesTable = pgTable(
  "prompt_test_cases",
  {
    id: serial("id").primaryKey(),
    caseTypeId: integer("case_type_id").notNull(),
    title: text("title").notNull(),
    // Sample runtime context: { userInput, placeholders: {...} }
    inputJson: jsonb("input_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    expectedNotes: text("expected_notes"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => ({
    caseIdx: index("prompt_test_cases_case_idx").on(t.caseTypeId),
  }),
);

export const promptTestRunsTable = pgTable(
  "prompt_test_runs",
  {
    id: serial("id").primaryKey(),
    promptVersionId: integer("prompt_version_id").notNull(),
    // Null for ad-hoc playground runs not saved as a test case.
    testCaseId: integer("test_case_id"),
    inputJson: jsonb("input_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    outputText: text("output_text"),
    // The exact compiled prompt sent for this run (for version comparison).
    compiledPrompt: text("compiled_prompt"),
    // Reviewer score 1..5, if given.
    score: integer("score"),
    // "pass" | "fail" | null (not judged)
    passFail: text("pass_fail"),
    latencyMs: integer("latency_ms"),
    tokenUsage: jsonb("token_usage").$type<Record<string, number> | null>(),
    // Paise; null when unknown (never guessed).
    estimatedCostPaise: integer("estimated_cost_paise"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    versionIdx: index("prompt_test_runs_version_idx").on(t.promptVersionId),
  }),
);

export const userPromptCustomizationsTable = pgTable(
  "user_prompt_customizations",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id").notNull(),
    // The team member who owns this variant (owners and members alike).
    clerkUserId: text("clerk_user_id").notNull(),
    caseTypeId: integer("case_type_id").notNull(),
    title: text("title").notNull(),
    // Additive-only amendment text, compiled AFTER admin layers.
    instructionBlock: text("instruction_block").notNull(),
    // "active" | "disabled" | "archived"
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    tenantUserIdx: index("user_prompt_customizations_tenant_user_idx").on(
      t.tenantId,
      t.clerkUserId,
    ),
    caseIdx: index("user_prompt_customizations_case_idx").on(t.caseTypeId),
  }),
);

export const compiledPromptLogsTable = pgTable(
  "compiled_prompt_logs",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id").notNull(),
    clerkUserId: text("clerk_user_id"),
    caseTypeId: integer("case_type_id").notNull(),
    templateId: integer("template_id"),
    templateVersionId: integer("template_version_id"),
    customizationId: integer("customization_id"),
    flowKey: text("flow_key").$type<PromptFlowKey>().notNull(),
    // Truncated to a sane cap at write time; enough for tracing, not a dump.
    compiledPrompt: text("compiled_prompt").notNull(),
    generationContextJson: jsonb("generation_context_json")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    outputMetadataJson: jsonb("output_metadata_json").$type<Record<
      string,
      unknown
    > | null>(),
    success: boolean("success"),
    latencyMs: integer("latency_ms"),
    tokenUsage: jsonb("token_usage").$type<Record<string, number> | null>(),
    estimatedCostPaise: integer("estimated_cost_paise"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    versionIdx: index("compiled_prompt_logs_version_idx").on(
      t.templateVersionId,
    ),
    tenantIdx: index("compiled_prompt_logs_tenant_idx").on(t.tenantId),
    createdIdx: index("compiled_prompt_logs_created_idx").on(t.createdAt),
  }),
);

/**
 * Snapshot entry recorded on every Prompt Kit export.
 * One row per export event (newest row = last export).
 * The row also carries the dismiss/snooze state for the drift banner so that
 * a superadmin can intentionally leave production behind without being
 * spammed on every page load.
 */
export type PromptKitExportedPromotion = {
  caseSlug: string;
  caseName: string;
  templateId: number;
  templateTitle: string;
  /** Production versionNo at time of export, or null when none was promoted. */
  promotedVersionNo: number | null;
};

export const promptKitExportLogTable = pgTable("prompt_kit_export_log", {
  id: serial("id").primaryKey(),
  exportedAt: timestamp("exported_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  exportedBy: text("exported_by"),
  /** Per-template promoted version snapshot captured at export time. */
  promotedSnapshot: jsonb("promoted_snapshot")
    .$type<PromptKitExportedPromotion[]>()
    .notNull()
    .default([]),
  /** Set when a superadmin explicitly dismisses the drift banner. */
  dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
  /** When set, the drift banner is suppressed until this timestamp. */
  snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
});

export type PromptCaseType = typeof promptCaseTypesTable.$inferSelect;
export type PromptTemplate = typeof promptTemplatesTable.$inferSelect;
export type PromptTemplateVersion =
  typeof promptTemplateVersionsTable.$inferSelect;
export type PromptReview = typeof promptReviewsTable.$inferSelect;
export type PromptTestCase = typeof promptTestCasesTable.$inferSelect;
export type PromptTestRun = typeof promptTestRunsTable.$inferSelect;
export type UserPromptCustomization =
  typeof userPromptCustomizationsTable.$inferSelect;
export type CompiledPromptLog = typeof compiledPromptLogsTable.$inferSelect;
export type PromptKitExportLog = typeof promptKitExportLogTable.$inferSelect;
