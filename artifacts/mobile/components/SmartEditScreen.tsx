import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  getCredits, getGetCreditsQueryKey, getGetMeQueryKey, getWalletGetOverviewQueryKey,
  getGetSmartEditQueryKey, getGetVideoJobQueryKey, getListVideoJobsQueryKey,
  useGetVideoJob, useGetSmartEdit, useCreateSmartEdit, useQuoteSmartEdit,
  useApproveSmartEdit, useDiscardSmartEdit, useRestoreSmartEditVersion,
  type SmartEditState, type SmartEditAttemptView, type SmartEditInput, type SmartEditBox,
  type SmartEditType, type SmartEditCreateInput,
} from "@workspace/api-client-react";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { SmartEditPlayer } from "@/components/SmartEditPlayer";
import { Button } from "@/components/ui";
import colors from "@/constants/colors";
import { fonts } from "@/constants/fonts";
import { apiErrorMessage } from "@/lib/apiErrorMessage";
import { clampEditRange, editCanSubmit, secondsLabel } from "@/lib/smartEdit";

const c = colors.light;
const types: [SmartEditType, string][] = [
  ["change", "Change"], ["remove", "Remove"], ["outfit", "Outfit"],
  ["dialogue", "New line"], ["regenerate", "Re-shoot"],
];
const voices = ["brand", "alloy", "echo", "fable", "onyx", "nova", "shimmer"] as const;
type Voice = typeof voices[number];

