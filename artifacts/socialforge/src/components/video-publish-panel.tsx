import { useEffect, useState } from "react";
import {
  usePublishLibraryVideo,
  useUpdateContent,
  useCreateSchedule,
  useGetYoutubeStatus,
  useGetVideoPublishCapabilities,
  getListContentQueryKey,
  getListSchedulesQueryKey,
  getListVideoPublishesQueryKey,
  type VideoPublishMetadata,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { RippleSpinner } from "@/components/ui/ripple-spinner";
import { useToast } from "@/hooks/use-toast";
import { useFeatureFlags } from "@/lib/features";
import { apiErrorMessage } from "@/lib/apiErrorMessage";
import { defaultScheduleValue } from "@/components/studio-quick-publish";
import { useVideoPublishes, VideoPublishProgressList } from "@/components/video-publish-status";
import {
  VIDEO_DESTINATIONS,
  VIDEO_DESTINATION_LABELS,
  VIDEO_DESTINATION_SPECS,
  YOUTUBE_TITLE_MAX,
  YOUTUBE_DESCRIPTION_MAX,
  META_CAPTION_MAX,
  canSubmitVideoDestination,
  defaultVideoMetadata,
  normalizeForDestination,
  sameVideoMetadata,
  utf8Bytes,
  validateVideoMetadata,
  type VideoDestination,
} from "@/lib/videoPublish";
import { AlertCircle, CalendarClock, Info, Save, Send } from "lucide-react";


export interface VideoPublishItem {
  id: number;
  title: string;
  caption: string;
  platform?: string;
  videoPublishMetadata?: VideoPublishMetadata | null;
}

export function VideoPublishPanel({
  item,
  platformLive,
  onDone,
}: {
  item: VideoPublishItem;
  platformLive: Record<string, boolean>;
  onDone?: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { flags } = useFeatureFlags();
  const updateContent = useUpdateContent();
  const publishVideo = usePublishLibraryVideo();
  const createSchedule = useCreateSchedule();
  const { data: ytStatus } = useGetYoutubeStatus();
  const { data: capabilities, isLoading: capabilitiesLoading } = useGetVideoPublishCapabilities();
  const { data: publishes } = useVideoPublishes(item.id);

  const initialDestination = (): VideoDestination => {
    const saved = item.videoPublishMetadata?.destination;
    if (saved) return saved;
    return (VIDEO_DESTINATIONS as string[]).includes(item.platform ?? "") ? (item.platform as VideoDestination) : "instagram";
  };

  // The item's title/caption are authoritative; saved metadata only supplies
  // destination/format. Audience and privacy are never trusted from storage:
  // the user must choose them explicitly every time a review opens.
  const initialDraft = (): VideoPublishMetadata => {
    const meta = item.videoPublishMetadata;
    return meta ? { ...meta, title: item.title, description: item.caption ?? "" } : defaultVideoMetadata(initialDestination(), item.title, item.caption ?? "");
  };
  const [saved, setSaved] = useState<VideoPublishMetadata | null>(item.videoPublishMetadata ?? null);
  const [draft, setDraft] = useState<VideoPublishMetadata>(initialDraft);
  const [audienceChosen, setAudienceChosen] = useState(false);
  const [privacyChosen, setPrivacyChosen] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleAt, setScheduleAt] = useState(() => defaultScheduleValue());
  const [busy, setBusy] = useState<"save" | "publish" | "schedule" | null>(null);

  useEffect(() => {
    const meta = item.videoPublishMetadata ?? null;
    setSaved(meta);
    setDraft(initialDraft());
    setAudienceChosen(false);
    setPrivacyChosen(false);
    setReviewed(false);
    setScheduleOpen(false);
    // Re-init only when a different item is opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);

  const update = (patch: Partial<VideoPublishMetadata>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setReviewed(false);
  };

  const changeDestination = (destination: VideoDestination) => {
    setDraft((d) => {
      const base = defaultVideoMetadata(destination, d.title, d.description);
      return destination === "youtube" ? base : normalizeForDestination(base);
    });
    setAudienceChosen(false);
    setPrivacyChosen(false);
    setReviewed(false);
  };

  const dest = draft.destination;
  const ytConnected = !!ytStatus?.connected;
  const ytCanUpload = ytConnected && ytStatus?.canUpload !== false;
  const cap = capabilities?.[dest];
  const connected = dest === "youtube" ? ytConnected : !!platformLive[dest];
  // Fail closed: Meta destinations require a loaded capability that says available.
  const destinationReady =
    dest === "youtube" ? ytCanUpload && cap?.available !== false : connected && cap?.available === true;

  let readinessMessage: string | null = null;
  if (dest === "youtube") {
    if (!ytConnected) readinessMessage = "Connect a YouTube channel on the Accounts page first.";
    else if (!ytCanUpload)
      readinessMessage = `Your YouTube channel is connected but cannot upload yet. ${ytStatus?.uploadGuidance ?? "Reconnect and grant upload permission on the Accounts page."}`;
  } else if (!connected) {
    readinessMessage =
      dest === "instagram"
        ? "Connect and verify your Instagram account (and its Facebook Page) on the Accounts page first."
        : "Connect and verify your Facebook Page on the Accounts page first.";
  }
  if (!readinessMessage && dest !== "youtube" && !cap) {
    readinessMessage = capabilitiesLoading
      ? `Checking ${VIDEO_DESTINATION_LABELS[dest]} availability...`
      : `Could not confirm ${VIDEO_DESTINATION_LABELS[dest]} availability. Reload and try again.`;
  }
  if (!readinessMessage && cap && !cap.available) {
    readinessMessage = cap.guidance ?? `${VIDEO_DESTINATION_LABELS[dest]} publishing is not available for this workspace yet.`;
  }

  const errors = validateVideoMetadata(draft, { audienceChosen, privacyChosen });
  const submit = canSubmitVideoDestination(dest, publishes);
  const isSaved = sameVideoMetadata(saved, draft) && item.title === draft.title && (item.caption ?? "") === draft.description;
  const canAct = errors.length === 0 && destinationReady && submit.allowed && reviewed && busy === null;

  /** Persist the reviewed snapshot with the exact title/caption that will post. */
  const save = async (): Promise<boolean> => {
    if (errors.length > 0) return false;
    if (isSaved && item.title === draft.title.trim() && item.caption === draft.description) return true;
    const meta = { ...draft, title: draft.title.trim() };
    try {
      await updateContent.mutateAsync({
        id: item.id,
        data: { title: meta.title, caption: meta.description, videoPublishMetadata: meta },
      });
      setSaved(meta);
      setDraft(meta);
      queryClient.invalidateQueries({ queryKey: getListContentQueryKey() });
      return true;
    } catch (err) {
      toast({ title: "Could not save the review", description: apiErrorMessage(err, "Please try again."), variant: "destructive" });
      return false;
    }
  };

  const handleSave = async () => {
    setBusy("save");
    const ok = await save();
    setBusy(null);
    if (ok) toast({ title: "Review saved", description: `Saved for ${VIDEO_DESTINATION_LABELS[dest]}. Nothing was posted.` });
  };

  const handlePublish = async () => {
    setConfirmOpen(false);
    setBusy("publish");
    if (!(await save())) {
      setBusy(null);
      return;
    }
    try {
      const res = await publishVideo.mutateAsync({ id: item.id });
      queryClient.invalidateQueries({ queryKey: getListVideoPublishesQueryKey(item.id) });
      queryClient.invalidateQueries({ queryKey: getListContentQueryKey() });
      toast({
        title: "Video queued",
        description: `${VIDEO_DESTINATION_LABELS[dest]} upload is ${res?.state === "processing" ? "processing" : "queued"}. It is not live yet; the Library card shows progress and the link once published.`,
      });
      onDone?.();
    } catch (err) {
      toast({ title: "Could not queue the video", description: apiErrorMessage(err, "Please try again."), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  const handleSchedule = async () => {
    const when = new Date(scheduleAt);
    if (Number.isNaN(when.getTime()) || when.getTime() <= Date.now()) {
      toast({ title: "Pick a future time", variant: "destructive" });
      return;
    }
    setBusy("schedule");
    if (!(await save())) {
      setBusy(null);
      return;
    }
    try {
      await createSchedule.mutateAsync({ data: { contentItemId: item.id, platform: dest, scheduledAt: when.toISOString() } });
      queryClient.invalidateQueries({ queryKey: getListSchedulesQueryKey() });
      queryClient.invalidateQueries({ queryKey: getListContentQueryKey() });
      toast({ title: "Scheduled", description: `Will upload to ${VIDEO_DESTINATION_LABELS[dest]} on ${when.toLocaleString()} using this reviewed copy.` });
      onDone?.();
    } catch (err) {
      toast({ title: "Scheduling failed", description: apiErrorMessage(err, "Please try again."), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  const titleMax = dest === "youtube" ? YOUTUBE_TITLE_MAX : 200;
  const descLen = dest === "youtube" ? utf8Bytes(draft.description) : draft.description.length;
  const descMax = dest === "youtube" ? YOUTUBE_DESCRIPTION_MAX : META_CAPTION_MAX[dest];

  return (
    <div className="space-y-4 rounded-lg border border-border bg-muted/20 p-4" data-testid="panel-video-publish">
      <div className="space-y-1.5">
        <Label>Destination</Label>
        <Select value={dest} onValueChange={(v) => changeDestination(v as VideoDestination)} disabled={busy !== null}>
          <SelectTrigger data-testid="select-video-destination">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {VIDEO_DESTINATIONS.map((d) => (
              <SelectItem key={d} value={d}>
                {VIDEO_DESTINATION_LABELS[d]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">One destination per review. Videos cannot be sent to X, LinkedIn or Threads.</p>
      </div>

      <ul className="space-y-1" data-testid="video-destination-specs">
        {VIDEO_DESTINATION_SPECS[dest].map((s) => (
          <li key={s} className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" /> {s}
          </li>
        ))}
      </ul>

      {readinessMessage && (
        <p className="flex items-start gap-1.5 text-xs text-destructive" data-testid="text-video-readiness">
          <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" /> {readinessMessage}
        </p>
      )}

      <div className="space-y-1.5">
        <div className="flex justify-between">
          <Label htmlFor="video-publish-title">Title</Label>
          <span className={`text-xs ${draft.title.length > titleMax ? "text-destructive" : "text-muted-foreground"}`}>
            {draft.title.length}/{titleMax}
          </span>
        </div>
        <Input
          id="video-publish-title"
          value={draft.title}
          onChange={(e) => update({ title: e.target.value })}
          disabled={busy !== null}
          data-testid="input-video-title"
        />
      </div>
      <div className="space-y-1.5">
        <div className="flex justify-between">
          <Label htmlFor="video-publish-description">{dest === "youtube" ? "Description" : "Caption"}</Label>
          <span className={`text-xs ${descLen > descMax ? "text-destructive" : "text-muted-foreground"}`}>
            {descLen}/{descMax}{dest === "youtube" ? " bytes" : ""}
          </span>
        </div>
        <Textarea
          id="video-publish-description"
          rows={5}
          value={draft.description}
          onChange={(e) => update({ description: e.target.value })}
          disabled={busy !== null}
          data-testid="input-video-description"
        />
      </div>

      {dest === "youtube" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Audience</Label>
            <Select
              value={audienceChosen ? (draft.madeForKids ? "kids" : "notkids") : ""}
              onValueChange={(v) => {
                setAudienceChosen(true);
                update({ madeForKids: v === "kids" });
              }}
              disabled={busy !== null}
            >
              <SelectTrigger data-testid="select-video-audience">
                <SelectValue placeholder="Choose audience" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="notkids">Not made for kids</SelectItem>
                <SelectItem value="kids">Made for kids</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Privacy</Label>
            <Select
              value={privacyChosen ? draft.privacy : ""}
              onValueChange={(v) => {
                setPrivacyChosen(true);
                update({ privacy: v as VideoPublishMetadata["privacy"] });
              }}
              disabled={busy !== null}
            >
              <SelectTrigger data-testid="select-video-privacy">
                <SelectValue placeholder="Choose privacy" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="private">Private</SelectItem>
                <SelectItem value="unlisted">Unlisted</SelectItem>
                <SelectItem value="public">Public</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Posts as a public Reel.</p>
      )}

      {errors.length > 0 && (
        <ul className="space-y-1" data-testid="video-publish-errors">
          {errors.map((e) => (
            <li key={e} className="flex items-start gap-1.5 text-xs text-destructive">
              <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" /> {e}
            </li>
          ))}
        </ul>
      )}
      {!submit.allowed && submit.reason && (
        <p className="text-xs text-muted-foreground" data-testid="text-video-submit-blocked">{submit.reason}</p>
      )}

      <label className="flex items-start gap-2 text-sm cursor-pointer">
        <Checkbox
          checked={reviewed}
          onCheckedChange={(v) => setReviewed(v === true)}
          disabled={busy !== null || errors.length > 0}
          data-testid="checkbox-video-reviewed"
        />
        <span>I reviewed the video, title and {dest === "youtube" ? "description" : "caption"} for {VIDEO_DESTINATION_LABELS[dest]}.</span>
      </label>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy !== null || errors.length > 0 || isSaved}
          onClick={handleSave}
          data-testid="button-video-save"
        >
          {busy === "save" ? <RippleSpinner className="mr-2 h-4 w-4" /> : <Save className="mr-2 h-4 w-4" />}
          {isSaved ? "Saved" : "Save review"}
        </Button>
        <Button type="button" size="sm" disabled={!canAct} onClick={() => setConfirmOpen(true)} data-testid="button-video-publish">
          {busy === "publish" ? <RippleSpinner className="mr-2 h-4 w-4" /> : <Send className="mr-2 h-4 w-4" />}
          Publish
        </Button>
        {flags.scheduling && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!canAct}
            onClick={() => setScheduleOpen((v) => !v)}
            data-testid="button-video-schedule-toggle"
          >
            <CalendarClock className="mr-2 h-4 w-4" /> Schedule
          </Button>
        )}
      </div>

      {scheduleOpen && flags.scheduling && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="video-schedule-at" className="text-xs text-muted-foreground">When to upload</Label>
            <Input
              id="video-schedule-at"
              type="datetime-local"
              value={scheduleAt}
              onChange={(e) => setScheduleAt(e.target.value)}
              disabled={busy !== null}
              className="w-auto"
              data-testid="input-video-schedule-at"
            />
          </div>
          <Button type="button" size="sm" disabled={!canAct} onClick={handleSchedule} data-testid="button-video-schedule-confirm">
            {busy === "schedule" ? <RippleSpinner className="mr-2 h-4 w-4" /> : <CalendarClock className="mr-2 h-4 w-4" />}
            Confirm schedule
          </Button>
        </div>
      )}

      <VideoPublishProgressList itemId={item.id} publishes={publishes} />

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Upload to {VIDEO_DESTINATION_LABELS[dest]}?</AlertDialogTitle>
            <AlertDialogDescription>
              The saved title and {dest === "youtube" ? "description" : "caption"} and this exact video will be uploaded
              {dest === "youtube" ? ` as ${draft.privacy}, ${draft.madeForKids ? "made for kids" : "not made for kids"}, with AI-generated content disclosed` : " as a public Reel"}.
              Once queued, this destination cannot be changed or resubmitted for this item.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-video-confirm-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handlePublish} data-testid="button-video-confirm-publish">
              Upload
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
