import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useSearch } from "wouter";
import {
  getListVideoJobsQueryKey,
  useGetMe,
  useApproveVideoStoryboard,
  useDiscardVideoStoryboard,
  useListVideoJobs,
  type VideoJob,
} from "@workspace/api-client-react";
import { CheckCircle2, Clapperboard, Clock, Loader2, Pencil, Plus, XCircle } from "lucide-react";
import { loadReelFromPhotos } from "@/lib/create-draft";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { VideoDownloadButton } from "@/components/video-download-button";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { apiErrorMessage } from "@/lib/apiErrorMessage";
import { refreshCreditBalanceSafely } from "@/lib/refresh-credit-balance";
import { cn } from "@/lib/utils";

function storageUrl(path: string): string {
  return `/api/storage${path}`;
}

const ACTIVE = new Set(["queued", "processing"]);

export function resultStatusLabel(status: VideoJob["status"]): string {
  switch (status) {
    case "succeeded":
      return "Ready";
    case "queued":
      return "Queued";
    case "processing":
      return "Rendering";
    case "awaiting_review":
      return "Needs review";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    default:
      return status;
  }
}

function StatusBadge({ status }: { status: VideoJob["status"] }) {
  const Icon =
    status === "succeeded"
      ? CheckCircle2
      : status === "failed" || status === "cancelled"
        ? XCircle
        : ACTIVE.has(status)
          ? Loader2
          : Clock;
  return (
    <Badge
      variant="secondary"
      className={cn(
        "gap-1",
        status === "succeeded" && "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-100",
        (status === "failed" || status === "cancelled") && "bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-100",
      )}
    >
      <Icon className={cn("h-3.5 w-3.5", ACTIVE.has(status) && "animate-spin")} />
      {resultStatusLabel(status)}
    </Badge>
  );
}

/**
 * Approve a waiting storyboard right here. Guided stories and plans with
 * blocking compliance findings still go to the studio, which owns those flows.
 */
