/**
 * "AI amount spent" line for a video job, matching the web Video Studio
 * ("text-video-ai-spent"): admin-set per-video rate × the job's charged
 * units. Multi-scene jobs (character stories, multi-shot clips, review-added
 * scenes, AI music bed) charge several units, so multiplying is what keeps
 * the shown figure equal to what was really spent; single-unit jobs show the
 * plain rate.
 *
 * Returns null when nothing should render: rate is zero/absent (which is
 * also how the aiSpend kill switch surfaces — callers additionally gate the
 * rates fetch on the flag).
 */
export function formatVideoAiSpend(
  ratePaise: number | null | undefined,
  units: number | null | undefined,
): string | null {
  if (!ratePaise || ratePaise <= 0) return null;
  const totalPaise = ratePaise * Math.max(1, units ?? 1);
  return `\u20B9${(totalPaise / 100).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
