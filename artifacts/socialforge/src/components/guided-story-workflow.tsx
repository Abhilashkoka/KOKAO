import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetGuidedStoryDraftQueryKey,
  useApproveGuidedStoryDraftScript,
  useCastGuidedStoryDraft,
  useCreateGuidedStoryDraft,
  useEnqueueGuidedStoryDraft,
  useGenerateGuidedStoryDraftScript,
  useGetGuidedStoryDraft,
  useListGuidedStoryPlatforms,
  useUpdateGuidedStoryDraft,
  type BrandKit,
  type Character,
  type GuidedStoryDraft,
  type GuidedStoryPlatformContract,
  type GuidedStoryScript,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

const GENRES = [
  ["action_adventure", "Action / Adventure", "High stakes, motion, and a daring goal."],
  ["comedy", "Comedy", "A character-led setup with a satisfying turn."],
  ["drama", "Drama", "Human choices, emotional stakes, and consequence."],
  ["romance", "Romance", "Connection, vulnerability, and a hopeful beat."],
  ["thriller_mystery", "Thriller / Mystery", "Clues, tension, and a reveal."],
  ["fantasy", "Fantasy", "An original world with wonder and rules."],
  ["science_fiction", "Science Fiction", "A future-facing idea grounded in people."],
] as const;

type Assignment = { characterId: number | null; outfitId: number | null; voiceId: string };

function voiceOptions(kit: BrandKit | undefined) {
  const voice = kit?.activeVersion?.payload?.brand_voice;
  const choices = voice?.voices ?? [];
  if (choices.length) return choices.map((item) => ({ id: item.id, label: item.label }));
  if (voice?.mode === "cloned" && voice.provider_voice_id) {
    return [{ id: "active", label: voice.cloned_label || "Active Brand Voice" }];
  }
  if (voice?.preset_voice) return [{ id: `preset:${voice.preset_voice}`, label: voice.preset_voice }];
  return [];
}

function draftStep(draft: GuidedStoryDraft | undefined) {
  if (!draft?.script) return "script";
  if (!draft.scriptApprovedAt) return "review";
  if (draft.cast.length !== draft.script.roles.length) return "cast";
  return "ready";
}

