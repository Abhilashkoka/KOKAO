import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  healthReportsTable,
  HEALTH_REPORT_HISTORY_LIMIT,
  type HealthReport,
} from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import { runAndStoreHealthAudit } from "../lib/healthAudit";

/**
 * Social health audit endpoints. Session-scoped (no tenantId in URLs) and
 * gated like analytics reports: workspace owners and admins only; plain
 * members get 403. Reports are always scoped to req.tenantId.
 */
const router: IRouter = Router();

function canView(req: Request): boolean {
  return req.memberRole === "owner" || req.memberRole === "admin";
}

function toDetail(row: HealthReport) {
  return {
    id: row.id,
    score: row.score,
    coverage: row.coverage,
    coverageGrade: row.coverageGrade,
    createdAt: row.createdAt.toISOString(),
    checks: row.report.checks,
    categories: row.report.categories,
  };
}

async function loadOverview(tenantId: number) {
  const rows = await db
    .select()
    .from(healthReportsTable)
    .where(eq(healthReportsTable.tenantId, tenantId))
    .orderBy(desc(healthReportsTable.createdAt), desc(healthReportsTable.id))
    .limit(HEALTH_REPORT_HISTORY_LIMIT);
  const latest = rows[0] ?? null;
  return {
    latest: latest ? toDetail(latest) : null,
    // Oldest-first so the trend chart reads left to right.
    history: [...rows].reverse().map((r) => ({
      id: r.id,
      score: r.score,
      coverage: r.coverage,
      coverageGrade: r.coverageGrade,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

router.get("/health-report", async (req: Request, res: Response) => {
  if (!canView(req)) {
    res.status(403).json({
      error: "Health reports are available to workspace owners and admins only",
    });
    return;
  }
  try {
    res.json(await loadOverview(req.tenantId));
  } catch (error) {
    req.log.error({ err: error }, "Failed to load health report");
    res.status(500).json({ error: "Failed to load the health report" });
  }
});

router.post("/health-report/run", async (req: Request, res: Response) => {
  if (!canView(req)) {
    res.status(403).json({
      error: "Health reports are available to workspace owners and admins only",
    });
    return;
  }
  try {
    await runAndStoreHealthAudit(req.tenantId);
    res.json(await loadOverview(req.tenantId));
  } catch (error) {
    req.log.error({ err: error }, "Health audit run failed");
    res.status(500).json({ error: "Failed to run the health audit" });
  }
});

export default router;
