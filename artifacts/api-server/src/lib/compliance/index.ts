import { db, tenantsTable, type FrozenJobCompliance, type FrozenSemanticReview, type VideoStoryboard } from "@workspace/db";
import { eq } from "drizzle-orm";
import { loadActivePayload } from "../brandKit/service";
import { resolveSelection } from "../brandKit/selection";
import { freezeCompliance, resolveCompliance, thawCompliance } from "./profile";
import { checkCompliance, storyboardComplianceTexts, type ComplianceReport, type ComplianceText } from "./check";
import { contentFingerprint } from "./gates";
import { complianceTextConstraints } from "./prompt";
import { runSemanticReview } from "./semantic";
import { ComplianceUnavailableError } from "./errors";
import { isFeatureEnabled } from "../featureFlags";
import { logger } from "../logger";

export * from "./check";
export * from "./errors";
export * from "./gates";
export * from "./profile";
export * from "./prompt";
export * from "./rulePacks";
export * from "./semantic";

async function tenantIndustry(tenantId: number): Promise<string | null> {
  const row = (
    await db
      .select({ industry: tenantsTable.industry })
      .from(tenantsTable)
      .where(eq(tenantsTable.id, tenantId))
      .limit(1)
  )[0];
  return row?.industry ?? null;
}

/**
 * The compliance snapshot to freeze onto a new video job.
 *
 * Deliberately independent of the brandVideo kill switch and of whether the
 * user attached a kit: a doctor who forgets to pick a kit is still a doctor.
 * Order: requested kit → default kit → tenant industry.
 * Fail closed on lookup errors; foreign/deleted kits fall back only to this tenant.
 */
export async function resolveJobCompliance(
  tenantId: number,
  brandKitId: number | null | undefined,
): Promise<FrozenJobCompliance | null> {
  try {
    let loaded = brandKitId != null ? await loadActivePayload(tenantId, brandKitId) : null;
    let kitId: number | null = loaded ? brandKitId! : null;
    if (!loaded) {
      const selected = await resolveSelection(tenantId, {});
      const defaultId = selected.status === "resolved" ? (selected.brandKit?.id ?? null) : null;
      if (defaultId != null) {
        loaded = await loadActivePayload(tenantId, defaultId);
        kitId = loaded ? defaultId : null;
      }
    }
    const industry = await tenantIndustry(tenantId);
    const effective = resolveCompliance(loaded?.payload ?? null, industry);
    if (!effective) return null;
    const semanticReviewRequired = await isFeatureEnabled("complianceAiReview").catch(() => true);
    return freezeCompliance(effective, kitId, { semanticReviewRequired });
  } catch (error) {
    if (error instanceof ComplianceUnavailableError) throw error;
    logger.error({ err: error, tenantId, brandKitId }, "Compliance profile lookup failed; refusing to continue");
    throw new ComplianceUnavailableError();
  }
}

/** Negative list plus required AI check for content without a later review step. */
export async function checkTextsWithAiReview(args: {
  tenantId: number;
  items: ComplianceText[];
  frozen: FrozenJobCompliance | null;
  operationKey: string;
}): Promise<ComplianceReport | null> {
  if (!args.frozen) return null;
  const compliance = thawCompliance(args.frozen)!;
  const report = checkCompliance(args.items, compliance);
  if (!report) return null;
  if (report.blocking > 0 || !args.frozen.semanticReviewRequired || args.items.length === 0) return report;
  const reviewed = await runSemanticReview({
    tenantId: args.tenantId, items: args.items, compliance, operationKey: args.operationKey,
  });
  const seen = new Set(report.findings.map((f) => `${f.ruleId}|${f.location}|${f.match.toLocaleLowerCase()}`));
  const findings = [
    ...report.findings,
    ...reviewed.findings.filter((f) => !seen.has(`${f.ruleId}|${f.location}|${f.match.toLocaleLowerCase()}`)),
  ];
  return {
    ...report,
    findings,
    blocking: findings.filter((f) => f.severity === "block").length,
    review: findings.filter((f) => f.severity === "review").length,
    aiReview: { required: true, upToDate: true, reviewedAt: reviewed.reviewedAt },
  };
}

/** Reuse AI review only for unchanged content. */
export async function ensureStoryboardAiReview(args: {
  tenantId: number;
  jobId: number;
  board: VideoStoryboard;
  frozen: FrozenJobCompliance;
}): Promise<FrozenSemanticReview | null> {
  if (!args.frozen.semanticReviewRequired) return null;
  const items = storyboardComplianceTexts(args.board);
  const fingerprint = contentFingerprint(items, args.frozen);
  if (args.frozen.semanticReview?.contentFingerprint === fingerprint) return args.frozen.semanticReview;
  const reviewed = await runSemanticReview({
    tenantId: args.tenantId,
    items,
    compliance: thawCompliance(args.frozen)!,
    operationKey: `job:${args.jobId}:storyboard:${fingerprint.slice(0, 16)}`,
  });
  return {
    contentFingerprint: fingerprint,
    reviewedAt: reviewed.reviewedAt,
    model: reviewed.model,
    findings: reviewed.findings,
  };
}

export async function textComplianceConstraints(
  tenantId: number,
  brandKitId: number | null | undefined,
): Promise<string[]> {
  return complianceTextConstraints(thawCompliance(await resolveJobCompliance(tenantId, brandKitId)));
}
