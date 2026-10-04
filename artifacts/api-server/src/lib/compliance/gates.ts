import { createHash } from "node:crypto";
import type { FrozenJobCompliance, VideoStoryboard } from "@workspace/db";
import {
  checkCompliance,
  describeFindings,
  storyboardComplianceTexts,
  type ComplianceFinding,
  type ComplianceReport,
} from "./check";
import { thawCompliance } from "./profile";

/* Pure gate helpers shared by the storyboard edit / approval routes and the
 * job runner's render gate. No DB access — safe to unit test directly. */

/** Compliance report for a storyboard under a job's frozen snapshot. */
export function storyboardComplianceReport(
  board: VideoStoryboard | null | undefined,
  frozen: FrozenJobCompliance | null | undefined,
): ComplianceReport | null {
  if (!board || !frozen) return null;
  return checkCompliance(storyboardComplianceTexts(board), thawCompliance(frozen));
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
  const after = storyboardComplianceReport(next, frozen);
  if (!after) return [];
  const before = new Set(
    (storyboardComplianceReport(previous, frozen)?.findings ?? []).map((f) => `${f.ruleId}|${f.match}`),
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
export function storyboardComplianceError(
  board: VideoStoryboard | null | undefined,
  frozen: FrozenJobCompliance | null | undefined,
  opts: { requireReviewAck?: boolean; acknowledged?: boolean } = {},
): { code: "compliance_blocked" | "compliance_review_required"; error: string; report: ComplianceReport } | null {
  const report = storyboardComplianceReport(board, frozen);
  if (!report) return null;
  const blocking = report.findings.filter((f) => f.severity === "block");
  if (blocking.length > 0) {
    return {
      code: "compliance_blocked",
      error: `This storyboard breaks ${report.profession === "medical" ? "NMC" : "ICAI"} advertising rules and cannot continue until these are edited out — ${describeFindings(blocking)}.`,
      report,
    };
  }
  const review = report.findings.filter((f) => f.severity === "review");
  const previouslyAcknowledged =
    Boolean(frozen?.reviewAcknowledgedFingerprint) &&
    frozen?.reviewAcknowledgedFingerprint === reviewFingerprint(review);
  if (opts.requireReviewAck && review.length > 0 && !opts.acknowledged && !previouslyAcknowledged) {
    return {
      code: "compliance_review_required",
      error: `Confirm you have reviewed these ${report.profession === "medical" ? "NMC" : "ICAI"} compliance flags before approving — ${describeFindings(review)}.`,
      report,
    };
  }
  return null;
}
