import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetGuidedStoryDraftQueryKey,
  getGetVideoJobQueryKey,
  getListGuidedStoryVoicesQueryKey,
  useApproveGuidedStoryDraftScript,
  useApproveGuidedStoryCastRole,
  useApproveGuidedStoryBackdrop,
  useCastGuidedStoryDraft,
  useCreateGuidedStoryDraft,
  useEnqueueGuidedStoryDraft,
  useGenerateGuidedStoryDraftScript,
  useGenerateGuidedStoryDraftScene,
  useGetGuidedStoryDraft,
  useGetVideoJob,
  useListGuidedStoryPlatforms,
  useListGuidedStoryVoices,
  useRequestUploadUrl,
  usePrepareGuidedStoryBackdrop,
  useUpdateGuidedStoryDraft,
  type BrandKit,
  type Character,
  type GuidedStoryDraft,
  type GuidedStoryPlatformContract,
  type GuidedStoryScript,
  type GuidedStoryVoiceCatalogItem,
} from "@workspace/api-client-react";
import { apiErrorMessage } from "@/lib/apiErrorMessage";
import { track } from "@/lib/analytics";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ArrowDown, ArrowUp, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";


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
const GUIDED_STORY_ELEVENLABS_MODEL = "eleven_v3";
type GuidedStoryLocaleOption = {
  code: "en" | "hi" | "te" | "ta";
  label: string;
  endonym: string;
  bcp47: string;
  script: "Latin" | "Devanagari" | "Telugu" | "Tamil";
};
const GUIDED_STORY_LOCALES: readonly GuidedStoryLocaleOption[] = [
  { code: "en", label: "English", endonym: "English", bcp47: "en", script: "Latin" },
  { code: "hi", label: "Hindi", endonym: "हिन्दी", bcp47: "hi", script: "Devanagari" },
  { code: "te", label: "Telugu", endonym: "తెలుగు", bcp47: "te", script: "Telugu" },
  { code: "ta", label: "Tamil", endonym: "தமிழ்", bcp47: "ta", script: "Tamil" },
];
const SCRIPT_LETTERS: Partial<Record<string, RegExp>> = {
  Devanagari: /\p{Script=Devanagari}/u,
  Telugu: /\p{Script=Telugu}/u,
  Tamil: /\p{Script=Tamil}/u,
};

const BUILT_IN_VOICES: GuidedStoryVoiceCatalogItem[] = [
  ["alloy", "Alloy · balanced"],
  ["nova", "Nova · bright"],
  ["shimmer", "Shimmer · warm"],
  ["echo", "Echo · deep"],
  ["onyx", "Onyx · bold"],
  ["fable", "Fable · storyteller"],
].map(([id, label]) => ({
  id: `stock:${id}`,
  label,
  provider: "stock",
  providerVoiceId: null,
  brandKitId: null,
}));
const VISUAL_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];
const MAX_VISUAL_IMAGE_BYTES = 10 * 1024 * 1024;
type VisualChoices = {
  logo: { path: string | null; sceneIds: string[] };
  location: { mode: "none"; imagePath: null; description: null } | { mode: "image"; imagePath: string; description: null } | { mode: "text"; imagePath: null; description: string };
  backdropReference?: GuidedStoryDraft["visualChoices"]["backdropReference"];
};
function emptyVisualChoices(): VisualChoices {
  return { logo: { path: null, sceneIds: [] }, location: { mode: "none", imagePath: null, description: null } };
}
function normaliseVisualChoices(value: GuidedStoryDraft["visualChoices"] | undefined): VisualChoices {
  return value ? JSON.parse(JSON.stringify(value)) as VisualChoices : emptyVisualChoices();
}
function visualChoicesEqual(a: VisualChoices, b: VisualChoices): boolean {
  return JSON.stringify({ ...a, logo: { ...a.logo, sceneIds: [...a.logo.sceneIds].sort() } }) === JSON.stringify({ ...b, logo: { ...b.logo, sceneIds: [...b.logo.sceneIds].sort() } });
}

function guidedStoryLocaleOption(value: string): GuidedStoryLocaleOption | undefined {
  try {
    const locale = new Intl.Locale(value.trim().replaceAll("_", "-"));
    const option = GUIDED_STORY_LOCALES.find((item) => item.code === locale.language);
    if (!option) return undefined;
    const expectedScript =
      option.script === "Latin" ? "Latn" :
        option.script === "Devanagari" ? "Deva" :
          option.script === "Telugu" ? "Telu" :
            "Taml";
    return locale.script && locale.script !== expectedScript ? undefined : option;
  } catch {
    return undefined;
  }
}

function spokenLineNeedsNativeScriptWarning(
  text: string,
  locale: GuidedStoryLocaleOption | undefined,
): boolean {
  if (!locale || locale.script === "Latin") return false;
  const expectedLetter = SCRIPT_LETTERS[locale.script];
  if (!expectedLetter) return false;
  return /\p{Letter}/u.test(text) && !expectedLetter.test(text);
}

function spokenTextNeedsNativeScriptWarning(
  script: GuidedStoryScript,
  locale: GuidedStoryLocaleOption | undefined,
): boolean {
  return script.scenes.some((scene) =>
    scene.lines.some((line) =>
      spokenLineNeedsNativeScriptWarning(line.text, locale),
    ),
  );
}

export function guidedStoryWritingSystemWarning(
  script: GuidedStoryScript,
  locale: string,
): string | null {
  const option = guidedStoryLocaleOption(locale);
  if (!option) {
    return "This story has an unsupported language. Return to setup and choose English, Hindi, Tamil, or Telugu.";
  }
  return spokenTextNeedsNativeScriptWarning(script, option)
    ? `${option.label} spoken lines appear to be Romanized. Edit them to use ${option.script} characters, or regenerate the script, before approval.`
    : null;
}

/** Keep this capability check visible before a Telugu story reaches approval. */
export function guidedStoryElevenLabsCapabilityWarning(
  locale: string,
  modelId = GUIDED_STORY_ELEVENLABS_MODEL,
): string | null {
  const option = guidedStoryLocaleOption(locale);
  return option?.code === "te" && modelId === "eleven_multilingual_v2"
    ? "Telugu narration requires the ElevenLabs v3 voice model. Choose a compatible narration model before approval."
    : null;
}