export function SmartEditScreen({ jobId }: { jobId: number }) {
  const client = useQueryClient();
  const insets = useSafeAreaInsets();
  const validId = Number.isInteger(jobId) && jobId > 0;
  const job = useGetVideoJob(jobId, { query: { queryKey: getGetVideoJobQueryKey(jobId), enabled: validId } });
  const state = useGetSmartEdit(jobId, {
    query: {
      queryKey: getGetSmartEditQueryKey(jobId), enabled: validId,
      refetchOnMount: "always",
      refetchInterval: (query) => query.state.data?.edits.some((edit) => edit.status === "generating") ? 4000 : 15000,
    },
  });
  const approve = useApproveSmartEdit();
  const discard = useDiscardSmartEdit();
  const restore = useRestoreSmartEditVersion();
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState<SmartEditAttemptView | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [confirm, setConfirm] = useState<{ kind: "approve" | "discard" | "restore"; id: string } | null>(null);
  const busy = approve.isPending || discard.isPending || restore.isPending;
  const refreshCredits = useCallback(() => {
    const key = getGetCreditsQueryKey();
    // An old in-flight balance read must not overwrite the post-mutation balance.
    void client.cancelQueries({ queryKey: key }).then(() => client.fetchQuery({
      queryKey: key, queryFn: ({ signal }) => getCredits({ signal, cache: "no-store" }), staleTime: 0,
    })).catch(() => { void client.invalidateQueries({ queryKey: key }); });
    void client.invalidateQueries({ queryKey: getWalletGetOverviewQueryKey() });
    void client.invalidateQueries({ queryKey: getGetMeQueryKey() });
  }, [client]);
  const refresh = useCallback((next?: SmartEditState) => {
    if (next) client.setQueryData(getGetSmartEditQueryKey(jobId), next);
    else void client.invalidateQueries({ queryKey: getGetSmartEditQueryKey(jobId) });
    void client.invalidateQueries({ queryKey: getGetVideoJobQueryKey(jobId) });
    void client.invalidateQueries({ queryKey: getListVideoJobsQueryKey() });
    refreshCredits();
  }, [client, jobId, refreshCredits]);
  const editStatuses = state.data?.edits.map((edit) => `${edit.id}:${edit.status}`).join("|");
  const lastStatuses = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (lastStatuses.current !== undefined && editStatuses !== lastStatuses.current) refreshCredits();
    lastStatuses.current = editStatuses;
  }, [editStatuses, refreshCredits]);
  const act = () => {
    if (!confirm || busy) return;
    setError(null);
    const handlers = {
      onSuccess: (next: SmartEditState) => { refresh(next); setConfirm(null); setRetry(null); },
      onError: (cause: unknown) => {
        setError(apiErrorMessage(cause, `Could not ${confirm.kind} this edit. Please try again.`));
        refresh();
        setConfirm(null);
      },
    };
    if (confirm.kind === "restore") restore.mutate({ jobId, versionId: confirm.id }, handlers);
    else (confirm.kind === "approve" ? approve : discard).mutate({ jobId, editId: confirm.id }, handlers);
  };
  if (!validId) return <Text style={styles.error}>Invalid video number.</Text>;
  if (state.isPending || job.isPending) return <ActivityIndicator style={{ margin: 24 }} color={c.primary} />;
  if (state.isError || job.isError || !state.data || !job.data) return (
    <View style={styles.content}>
      <Text style={styles.error}>{apiErrorMessage(state.error ?? job.error, "Could not load this video.")}</Text>
      <Button title="Reload" onPress={() => { void state.refetch(); void job.refetch(); }} />
    </View>
  );
  const data = state.data;
  if (job.data.status !== "succeeded" || !data.currentVideoPath) return <Text style={styles.error}>Smart Edit is available once this video has finished.</Text>;
  const pending = data.edits.filter((edit) => edit.status === "ready" || edit.status === "generating").length;
  return (
    <KeyboardAwareScrollViewCompat bottomOffset={24} contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]} keyboardDismissMode="on-drag">
      <Text style={styles.title}>Repair a selected moment</Text>
      <Text style={styles.hint}>Only the selected cut is regenerated. Nothing changes until you approve. Your original stays in Versions.</Text>
      {job.data.compliance && <Text style={styles.hint}>The original video’s medical / CA compliance rules remain in force for every edit.</Text>}
      <EditForm
        key={`${data.currentVersionId}:${retryNonce}`}
        jobId={jobId} data={data} aspectRatio={job.data.aspectRatio}
        preset={retry} blocked={busy || pending >= 3} refresh={refresh}
      />
      {pending >= 3 && <Text style={styles.hint}>Approve or discard an open edit before starting another.</Text>}
      {error && <Text style={styles.error} accessibilityRole="alert">{error} (Video #{jobId})</Text>}
      {confirm && <View style={styles.card} testID="smart-edit-confirm">
        <Text style={styles.body}>{confirm.kind === "approve"
          ? "Apply this cut to the full video? The original and previous versions are kept."
          : confirm.kind === "restore"
            ? "Make this saved version current? The original stays available. Pending edits from another version cannot be approved."
            : "Discard this attempt? The current video stays unchanged. Credits already spent on generation are not refunded."}</Text>
        <Button title={busy ? "Working…" : `Confirm ${confirm.kind}`} loading={busy} onPress={act} />
        <Button title="Cancel" variant="outline" disabled={busy} onPress={() => setConfirm(null)} />
      </View>}
      <Text style={styles.heading}>Edits to review</Text>
      {data.edits.filter((edit) => edit.status !== "approved" && edit.status !== "discarded").map((edit) => {
        const stale = edit.baseVersionId !== data.currentVersionId;
        return <View key={edit.id} style={styles.card} testID={`smart-edit-attempt-${edit.id}`}>
          <Text style={styles.heading}>{types.find(([id]) => id === edit.type)?.[1]} · {secondsLabel(edit.startSec)}–{secondsLabel(edit.endSec)}</Text>
          <Text style={styles.body}>{edit.status === "generating" ? edit.stage ?? "Generating…" : edit.status === "ready" ? "Ready to review" : "Failed"}</Text>
          <Text style={styles.hint}>{edit.dialogueText ?? edit.instruction}</Text>
          {edit.status === "generating" && <><ActivityIndicator color={c.primary} /><Text style={styles.hint}>Only this cut is being regenerated. You can leave and return to review it.</Text></>}
          {edit.error && <Text style={styles.error} accessibilityRole="alert">{edit.error}</Text>}
          {edit.status === "ready" && edit.clipPath && <>
            <Text style={styles.heading}>Before</Text>
            <SmartEditPlayer path={edit.cutPath} aspectRatio={job.data.aspectRatio} />
            <Text style={styles.heading}>After</Text>
            <SmartEditPlayer path={edit.clipPath} aspectRatio={job.data.aspectRatio} />
          </>}
          {stale && <Text style={styles.hint}>The video has changed since this cut was made. Try again on the current version.</Text>}
          {edit.status === "ready" && !stale && <Button title="Approve & stitch" icon="check" disabled={busy} onPress={() => setConfirm({ kind: "approve", id: edit.id })} />}
          {(edit.status === "ready" || edit.status === "failed") && <Button title="Try again" icon="rotate-ccw" variant="outline" disabled={busy}
            onPress={() => { setRetry(edit); setRetryNonce((n) => n + 1); setError(null); setConfirm(null); }}
          />}
          <Button title="Discard" variant="outline" icon="trash-2" disabled={busy} onPress={() => setConfirm({ kind: "discard", id: edit.id })} />
        </View>;
      })}
      {!data.edits.some((edit) => ["generating", "ready", "failed"].includes(edit.status)) && <Text style={styles.hint}>No edits waiting for review.</Text>}
      <Text style={styles.heading}>Versions</Text>
      {data.versions.slice().reverse().map((version) => <View style={styles.card} key={version.id}>
        <Text style={styles.body}>{version.label}{version.id === data.currentVersionId ? " · Current" : ""}</Text>
        {version.id !== data.currentVersionId && <Button title="Restore" icon="corner-up-left" variant="outline" disabled={busy}
          onPress={() => setConfirm({ kind: "restore", id: version.id })} />}
      </View>)}
    </KeyboardAwareScrollViewCompat>
  );
}

