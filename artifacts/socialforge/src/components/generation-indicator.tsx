import { Link } from "wouter";
import { Loader2 } from "lucide-react";
import {
  useListVideoJobs,
  getListVideoJobsQueryKey,
  useListImageJobs,
  getListImageJobsQueryKey,
} from "@workspace/api-client-react";

/**
 * App-wide "something is still generating" pill.
 *
 * A video or image job runs server-side, so it survives logout/reload — but
 * the page-local progress UIs do not. This pill lives in the layout (sidebar
 * on desktop, header on mobile), so a tenant who logs back in mid-generation
 * sees immediately that work is still cooking and where to find it:
 * videos link to the Video Studio (which auto-opens the running job),
 * images link to the AI Studio.
 *
 * Polling is active-only: 5s while a job is in flight, a lazy 60s heartbeat
 * otherwise so newly enqueued jobs are still discovered.
 */
export function GenerationIndicator() {
  const { data: videoJobs } = useListVideoJobs({
    query: {
      queryKey: getListVideoJobsQueryKey(),
      refetchInterval: (query) =>
        (query.state.data ?? []).some(
          (j) => j.status === "queued" || j.status === "processing",
        )
          ? 5000
          : 60000,
    },
  });
  const { data: imageJobs } = useListImageJobs({
    query: {
      queryKey: getListImageJobsQueryKey(),
      refetchInterval: (query) =>
        (query.state.data ?? []).some(
          (j) => j.status === "queued" || j.status === "processing",
        )
          ? 5000
          : 60000,
    },
  });

  const activeVideo = (videoJobs ?? []).filter(
    (j) => j.status === "queued" || j.status === "processing",
  );
  const activeImage = (imageJobs ?? []).filter(
    (j) => j.status === "queued" || j.status === "processing",
  );
  if (activeVideo.length === 0 && activeImage.length === 0) return null;

  const stage = activeVideo[0]?.stage ?? null;
  const label =
    activeVideo.length > 0 && activeImage.length > 0
      ? "Video & image generating"
      : activeVideo.length > 0
        ? (stage ?? "Video generating…")
        : "Image generating…";
  const href = activeVideo.length > 0 ? "/studio?tab=video" : "/studio?tab=image";

  return (
    <Link href={href}>
      <div
        className="flex items-center gap-2 rounded-full border border-primary/40 bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary cursor-pointer hover:bg-primary/20 transition-colors max-w-full"
        data-testid="pill-generation-in-progress"
        title="A generation is still running — click to view its progress"
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
        <span className="truncate">{label}</span>
      </div>
    </Link>
  );
}
