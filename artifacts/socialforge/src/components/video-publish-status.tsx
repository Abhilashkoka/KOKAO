import { useListVideoPublishes, getListVideoPublishesQueryKey, type VideoPublishResult } from "@workspace/api-client-react";
import { ExternalLink, AlertCircle } from "lucide-react";
import { RippleSpinner } from "@/components/ui/ripple-spinner";
import { VIDEO_DESTINATION_LABELS, VIDEO_FAILED_GUIDANCE, VIDEO_PUBLISH_STATE_LABELS, isActiveVideoState } from "@/lib/videoPublish";

export function useVideoPublishes(id: number, enabled = true) {
  return useListVideoPublishes(id, {
    query: {
      queryKey: getListVideoPublishesQueryKey(id),
      enabled,
      refetchInterval: (query) =>
        (query.state.data ?? []).some((p: VideoPublishResult) => isActiveVideoState(p.state)) ? 4000 : false,
    },
  });
}

/** Per-platform native video progress with permalinks. */
export function VideoPublishProgressList({ itemId, publishes }: { itemId: number; publishes: VideoPublishResult[] | undefined }) {
  if (!publishes || publishes.length === 0) return null;
  return (
    <ul className="space-y-1" data-testid={`video-publishes-${itemId}`}>
      {publishes.map((p) => {
        const label = VIDEO_DESTINATION_LABELS[p.platform as keyof typeof VIDEO_DESTINATION_LABELS] ?? p.platform;
        const active = isActiveVideoState(p.state);
        const bad = p.state === "failed" || p.state === "attention";
        return (
          <li
            key={p.platform}
            className="flex flex-wrap items-center gap-1.5 text-xs"
            data-testid={`video-publish-${p.platform}-${itemId}`}
          >
            {active ? (
              <RippleSpinner className="h-3 w-3" />
            ) : bad ? (
              <AlertCircle className="h-3 w-3 text-destructive" />
            ) : null}
            <span className="font-medium text-foreground">{label}</span>
            <span className={bad ? "text-destructive" : "text-muted-foreground"} data-testid={`status-video-publish-${p.platform}-${itemId}`}>
              {VIDEO_PUBLISH_STATE_LABELS[p.state] ?? p.state}
            </span>
            {p.permalink && (
              <a
                href={p.permalink}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-0.5 text-primary hover:underline"
                data-testid={`link-video-publish-${p.platform}-${itemId}`}
              >
                View <ExternalLink className="h-3 w-3" />
              </a>
            )}
            {p.error && <span className="w-full text-destructive/90">{p.error}</span>}
            {p.state === "failed" && <span className="w-full text-muted-foreground">{VIDEO_FAILED_GUIDANCE}</span>}
            {active && p.error && (
              <span className="w-full text-muted-foreground">Paused. Reconnect the account on the Accounts page and it resumes automatically.</span>
            )}
            {p.state === "attention" && (
              <span className="w-full text-muted-foreground">
                Check the platform directly. This upload will not be resubmitted to avoid a duplicate post.
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Card-level wrapper that fetches and renders progress for one library video. */
export function LibraryVideoPublishStatus({ itemId }: { itemId: number }) {
  const { data } = useVideoPublishes(itemId);
  return <VideoPublishProgressList itemId={itemId} publishes={data} />;
}
