/**
 * "AI amount spent" line for a video job, matching the web Video Studio
 * ("text-video-ai-spent"): per-video rate × the job's charged units.
 * Multi-scene jobs (character stories, multi-shot clips, review-added
 * scenes, AI music bed) charge several units, so multiplying is what keeps
 * the shown figure equal to what was really spent; single-unit jobs show the
 * plain rate.
 *
 * The job's snapshotted TOTAL spend (spendPaise — the real per-event display
 * amount recorded at settle, actual cost + margin in cost_plus mode) wins
 * outright when the server persisted one. Otherwise the rate used is the
 * job's PERSISTED charge-time rate (chargedRatePaise) when the server
 * recorded one, so history never shifts when an admin later edits the
 * display rates. Legacy jobs (null/undefined snapshots) fall back to the
 * current admin-set rate.
 *
 * Returns null when nothing should render: the effective rate is zero/absent
 * (which is also how the aiSpend kill switch surfaces — callers additionally
 * gate the rates fetch on the flag and pass spendPaise/chargedRatePaise
 * accordingly).
 */
export function formatVideoAiSpend(
  currentRatePaise: number | null | undefined,
  units: number | null | undefined,
  chargedRatePaise?: number | null,
  spendPaise?: number | null,
): string | null {
  if (spendPaise != null) {
    // A real snapshot always wins — a genuine 0 hides the line rather than
    // ever being replaced by a nonzero flat/charged estimate.
    if (spendPaise <= 0) return null;
    return `\u20B9${(spendPaise / 100).toLocaleString("en-IN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }
  const ratePaise = chargedRatePaise ?? currentRatePaise;
  if (!ratePaise || ratePaise <= 0) return null;
  const totalPaise = ratePaise * Math.max(1, units ?? 1);
  return `\u20B9${(totalPaise / 100).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