export function GuidedStoryWorkflow({
  tenantId,
  characters,
  brandKits,
  onManageCharacters,
  onJobReady,
}: {
  tenantId?: number;
  characters: Character[];
  brandKits: BrandKit[];
  onManageCharacters: () => void;
  onJobReady: (jobId: number) => void;
}) {
  const storageKey = tenantId ? `kokao-guided-story-draft-v1:${tenantId}` : null;
  const [draftId, setDraftId] = useState<number | null>(null);
  const [genre, setGenre] = useState<(typeof GENRES)[number][0]>("action_adventure");
  const [platformId, setPlatformId] = useState<string>("");
  const [duration, setDuration] = useState<number | null>(null);
  const [roleCount, setRoleCount] = useState<number | null>(null);
  const [locale, setLocale] = useState("en");
  const [topic, setTopic] = useState("");
  const [brandKitId, setBrandKitId] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [userRoleId, setUserRoleId] = useState<string | null>(null);
  const [strategy, setStrategy] = useState<"generated" | "saved">("generated");
  const [assignments, setAssignments] = useState<Record<string, Assignment>>({});
  const [consent, setConsent] = useState(false);
  const [duplicateConfirmed, setDuplicateConfirmed] = useState(false);
  const [mutationLocked, setMutationLocked] = useState(false);
  const mutationLockRef = useRef(false);
  const queryClient = useQueryClient();
  const platforms = useListGuidedStoryPlatforms();
  const draftQuery = useGetGuidedStoryDraft(draftId ?? 0, {
    query: { enabled: draftId !== null, queryKey: getGetGuidedStoryDraftQueryKey(draftId ?? 0) },
  });
  const createDraft = useCreateGuidedStoryDraft();
  const generateScript = useGenerateGuidedStoryDraftScript();
  const approveScript = useApproveGuidedStoryDraftScript();
  const updateDraft = useUpdateGuidedStoryDraft();
  const castDraft = useCastGuidedStoryDraft();
  const enqueueDraft = useEnqueueGuidedStoryDraft();
  const draft = draftQuery.data;
  const contract = (platforms.data ?? []).find((item) => item.id === platformId) as GuidedStoryPlatformContract | undefined;
  const rolePlan = duration != null ? contract?.rolePlans[String(duration)] : undefined;
  const selectedKit = brandKits.find((kit) => kit.id === brandKitId);
  const voices = voiceOptions(selectedKit);

  useEffect(() => {
    setDraftId(null);
    if (!storageKey) return;
    const stored = Number(localStorage.getItem(storageKey));
    if (Number.isInteger(stored) && stored > 0) setDraftId(stored);
  }, [storageKey]);
  useEffect(() => {
    if (!contract) return;
    if (!contract.durations.includes(duration ?? -1)) setDuration(contract.durations[0] ?? null);
  }, [contract, duration]);
  useEffect(() => {
    if (!rolePlan) return;
    if (!rolePlan.allowed.includes(roleCount ?? -1)) setRoleCount(rolePlan.recommended);
  }, [roleCount, rolePlan]);
  useEffect(() => {
    if (!draft?.setup) return;
    setGenre(draft.setup.genre); setPlatformId(draft.setup.platform); setDuration(draft.setup.durationSeconds);
    setRoleCount(draft.setup.roleCount); setLocale(draft.setup.locale); setTopic(draft.setup.topic);
    setBrandKitId(draft.setup.brandKitId ?? null);
  }, [draft?.id, draft?.revision]);
  useEffect(() => {
    if (!draft?.script) return;
    setUserRoleId(draft.userRoleId);
    setStrategy(draft.castStrategy ?? "generated");
  }, [draft?.id, draft?.revision, draft?.script]);

  const setAuthoritativeDraft = useCallback((next: GuidedStoryDraft) => {
    queryClient.setQueryData(getGetGuidedStoryDraftQueryKey(next.id), next);
    setDraftId(next.id);
    setEditing(false);
    setConsent(false); // identity consent is per request, never persisted by this component
    if (storageKey) localStorage.setItem(storageKey, String(next.id));
  }, [queryClient, storageKey]);
  const acquireMutation = () => {
    if (mutationLockRef.current) return false;
    mutationLockRef.current = true;
    setMutationLocked(true);
    return true;
  };
  const releaseMutation = () => {
    mutationLockRef.current = false;
    setMutationLocked(false);
  };
  const setupComplete = !!contract && duration !== null && roleCount !== null && topic.trim().length >= 3 && !!brandKitId;
  const begin = () => {
    if (!setupComplete || duration === null || roleCount === null || !acquireMutation()) return;
    const setup = { genre, platform: platformId as never, durationSeconds: duration, locale, topic: topic.trim(), roleCount, brandKitId };
    if (draft) {
      updateDraft.mutate(
        { draftId: draft.id, data: { revision: draft.revision, setup } },
        { onSuccess: setAuthoritativeDraft, onSettled: releaseMutation },
      );
      return;
    }
    createDraft.mutate({ data: setup }, {
      onSuccess: setAuthoritativeDraft,
      onSettled: releaseMutation,
    });
  };
  const saveScript = (script: GuidedStoryScript) => {
    if (!draft || !acquireMutation()) return;
    updateDraft.mutate(
      { draftId: draft.id, data: { revision: draft.revision, script } },
      { onSuccess: setAuthoritativeDraft, onSettled: releaseMutation },
    );
  };
  const updateAssignment = (roleId: string, patch: Partial<Assignment>) =>
    setAssignments((current) => ({
      ...current,
      [roleId]: { ...(current[roleId] ?? { characterId: null, outfitId: null, voiceId: voices[0]?.id ?? "" }), ...patch },
    }));
  const needsSaved = draft?.script?.roles.filter((role) => role.id === userRoleId || strategy === "saved") ?? [];
  const castComplete = !!draft?.script && !!userRoleId && voices.length > 0 &&
    draft.script.roles.every((role) => {
      const assigned = assignments[role.id];
      return role.id === userRoleId || strategy === "generated"
        ? role.id !== userRoleId || (!!assigned?.characterId && !!assigned.voiceId && consent)
        : !!assigned?.characterId && !!assigned.voiceId && consent;
    });
  const hasDuplicate = useMemo(() => {
    const saved = needsSaved.map((role) => assignments[role.id]).filter(Boolean);
    return new Set(saved.map((item) => item!.characterId).filter(Boolean)).size !== saved.filter((item) => item!.characterId).length ||
      new Set(saved.map((item) => item!.voiceId).filter(Boolean)).size !== saved.filter((item) => item!.voiceId).length;
  }, [assignments, needsSaved]);

  if (draftId !== null && draftQuery.isLoading) return <Card><CardContent className="p-6" data-testid="status-guided-story-loading">Restoring your guided story…</CardContent></Card>;
  return <div className="space-y-5" data-testid="guided-story-workflow">
    <Card>
      <CardHeader><CardTitle>Guided Story</CardTitle><CardDescription>Plan a cast-led story, approve its script, then use the existing storyboard review.</CardDescription></CardHeader>
      <CardContent className="space-y-4">
        {!draft || editing ? <>
          <div className="grid gap-2 md:grid-cols-2">{GENRES.map(([id, name, description]) => <Button key={id} type="button" variant={genre === id ? "default" : "outline"} className="h-auto justify-start whitespace-normal p-4 text-left" onClick={() => setGenre(id)} data-testid={`button-guided-genre-${id}`}><span><b>{name}</b><br /><small>{description}</small></span></Button>)}</div>
          <div className="grid gap-4 md:grid-cols-2">
            <div><Label>Publishing platform</Label><Select value={platformId} onValueChange={setPlatformId}><SelectTrigger data-testid="select-guided-platform"><SelectValue placeholder="Choose a platform" /></SelectTrigger><SelectContent>{(platforms.data ?? []).map((item) => <SelectItem key={item.id} value={item.id}>{item.id.replaceAll("_", " ")}</SelectItem>)}</SelectContent></Select></div>
            <div><Label>Brand Kit and voice library</Label><Select value={brandKitId?.toString() ?? ""} onValueChange={(value) => setBrandKitId(Number(value))}><SelectTrigger data-testid="select-guided-brand-kit"><SelectValue placeholder="Choose a Brand Kit" /></SelectTrigger><SelectContent>{brandKits.map((kit) => <SelectItem key={kit.id} value={String(kit.id)}>{kit.name}</SelectItem>)}</SelectContent></Select></div>
          </div>
          {contract && <div className="rounded-md bg-muted p-3 text-sm" data-testid="text-guided-format">Format: {contract.aspectRatio} · {contract.width}×{contract.height}. Safe area: {contract.safeArea}</div>}
          {contract && <div><Label>Duration</Label><div className="flex flex-wrap gap-2 mt-2">{contract.durations.map((value) => <Button type="button" size="sm" key={value} variant={duration === value ? "default" : "outline"} onClick={() => setDuration(value)} data-testid={`button-guided-duration-${value}`}>{value}s</Button>)}</div></div>}
          {rolePlan && <div data-testid="text-guided-role-plan">Recommended: {rolePlan.recommended} roles. Allowed: {rolePlan.allowed.join(", ")}.<div className="flex gap-2 mt-2">{rolePlan.allowed.map((value) => <Button type="button" size="sm" key={value} variant={roleCount === value ? "default" : "outline"} onClick={() => setRoleCount(value)} data-testid={`button-guided-role-count-${value}`}>{value} roles</Button>)}</div></div>}
          <div><Label>Locale</Label><Input value={locale} onChange={(event) => setLocale(event.target.value)} data-testid="input-guided-locale" /></div>
          <div><Label>Story topic</Label><Textarea value={topic} onChange={(event) => setTopic(event.target.value)} data-testid="input-guided-topic" /></div>
          {brandKits.length === 0 && <p className="text-sm text-muted-foreground" data-testid="status-guided-empty-brand-kit">A Brand Kit with a compatible voice is required. Create one before continuing.</p>}
          <p className="text-sm text-muted-foreground">A server-authored unit estimate appears after this durable draft is created.</p>
          <Button type="button" disabled={!setupComplete || mutationLocked || createDraft.isPending || updateDraft.isPending} onClick={begin} data-testid="button-guided-create-draft">{editing ? "Save setup" : "Create story draft"}</Button>
        </> : <StoryFlow draft={draft} characters={characters} voices={voices} userRoleId={userRoleId} setUserRoleId={setUserRoleId} strategy={strategy} setStrategy={setStrategy} assignments={assignments} updateAssignment={updateAssignment} consent={consent} setConsent={setConsent} duplicateConfirmed={duplicateConfirmed} setDuplicateConfirmed={setDuplicateConfirmed} hasDuplicate={hasDuplicate} castComplete={castComplete} onManageCharacters={onManageCharacters} onEdit={() => setEditing(true)} onGenerate={() => { if (!acquireMutation()) return; generateScript.mutate({ draftId: draft.id, data: { revision: draft.revision } }, { onSuccess: setAuthoritativeDraft, onSettled: releaseMutation }); }} onSaveScript={saveScript} onApprove={() => { if (!acquireMutation()) return; approveScript.mutate({ draftId: draft.id, data: { revision: draft.revision } }, { onSuccess: setAuthoritativeDraft, onSettled: releaseMutation }); }} onCast={() => { if (!acquireMutation()) return; castDraft.mutate({ draftId: draft.id, data: { revision: draft.revision, strategy, duplicateAssignmentConfirmed: duplicateConfirmed, assignments: draft.script!.roles.map((role) => { const saved = role.id === userRoleId || strategy === "saved"; const item = assignments[role.id] ?? { characterId: null, outfitId: null, voiceId: voices[0]?.id ?? "" }; return { roleId: role.id, source: saved ? "saved" : "generated", characterId: saved ? item.characterId : null, outfitId: saved ? item.outfitId : null, brandKitId, voiceId: item.voiceId || voices[0]?.id || "", isUserRole: role.id === userRoleId, consentGranted: saved ? consent : false }; }) } }, { onSuccess: setAuthoritativeDraft, onSettled: releaseMutation }); }} onEnqueue={() => { if (!acquireMutation()) return; enqueueDraft.mutate({ draftId: draft.id, data: { revision: draft.revision } }, { onSuccess: (job) => onJobReady(job.id), onSettled: releaseMutation }); }} pending={mutationLocked || generateScript.isPending || approveScript.isPending || updateDraft.isPending || castDraft.isPending || enqueueDraft.isPending} />}
      </CardContent>
    </Card>
  </div>;
}