function ReviewPanel({ job, onOpenStudio }: { job: VideoJob; onOpenStudio: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const approve = useApproveVideoStoryboard();
  const discard = useDiscardVideoStoryboard();
  const [ack, setAck] = useState(false);
  const scenes = job.storyboard?.scenes ?? [];
  const report = job.compliance?.report ?? null;
  const blocked = (report?.blocking ?? 0) > 0;
  const needsAck = (report?.review ?? 0) > 0 && report?.reviewAcknowledged !== true;
  const studioOnly = job.guidedStoryDraftId != null || blocked || scenes.length === 0;

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: getListVideoJobsQueryKey() });
    refreshCreditBalanceSafely(queryClient);
  };
  const fail = (title: string) => (error: unknown) =>
    toast({ title, description: apiErrorMessage(error, "Please try again."), variant: "destructive" });

  if (studioOnly) {
    return (
      <div className="space-y-3 rounded-2xl border bg-card p-4" data-testid="results-review-studio">
        <p className="text-sm text-muted-foreground">
          {blocked
            ? "This plan has compliance issues to fix before it can render."
            : "This video has steps to review in the studio."}
        </p>
        <Button variant="outline" onClick={onOpenStudio}>
          Open in studio
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-2xl border bg-card p-4" data-testid="results-review">
      <h2 className="font-semibold">Check the plan, then make the video</h2>
      <ol className="space-y-3">
        {scenes.map((scene, index) => (
          <li key={scene.id} className="flex gap-3">
            {scene.previewPath ? (
              <img
                src={storageUrl(scene.previewPath)}
                alt=""
                className="h-20 w-14 shrink-0 rounded-lg object-cover"
              />
            ) : (
              <span className="flex h-20 w-14 shrink-0 items-center justify-center rounded-lg bg-muted text-sm font-semibold">
                {index + 1}
              </span>
            )}
            <div className="min-w-0 text-sm">
              <p className="font-medium">{scene.visual}</p>
              {scene.text && <p className="text-muted-foreground">{scene.text}</p>}
              <p className="text-xs text-muted-foreground">{scene.durationSec}s</p>
            </div>
          </li>
        ))}
      </ol>
      {needsAck && (
        <label className="flex items-start gap-2 text-sm">
          <Checkbox checked={ack} onCheckedChange={(v) => setAck(v === true)} className="mt-0.5" />
          I have reviewed the compliance notes on this plan.
        </label>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          onClick={() =>
            approve.mutate(
              { jobId: job.id, data: needsAck ? { acknowledgeComplianceReview: true } : undefined },
              { onSuccess: refresh, onError: fail("Could not start the video") },
            )
          }
          disabled={approve.isPending || (needsAck && !ack)}
          data-testid="results-approve"
        >
          {approve.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Approve &amp; make video
        </Button>
        <Button variant="outline" onClick={onOpenStudio} data-testid="results-edit-plan">
          Edit in studio
        </Button>
        <Button
          variant="ghost"
          onClick={() =>
            discard.mutate({ jobId: job.id }, { onSuccess: refresh, onError: fail("Could not discard") })
          }
          disabled={discard.isPending}
        >
          Discard
        </Button>
      </div>
    </div>
  );
}

export function ResultsPage() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const { data: me } = useGetMe();
  const requested = Number(new URLSearchParams(search).get("job"));
  const [selectedId, setSelectedId] = useState<number | null>(
    Number.isSafeInteger(requested) && requested > 0 ? requested : null,
  );

  const { data: jobs, isLoading } = useListVideoJobs({
    query: {
      queryKey: getListVideoJobsQueryKey(),
      // Keep rendering jobs fresh without hammering the API when all are done.
      refetchInterval: (query) =>
        (query.state.data as VideoJob[] | undefined)?.some((j) => ACTIVE.has(j.status))
          ? 5_000
          : false,
    },
  });

  const sorted = useMemo(
    () => [...(jobs ?? [])].sort((a, b) => b.id - a.id),
    [jobs],
  );

  useEffect(() => {
    if (selectedId === null && sorted.length > 0) setSelectedId(sorted[0].id);
  }, [selectedId, sorted]);

  const selected = sorted.find((j) => j.id === selectedId) ?? null;
  const videoPath = selected?.currentVideoPath ?? selected?.videoPath ?? null;

  /** Hand the job to the full studio, which restores the active job by key. */
  const openInStudio = (job: VideoJob) => {
    const tenantId = me?.tenant?.id;
    if (tenantId) {
      try {
        localStorage.setItem(`kokao-active-video-job-v1:${tenantId}`, String(job.id));
      } catch {
        // Storage can be unavailable (private mode); the studio still opens.
      }
    }
    navigate("/studio?tab=video");
  };

  if (isLoading) {
    return (
      <div className="mx-auto max-w-6xl space-y-4" data-testid="results-loading">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (sorted.length === 0) {
    return (
      <div className="mx-auto max-w-xl space-y-4 py-16 text-center" data-testid="results-empty">
        <h1 className="text-3xl font-bold">No videos yet</h1>
        <p className="text-muted-foreground">Your videos will appear here as soon as you create one.</p>
        <Button asChild size="lg">
          <Link href="/create">
            <Plus className="mr-2 h-5 w-5" /> Create a video
          </Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6" data-testid="results-page">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl font-bold tracking-tight">Your videos</h1>
        <Button asChild>
          <Link href="/create" data-testid="results-create">
            <Plus className="mr-2 h-4 w-4" /> Create
          </Link>
        </Button>
      </div>

      {selected && (
        <div className="flex flex-wrap items-start gap-6">
          <div className="w-full max-w-sm flex-[1_1_300px] overflow-hidden rounded-3xl border bg-muted">
            {selected.status === "succeeded" && videoPath ? (
              <video
                key={videoPath}
                src={storageUrl(videoPath)}
                poster={selected.thumbnailPath ? storageUrl(selected.thumbnailPath) : undefined}
                controls
                playsInline
                className="aspect-[9/16] h-full w-full bg-black object-contain"
                data-testid="results-player"
              />
            ) : (
              <div className="flex aspect-[9/16] flex-col items-center justify-center gap-3 p-6 text-center">
                <StatusBadge status={selected.status} />
                <p className="text-sm text-muted-foreground">
                  {ACTIVE.has(selected.status)
                    ? "Your video is being made. This page updates by itself."
                    : selected.status === "awaiting_review"
                      ? "Check the plan on the right, then make the video."
                      : (selected.error ?? "This video did not finish.")}
                </p>
                {selected.status === "failed" && (
                  <Button variant="outline" onClick={() => openInStudio(selected)}>
                    Open in studio
                  </Button>
                )}
              </div>
            )}
          </div>

          <div className="min-w-0 flex-[999_1_340px] space-y-5">
            <div className="flex items-center gap-3">
              <StatusBadge status={selected.status} />
              <span className="text-sm text-muted-foreground">
                {selected.aspectRatio}
                {selected.totalCreditsUsed != null && ` · ${selected.totalCreditsUsed} credits`}
              </span>
            </div>
            {selected.prompt && (
              <p className="rounded-2xl border bg-card p-4 text-sm" data-testid="results-prompt">
                {selected.prompt}
              </p>
            )}
            {selected.status === "awaiting_review" && (
              <ReviewPanel job={selected} onOpenStudio={() => openInStudio(selected)} />
            )}
            {selected.status === "succeeded" && videoPath && (
              <div className="grid gap-3 sm:grid-cols-2">
                <VideoDownloadButton
                  objectPath={videoPath}
                  filename={`kokao-video-${selected.id}.mp4`}
                  testId="results-download"
                />
                <Button
                  variant="outline"
                  onClick={() => openInStudio(selected)}
                  data-testid="results-edit"
                >
                  <Pencil className="mr-2 h-4 w-4" /> Edit a part
                </Button>
              </div>
            )}
            {selected.status === "succeeded" &&
              selected.engine === "slideshow" &&
              selected.sourceImagePaths.length >= 2 && (
                <div
                  className="space-y-2 rounded-2xl bg-pastel-lavender/50 p-4"
                  data-testid="results-bring-to-life"
                >
                  <p className="text-sm">
                    <strong>Bring it to life.</strong> Turn these looks into a video reel
                    where she twirls, walks and turns. You'll see the cost before it starts.
                  </p>
                  <Button
                    className="w-full"
                    onClick={() => {
                      loadReelFromPhotos(selected.sourceImagePaths, selected.aspectRatio);
                      navigate("/create?mode=reel");
                    }}
                    data-testid="results-bring-to-life-button"
                  >
                    <Clapperboard className="mr-2 h-4 w-4" /> Bring it to life
                  </Button>
                </div>
              )}
            <Button asChild variant="secondary" className="w-full">
              <Link href="/create" data-testid="results-make-another">
                Make another
              </Link>
            </Button>
          </div>
        </div>
      )}

      <section className="space-y-3" aria-labelledby="results-recent">
        <h2 id="results-recent" className="text-lg font-semibold">
          Recent
        </h2>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-3">
          {sorted.map((job) => (
            <button
              key={job.id}
              type="button"
              onClick={() => setSelectedId(job.id)}
              aria-pressed={job.id === selectedId}
              aria-label={`Video ${job.id}, ${resultStatusLabel(job.status)}`}
              data-testid={`results-item-${job.id}`}
              className={cn(
                "relative aspect-[9/14] overflow-hidden rounded-2xl border bg-muted text-left",
                job.id === selectedId && "ring-2 ring-primary",
              )}
            >
              {job.thumbnailPath && (
                <img
                  src={storageUrl(job.thumbnailPath)}
                  alt=""
                  className="absolute inset-0 h-full w-full object-cover"
                />
              )}
              <span className="absolute bottom-2 left-2">
                <StatusBadge status={job.status} />
              </span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
