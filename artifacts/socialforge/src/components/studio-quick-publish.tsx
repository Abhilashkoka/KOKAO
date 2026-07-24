import { useEffect, useState } from "react";
import {
  usePublishContentToFacebook,
  usePublishContentToInstagram,
  usePublishContentToLinkedin,
  usePublishContentToTwitter,
  usePublishContentToThreads,
  useCreateSchedule,
  getListContentQueryKey,
  getListSchedulesQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RippleSpinner } from "@/components/ui/ripple-spinner";
import { useToast } from "@/hooks/use-toast";
import { useFeatureFlags } from "@/lib/features";
import { track } from "@/lib/analytics";
import { apiErrorMessage } from "@/lib/apiErrorMessage";
import { Send, CalendarClock, Globe, AlertCircle, Info } from "lucide-react";
import {
  isOverTweetLimit,
  splitIntoTweets,
  isOverLinkedinLimit,
  splitForLinkedin,
  THREADS_MAX_LENGTH,
  chunkOnWhitespace,
} from "@workspace/social-limits";

export const QUICK_PUBLISH_LABELS: Record<string, string> = {
  facebook: "Facebook",
  instagram: "Instagram",
  linkedin: "LinkedIn",
  twitter: "X",
  threads: "Threads",
};

const PLATFORM_ORDER = ["facebook", "instagram", "linkedin", "twitter", "threads"];