function StoryFlow(props: any) {
  const { draft, characters, voices } = props;
  const step = draftStep(draft);
  const estimate = <PhaseEstimates draft={draft} />;
  if (step === "script") return <>{estimate}<Button type="button" onClick={props.onGenerate} disabled={props.pending} data-testid="button-guided-generate-script">Generate script</Button></>;
  if (step === "review") return <>{estimate}<ScriptReview {...props} /></>;
  if (step === "ready") return <>{estimate}<p data-testid="status-guided-cast-complete">Cast is saved and ready for the existing storyboard funding pipeline.</p><Button type="button" onClick={props.onEnqueue} disabled={props.pending} data-testid="button-guided-enqueue">Build storyboard for review</Button></>;
  return <>{estimate}<ScriptSummary script={draft.script} /><h3 className="font-semibold">Which character are you playing?</h3><div className="flex flex-wrap gap-2">{draft.script.roles.map((role: any) => <Button type="button" key={role.id} variant={props.userRoleId === role.id ? "default" : "outline"} onClick={() => props.setUserRoleId(role.id)} data-testid={`button-guided-user-role-${role.id}`}>{role.name}</Button>)}</div><div className="flex gap-2"><Button type="button" variant={props.strategy === "generated" ? "default" : "outline"} onClick={() => props.setStrategy("generated")} data-testid="button-guided-cast-generated">Generate remaining cast</Button><Button type="button" variant={props.strategy === "saved" ? "default" : "outline"} onClick={() => props.setStrategy("saved")} data-testid="button-guided-cast-saved">Use saved characters</Button></div>{characters.length === 0 && <><p data-testid="status-guided-empty-characters">No saved characters are available for your role.</p><Button type="button" variant="outline" onClick={props.onManageCharacters} data-testid="button-guided-manage-characters">Manage characters</Button></>}{voices.length === 0 && <p data-testid="status-guided-empty-voices">This Brand Kit has no compatible voice. Add a voice in Brand Kit, then return here.</p>}{draft.script.roles.filter((role: any) => role.id === props.userRoleId || props.strategy === "saved").map((role: any) => <CastFields key={role.id} role={role} {...props} />)}{props.strategy === "generated" && props.userRoleId && draft.script.roles.filter((role: any) => role.id !== props.userRoleId).map((role: any) => <GeneratedCastVoice key={role.id} role={role} {...props} />)}<div className="flex items-center gap-2"><Checkbox checked={props.consent} onCheckedChange={(value) => props.setConsent(value === true)} data-testid="checkbox-guided-consent" /><Label>I have permission to use each saved person’s likeness and selected voice for this attempt.</Label></div>{props.hasDuplicate && <div className="flex items-center gap-2"><Checkbox checked={props.duplicateConfirmed} onCheckedChange={(value) => props.setDuplicateConfirmed(value === true)} data-testid="checkbox-guided-duplicate-confirmation" /><Label>I confirm one performer may play multiple roles.</Label></div>}<Button type="button" disabled={!props.castComplete || (props.hasDuplicate && !props.duplicateConfirmed) || props.pending} onClick={props.onCast} data-testid="button-guided-save-cast">Save cast and continue</Button></>;
}

