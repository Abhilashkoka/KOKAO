import { createHash } from "node:crypto";
import type { FrozenJobCompliance, VideoStoryboard } from "@workspace/db";
import {
  checkCompliance,
  describeFindings,
  normaliseForCheck,
  storyboardComplianceTexts,
  type ComplianceFinding,
  type ComplianceReport,
  type ComplianceText,
} from "./check";
import { thawCompliance } from "./profile";

/** Exact reviewed text plus pinned rules and approved facts. */
export function contentFingerprint(
  items: ComplianceText[],
  frozen: Pick<FrozenJobCompliance, "packId" | "packVersion" | "facts" | "extraNegativeTerms">,
): string {
  return createHash("sha256")
    .update(JSON.stringify({
      pack: `${frozen.packId}@${frozen.packVersion}`,
      facts: frozen.facts,
      negatives: [...(frozen.extraNegativeTerms ?? [])].sort(),
      items: items.map((item) => [item.field, item.location, normaliseForCheck(item.text)]),
    }))
    .digest("hex");
}

export function storyboardContentFingerprint(board: VideoStoryboard, frozen: FrozenJobCompliance): string {
  return contentFingerprint(storyboardComplianceTexts(board), frozen);
}

export function complianceReportFor(
  items: ComplianceText[],
  frozen: FrozenJobCompliance | null | undefined,
): ComplianceReport | null {
  if (!frozen) return null;
  const report = checkCompliance(items, thawCompliance(frozen));
  if (!report) return null;
  const fingerprint = contentFingerprint(items, frozen);
  const stored = frozen.semanticReview;
  const upToDate = Boolean(stored && stored.contentFingerprint === fingerprint);
  const seen = new Set(report.findings.map((f) => `${f.ruleId}|${f.location}|${f.match.toLocaleLowerCase()}`));
  const aiFindings = upToDate
    ? stored!.findings.filter((f) => !seen.has(`${f.ruleId}|${f.location}|${f.match.toLocaleLowerCase()}`))
    : [];
  const findings: ComplianceFinding[] = [...report.findings, ...aiFindings];
  return {
    ...report,
    findings,
    blocking: findings.filter((f) => f.severity === "block").length,
    review: findings.filter((f) => f.severity === "review").length,
    contentFingerprint: fingerprint,
    aiReview: {
      required: frozen.semanticReviewRequired === true,
      upToDate,
      reviewedAt: upToDate ? stored!.reviewedAt : null,
    },
    reviewAcknowledged:
      Boolean(frozen.reviewAcknowledgedContentFingerprint) &&
      frozen.reviewAcknowledgedContentFingerprint === fingerprint,
  };
}

/* Pure gate helpers shared by the storyboard edit / approval routes and the
 * job runner's render gate. No DB access — safe to unit test directly. */

/** Compliance report for a storyboard under a job's frozen snapshot. */
export function storyboardComplianceReport(
  board: VideoStoryboard | null | undefined,
  frozen: FrozenJobCompliance | null | undefined,
): ComplianceReport | null {
  if (!board || !frozen) return null;
  return complianceReportFor(storyboardComplianceTexts(board), frozen);
}

/** Stable identity of a set of review findings (what was acknowledged). */
export function reviewFingerprint(findings: ComplianceFinding[]): string {
  const keys = findings
    .filter((f) => f.severity === "review")
    .map((f) => `${f.ruleId}|${f.location}|${f.match}`)
    .sort();
  return createHash("sha256").update(JSON.stringify(keys)).digest("hex").slice(0, 32);
}

/** Block findings present in `next` that were not in `previous`. */
export function newBlockingFindings(
  previous: VideoStoryboard | null | undefined,
  next: VideoStoryboard,
  frozen: FrozenJobCompliance | null | undefined,
): ComplianceFinding[] {
  if (!frozen) return [];
  const after = checkCompliance(storyboardComplianceTexts(next), thawCompliance(frozen));
  if (!after) return [];
  const before = new Set(
    (previous ? checkCompliance(storyboardComplianceTexts(previous), thawCompliance(frozen))?.findings ?? [] : [])
      .map((f) => `${f.ruleId}|${f.match}`),
  );
  return after.findings.filter((f) => f.severity === "block" && !before.has(`${f.ruleId}|${f.match}`));
}

/**
 * Gate used by storyboard edit / approval / render.
 * Returns a user-facing error, or null when the board may proceed.
 * - "block" findings always stop it.
 * - "review" findings stop it only when `requireReviewAck` is set and the
 *   job has not recorded an acknowledgement.
 */
export function complianceGateError(
  report: ComplianceReport | null,
  frozen: FrozenJobCompliance | null | undefined,
  opts: { requireReviewAck?: boolean; acknowledged?: boolean; requireAiReview?: boolean } = {},
): ComplianceGateFailure | null {
  if (!report || !frozen) return null;
  const blocking = report.findings.filter((f) => f.severity === "block");
  if (blocking.length > 0) {
    return {
      code: "compliance_blocked",
      error: `This breaks ${regulator(report)} advertising rules and cannot continue until these are edited out — ${describeFindings(blocking)}.`,
      report,
    };
  }
  const review = report.findings.filter((f) => f.severity === "review");
  if ((opts.requireAiReview ?? true) && frozen.semanticReviewRequired && !report.aiReview?.upToDate) {
    return {
      code: "compliance_ai_review_required",
      error: `The ${regulator(report)} compliance review has not been run on this exact version. Re-approve it so it can be checked before anything is generated.`,
      report,
    };
  }
  const acknowledged = opts.acknowledged === true || report.reviewAcknowledged === true;
  if (opts.requireReviewAck && review.length > 0 && !acknowledged) {
    return {
      code: "compliance_review_required",
      error: `Confirm you have reviewed these ${regulator(report)} compliance flags for this exact version before it is generated — ${describeFindings(review)}.`,
      report,
    };
  }
  return null;
}

export type ComplianceGateCode = "compliance_blocked" | "compliance_ai_review_required" | "compliance_review_required";
export interface ComplianceGateFailure {
  code: ComplianceGateCode;
  error: string;
  report: ComplianceReport;
}
const regulator = (report: ComplianceReport) => (report.profession === "medical" ? "NMC" : "ICAI");

export function storyboardComplianceError(
  board: VideoStoryboard | null | undefined,
  frozen: FrozenJobCompliance | null | undefined,
  opts: { requireReviewAck?: boolean; acknowledged?: boolean; requireAiReview?: boolean } = {},
): ComplianceGateFailure | null {
  return complianceGateError(storyboardComplianceReport(board, frozen), frozen, opts);
}