/** Local-time value for a datetime-local input, N minutes from now. */
export function defaultScheduleValue(minutesFromNow = 60): string {
  const d = new Date(Date.now() + minutesFromNow * 60_000);
  d.setSeconds(0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** localStorage key remembering the last platform selection (composer mode). */
const SELECTION_STORAGE_KEY = "kokao.quickPublish.platforms";

interface QuickPublishPanelProps {
  /** The auto-saved draft to publish. */
  contentItemId: number;
  /** Which platforms have a live, verified connection. */
  platformLive: Record<string, boolean>;
  /** Preselected platforms (e.g. the campaign toggles); filtered to live ones. */
  defaultSelected: string[];
  disabled?: boolean;
  /** Called after at least one platform published successfully. */
  onPublished?: (succeeded: string[]) => void;
  /** Called after at least one schedule was created successfully. */
  onScheduled?: (succeeded: string[]) => void;
  /**
   * The caption that will be posted. When provided, a pre-publish checklist
   * explains platform behavior BEFORE the click (X threads, LinkedIn comment
   * overflow, Threads chains) using the same social-limits helpers the
   * server-side publishers use, so the warning can never drift from reality.
   */
  caption?: string;
  /**
   * Whether the item has an image. Pass `false` to gate Instagram (which
   * requires one): its checkbox disables with a hint instead of failing at
   * publish time. Leave undefined to skip the check.
   */
  hasImage?: boolean;
  /**
   * Runs before publishing/scheduling (e.g. persist caption edits so every
   * platform posts the same text). Return false to abort the action.
   */
  beforeAction?: () => Promise<boolean>;
  /** Remember the selection in this browser and prefill it next time. */
  rememberSelection?: boolean;
}

/**
 * Inline publish panel shown in the Studio right after a generation:
 * pick platforms, then "Post now", "Publish to all connected", or schedule —
 * without leaving the page. The content is already auto-saved as a draft, so
 * publishing here is the second (and last) click.
 */
export function QuickPublishPanel({
  contentItemId,
  platformLive,
  defaultSelected,
  disabled,
  onPublished,
  onScheduled,
  caption,
  hasImage,
  beforeAction,
  rememberSelection,
}: QuickPublishPanelProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { flags } = useFeatureFlags();

  const publishFacebook = usePublishContentToFacebook();
  const publishInstagram = usePublishContentToInstagram();
  const publishLinkedin = usePublishContentToLinkedin();
  const publishTwitter = usePublishContentToTwitter();
  const publishThreads = usePublishContentToThreads();
  const createSchedule = useCreateSchedule();

  const publishers: Record<string, (vars: { id: number }) => Promise<unknown>> = {
    facebook: (v) => publishFacebook.mutateAsync(v),
    instagram: (v) => publishInstagram.mutateAsync(v),
    linkedin: (v) => publishLinkedin.mutateAsync(v),
    twitter: (v) => publishTwitter.mutateAsync(v),
    threads: (v) => publishThreads.mutateAsync(v),
  };

  const livePlatforms = PLATFORM_ORDER.filter((p) => platformLive[p]);
  // Instagram requires an image: when the item has none, keep the checkbox
  // visible but disabled so the user learns why instead of hitting an error.
  const instagramBlocked = hasImage === false && platformLive.instagram === true;
  const publishablePlatforms = instagramBlocked
    ? livePlatforms.filter((p) => p !== "instagram")
    : livePlatforms;

  const [selected, setSelected] = useState<string[]>([]);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleAt, setScheduleAt] = useState(() => defaultScheduleValue());
  const [busy, setBusy] = useState<"publish" | "schedule" | null>(null);

  // Re-prefill whenever the draft changes (a new generation): the remembered
  // selection (composer mode) or the campaign toggles, intersected with live
  // connections, falling back to all connected.
  useEffect(() => {
    let remembered: string[] = [];
    if (rememberSelection) {
      try {
        const raw = localStorage.getItem(SELECTION_STORAGE_KEY);
        remembered = raw ? (JSON.parse(raw) as string[]) : [];
      } catch {
        remembered = [];
      }
    }
    const rememberedLive = remembered.filter((p) => publishablePlatforms.includes(p));
    const prefilled = defaultSelected.filter((p) => publishablePlatforms.includes(p));
    setSelected(
      rememberedLive.length > 0
        ? rememberedLive
        : prefilled.length > 0
          ? prefilled
          : publishablePlatforms,
    );
    setScheduleOpen(false);
    setBusy(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contentItemId, livePlatforms.join(","), instagramBlocked]);

  const persistSelection = (platforms: string[]) => {
    if (!rememberSelection) return;
    try {
      localStorage.setItem(SELECTION_STORAGE_KEY, JSON.stringify(platforms));
    } catch {
      // Remembering defaults is best-effort.
    }
  };

  // Pre-publish checklist: platform behavior explained BEFORE the click.
  const checklistInfos: string[] = [];
  if (caption) {
    if (selected.includes("twitter") && isOverTweetLimit(caption)) {
      checklistInfos.push(
        `X: over the character limit — will post as a thread of ${splitIntoTweets(caption).length} tweets.`,
      );
    }
    if (selected.includes("linkedin") && isOverLinkedinLimit(caption)) {
      checklistInfos.push(
        `LinkedIn: long caption — the overflow continues in ${splitForLinkedin(caption).comments.length} comment(s).`,
      );
    }
    if (selected.includes("threads") && caption.length > THREADS_MAX_LENGTH) {
      checklistInfos.push(
        `Threads: over the limit — will post as a chain of ${chunkOnWhitespace(caption, THREADS_MAX_LENGTH).length} posts.`,
      );
    }
  }

  if (livePlatforms.length === 0) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="text-quick-publish-no-accounts">
        Connect a social account to publish straight from the Studio.
      </p>
    );
  }

  const toggle = (platform: string, on: boolean) => {
    setSelected((prev) => (on ? [...prev, platform] : prev.filter((p) => p !== platform)));
  };

  const finishInvalidate = () => {
    queryClient.invalidateQueries({ queryKey: getListContentQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListSchedulesQueryKey() });
  };

  const postNow = async (platforms: string[]) => {
    if (platforms.length === 0) {
      toast({ title: "Pick at least one platform", variant: "destructive" });
      return;
    }
    setBusy("publish");
    persistSelection(platforms);
    if (beforeAction && !(await beforeAction().catch(() => false))) {
      setBusy(null);
      return;
    }
    const succeeded: string[] = [];
    const failed: { platform: string; message: string }[] = [];
    // Sequential on purpose: each publish route holds the per-item lock, and
    // one clear outcome per platform beats five racing spinners.
    for (const platform of platforms) {
      try {
        await publishers[platform]({ id: contentItemId });
        succeeded.push(platform);
        track("post_published", { platform, category: "content", outcome: "success" });
      } catch (err: any) {
        failed.push({
          platform,
          message: apiErrorMessage(err, "Publish failed"),
        });
      }
    }
    setBusy(null);
    finishInvalidate();
    const names = (list: string[]) => list.map((p) => QUICK_PUBLISH_LABELS[p] ?? p).join(", ");
    if (failed.length === 0) {
      toast({ title: "Published!", description: `Posted to ${names(succeeded)}.` });
    } else if (succeeded.length > 0) {
      toast({
        title: `Posted to ${names(succeeded)}`,
        description: `Failed on ${failed.map((f) => `${QUICK_PUBLISH_LABELS[f.platform] ?? f.platform} (${f.message})`).join("; ")}`,
        variant: "destructive",
      });
    } else {
      toast({
        title: "Publish failed",
        description: failed.map((f) => `${QUICK_PUBLISH_LABELS[f.platform] ?? f.platform}: ${f.message}`).join("; "),
        variant: "destructive",
      });
    }
    if (succeeded.length > 0) onPublished?.(succeeded);
  };

  const scheduleSelected = async () => {
    if (selected.length === 0) {
      toast({ title: "Pick at least one platform", variant: "destructive" });
      return;
    }
    const when = new Date(scheduleAt);
    if (Number.isNaN(when.getTime()) || when.getTime() <= Date.now()) {
      toast({ title: "Pick a future time", variant: "destructive" });
      return;
    }
    setBusy("schedule");
    persistSelection(selected);
    if (beforeAction && !(await beforeAction().catch(() => false))) {
      setBusy(null);
      return;
    }
    const succeeded: string[] = [];
    const failed: string[] = [];
    for (const platform of selected) {
      try {
        await createSchedule.mutateAsync({
          data: { contentItemId, platform, scheduledAt: when.toISOString() },
        });
        succeeded.push(platform);
      } catch {
        failed.push(platform);
      }
    }
    setBusy(null);
    finishInvalidate();
    const names = (list: string[]) => list.map((p) => QUICK_PUBLISH_LABELS[p] ?? p).join(", ");
    if (failed.length === 0) {
      toast({
        title: "Scheduled!",
        description: `Will post to ${names(succeeded)} on ${when.toLocaleString()}.`,
      });
      setScheduleOpen(false);
    } else {
      toast({
        title: succeeded.length > 0 ? `Scheduled for ${names(succeeded)}` : "Scheduling failed",
        description: `Could not schedule ${names(failed)}. Try again from the Library.`,
        variant: "destructive",
      });
    }
    if (succeeded.length > 0) onScheduled?.(succeeded);
  };

  const anyBusy = busy !== null || !!disabled;

  return (
    <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-4" data-testid="panel-quick-publish">
      <p className="text-sm font-medium">Publish this post</p>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {livePlatforms.map((platform) => {
          const blocked = platform === "instagram" && instagramBlocked;
          return (
            <label
              key={platform}
              className={`flex items-center gap-2 text-sm ${blocked ? "text-muted-foreground/60 cursor-not-allowed" : "cursor-pointer"}`}
            >
              <Checkbox
                checked={selected.includes(platform)}
                onCheckedChange={(v) => toggle(platform, v === true)}
                disabled={anyBusy || blocked}
                data-testid={`checkbox-quick-publish-${platform}`}
              />
              {QUICK_PUBLISH_LABELS[platform] ?? platform}
              {blocked && <span className="text-xs">(needs an image)</span>}
            </label>
          );
        })}
      </div>
      {instagramBlocked && selected.length === 0 && (
        <p className="flex items-start gap-1.5 text-xs text-destructive" data-testid="text-quick-publish-ig-blocked">
          <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          Instagram needs an image — generate or attach one first.
        </p>
      )}
      {checklistInfos.length > 0 && (
        <div className="space-y-1" data-testid="quick-publish-checklist">
          {checklistInfos.map((text) => (
            <p key={text} className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" /> {text}
            </p>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={anyBusy || selected.length === 0}
          onClick={() => postNow(selected)}
          data-testid="button-quick-publish-now"
        >
          {busy === "publish" ? <RippleSpinner className="mr-2 h-4 w-4" /> : <Send className="mr-2 h-4 w-4" />}
          Post now
        </Button>
        {publishablePlatforms.length > 1 && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={anyBusy}
            onClick={() => {
              setSelected(publishablePlatforms);
              postNow(publishablePlatforms);
            }}
            data-testid="button-quick-publish-all"
          >
            <Globe className="mr-2 h-4 w-4" />
            Publish to all connected
          </Button>
        )}
        {flags.scheduling && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={anyBusy}
            onClick={() => setScheduleOpen((v) => !v)}
            data-testid="button-quick-publish-schedule-toggle"
          >
            <CalendarClock className="mr-2 h-4 w-4" />
            Schedule
          </Button>
        )}
      </div>
      {scheduleOpen && flags.scheduling && (
        <div className="flex flex-wrap items-end gap-2 pt-1">
          <div className="space-y-1">
            <Label htmlFor="quick-publish-schedule-at" className="text-xs text-muted-foreground">
              When to post
            </Label>
            <Input
              id="quick-publish-schedule-at"
              type="datetime-local"
              value={scheduleAt}
              onChange={(e) => setScheduleAt(e.target.value)}
              disabled={anyBusy}
              className="w-auto"
              data-testid="input-quick-publish-schedule-at"
            />
          </div>
          <Button
            type="button"
            size="sm"
            disabled={anyBusy || selected.length === 0}
            onClick={scheduleSelected}
            data-testid="button-quick-publish-schedule-confirm"
          >
            {busy === "schedule" ? <RippleSpinner className="mr-2 h-4 w-4" /> : <CalendarClock className="mr-2 h-4 w-4" />}
            Confirm schedule
          </Button>
        </div>
      )}
    </div>
  );
}