function EditForm({ jobId, data, aspectRatio, preset, blocked, refresh }: {
  jobId: number; data: SmartEditState; aspectRatio?: string | null;
  preset: SmartEditAttemptView | null; blocked: boolean; refresh: (next?: SmartEditState) => void;
}) {
  const create = useCreateSmartEdit();
  const quote = useQuoteSmartEdit();
  const quoteRef = useRef(quote.mutateAsync);
  quoteRef.current = quote.mutateAsync;
  const [duration, setDuration] = useState(0);
  const [playhead, setPlayhead] = useState(0);
  const [range, setRange] = useState<[number, number]>(preset ? [preset.startSec, preset.endSec] : [0, 3]);
  const [box, setBox] = useState<SmartEditBox | null>(preset?.box ?? null);
  const [drawing, setDrawing] = useState(false);
  const [type, setType] = useState<SmartEditType>(preset?.type ?? "change");
  const [instruction, setInstruction] = useState(preset?.instruction ?? "");
  const [dialogueText, setDialogueText] = useState(preset?.dialogueText ?? "");
  const [voice, setVoice] = useState<Voice>("brand");
  const [consent, setConsent] = useState(false);
  const [seek, setSeek] = useState<{ at: number; nonce: number }>();
  const [error, setError] = useState<string | null>(null);
  const [price, setPrice] = useState<{ key: string; credits?: number; error?: string } | null>(null);
  const request: SmartEditInput = { type, startSec: range[0], endSec: range[1], box,
    instruction, dialogueText: type === "dialogue" ? dialogueText : null };
  // Price follows the entire request. Obsolete responses never display or enable submission.
  const quoteRequest = { ...request, instruction: instruction || "x x x",
    dialogueText: type === "dialogue" ? dialogueText || "xx" : null };
  const quoteKey = JSON.stringify(quoteRequest);
  useEffect(() => {
    if (!duration || (type === "remove" && !box)) return;
    let live = true;
    const timer = setTimeout(() => {
      void quoteRef.current({ jobId, data: JSON.parse(quoteKey) as SmartEditInput }).then(
        (result) => { if (live) setPrice({ key: quoteKey, credits: result.credits }); },
        (cause) => { if (live) setPrice({ key: quoteKey, error: apiErrorMessage(cause, "Price unavailable. Adjust the selection to retry.") }); },
      );
    }, 400);
    return () => { live = false; clearTimeout(timer); };
  }, [quoteKey, jobId, duration, type, box]);
  const move = (moved: "start" | "end", value: number) => {
    const next = clampEditRange(moved === "start" ? value : range[0], moved === "end" ? value : range[1],
      duration, moved, data.limits.minSeconds, data.limits.maxSeconds);
    setRange(next);
    setSeek({ at: moved === "start" ? next[0] : next[1], nonce: Date.now() });
  };
  const credits = price?.key === quoteKey ? price.credits : undefined;
  const ready = !blocked && !drawing && !create.isPending && credits !== undefined && editCanSubmit(request, duration, consent);
  const submit = () => {
    if (!ready) return;
    setError(null);
    const payload: SmartEditCreateInput = {
      ...request, baseVersionId: data.currentVersionId,
      ...(type === "dialogue" ? { consent, ...(voice !== "brand" ? { voice } : {}) } : {}),
    };
    create.mutate({ jobId, data: payload }, {
      onSuccess: (next) => { refresh(next); setInstruction(""); setDialogueText(""); setConsent(false); },
      onError: (cause) => { setError(apiErrorMessage(cause, "Could not start this edit.")); refresh(); },
    });
  };
  return <View style={styles.card}>
    {preset && <Text style={styles.hint}>Retry loaded below. Review the range, voice, permission and quote before generating a new paid attempt.</Text>}
    <SmartEditPlayer path={data.currentVideoPath!} aspectRatio={aspectRatio} box={box} drawing={drawing} onBox={setBox}
      onTime={setPlayhead} seek={seek} onLoad={(total) => {
        setDuration(total);
        setRange(clampEditRange(preset?.startSec ?? 0, preset?.endSec ?? Math.min(3, total),
          total, "end", data.limits.minSeconds, data.limits.maxSeconds));
      }} />
    <Button title={drawing ? "Done marking" : box ? "Redraw area" : "Mark area"} icon="square" variant="outline"
      onPress={() => { setSeek({ at: playhead, nonce: Date.now() }); setDrawing(!drawing); }} />
    {drawing && <Text style={styles.hint}>Drag across the paused video to draw a rectangle. Scroll outside the video.</Text>}
    {box && <Button title="Clear area" variant="outline" onPress={() => { setBox(null); setDrawing(false); }} />}
    <Text style={styles.heading}>Select {data.limits.minSeconds}–{data.limits.maxSeconds} seconds</Text>
    <Text style={styles.body}>{secondsLabel(range[0])}–{secondsLabel(range[1])} · {(range[1] - range[0]).toFixed(1)}s</Text>
    {(["start", "end"] as const).map((which, index) => <View key={which} style={{ gap: 8 }}>
      <Text style={styles.body}>{which === "start" ? "Start" : "End"} · {secondsLabel(range[index])}</Text>
      <TimeTrack value={range[index]} duration={duration} label={`Edit ${which}`} onChange={(value) => move(which, value)} />
      <View style={styles.row}>
        <Button title="−0.1s" variant="outline" disabled={!duration} onPress={() => move(which, range[index] - 0.1)} style={{ flex: 1 }} />
        <Button title="+0.1s" variant="outline" disabled={!duration} onPress={() => move(which, range[index] + 0.1)} style={{ flex: 1 }} />
      </View>
      <Button title={`${which === "start" ? "Start" : "End"} here (${secondsLabel(playhead)})`} variant="outline" disabled={!duration} onPress={() => move(which, playhead)} />
    </View>)}
    {duration > 0 && duration < 1 && <Text style={styles.error}>This video is shorter than the minimum 1-second edit.</Text>}
    <Text style={styles.hint}>{box ? "Only the marked area changes." : "Without a marked area the whole frame can change."}</Text>
    <View style={styles.row}>
      {types.map(([id, label]) => <Pressable key={id} accessibilityRole="button" accessibilityState={{ selected: type === id }}
        testID={`smart-edit-type-${id}`} onPress={() => setType(id)}
        style={[styles.choice, type === id && { borderColor: c.primary, backgroundColor: c.accent }]}>
        <Text style={styles.body}>{label}</Text>
      </Pressable>)}
    </View>
    {type === "dialogue" ? <>
      <Text style={styles.heading}>New line</Text>
      <TextInput testID="smart-edit-dialogue" accessibilityLabel="New dialogue" multiline maxLength={600}
        value={dialogueText} onChangeText={setDialogueText} style={styles.input} placeholder="What should they say instead?" placeholderTextColor={c.mutedForeground} />
      <Text style={styles.heading}>Voice</Text>
      <View style={styles.row}>
        {voices.map((v) => <Pressable key={v} accessibilityRole="button" accessibilityState={{ selected: voice === v }}
          onPress={() => setVoice(v)} style={[styles.choice, voice === v && { borderColor: c.primary, backgroundColor: c.accent }]}>
          <Text style={styles.body}>{v === "brand" ? "Brand Kit voice" : v}</Text>
        </Pressable>)}
      </View>
      <View style={styles.row}>
        <Switch testID="smart-edit-consent" accessibilityLabel="I have permission to make this person say the new line" value={consent} onValueChange={setConsent} />
        <Text style={[styles.hint, { flex: 1 }]}>I have permission to make the person in this video say the new line.</Text>
      </View>
    </> : <>
      <Text style={styles.heading}>{type === "remove" ? "Anything to add? (optional)" : type === "regenerate" ? "Direction (optional)" : "Describe the change"}</Text>
      <TextInput testID="smart-edit-instruction" accessibilityLabel="Edit description" multiline maxLength={600}
        value={instruction} onChangeText={setInstruction} style={styles.input}
        placeholder={type === "outfit" ? "e.g. a white lab coat over a blue shirt" : "Describe how this moment should change"} placeholderTextColor={c.mutedForeground} />
    </>}
    {type === "remove" && !box && <Text style={styles.hint}>Mark the area to remove on the video.</Text>}
    <Text style={styles.hint} testID="smart-edit-quote">{credits === undefined
      ? price?.key === quoteKey && price.error ? price.error : "Select a valid cut to see a live credit quote."
      : `≈ ${credits.toLocaleString("en-IN", { maximumFractionDigits: 1 })} credits`}</Text>
    {error && <Text style={styles.error} accessibilityRole="alert">{error} (Video #{jobId})</Text>}
    <Button title="Generate edit" icon="scissors" testID="smart-edit-generate" loading={create.isPending} disabled={!ready} onPress={submit} />
  </View>;
}

function TimeTrack({ value, duration, label, onChange }: {
  value: number; duration: number; label: string; onChange: (value: number) => void;
}) {
  const width = useRef(1);
  return <View accessibilityRole="adjustable" accessibilityLabel={label}
    accessibilityValue={{ min: 0, max: duration, now: value }}
    accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
    onAccessibilityAction={(event) => onChange(value + (event.nativeEvent.actionName === "increment" ? 0.1 : -0.1))}
    onLayout={(event) => { width.current = event.nativeEvent.layout.width; }}
    onStartShouldSetResponder={() => duration > 0}
    onMoveShouldSetResponder={() => duration > 0}
    onResponderGrant={(event) => onChange((event.nativeEvent.locationX / width.current) * duration)}
    onResponderMove={(event) => onChange((event.nativeEvent.locationX / width.current) * duration)}
    onResponderTerminationRequest={() => false}
    style={{ height: 44, justifyContent: "center" }}>
    <View pointerEvents="none" style={{ height: 8, backgroundColor: c.muted, borderRadius: 4 }}>
      <View style={{ width: `${duration ? value / duration * 100 : 0}%`, height: 8, backgroundColor: c.primary, borderRadius: 4 }} />
    </View>
  </View>;
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 48, gap: 16, backgroundColor: c.background },
  title: { fontSize: 24, fontFamily: fonts.bold, color: c.foreground },
  heading: { fontSize: 16, fontFamily: fonts.semiBold, color: c.foreground },
  body: { fontSize: 14, fontFamily: fonts.medium, color: c.foreground, lineHeight: 20 },
  hint: { fontSize: 13, fontFamily: fonts.regular, color: c.mutedForeground, lineHeight: 19 },
  error: { fontSize: 14, color: c.destructive, lineHeight: 20 },
  card: { padding: 12, gap: 12, backgroundColor: c.card, borderRadius: colors.radius, borderWidth: 1, borderColor: c.border },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" },
  choice: { paddingHorizontal: 12, paddingVertical: 12, minHeight: 44, borderWidth: 1, borderColor: c.border, borderRadius: colors.radius },
  input: { minHeight: 100, borderWidth: 1, borderColor: c.input, borderRadius: colors.radius, padding: 12, color: c.foreground, fontSize: 16, textAlignVertical: "top" },
});