function trackGuidedStoryEvent(name: string, data: Record<string, number>): void {
  try {
    track(name, data);
  } catch {
    // Analytics must never interrupt editing or generation.
  }
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
  editRequest = null,
}: {
  tenantId?: number;
  characters: Character[];
  brandKits: BrandKit[];
  onManageCharacters: () => void;
  onJobReady: (jobId: number) => void;
  editRequest?: { key: number; draftId: number } | null;
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
  const [scriptEditorOpen, setScriptEditorOpen] = useState(false);
  const scriptEditorRef = useRef<HTMLDivElement>(null);
  const [userRoleId, setUserRoleId] = useState<string | null>(null);
  const [userRoleChoiceMade, setUserRoleChoiceMade] = useState(false);
  const [strategy, setStrategy] = useState<"generated" | "saved">("generated");
  const [assignments, setAssignments] = useState<Record<string, Assignment>>({});
  const [consent, setConsent] = useState(false);
  const [duplicateConfirmed, setDuplicateConfirmed] = useState(false);
  const [castSaveError, setCastSaveError] = useState<string | null>(null);
  const [enqueueError, setEnqueueError] = useState<string | null>(null);
  const [scriptApprovalError, setScriptApprovalError] = useState<string | null>(null);
  const [castApprovalError, setCastApprovalError] = useState<{ roleId: string; message: string } | null>(null);
  const [castBusyRole, setCastBusyRole] = useState<string | null>(null);
  const [castRetryAttempt, setCastRetryAttempt] = useState(0);
  const [visualChoices, setVisualChoices] = useState<VisualChoices>(emptyVisualChoices);
  const [visualError, setVisualError] = useState<string | null>(null);
  const [visualUploading, setVisualUploading] = useState<"logo" | "background" | null>(null);
  const [mutationLocked, setMutationLocked] = useState(false);
  const mutationLockRef = useRef(false);
  const queryClient = useQueryClient();
  const platforms = useListGuidedStoryPlatforms();
  const voiceCatalog = useListGuidedStoryVoices({
    query: {
      queryKey: getListGuidedStoryVoicesQueryKey(),
      staleTime: 0,
      refetchOnMount: "always",
    },
  });
  const draftQuery = useGetGuidedStoryDraft(draftId ?? 0, {
    query: { enabled: draftId !== null, queryKey: getGetGuidedStoryDraftQueryKey(draftId ?? 0) },
  });
  const createDraft = useCreateGuidedStoryDraft();
  const generateScript = useGenerateGuidedStoryDraftScript();
  const approveScript = useApproveGuidedStoryDraftScript();
  const approveCastRole = useApproveGuidedStoryCastRole();
  const updateDraft = useUpdateGuidedStoryDraft();
  const castDraft = useCastGuidedStoryDraft();
  const enqueueDraft = useEnqueueGuidedStoryDraft();
  const requestUploadUrl = useRequestUploadUrl();
  const draft = draftQuery.data;
  const linkedStoryboardJobId =
    draft?.storyboardJobId != null && draft.storyboardJobId > 0
      ? draft.storyboardJobId
      : null;
  const existingJobQuery = useGetVideoJob(linkedStoryboardJobId ?? 0, {
    query: {
      queryKey: getGetVideoJobQueryKey(linkedStoryboardJobId ?? 0),
      enabled: linkedStoryboardJobId !== null,
    },
  });
  const failedBeforeStoryboard =
    linkedStoryboardJobId !== null &&
    existingJobQuery.data?.status === "failed" &&
    !existingJobQuery.data.storyboard;
  // A failed pre-storyboard job returns the user to editing rather than being
  // treated as an existing storyboard they can open.
  const existingJobId = failedBeforeStoryboard ? null : linkedStoryboardJobId;
  const contract = (platforms.data ?? []).find((item) => item.id === platformId) as GuidedStoryPlatformContract | undefined;
  const rolePlan = duration != null ? contract?.rolePlans[String(duration)] : undefined;
  const storyLocales = GUIDED_STORY_LOCALES;
  const selectedStoryLocale = guidedStoryLocaleOption(locale);
  const voices = voiceCatalog.data?.voices.length
    ? voiceCatalog.data.voices
    : BUILT_IN_VOICES;

  useEffect(() => {
    if (editRequest?.draftId) {
      setDraftId(editRequest.draftId);
      return;
    }
    setDraftId(null);
    if (!storageKey) return;
    const stored = Number(localStorage.getItem(storageKey));
    if (Number.isInteger(stored) && stored > 0) setDraftId(stored);
  }, [editRequest?.draftId, editRequest?.key, storageKey]);
  useEffect(() => {
    if (!editRequest || draft?.id !== editRequest.draftId || !draft.script) return;
    setEditing(false);
    setScriptEditorOpen(true);
    if (storageKey) localStorage.setItem(storageKey, String(draft.id));
  }, [draft?.id, draft?.script, editRequest, storageKey]);
  useEffect(() => {
    if (!scriptEditorOpen || draft?.id !== editRequest?.draftId) return;
    const frame = window.requestAnimationFrame(() => {
      scriptEditorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      scriptEditorRef.current
        ?.querySelector<HTMLElement>("input, textarea, button")
        ?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [draft?.id, editRequest?.draftId, scriptEditorOpen]);
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
    setUserRoleChoiceMade(draft.cast.length > 0 || draft.userRoleId !== null);
    setStrategy(draft.castStrategy ?? "generated");
  }, [draft?.id, draft?.revision, draft?.script]);
  useEffect(() => {
    if (draft) setVisualChoices(normaliseVisualChoices(draft.visualChoices));
  }, [draft?.id, draft?.revision]);

  const setAuthoritativeDraft = useCallback((next: GuidedStoryDraft) => {
    queryClient.setQueryData(getGetGuidedStoryDraftQueryKey(next.id), next);
    setDraftId(next.id);
    setEditing(false);
    setScriptEditorOpen(false);
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
  const setupComplete = !!contract && duration !== null && roleCount !== null && !!selectedStoryLocale && topic.trim().length >= 3 && !!brandKitId;
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
  const saveScript = (
    script: GuidedStoryScript,
    onSaved?: (savedScript: GuidedStoryScript) => void,
    onError?: (message: string) => void,
  ) => {
    if (!draft?.setup || !acquireMutation()) return;
    updateDraft.mutate(
      {
        draftId: draft.id,
        data: {
          revision: draft.revision,
          setup: { ...draft.setup, roleCount: script.roles.length },
          script,
        },
      },
      {
        onSuccess: (next) => {
          setAuthoritativeDraft(next);
          trackGuidedStoryEvent("guided_script_revised_saved", {
            role_count: script.roles.length,
            scene_count: script.scenes.length,
          });
          if (next.script) onSaved?.(next.script);
        },
        onError: (error) => onError?.(
          apiErrorMessage(error, "Could not save these script changes."),
        ),
        onSettled: releaseMutation,
      },
    );
  };
  const updateAssignment = (roleId: string, patch: Partial<Assignment>) =>
    setAssignments((current) => ({
      ...current,
      [roleId]: { ...(current[roleId] ?? { characterId: null, outfitId: null, voiceId: voices[0]?.id ?? "" }), ...patch },
    }));
  const needsSaved = draft?.script?.roles.filter(
    (role) => (userRoleId !== null && role.id === userRoleId) || strategy === "saved",
  ) ?? [];
  const castComplete = !!draft?.script && userRoleChoiceMade && voices.length > 0 &&
    draft.script.roles.every((role) => {
      const assigned = assignments[role.id];
      const isUserRole = userRoleId !== null && role.id === userRoleId;
      return isUserRole || strategy === "generated"
        ? !isUserRole || (!!assigned?.characterId && !!assigned.voiceId && consent)
        : !!assigned?.characterId && !!assigned.voiceId && consent;
    });
  const pendingCastApprovalRoles = draft?.script?.roles.filter((role) => {
    const approval = draft.castApprovals?.roles[role.id];
    return !approval || draft.castApprovals?.draftRevision !== draft.revision;
  }) ?? [];
  const castApprovalsComplete = failedBeforeStoryboard || (!!draft?.script &&
    draft.cast.length === draft.script.roles.length &&
    pendingCastApprovalRoles.length === 0);
  const hasDuplicate = useMemo(() => {
    const saved = needsSaved.map((role) => assignments[role.id]).filter(Boolean);
    return new Set(saved.map((item) => item!.characterId).filter(Boolean)).size !== saved.filter((item) => item!.characterId).length ||
      new Set(saved.map((item) => item!.voiceId).filter(Boolean)).size !== saved.filter((item) => item!.voiceId).length;
  }, [assignments, needsSaved]);
  const submitCast = () => {
    if (!draft?.script || !acquireMutation()) return;
    setCastSaveError(null);
    castDraft.mutate({
      draftId: draft.id,
      data: {
        revision: draft.revision,
        strategy,
        duplicateAssignmentConfirmed: duplicateConfirmed,
        assignments: draft.script.roles.map((role) => {
          const isUserRole = userRoleId !== null && role.id === userRoleId;
          const saved = isUserRole || strategy === "saved";
          const item = assignments[role.id] ?? {
            characterId: null,
            outfitId: null,
            voiceId: voices[0]?.id ?? "",
          };
          return {
            roleId: role.id,
            source: saved ? "saved" as const : "generated" as const,
            characterId: saved ? item.characterId : null,
            outfitId: saved ? item.outfitId : null,
            brandKitId,
            voiceId: item.voiceId || voices[0]?.id || "",
            isUserRole,
            consentGranted: saved ? consent : false,
          };
        }),
      },
    }, {
      onSuccess: (next) => {
        setCastBusyRole(null);
        setCastRetryAttempt(0);
        setAuthoritativeDraft(next);
      },
      onError: (error) => {
        const message = apiErrorMessage(error, "Could not save this cast. Please try again.");
        const busy = message.match(/^Cast generation is already in progress for role (.+)\.$/);
        if (busy?.[1]) {
          setCastBusyRole(busy[1]);
          setCastRetryAttempt((attempt) => attempt + 1);
        } else {
          setCastBusyRole(null);
          setCastSaveError(message);
        }
      },
      onSettled: releaseMutation,
    });
  };
  useEffect(() => {
    if (!castBusyRole) return;
    const timer = window.setTimeout(submitCast, 4_000);
    return () => window.clearTimeout(timer);
  }, [castBusyRole, castRetryAttempt]);

  if (draftId !== null && draftQuery.isLoading) return <Card><CardContent className="p-6" data-testid="status-guided-story-loading">Restoring your guided story…</CardContent></Card>;
  if (editRequest && draftId === editRequest.draftId && (draftQuery.isError || (!draftQuery.isLoading && !draft))) return <Card><CardContent className="p-6 text-destructive" role="alert" data-testid="error-guided-story-restore">This story draft could not be restored. Return to your video jobs and try again.</CardContent></Card>;
  return <div className="space-y-5" data-testid="guided-story-workflow">
    <Card>
      <CardHeader><CardTitle>Guided Story</CardTitle><CardDescription>Plan a cast-led story, approve its script, then use the existing storyboard review.</CardDescription></CardHeader>
      <CardContent className="space-y-4" ref={scriptEditorRef}>
        {!draft || editing ? <>
          <div className="grid gap-2 md:grid-cols-2">{GENRES.map(([id, name, description]) => <Button key={id} type="button" variant={genre === id ? "default" : "outline"} className="h-auto justify-start whitespace-normal p-4 text-left" onClick={() => setGenre(id)} data-testid={`button-guided-genre-${id}`}><span><b>{name}</b><br /><small>{description}</small></span></Button>)}</div>
          <div className="grid gap-4 md:grid-cols-2">
            <div><Label>Publishing platform</Label><Select value={platformId} onValueChange={setPlatformId}><SelectTrigger data-testid="select-guided-platform"><SelectValue placeholder="Choose a platform" /></SelectTrigger><SelectContent>{(platforms.data ?? []).map((item) => <SelectItem key={item.id} value={item.id}>{item.id.replaceAll("_", " ")}</SelectItem>)}</SelectContent></Select></div>
            <div><Label>Brand Kit and voice library</Label><Select value={brandKitId?.toString() ?? ""} onValueChange={(value) => setBrandKitId(Number(value))}><SelectTrigger data-testid="select-guided-brand-kit"><SelectValue placeholder="Choose a Brand Kit" /></SelectTrigger><SelectContent>{brandKits.map((kit) => <SelectItem key={kit.id} value={String(kit.id)}>{kit.name}</SelectItem>)}</SelectContent></Select></div>
          </div>
          {contract && <div className="rounded-md bg-muted p-3 text-sm" data-testid="text-guided-format">Format: {contract.aspectRatio} · {contract.width}×{contract.height}. Safe area: {contract.safeArea}</div>}
          {contract && <div><Label>Duration</Label><div className="flex flex-wrap gap-2 mt-2">{contract.durations.map((value) => <Button type="button" size="sm" key={value} variant={duration === value ? "default" : "outline"} onClick={() => setDuration(value)} data-testid={`button-guided-duration-${value}`}>{value}s</Button>)}</div></div>}
          {rolePlan && <div data-testid="text-guided-role-plan">Recommended: {rolePlan.recommended} roles. Allowed: {rolePlan.allowed.join(", ")}.<div className="flex gap-2 mt-2">{rolePlan.allowed.map((value) => <Button type="button" size="sm" key={value} variant={roleCount === value ? "default" : "outline"} onClick={() => setRoleCount(value)} data-testid={`button-guided-role-count-${value}`}>{value} roles</Button>)}</div></div>}
          <div className="space-y-1.5">
            <Label>Story language</Label>
            <Select value={locale} onValueChange={setLocale}>
              <SelectTrigger data-testid="select-guided-locale"><SelectValue placeholder="Choose a supported language" /></SelectTrigger>
              <SelectContent>
                {!selectedStoryLocale && <SelectItem value={locale}>{locale} · saved locale</SelectItem>}
                {storyLocales.map((item) => <SelectItem key={item.code} value={item.code}>{item.endonym} · {item.label} ({item.bcp47})</SelectItem>)}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground" data-testid="text-guided-language-authority">
              This language is saved with the story and used for script, subtitles, and speech. The server rejects unsupported locales before paid work.
            </p>
            {selectedStoryLocale ? (
              <p className="text-xs text-muted-foreground" data-testid="status-guided-language-supported">
                {selectedStoryLocale.label} ({selectedStoryLocale.code}) in {selectedStoryLocale.script} script. Spoken lines must use this writing system. ElevenLabs receives {selectedStoryLocale.code} with the exact approved text when the selected model supports explicit language control.
              </p>
            ) : (
              <p className="text-xs text-destructive" role="alert">Choose English, Hindi, Telugu, or Tamil before continuing.</p>
            )}
          </div>
          <div><Label>Story topic</Label><Textarea value={topic} onChange={(event) => setTopic(event.target.value)} data-testid="input-guided-topic" /></div>
          {brandKits.length === 0 && <p className="text-sm text-muted-foreground" data-testid="status-guided-empty-brand-kit">A Brand Kit is required for the story’s visual branding. Voice selection is managed separately.</p>}
          <p className="text-sm text-muted-foreground">A server-authored unit estimate appears after this durable draft is created.</p>
          <Button type="button" disabled={!setupComplete || mutationLocked || createDraft.isPending || updateDraft.isPending} onClick={begin} data-testid="button-guided-create-draft">{editing ? "Save setup" : "Create story draft"}</Button>
        </> : <StoryFlow draft={draft} rolePlan={rolePlan} characters={characters} voices={voices} brandKits={brandKits} voiceCatalogWarning={voiceCatalog.data?.providerWarning ?? (voiceCatalog.isError ? "Provider voices could not be loaded. Built-in voices are still available." : null)} castSaveError={castSaveError} castBusyRole={castBusyRole} castSaving={castDraft.isPending} enqueueError={enqueueError} scriptApprovalError={scriptApprovalError} enqueuePending={enqueueDraft.isPending} existingJobId={existingJobId} failedBeforeStoryboard={failedBeforeStoryboard} userRoleId={userRoleId} setUserRoleId={(roleId: string | null) => { setUserRoleId(roleId); setUserRoleChoiceMade(true); }} userRoleChoiceMade={userRoleChoiceMade} scriptEditorOpen={scriptEditorOpen} onBackToScript={() => setScriptEditorOpen(true)} strategy={strategy} setStrategy={setStrategy} assignments={assignments} updateAssignment={updateAssignment} consent={consent} setConsent={setConsent} duplicateConfirmed={duplicateConfirmed} setDuplicateConfirmed={setDuplicateConfirmed} hasDuplicate={hasDuplicate} castComplete={castComplete} needsSaved={needsSaved} onManageCharacters={onManageCharacters} onEdit={() => setEditing(true)} onGenerate={() => { if (!acquireMutation()) return; generateScript.mutate({ draftId: draft.id, data: { revision: draft.revision } }, { onSuccess: setAuthoritativeDraft, onSettled: releaseMutation }); }} onSaveScript={saveScript} onApprove={() => { setScriptApprovalError(null); if (!acquireMutation()) return; approveScript.mutate({ draftId: draft.id, data: { revision: draft.revision } }, { onSuccess: setAuthoritativeDraft, onError: (error) => setScriptApprovalError(apiErrorMessage(error, "Could not approve this script. Please try again.")), onSettled: releaseMutation }); }} onCast={submitCast} castApprovalsComplete={castApprovalsComplete} pendingCastApprovalRoles={pendingCastApprovalRoles} castApprovalError={castApprovalError} castApprovalPending={approveCastRole.isPending} onApproveCastRole={(roleId: string) => { setCastApprovalError(null); if (!acquireMutation()) return; approveCastRole.mutate({ draftId: draft.id, roleId, data: { revision: draft.revision } }, { onSuccess: setAuthoritativeDraft, onError: (error) => setCastApprovalError({ roleId, message: apiErrorMessage(error, "Could not approve these references. Review the role and try again.") }), onSettled: releaseMutation }); }} visualChoices={visualChoices} visualSaved={visualChoicesEqual(visualChoices, normaliseVisualChoices(draft.visualChoices))} visualError={visualError} visualUploading={visualUploading} setVisualChoices={setVisualChoices} onUploadVisual={async (kind: "logo" | "background", file: File) => { setVisualError(null); if (!VISUAL_IMAGE_TYPES.includes(file.type)) { setVisualError("Use a PNG, JPEG, or WebP image."); return; } if (file.size > MAX_VISUAL_IMAGE_BYTES) { setVisualError("Image must be 10 MB or smaller."); return; } setVisualUploading(kind); try { const { uploadURL, objectPath } = await requestUploadUrl.mutateAsync({ data: { name: file.name, size: file.size, contentType: file.type } }); const put = await fetch(uploadURL, { method: "PUT", body: file, headers: { "Content-Type": file.type } }); if (!put.ok) throw new Error(`Upload failed (${put.status})`); setVisualChoices((current) => kind === "logo" ? { ...current, logo: { ...current.logo, path: objectPath } } : { ...current, location: { mode: "image", imagePath: objectPath, description: null } }); } catch (error) { setVisualError(apiErrorMessage(error, "Could not upload this image. Please try again.")); } finally { setVisualUploading(null); } }} onSaveVisual={() => { setVisualError(null); if (!acquireMutation()) return; const snapshot = JSON.parse(JSON.stringify(visualChoices)) as VisualChoices; updateDraft.mutate({ draftId: draft.id, data: { revision: draft.revision, visualChoices: snapshot } }, { onSuccess: setAuthoritativeDraft, onError: (error) => setVisualError(apiErrorMessage(error, "Could not save visual choices. Please try again.")), onSettled: releaseMutation }); }} onEnqueue={() => { setEnqueueError(null); if (existingJobId !== null) { onJobReady(existingJobId); return; } if (!castApprovalsComplete) { setEnqueueError("Approve every current cast role before building the storyboard."); return; } if (!draft.visualChoices?.backdropReference?.approvedAt) { setEnqueueError("Approve the shared backdrop before building the storyboard."); return; } if (!visualChoicesEqual(visualChoices, normaliseVisualChoices(draft.visualChoices))) { setEnqueueError("Save visual consistency choices before building the storyboard."); return; } if (failedBeforeStoryboard) { setScriptEditorOpen(true); return; } if (!acquireMutation()) return; enqueueDraft.mutate({ draftId: draft.id, data: { revision: draft.revision } }, { onSuccess: (job) => onJobReady(job.id), onError: (error) => setEnqueueError(apiErrorMessage(error, "Could not start the storyboard. Please try again.")), onSettled: releaseMutation }); }} pending={mutationLocked || !!castBusyRole || generateScript.isPending || approveScript.isPending || approveCastRole.isPending || updateDraft.isPending || castDraft.isPending || enqueueDraft.isPending} />}
      </CardContent>
    </Card>
  </div>;
}



function StoryFlow(props: any) {
  const { draft, characters, voices } = props;
  const [roleChoicePrompt, setRoleChoicePrompt] = useState(false);
  const [readyToGenerateCast, setReadyToGenerateCast] = useState(false);
  const step = draftStep(draft);
  const estimate = <PhaseEstimates draft={draft} />;
  const voiceLanguageNote = (
    <p className="text-sm text-muted-foreground" data-testid="text-guided-voice-language">
      ElevenLabs speaks the exact approved story text in the selected language; voices choose how a character sounds; they are not language-specific.
    </p>
  );
  const elevenLabsVoiceCount = voices.filter(
    (voice: GuidedStoryVoiceCatalogItem) =>
      voice.provider === "elevenlabs" && voice.brandKitId === null,
  ).length;
  const chooseUserRole = (roleId: string | null) => {
    props.setUserRoleId(roleId);
    if (roleChoicePrompt) {
      setRoleChoicePrompt(false);
      setReadyToGenerateCast(true);
    }
  };
  const chooseGeneratedCast = () => {
    if (!props.userRoleChoiceMade) {
      setRoleChoicePrompt(true);
      setReadyToGenerateCast(false);
      return;
    }
    props.setStrategy("generated");
    setRoleChoicePrompt(false);
    setReadyToGenerateCast(false);
  };
  if (step === "script") return <>{estimate}<Button type="button" onClick={props.onGenerate} disabled={props.pending} data-testid="button-guided-generate-script">Generate script</Button></>;
  if (step === "review" || props.scriptEditorOpen) return <>{estimate}{voiceLanguageNote}<ScriptReview {...props} /></>;
  if (step === "ready") return <>{estimate}<p data-testid="status-guided-cast-complete">Cast is saved. Review and approve each role’s current references before the storyboard.</p><CastApprovalStep {...props} />{voiceLanguageNote}<VisualConsistencyStep {...props} /><BackdropReviewStep draft={draft} />{props.enqueueError && <p className="text-sm text-destructive" role="alert" data-testid="error-guided-enqueue">{props.enqueueError}</p>}<Button type="button" onClick={props.onEnqueue} disabled={props.pending || (props.existingJobId === null && (!props.castApprovalsComplete || !draft.visualChoices?.backdropReference?.approvedAt)) || !props.visualSaved || !!props.visualUploading} data-testid="button-guided-enqueue">{props.failedBeforeStoryboard ? "Edit story and rebuild storyboard" : props.existingJobId ? "Open existing storyboard job" : props.enqueuePending ? "Starting storyboard…" : "Build storyboard for review"}</Button></>;
  return <>{estimate}<ScriptSummary script={draft.script} /><Button type="button" variant="outline" onClick={props.onBackToScript} data-testid="button-guided-back-to-script">Back to scene editor</Button><div className={roleChoicePrompt ? "space-y-3 rounded-lg border-2 border-amber-500 bg-amber-50 p-3 ring-4 ring-amber-200/60 dark:bg-amber-950/20" : "space-y-3"} data-testid="section-guided-user-role"><h3 className="font-semibold">Which character are you playing?</h3>{roleChoicePrompt && <p className="text-sm font-medium text-amber-800 dark:text-amber-200" role="alert" data-testid="error-guided-user-role">Choose your character, or select “None — I’m not playing a character,” before generating the remaining cast.</p>}<div className="flex flex-wrap gap-2"><Button type="button" aria-pressed={props.userRoleChoiceMade && props.userRoleId === null} variant={props.userRoleChoiceMade && props.userRoleId === null ? "default" : "outline"} className={roleChoicePrompt ? "ring-2 ring-amber-400 ring-offset-2" : undefined} onClick={() => chooseUserRole(null)} data-testid="button-guided-user-role-none">None — I’m not playing a character</Button>{draft.script.roles.map((role: any) => <Button type="button" key={role.id} aria-pressed={props.userRoleId === role.id} variant={props.userRoleId === role.id ? "default" : "outline"} className={roleChoicePrompt ? "ring-2 ring-amber-400 ring-offset-2" : undefined} onClick={() => chooseUserRole(role.id)} data-testid={`button-guided-user-role-${role.id}`}>{role.name}</Button>)}</div></div><div className="flex gap-2"><Button type="button" variant={props.strategy === "generated" ? "default" : "outline"} onClick={chooseGeneratedCast} data-testid="button-guided-cast-generated">Generate remaining cast</Button><Button type="button" variant={props.strategy === "saved" ? "default" : "outline"} onClick={() => { props.setStrategy("saved"); setRoleChoicePrompt(false); setReadyToGenerateCast(false); }} data-testid="button-guided-cast-saved">Use saved characters</Button></div>{readyToGenerateCast && <p className="text-sm font-medium text-primary" role="status" data-testid="status-guided-ready-generate-cast">Role selected. Now click “Generate remaining cast” to continue.</p>}{elevenLabsVoiceCount > 0 && <p className="text-sm font-medium text-primary" role="status" data-testid="status-guided-elevenlabs-voices">{elevenLabsVoiceCount} ElevenLabs premade voices loaded — open any voice menu to choose one.</p>}{props.needsSaved.length > 0 && characters.length === 0 && <><p data-testid="status-guided-empty-characters">No saved characters are available for the selected roles.</p><Button type="button" variant="outline" onClick={props.onManageCharacters} data-testid="button-guided-manage-characters">Manage characters</Button></>}{props.voiceCatalogWarning && <p className="text-sm text-amber-700 dark:text-amber-300" role="status" data-testid="status-guided-voice-catalog-error">{props.voiceCatalogWarning}</p>}{props.needsSaved.map((role: any) => <CastFields key={role.id} role={role} {...props} />)}{props.strategy === "generated" && props.userRoleChoiceMade && draft.script.roles.filter((role: any) => role.id !== props.userRoleId).map((role: any) => <GeneratedCastVoice key={role.id} role={role} {...props} />)}{props.needsSaved.length > 0 && <div className="flex items-center gap-2"><Checkbox checked={props.consent} onCheckedChange={(value) => props.setConsent(value === true)} data-testid="checkbox-guided-consent" /><Label>I have permission to use each saved person’s likeness and selected voice for this attempt.</Label></div>}{props.hasDuplicate && <div className="flex items-center gap-2"><Checkbox checked={props.duplicateConfirmed} onCheckedChange={(value) => props.setDuplicateConfirmed(value === true)} data-testid="checkbox-guided-duplicate-confirmation" /><Label>I confirm one performer may play multiple roles.</Label></div>}{props.castBusyRole && <div className="flex items-center gap-3 rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm" role="status" aria-live="polite" data-testid="status-guided-cast-progress"><Loader2 className="h-5 w-5 animate-spin text-primary" aria-hidden="true" /><span><b>Generating {props.castBusyRole}’s cast…</b><br /><span className="text-muted-foreground">KOKAO is checking progress automatically. You can keep this page open.</span></span></div>}{props.castSaveError && <p className="text-sm text-destructive" role="alert" data-testid="error-guided-save-cast">{props.castSaveError}</p>}<div className="flex flex-wrap items-center gap-3"><Button type="button" disabled={!props.castComplete || (props.hasDuplicate && !props.duplicateConfirmed) || props.pending} onClick={props.onCast} data-testid="button-guided-save-cast">{props.castSaving ? "Saving cast…" : props.castBusyRole ? `Generating ${props.castBusyRole}…` : props.castSaveError ? "Retry saving cast" : "Save cast and continue"}</Button>{props.castSaving && !props.castBusyRole && <span className="inline-flex items-center gap-2 text-sm text-muted-foreground" role="status" aria-live="polite" data-testid="status-guided-cast-saving"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /><span><b>Saving your cast choices…</b> Securing the selected characters and voices. This can take a moment.</span></span>}</div></>;
}



function BackdropReviewStep({ draft }: { draft: GuidedStoryDraft }) {
  const queryClient = useQueryClient();
  const requestUploadUrl = useRequestUploadUrl();
  const prepare = usePrepareGuidedStoryBackdrop();
  const approve = useApproveGuidedStoryBackdrop();
  const visuals = draft.visualChoices;
  const [prompt, setPrompt] = useState(
    visuals?.backdropReference?.prompt ??
      (visuals?.location.mode === "text" ? visuals.location.description : ""),
  );
  const [file, setFile] = useState<File | null>(null);
  const [enlarged, setEnlarged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reference = visuals?.backdropReference;
  const hasUnsavedBackdropEdits = !!file ||
    prompt.trim() !== (reference?.prompt.trim() ?? "");
  if (!visuals) {
    return <Card data-testid="card-guided-backdrop-review"><CardHeader><CardTitle>Backdrop / location reference</CardTitle><CardDescription>Backdrop review is required before previews.</CardDescription></CardHeader><CardContent><p className="text-sm text-destructive" role="alert" data-testid="error-guided-backdrop-missing">This older draft has no visual choices. Save visual consistency settings and prepare a backdrop reference before building the storyboard.</p></CardContent></Card>;
  }
  const refresh = (next: GuidedStoryDraft) => {
    queryClient.setQueryData(getGetGuidedStoryDraftQueryKey(next.id), next);
  };
  const prepareCandidate = async () => {
    setError(null);
    try {
      let imagePath =
        visuals.location.mode === "image"
          ? visuals.location.imagePath
          : null;
      if (file) {
        if (!VISUAL_IMAGE_TYPES.includes(file.type) || file.size > MAX_VISUAL_IMAGE_BYTES) {
          throw new Error("Use a PNG, JPEG, or WebP image no larger than 10 MB.");
        }
        const upload = await requestUploadUrl.mutateAsync({
          data: { name: file.name, size: file.size, contentType: file.type },
        });
        const put = await fetch(upload.uploadURL, {
          method: "PUT",
          body: file,
          headers: { "Content-Type": file.type },
        });
        if (!put.ok) throw new Error(`Upload failed (${put.status}).`);
        imagePath = upload.objectPath;
      }
      if (!imagePath) throw new Error("Upload a rendered location reference first.");
      const next = await prepare.mutateAsync({
        draftId: draft.id,
        data: {
          revision: draft.revision,
          prompt: prompt.trim(),
          imagePath,
          sceneIds: draft.script?.scenes.map((scene) => scene.id) ?? [],
        },
      });
      refresh(next);
      setFile(null);
    } catch (cause) {
      setError(apiErrorMessage(cause, "Could not prepare this backdrop."));
    }
  };
  return <Card data-testid="card-guided-backdrop-review">
    <CardHeader>
      <CardTitle>Backdrop / location reference</CardTitle>
      <CardDescription>Review this shared location before any scene previews are generated. Approval freezes the exact image and prompt for every listed scene. Editing the prompt changes reference guidance; upload a newly rendered image when the visual itself should change.</CardDescription>
    </CardHeader>
    <CardContent className="space-y-3">
      {reference && <button type="button" onClick={() => setEnlarged(true)} aria-label="Enlarge backdrop reference" data-testid="button-enlarge-guided-backdrop">
        <img src={`/api/storage${reference.imagePath}`} alt="Shared backdrop reference" className="h-40 w-64 rounded-md border object-cover" />
      </button>}
      <div><Label htmlFor="guided-backdrop-prompt">Backdrop prompt</Label><Textarea id="guided-backdrop-prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Describe the shared location and stable environmental details" data-testid="input-guided-backdrop-prompt" /></div>
      <div><Label htmlFor="guided-backdrop-upload">Upload rendered replacement</Label><Input id="guided-backdrop-upload" type="file" accept={VISUAL_IMAGE_TYPES.join(",")} onChange={(event) => setFile(event.target.files?.[0] ?? null)} data-testid="input-guided-backdrop-upload" /></div>
      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" disabled={prepare.isPending || prompt.trim().length < 3} onClick={() => void prepareCandidate()} data-testid="button-prepare-guided-backdrop">{prepare.isPending ? "Preparing…" : reference ? "Save backdrop review changes" : "Prepare backdrop review"}</Button>
        <Button type="button" disabled={!reference || !!reference.approvedAt || approve.isPending || hasUnsavedBackdropEdits} onClick={() => reference && approve.mutate({ draftId: draft.id, data: { revision: draft.revision, fingerprint: reference.fingerprint } }, { onSuccess: refresh, onError: (cause) => setError(apiErrorMessage(cause, "Could not approve this backdrop.")) })} data-testid="button-approve-guided-backdrop">{reference?.approvedAt ? "Backdrop approved" : approve.isPending ? "Approving…" : "Approve for all scenes"}</Button>
      </div>
      {hasUnsavedBackdropEdits && <p className="text-sm text-amber-700" role="status" data-testid="status-guided-backdrop-unsaved">Save backdrop review changes before approval.</p>}
      {!reference?.approvedAt && <p className="text-sm font-medium text-amber-700" role="status">Scene preview generation stays locked until this backdrop and the cast are approved.</p>}
      <Dialog open={enlarged} onOpenChange={setEnlarged}><DialogContent className="max-w-4xl"><DialogHeader><DialogTitle>Shared backdrop reference</DialogTitle><DialogDescription>Inspect the exact frozen location plate before approving it.</DialogDescription></DialogHeader>{reference && <img src={`/api/storage${reference.imagePath}`} alt="Enlarged shared backdrop" className="mx-auto max-h-[70vh] max-w-full object-contain" data-testid="image-enlarged-guided-backdrop" />}</DialogContent></Dialog>
    </CardContent>
  </Card>;
}

function CastApprovalStep(props: any) {
  const [reviewRoleId, setReviewRoleId] = useState<string | null>(null);
  const roles = props.draft.script?.roles ?? [];
  const manifest = props.draft.castApprovals;
  const manifestIsCurrent = manifest?.draftRevision === props.draft.revision;
  const pendingNames = props.pendingCastApprovalRoles.map((role: any) => role.name);
  const selected = props.draft.cast.find((item: any) => item.roleId === reviewRoleId);
  return <section className="space-y-3" aria-labelledby="guided-cast-approval-heading" data-testid="section-guided-cast-approvals">
    <div>
      <h3 id="guided-cast-approval-heading" className="font-semibold">Approve cast references</h3>
      <p className="text-sm text-muted-foreground">Approval is tied to the exact character and outfit reference bytes in this draft revision.</p>
    </div>
    {!props.castApprovalsComplete && <div className="rounded-md border border-amber-500/40 bg-amber-50 p-3 text-sm dark:bg-amber-950/20" role="status" data-testid="status-guided-cast-approval-checklist"><b>Storyboard is blocked until these roles are approved:</b><ul className="mt-1 list-disc pl-5">{pendingNames.map((name: string) => <li key={name}>{name}</li>)}</ul></div>}
    <div className="grid gap-3 md:grid-cols-2">
      {roles.map((role: any) => {
        const cast = props.draft.cast.find((item: any) => item.roleId === role.id);
        const approved = !!manifestIsCurrent && !!manifest?.roles[role.id];
        return <Card key={role.id} className="border-primary/20" data-testid={`card-guided-cast-approval-${role.id}`}>
          <CardHeader className="pb-2"><CardTitle className="text-base">{role.name}</CardTitle><CardDescription data-testid={`status-guided-cast-approval-${role.id}`}>{approved ? "Approved for this draft revision" : manifest && !manifestIsCurrent ? "Approval is stale — review and reapprove" : "Approval needed"}</CardDescription></CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-2 text-sm">
              <ReferenceThumbnail label="Character" asset={cast?.character} />
              <ReferenceThumbnail label="Outfit" asset={cast?.outfit} />
            </div>
            {props.castApprovalError?.roleId === role.id && <p className="text-sm text-destructive" role="alert" data-testid={`error-guided-cast-approval-${role.id}`}>{props.castApprovalError.message}</p>}
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" onClick={() => setReviewRoleId(role.id)} data-testid={`button-guided-review-cast-${role.id}`}>Review references</Button>
              <Button type="button" onClick={() => props.onApproveCastRole(role.id)} disabled={props.pending || !cast} data-testid={`button-guided-approve-cast-${role.id}`}>{props.castApprovalPending ? "Approving…" : approved ? "Reapprove" : "Approve"}</Button>
            </div>
          </CardContent>
        </Card>;
      })}
    </div>
    <Dialog open={reviewRoleId !== null} onOpenChange={(open) => !open && setReviewRoleId(null)}>
      <DialogContent className="max-w-2xl" data-testid="dialog-guided-cast-review">
        <DialogHeader><DialogTitle>Review {roles.find((role: any) => role.id === reviewRoleId)?.name} references</DialogTitle><DialogDescription>Confirm the exact character and outfit images before approving this role.</DialogDescription></DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <ReferenceThumbnail label="Character" asset={selected?.character} enlarged />
          <ReferenceThumbnail label="Outfit" asset={selected?.outfit} enlarged />
        </div>
      </DialogContent>
    </Dialog>
  </section>;
}
function VisualConsistencyStep(props: any) {
  const choices = props.visualChoices as VisualChoices;
  const scenes = props.draft.script?.scenes ?? [];
  const updateLocationMode = (mode: "none" | "image" | "text") => {
    props.setVisualChoices((current: VisualChoices) => ({
      ...current,
      location: mode === "none" ? { mode, imagePath: null, description: null }
        : mode === "image" ? { mode, imagePath: current.location.mode === "image" ? current.location.imagePath : "", description: null }
          : { mode, imagePath: null, description: current.location.mode === "text" ? current.location.description : "" },
    }));
  };
  return <Card className="border-primary/30" data-testid="guided-visual-consistency">
    <CardHeader className="pb-3"><CardTitle className="text-base">Visual consistency (optional)</CardTitle><CardDescription>These choices are frozen into this storyboard attempt. Leave everything off to skip them.</CardDescription></CardHeader>
    <CardContent className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="input-guided-logo">Logo (optional)</Label>
        <Input id="input-guided-logo" type="file" accept={VISUAL_IMAGE_TYPES.join(",")} onChange={(event) => { const file = event.target.files?.[0]; if (file) void props.onUploadVisual("logo", file); }} data-testid="input-guided-logo" />
        {props.visualUploading === "logo" && <p role="status" data-testid="status-guided-logo-upload">Uploading logo…</p>}
        {choices.logo.path && <p className="text-sm" data-testid="status-guided-logo-selected">Logo selected. Choose scenes that should show it:</p>}
        {choices.logo.path && <div className="grid gap-2">{scenes.map((scene: any, index: number) => <div className="flex items-center gap-2" key={scene.id}><Checkbox checked={choices.logo.sceneIds.includes(scene.id)} onCheckedChange={(checked) => props.setVisualChoices((current: VisualChoices) => ({ ...current, logo: { ...current.logo, sceneIds: checked === true ? [...new Set([...current.logo.sceneIds, scene.id])] : current.logo.sceneIds.filter((id) => id !== scene.id) } }))} data-testid={`checkbox-guided-logo-scene-${scene.id}`} /><Label>Scene {index + 1}</Label></div>)}</div>}
      </div>
      <div className="space-y-2">
        <Label>Shared location reference (optional)</Label>
        <div className="flex flex-wrap gap-2">
          {(["none", "image", "text"] as const).map((mode) => <Button type="button" size="sm" variant={choices.location.mode === mode ? "default" : "outline"} onClick={() => updateLocationMode(mode)} data-testid={`button-guided-location-${mode}`} key={mode}>{mode === "none" ? "No shared location" : mode === "image" ? "Background photo" : "Location description"}</Button>)}
        </div>
        {choices.location.mode === "image" && <><Input type="file" accept={VISUAL_IMAGE_TYPES.join(",")} onChange={(event) => { const file = event.target.files?.[0]; if (file) void props.onUploadVisual("background", file); }} data-testid="input-guided-background" />{props.visualUploading === "background" && <p role="status" data-testid="status-guided-background-upload">Uploading background…</p>}{choices.location.imagePath ? <p data-testid="status-guided-background-selected">Shared background photo selected.</p> : <p className="text-sm text-muted-foreground">Upload one PNG, JPEG, or WebP background photo.</p>}</>}
        {choices.location.mode === "text" && <Textarea value={choices.location.description} onChange={(event) => props.setVisualChoices((current: VisualChoices) => ({ ...current, location: { mode: "text", imagePath: null, description: event.target.value } }))} placeholder="e.g. a warm bookshop with tall windows" data-testid="input-guided-location-description" />}
      </div>
      {props.visualError && <p className="text-sm text-destructive" role="alert" data-testid="error-guided-visuals">{props.visualError}</p>}
      {!props.visualSaved && <p className="text-sm text-amber-700" data-testid="status-guided-visuals-unsaved">Save these choices before building the storyboard.</p>}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" onClick={props.onSaveVisual} disabled={props.pending || !!props.visualUploading || (choices.location.mode === "image" && !choices.location.imagePath) || (choices.location.mode === "text" && choices.location.description.trim().length < 3)} data-testid="button-guided-save-visuals">{props.visualSaved ? "Visual choices saved" : "Save visual choices"}</Button>
        {props.pending && (
          <span className="inline-flex items-center gap-2 text-sm text-muted-foreground" role="status" aria-live="polite" data-testid="status-guided-visuals-saving">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Saving visual choices…
          </span>
        )}
      </div>
    </CardContent>
  </Card>;
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
  const { script } = props.draft as { script: GuidedStoryScript };
  const [editedScript, setEditedScript] = useState<GuidedStoryScript>(script);
  const [jsonText, setJsonText] = useState(() => JSON.stringify(script, null, 2));
  const [jsonOpen, setJsonOpen] = useState(false);
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [saveFeedback, setSaveFeedback] = useState<
    { kind: "idle" | "saving" | "saved" | "error"; message?: string }
  >({ kind: "idle" });
  const [insertionIndex, setInsertionIndex] = useState<number | null>(null);
  const [insertionPrompt, setInsertionPrompt] = useState("");
  const [insertionError, setInsertionError] = useState<string | null>(null);
  const [nativeScriptAcknowledged, setNativeScriptAcknowledged] = useState(false);
  const localRevisionRef = useRef(0);
  const insertionRequestRef = useRef(0);
  const editedScriptRef = useRef(editedScript);
  const draftRevisionRef = useRef(props.draft.revision);
  const serverScriptRef = useRef(script);
  const generateScene = useGenerateGuidedStoryDraftScene();
  const storyLocale = guidedStoryLocaleOption(props.draft.setup.locale);
  const writingSystemWarning = guidedStoryWritingSystemWarning(
    editedScript,
    props.draft.setup.locale,
  );
  const elevenLabsCapabilityWarning = guidedStoryElevenLabsCapabilityWarning(
    props.draft.setup.locale,
  );

  editedScriptRef.current = editedScript;
  draftRevisionRef.current = props.draft.revision;

  useEffect(() => {
    const currentText = JSON.stringify(editedScriptRef.current);
    const previousServerText = JSON.stringify(serverScriptRef.current);
    const nextServerText = JSON.stringify(script);
    serverScriptRef.current = script;
    // Polling may deliver a new draft while the user is typing. Only adopt it
    // when the readable editor is clean (or the response is exactly our save).
    if (currentText === previousServerText || currentText === nextServerText) {
      setEditedScript(script);
      setJsonText(JSON.stringify(script, null, 2));
      setJsonError(null);
      localRevisionRef.current += 1;
    }
  }, [script]);

  const updateScript = (next: GuidedStoryScript) => {
    setSaveFeedback({ kind: "idle" });
    setNativeScriptAcknowledged(false);
    localRevisionRef.current += 1;
    editedScriptRef.current = next;
    setEditedScript(next);
    setJsonText(JSON.stringify(next, null, 2));
    setJsonError(null);
  };
  const addScene = () => {
    if (editedScript.scenes.length >= 40) return;
    const totalMs = editedScript.scenes.at(-1)?.endMs ?? Math.round(editedScript.runtimeSeconds * 1000);
    if (totalMs < 2_000) return;
    const newDuration = Math.max(
      1_000,
      Math.min(5_000, Math.floor(totalMs / (editedScript.scenes.length + 1))),
    );
    const existingEnd = totalMs - newDuration;
    const factor = existingEnd / totalMs;
    const scenes = editedScript.scenes.map((scene) => ({
      ...scene,
      startMs: Math.round(scene.startMs * factor),
      endMs: Math.round(scene.endMs * factor),
      lines: scene.lines.map((line) => ({
        ...line,
        startMs: Math.round(line.startMs * factor),
        endMs: Math.round(line.endMs * factor),
      })),
    }));
    let sceneNumber = scenes.length + 1;
    while (scenes.some((scene) => scene.id === `scene-${sceneNumber}`)) sceneNumber += 1;
    let lineNumber = sceneNumber;
    const existingLineIds = new Set(scenes.flatMap((scene) => scene.lines.map((line) => line.id)));
    while (existingLineIds.has(`scene-${sceneNumber}-line-${lineNumber}`)) lineNumber += 1;
    scenes.push({
      id: `scene-${sceneNumber}`,
      startMs: existingEnd,
      endMs: totalMs,
      visualDirection: "Describe what happens in this scene.",
      roleIds: [],
      lines: [{
        id: `scene-${sceneNumber}-line-${lineNumber}`,
        ownerRoleId: null,
        kind: "narration",
        text: "Add the spoken line for this scene.",
        startMs: existingEnd,
        endMs: totalMs,
      }],
    });
    updateScript({ ...editedScript, scenes });
  };
  const moveScene = (fromIndex: number, toIndex: number) => {
    if (
      fromIndex === toIndex ||
      fromIndex < 0 ||
      toIndex < 0 ||
      fromIndex >= editedScript.scenes.length ||
      toIndex >= editedScript.scenes.length
    ) return;

    const reordered = [...editedScript.scenes];
    const [moved] = reordered.splice(fromIndex, 1);
    if (!moved) return;
    reordered.splice(toIndex, 0, moved);

    let cursorMs = 0;
    const scenes = reordered.map((scene) => {
      const durationMs = Math.max(0, scene.endMs - scene.startMs);
      const shiftMs = cursorMs - scene.startMs;
      const shifted = {
        ...scene,
        startMs: cursorMs,
        endMs: cursorMs + durationMs,
        lines: scene.lines.map((line) => ({
          ...line,
          startMs: line.startMs + shiftMs,
          endMs: line.endMs + shiftMs,
        })),
      };
      cursorMs += durationMs;
      return shifted;
    });

    updateScript({ ...editedScript, scenes });
  };
  const canAddCharacter = editedScript.roles.length < 4;
  const addCharacter = () => {
    if (!canAddCharacter) return;
    let roleNumber = editedScript.roles.length + 1;
    while (editedScript.roles.some((role) => role.id === `role-${roleNumber}`)) roleNumber += 1;
    updateScript({
      ...editedScript,
      roles: [
        ...editedScript.roles,
        {
          id: `role-${roleNumber}`,
          name: `Character ${roleNumber}`,
          description: "Describe this character’s appearance, personality, and role in the story.",
        },
      ],
    });
  };
  const requestGeneratedScene = () => {
    if (insertionIndex === null || insertionPrompt.trim().length < 3 || generateScene.isPending) return;
    const requestedIndex = insertionIndex;
    const retryRequested = insertionError !== null;
    if (retryRequested) {
      trackGuidedStoryEvent("guided_scene_retry_requested", {
        insertion_position: requestedIndex + 1,
        role_count: editedScriptRef.current.roles.length,
        scene_count: editedScriptRef.current.scenes.length,
      });
    }
    const requestToken = ++insertionRequestRef.current;
    const requestedRevision = props.draft.revision;
    const requestedLocalRevision = localRevisionRef.current;
    const requestedSnapshot = JSON.stringify(editedScriptRef.current);
    setInsertionError(null);
    generateScene.mutate(
      {
        draftId: props.draft.id,
        data: {
          revision: requestedRevision,
          insertionIndex: requestedIndex,
          description: insertionPrompt.trim(),
          script: editedScriptRef.current,
        },
      },
      {
        onSuccess: (result) => {
          if (
            insertionRequestRef.current !== requestToken ||
            result.revision !== requestedRevision ||
            draftRevisionRef.current !== requestedRevision ||
            localRevisionRef.current !== requestedLocalRevision ||
            JSON.stringify(editedScriptRef.current) !== requestedSnapshot
          ) {
            setInsertionError("The script changed while this scene was being created. Retry to use the latest version.");
            return;
          }
          updateScript(result.script);
          trackGuidedStoryEvent("guided_scene_generation_succeeded", {
            insertion_position: requestedIndex + 1,
            role_count: result.script.roles.length,
            scene_count: result.script.scenes.length,
          });
          setInsertionIndex(null);
          setInsertionPrompt("");
          setInsertionError(null);
        },
        onError: (error) => {
          setInsertionError(apiErrorMessage(error, "Could not create this scene. Your script was not changed."));
        },
      },
    );
  };
  const dirty = JSON.stringify(editedScript) !== JSON.stringify(script);
  const openSceneInsertion = (index: number) => {
    setInsertionIndex(index);
    setInsertionPrompt("");
    setInsertionError(null);
    trackGuidedStoryEvent("guided_scene_prompt_opened", {
      insertion_position: index + 1,
      role_count: editedScript.roles.length,
      scene_count: editedScript.scenes.length,
    });
  };

  return (
    <>
      <ScriptSummary script={editedScript} />
      <div className="space-y-4" data-testid="guided-readable-script">
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="guided-script-title">Title</Label>
            <Input
              id="guided-script-title"
              value={editedScript.title}
              onChange={(event) => updateScript({ ...editedScript, title: event.target.value })}
              data-testid="input-guided-script-title"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="guided-script-logline">Story summary</Label>
            <Input
              id="guided-script-logline"
              value={editedScript.logline}
              onChange={(event) => updateScript({ ...editedScript, logline: event.target.value })}
              data-testid="input-guided-script-logline"
            />
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold">Characters</h3>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={addCharacter}
              disabled={!canAddCharacter}
              data-testid="button-guided-add-character"
            >
              Add character
            </Button>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {editedScript.roles.map((role, roleIndex) => (
              <div className="space-y-2 rounded-lg border bg-muted/20 p-3" key={role.id}>
                <Input
                  aria-label={`Character ${roleIndex + 1} name`}
                  value={role.name}
                  onChange={(event) => {
                    const roles = editedScript.roles.map((item, index) =>
                      index === roleIndex ? { ...item, name: event.target.value } : item,
                    );
                    updateScript({ ...editedScript, roles });
                  }}
                  data-testid={`input-guided-role-name-${role.id}`}
                />
                <Textarea
                  aria-label={`${role.name} description`}
                  rows={2}
                  value={role.description}
                  onChange={(event) => {
                    const roles = editedScript.roles.map((item, index) =>
                      index === roleIndex ? { ...item, description: event.target.value } : item,
                    );
                    updateScript({ ...editedScript, roles });
                  }}
                  data-testid={`input-guided-role-description-${role.id}`}
                />
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold">Script</h3>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={addScene}
              disabled={editedScript.scenes.length >= 40}
              data-testid="button-guided-add-scene"
            >
              Add scene
            </Button>
          </div>
          {editedScript.scenes.map((scene, sceneIndex) => (
            <div key={scene.id}>
              <SceneInsertionControl
                index={sceneIndex}
                open={insertionIndex === sceneIndex}
                prompt={insertionPrompt}
                error={insertionIndex === sceneIndex ? insertionError : null}
                pending={generateScene.isPending && insertionIndex === sceneIndex}
                disabled={editedScript.scenes.length >= 40}
                onOpen={() => openSceneInsertion(sceneIndex)}
                onPromptChange={setInsertionPrompt}
                onSubmit={requestGeneratedScene}
                onCancel={() => { insertionRequestRef.current += 1; setInsertionIndex(null); setInsertionPrompt(""); setInsertionError(null); generateScene.reset?.(); }}
              />
              <div
              className="space-y-3 rounded-lg border bg-card p-4"
              data-testid={`card-guided-script-scene-${scene.id}`}
            >
              <div className="flex items-center justify-between gap-3">
                <p className="font-semibold">Scene {sceneIndex + 1}</p>
                <div className="flex items-center gap-1">
                  <p className="mr-1 text-xs text-muted-foreground">
                    {Math.max(0, Math.round((scene.endMs - scene.startMs) / 1000))}s
                  </p>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8"
                    disabled={sceneIndex === 0}
                    aria-label={`Move scene ${sceneIndex + 1} up`}
                    title="Move scene up"
                    onClick={() => moveScene(sceneIndex, sceneIndex - 1)}
                    data-testid={`button-guided-scene-move-up-${scene.id}`}
                  >
                    <ArrowUp className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8"
                    disabled={sceneIndex === editedScript.scenes.length - 1}
                    aria-label={`Move scene ${sceneIndex + 1} down`}
                    title="Move scene down"
                    onClick={() => moveScene(sceneIndex, sceneIndex + 1)}
                    data-testid={`button-guided-scene-move-down-${scene.id}`}
                  >
                    <ArrowDown className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`guided-scene-visual-${scene.id}`}>Visual direction</Label>
                <Textarea
                  id={`guided-scene-visual-${scene.id}`}
                  rows={2}
                  value={scene.visualDirection}
                  onChange={(event) => {
                    const scenes = editedScript.scenes.map((item, index) =>
                      index === sceneIndex ? { ...item, visualDirection: event.target.value } : item,
                    );
                    updateScript({ ...editedScript, scenes });
                  }}
                  data-testid={`input-guided-scene-visual-${scene.id}`}
                />
              </div>
              <div className="space-y-2">
                <Label>Characters in this scene</Label>
                <div className="flex flex-wrap gap-3">
                  {editedScript.roles.map((role) => (
                    <label className="flex items-center gap-2 text-sm" key={role.id}>
                      <Checkbox
                        checked={scene.roleIds.includes(role.id)}
                        onCheckedChange={(checked) => {
                          const roleIds = checked === true
                            ? Array.from(new Set([...scene.roleIds, role.id]))
                            : scene.roleIds.filter((roleId) => roleId !== role.id);
                          const scenes = editedScript.scenes.map((item, index) =>
                            index === sceneIndex ? { ...item, roleIds } : item,
                          );
                          updateScript({ ...editedScript, scenes });
                        }}
                        data-testid={`checkbox-guided-scene-${scene.id}-role-${role.id}`}
                      />
                      {role.name}
                    </label>
                  ))}
                </div>
              </div>
              <div className="space-y-3">
                {scene.lines.length === 0 ? (
                  <p className="text-sm italic text-muted-foreground">No spoken lines in this scene.</p>
                ) : scene.lines.map((line, lineIndex) => {
                  const owner = editedScript.roles.find((role) => role.id === line.ownerRoleId);
                  return (
                    <div className="grid gap-2 md:grid-cols-[11rem_1fr]" key={line.id}>
                      <Select
                        value={line.ownerRoleId ?? "narrator"}
                        onValueChange={(value) => {
                          const lines = scene.lines.map((item, index) =>
                            index === lineIndex
                              ? {
                                  ...item,
                                  ownerRoleId: value === "narrator" ? null : value,
                                  kind: value === "narrator" ? "narration" as const : "dialogue" as const,
                                }
                              : item,
                          );
                          const roleIds = value === "narrator"
                            ? scene.roleIds
                            : Array.from(new Set([...scene.roleIds, value]));
                          const scenes = editedScript.scenes.map((item, index) =>
                            index === sceneIndex ? { ...item, lines, roleIds } : item,
                          );
                          updateScript({ ...editedScript, scenes });
                        }}
                      >
                        <SelectTrigger
                          aria-label={`Speaker for scene ${sceneIndex + 1}, line ${lineIndex + 1}`}
                          data-testid={`select-guided-line-speaker-${line.id}`}
                        >
                          <SelectValue placeholder={owner?.name ?? "Narrator"} />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="narrator">Narrator</SelectItem>
                          {editedScript.roles.map((role) => (
                            <SelectItem key={role.id} value={role.id}>{role.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Textarea
                        aria-label={`Scene ${sceneIndex + 1}, line ${lineIndex + 1}`}
                        rows={2}
                        value={line.text}
                        onChange={(event) => {
                          const lines = scene.lines.map((item, index) =>
                            index === lineIndex ? { ...item, text: event.target.value } : item,
                          );
                          const scenes = editedScript.scenes.map((item, index) =>
                            index === sceneIndex ? { ...item, lines } : item,
                          );
                          updateScript({ ...editedScript, scenes });
                        }}
                        data-testid={`input-guided-line-${line.id}`}
                      />
                      {spokenLineNeedsNativeScriptWarning(line.text, storyLocale) && (
                        <p
                          className="col-start-2 text-xs text-amber-700 dark:text-amber-300"
                          role="alert"
                          data-testid={`warning-guided-line-script-${line.id}`}
                        >
                          Use {storyLocale?.script} characters for this {storyLocale?.label} spoken line, or explicitly approve the Romanized wording below.
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
              </div>
            </div>
          ))}
          <SceneInsertionControl
            index={editedScript.scenes.length}
            open={insertionIndex === editedScript.scenes.length}
            prompt={insertionPrompt}
            error={insertionIndex === editedScript.scenes.length ? insertionError : null}
            pending={generateScene.isPending && insertionIndex === editedScript.scenes.length}
            disabled={editedScript.scenes.length >= 40}
            onOpen={() => openSceneInsertion(editedScript.scenes.length)}
            onPromptChange={setInsertionPrompt}
            onSubmit={requestGeneratedScene}
            onCancel={() => { insertionRequestRef.current += 1; setInsertionIndex(null); setInsertionPrompt(""); setInsertionError(null); generateScene.reset?.(); }}
          />
        </div>
      </div>

      <Button
        type="button"
        variant="ghost"
        onClick={() => setJsonOpen((open) => !open)}
        data-testid="button-guided-toggle-json"
      >
        {jsonOpen ? "Hide JSON editor" : "Edit JSON"}
      </Button>
      {jsonOpen && (
        <div className="space-y-1.5">
          <Textarea
            rows={16}
            value={jsonText}
            onChange={(event) => {
              const value = event.target.value;
              setJsonText(value);
              try {
                const parsed = JSON.parse(value) as GuidedStoryScript;
                localRevisionRef.current += 1;
                editedScriptRef.current = parsed;
                setEditedScript(parsed);
                setJsonError(null);
                setSaveFeedback({ kind: "idle" });
              } catch {
                setJsonError("JSON is not valid yet. Fix it before saving.");
              }
            }}
            data-testid="input-guided-script"
          />
          {jsonError && (
            <p className="text-sm text-destructive" role="alert" data-testid="error-guided-script-json">
              {jsonError}
            </p>
          )}
        </div>
      )}
      {dirty && (
        <p className="text-sm text-amber-700 dark:text-amber-300" data-testid="status-guided-script-unsaved">
          You have unsaved script changes. Save them before approval.
        </p>
      )}
      {saveFeedback.kind === "saved" && (
        <p className="text-sm text-green-700 dark:text-green-300" role="status" data-testid="status-guided-script-saved">
          Changes saved.
        </p>
      )}
      {saveFeedback.kind === "error" && (
        <p className="text-sm text-destructive" role="alert" data-testid="error-guided-script-save">
          {saveFeedback.message}
        </p>
      )}
      {props.scriptApprovalError && (
        <p className="text-sm text-destructive" role="alert" data-testid="error-guided-script-approval">
          {props.scriptApprovalError}
        </p>
      )}
      {writingSystemWarning && (
        <div className="rounded-md border border-amber-500 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/20 dark:text-amber-100" role="alert" data-testid="warning-guided-native-script">
          <p>These spoken lines do not appear to use the {storyLocale?.label ?? props.draft.setup.locale} writing system.</p>
          <p>{writingSystemWarning}</p>
          <p>If the wording is intentionally Romanized, review every line and choose “Approve anyway.”</p>
        </div>
      )}
      {elevenLabsCapabilityWarning && (
        <p className="rounded-md border border-amber-500 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/20 dark:text-amber-100" role="alert" data-testid="warning-guided-elevenlabs-capability">
          {elevenLabsCapabilityWarning}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" onClick={props.onGenerate} disabled={props.pending} data-testid="button-guided-regenerate-script">Regenerate</Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setSaveFeedback({ kind: "saving" });
            props.onSaveScript(
              editedScript,
              (savedScript: GuidedStoryScript) => {
                serverScriptRef.current = savedScript;
                editedScriptRef.current = savedScript;
                setEditedScript(savedScript);
                setJsonText(JSON.stringify(savedScript, null, 2));
                setJsonError(null);
                localRevisionRef.current += 1;
                setSaveFeedback({ kind: "saved" });
              },
              (message: string) => setSaveFeedback({ kind: "error", message }),
            );
          }}
          disabled={props.pending || !dirty || jsonError !== null}
          data-testid="button-guided-save-script"
        >
          {saveFeedback.kind === "saving" ? "Saving…" : "Save changes"}
        </Button>
        <Button
          type="button"
          onClick={() => {
            if (writingSystemWarning && !nativeScriptAcknowledged) {
              setNativeScriptAcknowledged(true);
              return;
            }
            props.onApprove();
          }}
          disabled={props.pending || dirty || jsonError !== null || elevenLabsCapabilityWarning !== null}
          data-testid="button-guided-approve-script"
        >
          {writingSystemWarning && nativeScriptAcknowledged ? "Approve anyway" : "Approve script"}
        </Button>
        {saveFeedback.kind === "saving" && (
          <span className="inline-flex items-center gap-2 text-sm text-muted-foreground" role="status" aria-live="polite" data-testid="status-guided-script-saving">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Saving script changes…
          </span>
        )}
      </div>
    </>
  );
}
function SceneInsertionControl({
  index,
  open,
  prompt,
  error,
  pending,
  disabled,
  onOpen,
  onPromptChange,
  onSubmit,
  onCancel,
}: {
  index: number;
  open: boolean;
  prompt: string;
  error: string | null;
  pending: boolean;
  disabled: boolean;
  onOpen: () => void;
  onPromptChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  if (!open) return <div className="flex justify-center py-1"><Button type="button" size="sm" variant="outline" className="h-7 w-7 rounded-full p-0" aria-label={`Insert scene at position ${index + 1}`} onClick={onOpen} disabled={disabled} data-testid={`button-guided-insert-scene-${index}`}>+</Button></div>;
  return <div className="space-y-2 rounded-md border border-dashed bg-muted/20 p-3" data-testid={`form-guided-insert-scene-${index}`}>
    <Label htmlFor={`guided-insert-scene-prompt-${index}`}>What should happen in the new scene?</Label>
    <Textarea id={`guided-insert-scene-prompt-${index}`} rows={2} value={prompt} disabled={pending} onChange={(event) => onPromptChange(event.target.value)} data-testid={`input-guided-insert-scene-${index}`} />
    {error && <p className="text-sm text-destructive" role="alert" data-testid={`error-guided-insert-scene-${index}`}>{error}</p>}
    {pending && <p className="text-sm text-muted-foreground" data-testid={`status-guided-insert-scene-loading-${index}`}>Creating scene…</p>}
    <div className="flex gap-2">
      <Button type="button" size="sm" onClick={onSubmit} disabled={pending || prompt.trim().length < 3} data-testid={`button-guided-generate-scene-${index}`}>{error ? "Retry" : "Create scene"}</Button>
      <Button type="button" size="sm" variant="ghost" onClick={onCancel} data-testid={`button-guided-cancel-scene-${index}`}>{pending ? "Cancel" : "Close"}</Button>
    </div>
  </div>;
}
function stockVoiceLabel(voice: GuidedStoryVoiceCatalogItem): string {
  return BUILT_IN_VOICES.find((candidate) => candidate.id === voice.id)?.label ?? voice.label;
}

function VoiceOptions({
  voices,
  brandKits,
}: {
  voices: GuidedStoryVoiceCatalogItem[];
  brandKits: BrandKit[];
}) {
  const groups = [
    {
      id: "elevenlabs",
      label: "ElevenLabs premade voices",
      items: voices.filter(
        (voice) => voice.provider === "elevenlabs" && voice.brandKitId === null,
      ),
    },
    {
      id: "cloned",
      label: "Your cloned voices",
      items: voices.filter((voice) => voice.brandKitId !== null),
    },
    {
      id: "stock",
      label: "Built-in voices",
      items: voices.filter((voice) => voice.provider === "stock"),
    },
  ];
  return (
    <>
      {groups.filter((group) => group.items.length > 0).map((group) => (
        <SelectGroup key={group.id}>
          <SelectLabel>{group.label}</SelectLabel>
          {group.items.map((voice) => {
            const kit = voice.brandKitId === null
              ? null
              : brandKits.find((candidate) => candidate.id === voice.brandKitId);
            const label = voice.provider === "stock"
              ? stockVoiceLabel(voice)
              : kit
                ? `${voice.label} · ${kit.name}`
                : voice.label;
            return <SelectItem key={voice.id} value={voice.id}>{label}</SelectItem>;
          })}
        </SelectGroup>
      ))}
    </>
  );
}

function CastFields({ role, characters, voices, brandKits, assignments, updateAssignment }: any) {
  const item = assignments[role.id] ?? {};
  const character = characters.find((candidate: Character) => candidate.id === item.characterId);
  const selectableOutfits = character?.outfits.filter(
    (outfit: Character["outfits"][number]) =>
      !outfit.isDefault &&
      outfit.status === "approved" &&
      outfit.identityVerified,
  ) ?? [];
  return <div className="grid gap-2 rounded border p-3" data-testid={`card-guided-cast-${role.id}`}><b>{role.name}</b><Select value={item.characterId?.toString() ?? ""} onValueChange={(value) => updateAssignment(role.id, { characterId: Number(value), outfitId: null })}><SelectTrigger data-testid={`select-guided-character-${role.id}`}><SelectValue placeholder="Select saved character" /></SelectTrigger><SelectContent>{characters.map((candidate: Character) => <SelectItem key={candidate.id} value={String(candidate.id)}>{candidate.name}</SelectItem>)}</SelectContent></Select>{character && <Select value={item.outfitId?.toString() ?? "none"} onValueChange={(value) => updateAssignment(role.id, { outfitId: value === "none" ? null : Number(value) })}><SelectTrigger data-testid={`select-guided-outfit-${role.id}`}><SelectValue placeholder="Default outfit" /></SelectTrigger><SelectContent><SelectItem value="none">Default outfit</SelectItem>{selectableOutfits.map((outfit: Character["outfits"][number]) => <SelectItem key={outfit.id} value={String(outfit.id)}>{outfit.name}</SelectItem>)}</SelectContent></Select>}<Select value={item.voiceId ?? ""} onValueChange={(value) => updateAssignment(role.id, { voiceId: value })}><SelectTrigger data-testid={`select-guided-voice-${role.id}`}><SelectValue placeholder="Select voice" /></SelectTrigger><SelectContent><VoiceOptions voices={voices} brandKits={brandKits} /></SelectContent></Select></div>;
}
function GeneratedCastVoice({ role, voices, brandKits, assignments, updateAssignment }: any) {
  const item = assignments[role.id] ?? {};
  return <div className="rounded border border-dashed p-3" data-testid={`card-guided-generated-cast-${role.id}`}><b>{role.name}</b><p className="text-sm text-muted-foreground">The server will create a wholly fictional appearance and genre-appropriate wardrobe.</p><Select value={item.voiceId ?? voices[0]?.id ?? ""} onValueChange={(value) => updateAssignment(role.id, { voiceId: value })}><SelectTrigger data-testid={`select-guided-generated-voice-${role.id}`}><SelectValue placeholder="Select voice" /></SelectTrigger><SelectContent><VoiceOptions voices={voices} brandKits={brandKits} /></SelectContent></Select></div>;
}

function ReferenceThumbnail({ label, asset, enlarged = false }: { label: string; asset?: { name?: string; referenceImagePath?: string | null } | null; enlarged?: boolean }) {
  return <div className="space-y-1" data-testid={`reference-guided-${label.toLowerCase()}`}>
    <p className="font-medium">{label}</p>
    {asset?.referenceImagePath
      ? <img className={enlarged ? "h-64 w-full rounded-md border object-contain bg-muted" : "h-24 w-full rounded border object-cover"} src={asset.referenceImagePath} alt={`${label} reference${asset.name ? ` for ${asset.name}` : ""}`} data-testid={`img-guided-${label.toLowerCase()}-reference`} />
      : <p className="rounded border border-dashed p-2 text-xs text-muted-foreground">No {label.toLowerCase()} reference image is available.</p>}
    {asset?.name && <p className="text-xs text-muted-foreground">{asset.name}</p>}
  </div>;
}
