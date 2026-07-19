import {
  pgTable,
  serial,
  integer,
  text,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

/** Status of one audit check. Score is computed from known (pass/fail)
 * checks only; unknown/not_applicable lower coverage instead. */
export type HealthCheckStatus = "pass" | "fail" | "unknown" | "not_applicable";

/** One finding in a health report: what was checked, what the data showed,
 * and what the user should do about it. */
export interface HealthCheckResult {
  id: string;
  category: string;
  title: string;
  status: HealthCheckStatus;
  /** Plain-language explanation of the outcome. */
  explanation: string;
  /** Dated, numeric evidence behind the outcome (empty when unknown). */
  evidence: string[];
  /** Recommended next step; null when nothing is needed. */
  recommendation: string | null;
  /** In-app path the recommendation links to (e.g. "/accounts"). */
  actionPath: string | null;
}

/** Per-category rollup inside a report. */
export interface HealthCategoryScore {
  category: string;
  label: string;
  /** 0-100 from this category's known checks; null when none were known. */
  score: number | null;
  passed: number;
  failed: number;
  unknown: number;
  notApplicable: number;
}

/** Full versioned audit payload stored on a health report row. */
export interface HealthReportPayload {
  version: 1;
  checks: HealthCheckResult[];
  categories: HealthCategoryScore[];
}

export const HEALTH_REPORT_HISTORY_LIMIT = 20;

/**
 * One completed on-demand health audit for a tenant. The newest row is the
 * "latest report"; older rows feed the score-trend display. History is
 * bounded in code to HEALTH_REPORT_HISTORY_LIMIT rows per tenant.
 */
export const healthReportsTable = pgTable(
  "health_reports",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id").notNull(),
    /** 0-100 computed from known checks only; null = insufficient evidence
     * (no known checks at all). */
    score: integer("score"),
    /** Evidence coverage percent (0-100): known checks / evaluable checks. */
    coverage: integer("coverage").notNull(),
    /** "graded" (>=80) | "provisional" (60-79) | "insufficient" (<60). */
    coverageGrade: text("coverage_grade").notNull(),
    report: jsonb("report").$type<HealthReportPayload>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    tenantIdx: index("health_reports_tenant_idx").on(t.tenantId, t.createdAt),
  }),
);

export type HealthReport = typeof healthReportsTable.$inferSelect;
