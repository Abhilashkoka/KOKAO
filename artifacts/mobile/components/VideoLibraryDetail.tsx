import React, { useRef, useState } from "react";
import { Linking, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  type ContentItem, type VideoPublishMetadata,
  useGetVideoPublishCapabilities, useGetYoutubeStatus,
  useGetFacebookCredentials, useGetInstagramCredentials, useListVideoPublishes,
  getListVideoPublishesQueryKey, usePublishLibraryVideo, useUpdateContent,
  getGetContentQueryKey, getListContentQueryKey,
  useDeleteContent, useListSchedules,
} from "@workspace/api-client-react";
import { Button, Card, Chip, ErrorState, Input, Label } from "@/components/ui";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { ContentImage } from "@/components/ContentImage";
import { LibraryVideoPlayer } from "@/components/LibraryVideoPlayer";
import { destinations, destinationLabels, initialVideoMetadata, videoMetadataErrors, videoOutcome } from "@/lib/videoPublish";
import colors from "@/constants/colors";
import { fonts } from "@/constants/fonts";

const c = colors.light;

/** Videos never mount the legacy text/image publish controls. */
export function VideoLibraryDetail({ item }: { item: ContentItem }) {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const client = useQueryClient();
  const [draft, setDraft] = useState<VideoPublishMetadata>(() => initialVideoMetadata(item));
  const [privacyChosen, setPrivacyChosen] = useState(false);
  const [audienceChosen, setAudienceChosen] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const remove = useDeleteContent();
  const schedules = useListSchedules();
  const activeSchedules = schedules.data?.filter((s) => s.contentItemId === item.id && (s.status === "pending" || s.status === "processing")) ?? [];
  const capabilities = useGetVideoPublishCapabilities();
  const youtube = useGetYoutubeStatus();
  const facebook = useGetFacebookCredentials();
  const instagram = useGetInstagramCredentials();
  const publishes = useListVideoPublishes(item.id, {
    query: {
      queryKey: getListVideoPublishesQueryKey(item.id),
      // Also refresh empty results: another device may enqueue this item.
      refetchInterval: 4000,
    },
  });
  const update = useUpdateContent();
  const publish = usePublishLibraryVideo();
  const dest = draft.destination;
  const cap = capabilities.data?.[dest];
  const connected = dest === "youtube"
    ? youtube.data?.connected === true && youtube.data?.canUpload === true
    : (dest === "facebook" ? facebook.data : instagram.data)?.verifyStatus === "verified";
  const existing = publishes.data?.find((p) => p.platform === dest);
  const errors = videoMetadataErrors(draft, privacyChosen, audienceChosen);
  const ready = !!item.videoPath && connected && cap?.available === true && !capabilities.isError;
  const canPublish = ready && publishes.isSuccess && !publishes.isFetching && !existing && reviewed && errors.length === 0 && !busy && !remove.isPending;

  const change = (patch: Partial<VideoPublishMetadata>) => {
    if (lock.current) return;
    setDraft((old) => ({ ...old, ...patch }));
    setReviewed(false);
    setConfirm(false);
    setNotice("");
  };
  const invalidate = () => {
    void client.invalidateQueries({ queryKey: getListVideoPublishesQueryKey(item.id) });
    void client.invalidateQueries({ queryKey: getGetContentQueryKey(item.id) });
    void client.invalidateQueries({ queryKey: getListContentQueryKey() });
  };
  const saveOrPublish = async (enqueue: boolean) => {
    if (lock.current || remove.isPending || errors.length || (enqueue && !canPublish)) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    setConfirm(false);
    try {
      // Check current destination outcomes immediately before saving/enqueueing.
      if (enqueue) {
        const current = await publishes.refetch();
        if (current.isError || !current.data) throw new Error("Could not confirm publishing status. Refresh before trying again.");
        if (current.data.some((p) => p.platform === dest)) throw new Error("This destination already has an upload. Check its progress below; do not submit again.");
      }
      const metadata = { ...draft, title: draft.title.trim() };
      await update.mutateAsync({
        id: item.id,
        data: { title: metadata.title, caption: metadata.description, videoPublishMetadata: metadata },
      });
      setDraft(metadata);
      if (enqueue) {
        await publish.mutateAsync({ id: item.id });
        // Progress below is authoritative; a persistent "processing" notice
        // would become misleading after a later failure or publication.
        setNotice("Upload request accepted. See upload progress below for the current outcome.");
        setReviewed(false);
      } else {
        setNotice("Review saved. Nothing was posted.");
      }
    } catch (err) {
      const e = err as { data?: { error?: string }; message?: string };
      setError(e.data?.error || e.message || "Could not complete this action.");
      if (enqueue) setNotice("Check upload progress before trying again. A lost response does not mean the upload failed.");
    } finally {
      lock.current = false;
      setBusy(false);
      invalidate();
    }
  };

  return (
    <KeyboardAwareScrollViewCompat contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 48, gap: 12 }} style={{ backgroundColor: c.background }}>
      {item.videoPath ? <LibraryVideoPlayer path={item.videoPath} /> : (item.videoThumbnailPath || item.imagePath) ? <ContentImage imagePath={(item.videoThumbnailPath || item.imagePath)!} style={styles.cover} /> : null}
      <Text style={styles.heading}>Review video publishing</Text>
      <Text style={styles.text}>Publish the saved video, never just its cover or caption. AI videos may contain glitches; review your video before publishing.</Text>
      {!item.videoPath ? <Text style={styles.error}>The saved video is missing. Publishing is blocked; no image or text fallback will be used.</Text> : null}
      <Label>Destination</Label>
      <View style={styles.row}>
        {destinations.map((destination) => <Chip key={destination} label={destinationLabels[destination]} selected={dest === destination} onPress={() => {
          if (lock.current) return;
          change({ destination, format: destination === "youtube" ? "video" : "reel", privacy: destination === "youtube" ? "private" : "public", madeForKids: false });
          setPrivacyChosen(false); setAudienceChosen(false);
        }} />)}
      </View>
      <Text style={styles.text}>{dest === "youtube"
        ? "Video upload. Title: 100 characters; description: 5,000 UTF-8 bytes. AI-generated content is disclosed to YouTube. Shorts eligibility is decided by YouTube. Google may restrict uploads to Private until its API audit is complete."
        : dest === "facebook"
          ? "Public Reel only. Vertical 9:16, at least 540×960; 3–90 seconds, 24–60 fps."
          : "Public Reel only. 3–900 seconds, up to 300 MB; H.264 or HEVC with AAC audio, 23–60 fps."}</Text>
      <Label>Title</Label>
      <Input accessibilityLabel="Video title" value={draft.title} editable={!busy} onChangeText={(title) => change({ title })} />
      <Label>{dest === "youtube" ? "Description" : "Caption"}</Label>
      <Input accessibilityLabel="Video description" value={draft.description} editable={!busy} onChangeText={(description) => change({ description })} multiline style={{ minHeight: 140 }} />
      {dest === "youtube" ? <>
        <Label>Privacy — choose explicitly</Label>
        <View style={styles.row}>{(["public", "unlisted", "private"] as const).map((privacy) =>
          <Chip key={privacy} label={privacy} selected={privacyChosen && draft.privacy === privacy} onPress={() => { if (!lock.current) { change({ privacy }); setPrivacyChosen(true); } }} />)}</View>
        <Label>Audience — choose explicitly</Label>
        <View style={styles.row}>{[true, false].map((madeForKids) =>
          <Chip key={String(madeForKids)} label={madeForKids ? "Made for kids" : "Not made for kids"} selected={audienceChosen && draft.madeForKids === madeForKids} onPress={() => { if (!lock.current) { change({ madeForKids }); setAudienceChosen(true); } }} />)}</View>
      </> : null}
      {errors.map((message) => <Text key={message} style={styles.error}>{message}</Text>)}
      {!connected ? <Text style={styles.error}>Connect or reconnect {destinationLabels[dest]} in Accounts on KOKAO on the web, grant upload permission, then return here. {dest === "youtube" ? youtube.data?.uploadGuidance : ""}</Text> : null}
      {cap?.available !== true ? <Text style={styles.text}>{cap?.guidance || "Video publishing availability has not been confirmed. Refresh to try again."}</Text> : null}
      <Button title="Refresh connection and status" variant="outline" disabled={busy} onPress={() => {
        void capabilities.refetch(); void youtube.refetch(); void facebook.refetch(); void instagram.refetch(); void publishes.refetch();
      }} />
      <Chip label={reviewed ? "Reviewed for this destination" : "I reviewed this video, copy and settings"} selected={reviewed} onPress={() => { if (!lock.current) { setReviewed(!reviewed); setConfirm(false); } }} />
      <Button title="Save review" variant="secondary" disabled={busy || remove.isPending || errors.length > 0} onPress={() => void saveOrPublish(false)} />
      <Button title={`Publish to ${destinationLabels[dest]}`} disabled={!canPublish} onPress={() => setConfirm(true)} />
      {confirm ? <Card>
        <Text style={styles.text}>Publish this video to {destinationLabels[dest]} now? {draft.privacy} · {dest === "youtube" ? (draft.madeForKids ? "Made for kids" : "Not made for kids") : "Reel"}. This can create a real post.</Text>
        <Button title="Confirm video publish" disabled={!canPublish} onPress={() => void saveOrPublish(true)} />
        <Button title="Cancel" variant="secondary" onPress={() => setConfirm(false)} />
      </Card> : null}
      {notice ? <Text accessibilityLiveRegion="polite" style={styles.text}>{notice}</Text> : null}
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      <Label>Upload progress</Label>
      {activeSchedules.map((s) => <Text key={s.id} style={styles.text}>Scheduled for {new Date(s.scheduledAt).toLocaleString()} on {s.platform}. This uses the saved review from scheduling, not subsequent edits. Manage this schedule in KOKAO on the web.</Text>)}
      {publishes.isError ? <ErrorState message="Could not load upload progress. Publishing is blocked until status is confirmed." onRetry={() => void publishes.refetch()} /> : null}
      {publishes.isLoading ? <Text style={styles.text}>Checking existing uploads…</Text> : null}
      {publishes.data?.map((row) => <Card key={row.platform}>
        <Text style={styles.heading}>{destinationLabels[row.platform as typeof dest] ?? row.platform}</Text>
        <Text style={styles.text}>{videoOutcome(row)}</Text>
        {row.error ? <Text style={styles.error}>{row.error}</Text> : null}
        {row.state === "published" && row.permalink && /^https?:\/\//i.test(row.permalink) ? <Button title="View published video" variant="outline" onPress={() => void Linking.openURL(row.permalink!)} /> : null}
      </Card>)}
      {publishes.isSuccess && publishes.data.length === 0 ? <Text style={styles.text}>No uploads yet.</Text> : null}
      <Button title={confirmDelete ? "Delete forever" : "Delete"} variant="outline" disabled={busy || remove.isPending} onPress={() => {
        if (!confirmDelete) { setConfirmDelete(true); return; }
        remove.mutate({ id: item.id }, {
          onSuccess: () => { invalidate(); router.back(); },
          onError: (err) => {
            setError((err as { data?: { error?: string } }).data?.error || err.message || "Could not delete this item.");
            setConfirmDelete(false);
          },
        });
      }} />
      {confirmDelete ? <Button title="Keep video" variant="secondary" disabled={remove.isPending} onPress={() => setConfirmDelete(false)} /> : null}
    </KeyboardAwareScrollViewCompat>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  cover: { width: "100%", aspectRatio: 16 / 9, borderRadius: colors.radius },
  heading: { fontFamily: fonts.semiBold, fontSize: 17, color: c.foreground },
  text: { fontFamily: fonts.regular, fontSize: 13, lineHeight: 19, color: c.mutedForeground },
  error: { fontFamily: fonts.regular, fontSize: 13, lineHeight: 19, color: c.destructive },
});