function PhaseEstimates({ draft }: { draft: GuidedStoryDraft }) {
  const phases = [
    ["script", "Script", draft.estimates.scriptUnits],
    ["cast", "Cast assets", draft.estimates.castAssetUnits],
    ["storyboard", "Storyboard previews", draft.estimates.previewUnits],
    ["final", "Final approval", draft.estimates.finalAdditionalUnits],
  ] as const;
  return <div className="rounded-md border bg-muted/30 p-3" data-testid="guided-estimates"><p className="text-sm font-medium">Server estimate · product units</p><div className="mt-2 grid grid-cols-2 gap-2">{phases.map(([id, label, units]) => <p className="text-xs" key={id} data-testid={`text-guided-estimate-${id}`}>{label}: <b>{units} {units === 1 ? "unit" : "units"}</b></p>)}</div><p className="mt-2 text-xs text-muted-foreground" data-testid="text-guided-estimate-total">Total remaining: {draft.estimates.totalRemainingUnits} units. No paise estimate is supplied; final settlement follows provider receipts.</p></div>;
}

function ScriptSummary({ script }: { script: GuidedStoryScript }) {
  return <div data-testid="guided-script-summary"><h3 className="font-semibold">{script.title}</h3><p>{script.logline}</p><p className="text-sm">{script.runtimeSeconds}s · {script.scenes.length} scenes · {script.roles.length} roles</p>{script.warnings.length > 0 && <ul>{script.warnings.map((warning) => <li key={warning}>Warning: {warning}</li>)}</ul>}</div>;
}
function ScriptReview(props: any) {
  const [scriptText, setScriptText] = useState("");
  const { script } = props.draft;
  useEffect(() => setScriptText(JSON.stringify(script, null, 2)), [script]);
  return <><ScriptSummary script={script} /><Textarea value={scriptText} onChange={(event) => setScriptText(event.target.value)} data-testid="input-guided-script" /><div className="flex gap-2"><Button type="button" variant="outline" onClick={props.onGenerate} disabled={props.pending} data-testid="button-guided-regenerate-script">Regenerate</Button><Button type="button" variant="outline" onClick={() => { try { props.onSaveScript(JSON.parse(scriptText)); } catch { /* malformed JSON cannot be sent */ } }} disabled={props.pending} data-testid="button-guided-save-script">Save edit</Button><Button type="button" onClick={props.onApprove} disabled={props.pending} data-testid="button-guided-approve-script">Approve script</Button></div></>;
}
function CastFields({ role, characters, voices, assignments, updateAssignment }: any) {
  const item = assignments[role.id] ?? {};
  const character = characters.find((candidate: Character) => candidate.id === item.characterId);
  return <div className="grid gap-2 rounded border p-3" data-testid={`card-guided-cast-${role.id}`}><b>{role.name}</b><Select value={item.characterId?.toString() ?? ""} onValueChange={(value) => updateAssignment(role.id, { characterId: Number(value), outfitId: null })}><SelectTrigger data-testid={`select-guided-character-${role.id}`}><SelectValue placeholder="Select saved character" /></SelectTrigger><SelectContent>{characters.map((candidate: Character) => <SelectItem key={candidate.id} value={String(candidate.id)}>{candidate.name}</SelectItem>)}</SelectContent></Select>{character && <Select value={item.outfitId?.toString() ?? "none"} onValueChange={(value) => updateAssignment(role.id, { outfitId: value === "none" ? null : Number(value) })}><SelectTrigger data-testid={`select-guided-outfit-${role.id}`}><SelectValue placeholder="Default outfit" /></SelectTrigger><SelectContent><SelectItem value="none">Default outfit</SelectItem>{character.outfits.map((outfit: Character["outfits"][number]) => <SelectItem key={outfit.id} value={String(outfit.id)}>{outfit.name}</SelectItem>)}</SelectContent></Select>}<Select value={item.voiceId ?? ""} onValueChange={(value) => updateAssignment(role.id, { voiceId: value })}><SelectTrigger data-testid={`select-guided-voice-${role.id}`}><SelectValue placeholder="Select Brand Kit voice" /></SelectTrigger><SelectContent>{voices.map((voice: any) => <SelectItem key={voice.id} value={voice.id}>{voice.label}</SelectItem>)}</SelectContent></Select></div>;
}
function GeneratedCastVoice({ role, voices, assignments, updateAssignment }: any) {
  const item = assignments[role.id] ?? {};
  return <div className="rounded border border-dashed p-3" data-testid={`card-guided-generated-cast-${role.id}`}><b>{role.name}</b><p className="text-sm text-muted-foreground">The server will create a wholly fictional appearance and genre-appropriate wardrobe.</p><Select value={item.voiceId ?? voices[0]?.id ?? ""} onValueChange={(value) => updateAssignment(role.id, { voiceId: value })}><SelectTrigger data-testid={`select-guided-generated-voice-${role.id}`}><SelectValue placeholder="Select Brand Kit voice" /></SelectTrigger><SelectContent>{voices.map((voice: any) => <SelectItem key={voice.id} value={voice.id}>{voice.label}</SelectItem>)}</SelectContent></Select></div>;
}