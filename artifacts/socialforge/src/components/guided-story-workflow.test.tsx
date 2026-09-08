import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";

const trackMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/analytics", () => ({ track: trackMock }));

// Radix Select uses these browser methods while opening its menu.
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = () => {};
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

const state: { draft: any; requestedDraftIds: number[]; draftRefetches: number; existingJob: any; created: any; generatedScripts: number; generationError: unknown; cast: any; castError: unknown; approvalError: unknown; castApprovalError: unknown; castApprovalRoles: Record<string, any>; customizationRequest: any; customizationError: unknown; referenceSheetReview: any; updated: any; translationRequest: any; translationError: unknown; uploadError: unknown; generatedImageRequest: any; enqueued: any; sceneRequest: any; sceneError: unknown; deferScene: boolean; completeScene: null | (() => void) } = {
  draft: undefined,
  requestedDraftIds: [],
  draftRefetches: 0,
  existingJob: null,
  created: null,
  generatedScripts: 0,
  generationError: null,
  cast: null,
  castError: null,
  approvalError: null,
  castApprovalError: null,
  castApprovalRoles: {},
  customizationRequest: null,
  customizationError: null,
  referenceSheetReview: null,
  updated: null,
  translationRequest: null,
  translationError: null,
  uploadError: null,
  generatedImageRequest: null,
  enqueued: null,
  sceneRequest: null,
  sceneError: null,
  deferScene: false,
  completeScene: null,
};
const contract = {
  id: "instagram_reels",
  aspectRatio: "9:16",
  width: 1080,
  height: 1920,
  safeArea: "Keep captions clear of top and bottom UI.",
  durations: [15, 30],
};
const script = {
  version: 1 as const, title: "The plan", logline: "A small choice changes the day.", runtimeSeconds: 15,
  roles: [{ id: "r1", name: "Ari", description: "Planner" }, { id: "r2", name: "Bo", description: "Friend" }],
  scenes: [{ id: "s1", startMs: 0, endMs: 15000, visualDirection: "A desk", roleIds: ["r1"], lines: [{ id: "l1", ownerRoleId: "r1", kind: "dialogue" as const, text: "Here is the plan.", startMs: 0, endMs: 3000 }] }], warnings: [],
};

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  const { useQuery } = await import("@tanstack/react-query");
  const mutation = (apply: (vars: any) => any) => () => ({
    isPending: false,
    mutate: (vars: any, options: any) => {
      try {
        options?.onSuccess?.(apply(vars));
      } catch (error) {
        options?.onError?.(error);
      } finally {
        options?.onSettled?.();
      }
    },
  });
  return createApiClientMock({
    getGetGuidedStoryDraftQueryKey: (id: number) => ["guided", id],
    getGetVideoJobQueryKey: (id: number) => ["video-job", id],
    getListCharactersQueryKey: () => ["characters"],
    useListGuidedStoryPlatforms: () => ({ data: [contract], isLoading: false }),
    useListGuidedStoryVoices: () => ({
      data: {
        voices: [
          { id: "stock:alloy", label: "alloy", provider: "stock", providerVoiceId: null, brandKitId: null },
          { id: "stock:nova", label: "nova", provider: "stock", providerVoiceId: null, brandKitId: null },
          { id: "elevenlabs:premade:el-rachel", label: "Rachel", provider: "elevenlabs", providerVoiceId: "el-rachel", brandKitId: null },
          { id: "brand-kit:3:voice-a", label: "A voice", provider: "elevenlabs", providerVoiceId: "voice-a", brandKitId: 3 },
        ],
        providerWarning: null,
      },
      isLoading: false,
      isError: false,
    }),
    useGetGuidedStoryDraft: (id: number, options: any) => {
      state.requestedDraftIds.push(id);
      return useQuery({
        queryKey: ["guided", id],
        queryFn: async () => {
          state.draftRefetches += 1;
          return state.draft;
        },
        initialData: state.draft,
        enabled: options?.query?.enabled,
        staleTime: Infinity,
      });
    },
    useGetVideoJob: () => ({ data: state.existingJob, isLoading: false }),
    useCreateGuidedStoryDraft: mutation((vars) => {
      state.created = vars.data;
      const next = { id: 7, revision: 1, version: 1, setup: { ...vars.data, aspectRatio: "9:16", width: 1080, height: 1920, safeArea: contract.safeArea }, script: null, scriptApprovedAt: null, userRoleId: null, castStrategy: null, cast: [], duplicateAssignmentConfirmed: false, scriptGeneration: null, storyboardJobId: null, estimates: { scriptUnits: 1, castAssetUnits: 2, previewUnits: 3, finalAdditionalUnits: 4, totalRemainingUnits: 10 }, createdAt: "", updatedAt: "" };
      state.draft = next;
      return next;
    }),
    useGenerateGuidedStoryDraftScript: mutation(() => {
      state.generatedScripts += 1;
      if (state.generationError) {
        const latestDraft = (state.generationError as any).latestDraft;
        if (latestDraft) state.draft = latestDraft;
        throw state.generationError;
      }
      state.draft = {
        ...state.draft,
        revision: state.draft.revision + 1,
        script,
        scriptApprovedAt: null,
      };
      return state.draft;
    }),
    useApproveGuidedStoryDraftScript: mutation(() => {
      if (state.approvalError) throw state.approvalError;
      return {
        ...state.draft,
        revision: state.draft.revision + 1,
        scriptApprovedAt: "2026-08-30T00:00:00.000Z",
        storyboardJobId: null,
      };
    }),
    useApproveGuidedStoryCastRole: mutation((vars) => {
      if (state.castApprovalError) throw state.castApprovalError;
      state.castApprovalRoles[vars.roleId] = {
        roleId: vars.roleId,
        approvedAt: "2026-08-30T00:00:00.000Z",
        character: { referenceImagePath: "/character.png", sha256: "a".repeat(64) },
        outfit: { referenceImagePath: "/outfit.png", sha256: "b".repeat(64) },
      };
      return {
        ...state.draft,
        revision: vars.data.revision,
        cast: state.cast?.assignments ?? state.draft.cast,
        castApprovals: { version: 1, draftRevision: vars.data.revision, roles: { ...state.castApprovalRoles } },
      };
    }),
    useUpdateGuidedStoryDraft: mutation((vars) => {
      if (state.updated === "error") throw { data: { error: "Visual choices could not be saved." } };
      if (state.updated === "conflict") throw { data: { error: "This draft changed. Reload it and try again." } };
      state.updated = vars.data;
      return { ...state.draft, ...vars.data, revision: state.draft.revision + 1 };
    }),
    useRefreshGuidedStoryLineTranslation: mutation((vars) => {
      state.translationRequest = vars.data;
      if (state.translationError) throw state.translationError;
      return {
        ...state.draft,
        revision: vars.data.revision,
        script: {
          ...state.draft.script,
          scenes: state.draft.script.scenes.map((scene: any) =>
            scene.id === vars.data.sceneId
              ? {
                  ...scene,
                  lines: scene.lines.map((line: any) =>
                    line.id === vars.data.lineId
                      ? {
                          ...line,
                          text: vars.data.sourceText,
                          romanizedPronunciation: "Idi mana kottha pranalika.",
                          englishTranslation: "This is our updated plan.",
                        }
                      : line,
                  ),
                }
              : scene,
          ),
        },
      };
    }),
    useCastGuidedStoryDraft: mutation((vars) => {
      if (state.castError) throw state.castError;
      state.cast = vars.data;
      return {
        ...state.draft,
        revision: state.draft.revision + 1,
        userRoleId: vars.data.assignments.find((item: any) => item.isUserRole)?.roleId ?? null,
        castStrategy: vars.data.strategy,
        cast: vars.data.assignments.map((item: any) => ({ ...item })),
        castApprovals: null,
      };
    }),
    useCustomizeGuidedStoryGeneratedCastRole: () => ({
      isPending: false,
      mutateAsync: async (vars: any) => {
        state.customizationRequest = vars;
        if (state.customizationError) throw state.customizationError;
        return { ...state.draft, cast: state.draft.cast.filter((member: any) => member.roleId !== vars.roleId) };
      },
    }),
    useReviewCharacterReferenceSheet: mutation((vars) => {
      state.referenceSheetReview = vars;
      return {};
    }),
    useEnqueueGuidedStoryDraft: mutation((vars) => {
      state.enqueued = vars.data;
      return { id: 99 };
    }),
    usePrepareGuidedStoryBackdrop: () => ({
      isPending: false,
      mutateAsync: async (vars: any) => {
        const previous = state.draft.visualChoices?.backdrops ?? { version: 1, default: null, sceneOverrides: {} };
        const candidate = { version: 1, prompt: vars.data.prompt, imagePath: vars.data.imagePath, imageSha256: "a".repeat(64), fingerprint: "a".repeat(64), revision: state.draft.revision + 1, approvedAt: null };
        return {
          ...state.draft,
          revision: state.draft.revision + 1,
          visualChoices: {
            ...(state.draft.visualChoices ?? { logo: { path: null, sceneIds: [] }, location: { mode: "none", imagePath: null, description: null } }),
            backdrops: vars.data.sceneId
              ? { ...previous, sceneOverrides: { ...previous.sceneOverrides, [vars.data.sceneId]: candidate } }
              : { ...previous, default: candidate },
          },
        };
      },
    }),
    useApproveGuidedStoryBackdrop: mutation((vars) => {
      const previous = state.draft.visualChoices.backdrops ?? {
        version: 1,
        default: state.draft.visualChoices.backdropReference
          ? { ...state.draft.visualChoices.backdropReference, revision: 1 }
          : null,
        sceneOverrides: {},
      };
      return {
        ...state.draft,
        visualChoices: {
          ...state.draft.visualChoices,
          backdrops: {
            ...previous,
            default: vars.data.sceneId ? previous.default : { ...previous.default, approvedAt: "2026-08-30T00:00:00.000Z" },
            sceneOverrides: vars.data.sceneId ? { ...previous.sceneOverrides, [vars.data.sceneId]: { ...previous.sceneOverrides[vars.data.sceneId], approvedAt: "2026-08-30T00:00:00.000Z" } } : previous.sceneOverrides,
          },
        },
      };
    }),
    useInheritGuidedStoryDefaultBackdrop: mutation((vars) => ({
      ...state.draft,
      visualChoices: {
        ...state.draft.visualChoices,
        backdrops: {
          ...state.draft.visualChoices.backdrops,
          sceneOverrides: Object.fromEntries(
            Object.entries(state.draft.visualChoices.backdrops?.sceneOverrides ?? {})
              .filter(([sceneId]) => sceneId !== vars.sceneId),
          ),
        },
      },
    })),
    useRequestUploadUrl: () => ({
      mutateAsync: async () => {
        if (state.uploadError) throw state.uploadError;
        return { uploadURL: "http://upload", objectPath: "/objects/99/uploads/visual.png" };
      },
    }),
    useGenerateImage: () => ({
      isPending: false,
      mutateAsync: async (vars: any) => {
        state.generatedImageRequest = vars.data;
        return { imagePath: "/objects/99/generated/custom-backdrop.png" };
      },
    }),
    useGenerateGuidedStoryDraftScene: () => ({
      isPending: false,
      reset: vi.fn(),
      mutate: (vars: any, options: any) => {
        state.sceneRequest = vars.data;
        const generatedScene = {
          id: "ai-scene",
          startMs: 0,
          endMs: 4000,
          visualDirection: "A paper plane crosses the room.",
          roleIds: ["r1"],
          lines: [{ id: "ai-line", ownerRoleId: "r1", kind: "dialogue", text: "Catch it!", startMs: 0, endMs: 2000 }],
        };
        const scenes = [...vars.data.script.scenes];
        scenes.splice(vars.data.insertionIndex, 0, generatedScene);
        const result = {
          revision: vars.data.revision,
          insertedSceneId: generatedScene.id,
          script: { ...vars.data.script, scenes },
        };
        const complete = () => state.sceneError ? options.onError?.(state.sceneError) : options.onSuccess?.(result);
        if (state.deferScene) state.completeScene = complete;
        else complete();
      },
    }),
  });
});

import {
  GUIDED_BACKDROP_PROMPT_MAX,
  GuidedStoryWorkflow,
  fitGuidedBackdropPrompt,
} from "./guided-story-workflow";

const kit = { id: 3, name: "Studio", activeVersion: { payload: { brand_voice: { mode: "cloned", provider_voice_id: "voice-a", cloned_label: "A voice", preset_voice: "nova", voices: [{ id: "voice-a", label: "A voice" }] } } } };
const character = {
  id: 1,
  name: "Me",
  description: "A person",
  referenceImagePath: null,
  referenceSheetStatus: "approved",
  outfits: [
    {
      id: 11,
      name: "Jacket",
      description: "Blue",
      referenceImagePath: null,
      isDefault: false,
      status: "approved",
      identityVerified: true,
    },
  ],
};
function draft(overrides: Record<string, unknown> = {}) {
  return { id: 7, revision: 2, version: 1, setup: { genre: "comedy", platform: "instagram_reels", durationSeconds: 15, locale: "en", topic: "A tidy desk", roleCount: 2, brandKitId: 3, aspectRatio: "9:16", width: 1080, height: 1920, safeArea: contract.safeArea }, script, scriptApprovedAt: "2026-01-01", userRoleId: null, castStrategy: null, cast: [], castApprovals: null, duplicateAssignmentConfirmed: false, scriptGeneration: null, storyboardJobId: null, visualChoices: { version: 1, logo: { path: null, sceneIds: [] }, location: { mode: "none", imagePath: null, description: null }, backdropReference: { version: 1, prompt: "A tidy desk in warm daylight", imagePath: "/objects/99/uploads/visual.png", sceneIds: ["s1"], fingerprint: "a".repeat(64), approvedAt: "2026-01-01T00:00:00.000Z" } }, estimates: { scriptUnits: 1, castAssetUnits: 2, previewUnits: 3, finalAdditionalUnits: 4, totalRemainingUnits: 10 }, createdAt: "", updatedAt: "", ...overrides };
}
function generatedCast() {
  return script.roles.map((role, index) => ({
    roleId: role.id,
    source: "generated",
    characterId: index + 101,
    outfitId: index + 201,
    brandKitId: null,
    voiceId: "stock:alloy",
    character: {
      name: role.name,
      description: `${role.description} appearance`,
      referenceImagePath: `/objects/99/generated-${role.id}.png`,
    },
    outfit: {
      name: `${role.name} wardrobe`,
      description: `${role.description} outfit`,
      referenceImagePath: `/objects/99/outfit-${role.id}.png`,
    },
    voice: { id: "stock:alloy", label: "Alloy", provider: "stock", providerVoiceId: null },
    isUserRole: false,
    consentGranted: false,
  }));
}
function renderWorkflow(options: {
  characters?: any[];
  brandKits?: any[];
  editRequest?: { key: number; draftId: number; correctionMessage?: string } | null;
} = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onJobReady = vi.fn();
  return {
    client,
    onJobReady,
    ...render(<QueryClientProvider client={client}><TooltipProvider><GuidedStoryWorkflow tenantId={99} characters={options.characters ?? [character]} brandKits={options.brandKits ?? [kit]} onManageCharacters={vi.fn()} onJobReady={onJobReady} editRequest={options.editRequest} /></TooltipProvider></QueryClientProvider>),
  };
}

beforeEach(() => { vi.useRealTimers(); state.draft = undefined; state.requestedDraftIds = []; state.draftRefetches = 0; state.created = null; state.generatedScripts = 0; state.generationError = null; state.cast = null; state.castError = null; state.approvalError = null; state.castApprovalError = null; state.castApprovalRoles = {}; state.customizationRequest = null; state.customizationError = null; state.referenceSheetReview = null; state.updated = null; state.translationRequest = null; state.translationError = null; state.uploadError = null; state.generatedImageRequest = null; state.enqueued = null; state.sceneRequest = null; state.sceneError = null; state.deferScene = false; state.completeScene = null; trackMock.mockReset(); vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 })); localStorage.clear(); cleanup(); });

describe("GuidedStoryWorkflow", () => {
  it("starts a new story without deleting the previously restored draft", async () => {
    state.draft = draft();
    localStorage.setItem("kokao-guided-story-draft-v1:99", "7");
    renderWorkflow();

    await screen.findByTestId("button-guided-new-story");
    await userEvent.click(screen.getByTestId("button-guided-new-story"));

    expect(localStorage.getItem("kokao-guided-story-draft-v1:99")).toBeNull();
    expect(screen.queryByTestId("button-guided-new-story")).toBeNull();
    expect((screen.getByTestId("input-guided-topic") as HTMLTextAreaElement).value).toBe("");
    expect(screen.getByTestId("button-guided-create-draft").textContent).toBe("Generate script");
    expect(screen.queryByTestId("guided-intrinsic-lipsync-notice")).toBeNull();
  });

  it("shows native text, Romanized pronunciation, then English meaning without duplicating English stories", async () => {
    state.draft = draft({
      setup: { ...draft().setup, locale: "te" },
      scriptApprovedAt: null,
      script: {
        ...script,
        scenes: [{
          ...script.scenes[0],
          lines: [{
            ...script.scenes[0]!.lines[0]!,
            text: "ఇది మన ప్రణాళిక.",
            romanizedPronunciation: "Idi mana pranalika.",
            englishTranslation: "This is our plan.",
          }],
        }],
      },
    });
    localStorage.setItem("kokao-guided-story-draft-v1:99", "7");
    renderWorkflow();
    expect((await screen.findByTestId("text-guided-line-english-l1")).textContent)
      .toContain("This is our plan.");
    expect(screen.getByTestId("text-guided-line-romanized-l1").textContent)
      .toContain("Idi mana pranalika.");
    const localizedLineCard = screen.getByTestId("text-guided-line-romanized-l1").parentElement!;
    expect(localizedLineCard.textContent!.indexOf("Idi mana pranalika.")).toBeLessThan(
      localizedLineCard.textContent!.indexOf("This is our plan."),
    );

    cleanup();
    state.draft = draft({ scriptApprovedAt: null });
    renderWorkflow();
    expect(screen.queryByTestId("text-guided-line-english-l1")).toBeNull();
  });

  it("saves edited source text before refreshing only its missing English meaning", async () => {
    state.draft = draft({
      setup: { ...draft().setup, locale: "te" },
      scriptApprovedAt: null,
      script: {
        ...script,
        scenes: [{
          ...script.scenes[0],
          lines: [{
            ...script.scenes[0]!.lines[0]!,
            text: "ఇది మన ప్రణాళిక.",
            romanizedPronunciation: "Idi mana pranalika.",
            englishTranslation: "This is our plan.",
          }],
        }],
      },
    });
    localStorage.setItem("kokao-guided-story-draft-v1:99", "7");
    renderWorkflow();
    const user = userEvent.setup();
    const line = await screen.findByTestId("input-guided-line-l1");

    await user.clear(line);
    await user.type(line, "ఇది మన కొత్త ప్రణాళిక.");
    expect(screen.getByTestId("button-guided-refresh-english-l1").textContent)
      .toContain("Save changes first");
    expect((screen.getByTestId("button-guided-refresh-english-l1") as HTMLButtonElement).disabled)
      .toBe(true);

    await user.click(screen.getByTestId("button-guided-save-script"));
    expect(state.updated.script.scenes[0].lines[0]).toMatchObject({
      text: "ఇది మన కొత్త ప్రణాళిక.",
      romanizedPronunciation: null,
      englishTranslation: null,
    });
    expect(state.updated.setup).toEqual({
      genre: "comedy",
      platform: "instagram_reels",
      durationSeconds: 15,
      locale: "te",
      topic: "A tidy desk",
      brandKitId: 3,
    });
    await user.click(screen.getByTestId("button-guided-refresh-english-l1"));

    expect(state.translationRequest).toMatchObject({
      sceneId: "s1",
      lineId: "l1",
      sourceText: "ఇది మన కొత్త ప్రణాళిక.",
    });
    expect(screen.getByTestId("text-guided-line-english-l1").textContent)
      .toContain("This is our updated plan.");
    expect(screen.getByTestId("text-guided-line-romanized-l1").textContent)
      .toContain("Idi mana kottha pranalika.");
    expect((screen.getByTestId("input-guided-line-l1") as HTMLTextAreaElement).value)
      .toBe("ఇది మన కొత్త ప్రణాళిక.");
  });

  it("shows a retryable per-line error without losing the saved source edit", async () => {
    state.draft = draft({
      setup: { ...draft().setup, locale: "te" },
      scriptApprovedAt: null,
      script: {
        ...script,
        scenes: [{
          ...script.scenes[0],
          lines: [{
            ...script.scenes[0]!.lines[0]!,
            text: "ఇది మన కొత్త ప్రణాళిక.",
            englishTranslation: null,
          }],
        }],
      },
    });
    state.translationError = {
      data: { error: "The translation provider is temporarily unavailable." },
    };
    localStorage.setItem("kokao-guided-story-draft-v1:99", "7");
    renderWorkflow();

    await userEvent.click(await screen.findByTestId("button-guided-refresh-english-l1"));
    expect(screen.getByTestId("error-guided-refresh-english-l1").textContent)
      .toContain("temporarily unavailable");
    expect((screen.getByTestId("input-guided-line-l1") as HTMLTextAreaElement).value)
      .toBe("ఇది మన కొత్త ప్రణాళిక.");

    state.translationError = null;
    await userEvent.click(screen.getByTestId("button-guided-refresh-english-l1"));
    expect(screen.queryByTestId("error-guided-refresh-english-l1")).toBeNull();
    expect(screen.getByTestId("text-guided-line-english-l1").textContent)
      .toContain("This is our updated plan.");
  });

  it("lets the story decide its cast without a setup count or max-role control", async () => {
    renderWorkflow();
    expect((screen.getByTestId("button-guided-create-draft") as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByTestId("select-guided-platform"));
    await userEvent.click(screen.getByText("instagram reels"));
    expect(screen.getByTestId("text-guided-format").textContent).toContain("1080×1920");
    expect(screen.getByTestId("text-guided-story-decides-cast").textContent)
      .toContain("Story decides the cast");
    expect(screen.queryByTestId("text-guided-role-plan")).toBeNull();
    expect(screen.queryByTestId("button-guided-role-count-2")).toBeNull();
    await userEvent.click(screen.getByTestId("button-guided-duration-30"));
    expect(screen.queryByTestId("button-guided-role-count-3")).toBeNull();
    await userEvent.click(screen.getByTestId("select-guided-brand-kit"));
    await userEvent.click(screen.getByText("Studio"));
    await userEvent.type(screen.getByTestId("input-guided-topic"), "A story about sorting a desk");
    await userEvent.click(screen.getByTestId("button-guided-create-draft"));
    expect(state.created).toMatchObject({ platform: "instagram_reels", durationSeconds: 30 });
    expect(state.created).not.toHaveProperty("roleCount");
    expect(state.generatedScripts).toBe(1);
    expect(await screen.findByTestId("guided-script-summary")).toBeTruthy();
  });

  it("shows the script's actual cast even when a legacy setup count is smaller", async () => {
    const fiveRoleScript = {
      ...script,
      roles: [
        ...script.roles,
        { id: "r3", name: "Cy", description: "Medic" },
        { id: "r4", name: "Dee", description: "Pilot" },
        { id: "r5", name: "Em", description: "Ranger" },
      ],
    };
    state.draft = draft({
      script: fiveRoleScript,
      scriptApprovedAt: null,
      setup: { ...draft().setup, roleCount: 2 },
    });
    localStorage.setItem("kokao-guided-story-draft-v1:99", "7");

    renderWorkflow();

    expect((await screen.findByTestId("guided-script-summary")).textContent)
      .toContain("5 roles");
    expect(screen.queryByTestId("text-guided-role-plan")).toBeNull();
    expect(screen.queryByTestId("button-guided-role-count-4")).toBeNull();
  });

  it("creates a story without a Brand Kit", async () => {
    renderWorkflow({ brandKits: [] });
    await userEvent.click(screen.getByTestId("select-guided-platform"));
    await userEvent.click(screen.getByText("instagram reels"));
    await userEvent.type(screen.getByTestId("input-guided-topic"), "A story without a brand kit");

    expect(screen.getByTestId("status-guided-empty-brand-kit").textContent).toContain(
      "You can still create the story",
    );
    expect((screen.getByTestId("button-guided-create-draft") as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(screen.getByTestId("button-guided-create-draft"));

    expect(state.created).toMatchObject({ brandKitId: null });
  });

  it("shows the server error when Save setup fails", async () => {
    state.draft = draft({ script: null, scriptApprovedAt: null });
    state.generationError = { data: { error: "The script does not fit this runtime." } };
    localStorage.setItem("kokao-guided-story-draft-v1:99", "7");
    renderWorkflow();

    await userEvent.click(await screen.findByTestId("button-guided-generate-script"));
    expect((await screen.findByTestId("button-guided-create-draft")).textContent).toBe("Save & regenerate script");

    state.updated = "error";
    await userEvent.click(screen.getByTestId("button-guided-create-draft"));

    expect((await screen.findByTestId("error-guided-setup-save")).textContent)
      .toContain("Visual choices could not be saved.");
  });

  it("offers to reload the latest draft after a setup conflict", async () => {
    state.draft = draft({ script: null, scriptApprovedAt: null });
    state.generationError = { data: { error: "The script does not fit this runtime." } };
    localStorage.setItem("kokao-guided-story-draft-v1:99", "7");
    renderWorkflow();

    await userEvent.click(await screen.findByTestId("button-guided-generate-script"));
    state.updated = "conflict";
    await userEvent.click(await screen.findByTestId("button-guided-create-draft"));

    expect((await screen.findByTestId("error-guided-setup-save")).textContent)
      .toContain("This draft changed");
    expect(screen.getByTestId("button-guided-reload-draft")).toBeTruthy();

    state.draft = draft({
      revision: 8,
      script: null,
      scriptApprovedAt: null,
      setup: {
        ...state.draft.setup,
        topic: "The latest saved topic",
      },
    });
    await userEvent.click(screen.getByTestId("button-guided-reload-draft"));

    await waitFor(() =>
      expect((screen.getByTestId("input-guided-topic") as HTMLTextAreaElement).value)
        .toBe("The latest saved topic"),
    );
    expect(screen.queryByTestId("error-guided-setup-save")).toBeNull();
    expect(screen.getByTestId("button-guided-create-draft").textContent).toBe("Save & regenerate script");
  });

  it("refreshes the server revision before correcting a failed script generation", async () => {
    state.draft = draft({ revision: 7, script: null, scriptApprovedAt: null });
    state.generationError = {
      data: { error: "The script does not fit this runtime." },
      latestDraft: draft({ revision: 8, script: null, scriptApprovedAt: null }),
    };
    localStorage.setItem("kokao-guided-story-draft-v1:99", "7");
    renderWorkflow();

    await userEvent.click(await screen.findByTestId("button-guided-generate-script"));
    expect((await screen.findByTestId("button-guided-create-draft")).textContent).toBe("Save & regenerate script");

    state.generationError = null;
    await userEvent.click(screen.getByTestId("button-guided-create-draft"));

    expect(state.updated).toMatchObject({ revision: 8 });
    expect(screen.queryByTestId("error-guided-setup-save")).toBeNull();
  });

  it("uses the server language catalog as the authoritative story-language selector", async () => {
    renderWorkflow();
    await userEvent.click(screen.getByTestId("select-guided-locale"));
    expect(screen.getByText("తెలుగు · Telugu (te)")).toBeTruthy();
    await userEvent.click(screen.getByText("தமிழ் · Tamil (ta)"));
    expect(screen.getByTestId("status-guided-language-supported").textContent).toContain(
      "Tamil (ta) in Tamil script",
    );
    expect(screen.getByTestId("text-guided-language-authority").textContent).toContain(
      "used for script, subtitles, and speech",
    );
  });

  it("restores the server draft referenced by the tenant draft key", async () => {
    state.draft = draft();
    localStorage.setItem("kokao-guided-story-draft-v1:99", "7");
    renderWorkflow();
    await waitFor(() => expect(screen.getByTestId("guided-script-summary").textContent).toContain("The plan"));
    expect(screen.getByTestId("text-guided-estimate-script").textContent).toContain("1 unit");
    expect(screen.getByTestId("text-guided-estimate-final").textContent).toContain("4 units");
    expect(screen.getByTestId("text-guided-estimate-total").textContent).toContain("No paise estimate is supplied");
  });

  it("shows the image model snapshot locked for the story during review", async () => {
    state.draft = draft({
      imageModelSnapshot: {
        provider: "gemini",
        model: "imagen-4-ultra",
        customBaseUrl: null,
        fallbackEnabled: false,
        lockedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    localStorage.setItem("kokao-guided-story-draft-v1:99", "7");
    renderWorkflow();

    const lock = await screen.findByTestId("card-guided-image-model-lock");
    expect(lock.getAttribute("role")).toBe("status");
    expect(lock.textContent).toContain("Locked for this story");
    expect(lock.textContent).toContain("gemini · imagen-4-ultra");
    expect(lock.textContent).toContain("Fallback not allowed");
  });

  it("prioritizes an explicit failed-job draft and opens its scene editor", async () => {
    state.draft = draft({
      id: 81,
      setup: { ...draft().setup, locale: "te" },
      script: {
        ...script,
        title: "Failed job story",
        scenes: [{
          ...script.scenes[0],
          lines: [{
            ...script.scenes[0]!.lines[0]!,
            text: "ఇది మన ప్రణాళిక.",
            romanizedPronunciation: "Idi mana pranalika.",
            englishTranslation: "This is our plan.",
          }],
        }],
      },
    });
    localStorage.setItem("kokao-guided-story-draft-v1:99", "7");

    renderWorkflow({ editRequest: { key: 1, draftId: 81 } });

    expect(await screen.findByTestId("guided-readable-script")).toBeTruthy();
    expect((screen.getByTestId("input-guided-script-title") as HTMLInputElement).value)
      .toBe("Failed job story");
    expect((screen.getByTestId("input-guided-line-l1") as HTMLTextAreaElement).value)
      .toBe("ఇది మన ప్రణాళిక.");
    expect(screen.getByTestId("text-guided-line-romanized-l1").textContent)
      .toContain("Idi mana pranalika.");
    expect(screen.getByTestId("text-guided-line-english-l1").textContent)
      .toContain("This is our plan.");
    expect(state.requestedDraftIds).toContain(81);
    expect(state.requestedDraftIds).not.toContain(7);
    expect(localStorage.getItem("kokao-guided-story-draft-v1:99")).toBe("81");
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId("input-guided-script-title")),
    );
  });

  it("shows a clear state when an explicitly requested draft is unavailable", async () => {
    state.draft = null;

    renderWorkflow({ editRequest: { key: 1, draftId: 404 } });

    expect((await screen.findByTestId("error-guided-story-restore")).textContent)
      .toContain("could not be restored");
  });

  it("shows a readable script and keeps readable and JSON edits synchronized", async () => {
    state.draft = draft({ scriptApprovedAt: null });
    localStorage.setItem("kokao-guided-story-draft-v1:99", "7");
    renderWorkflow();
    const user = userEvent.setup();

    expect(await screen.findByTestId("guided-readable-script")).toBeTruthy();
    expect(screen.getByTestId("card-guided-script-scene-s1").textContent).toContain("Scene 1");
    expect((screen.getByTestId("input-guided-line-l1") as HTMLTextAreaElement).value).toBe("Here is the plan.");
    expect(screen.queryByTestId("input-guided-script")).toBeNull();

    await user.clear(screen.getByTestId("input-guided-line-l1"));
    await user.type(screen.getByTestId("input-guided-line-l1"), "The plan has changed.");
    expect(screen.getByTestId("status-guided-script-unsaved")).toBeTruthy();
    expect((screen.getByTestId("button-guided-approve-script") as HTMLButtonElement).disabled).toBe(true);

    await user.click(screen.getByTestId("button-guided-toggle-json"));
    expect((screen.getByTestId("input-guided-script") as HTMLTextAreaElement).value).toContain(
      "The plan has changed.",
    );

    await user.click(screen.getByTestId("button-guided-save-script"));
    expect(await screen.findByTestId("status-guided-script-saved")).toBeTruthy();
    expect(screen.queryByTestId("status-guided-script-unsaved")).toBeNull();
  });

  it("moves complete scene blocks and preserves their relative timings", async () => {
    state.draft = draft({
      scriptApprovedAt: null,
      script: {
        ...script,
        scenes: [
          {
            ...script.scenes[0],
            startMs: 0,
            endMs: 6000,
            lines: [{ ...script.scenes[0].lines[0], startMs: 1000, endMs: 3000 }],
          },
          {
            id: "s2",
            startMs: 6000,
            endMs: 15000,
            visualDirection: "Hospital corridor",
            roleIds: ["r1", "r2"],
            lines: [{
              id: "l2",
              ownerRoleId: null,
              kind: "narration" as const,
              text: "They hear the announcement.",
              startMs: 7000,
              endMs: 9000,
            }],
          },
        ],
      },
    });
    localStorage.setItem("kokao-guided-story-draft-v1:99", "7");
    renderWorkflow();

    expect((await screen.findByTestId("button-guided-scene-move-up-s1") as HTMLButtonElement).disabled)
      .toBe(true);
    expect((screen.getByTestId("button-guided-scene-move-down-s2") as HTMLButtonElement).disabled)
      .toBe(true);

    await userEvent.click(screen.getByTestId("button-guided-scene-move-up-s2"));

    const sceneCards = screen.getAllByTestId(/^card-guided-script-scene-/);
    expect(sceneCards.map((card) => card.getAttribute("data-testid"))).toEqual([
      "card-guided-script-scene-s2",
      "card-guided-script-scene-s1",
    ]);
    expect(sceneCards[0].textContent).toContain("Scene 1");
    expect(sceneCards[1].textContent).toContain("Scene 2");

    await userEvent.click(screen.getByTestId("button-guided-save-script"));

    expect(state.updated.script.scenes).toMatchObject([
      {
        id: "s2",
        startMs: 0,
        endMs: 9000,
        lines: [{ id: "l2", startMs: 1000, endMs: 3000 }],
      },
      {
        id: "s1",
        startMs: 9000,
        endMs: 15000,
        lines: [{ id: "l1", startMs: 10000, endMs: 12000 }],
      },
    ]);
  });

  it("shows the API error when script approval fails", async () => {
    state.draft = draft({ scriptApprovedAt: null });
    state.approvalError = { data: { error: "This linked storyboard cannot be replaced." } };
    localStorage.setItem("kokao-guided-story-draft-v1:99", "7");
    renderWorkflow();

    await userEvent.click(await screen.findByTestId("button-guided-approve-script"));

    expect(
      (await screen.findByTestId("error-guided-script-approval")).textContent,
    ).toContain("This linked storyboard cannot be replaced.");
  });

  it("moves script approval into automatic progress without a cast mutation", async () => {
    state.draft = draft({ scriptApprovedAt: null });
    localStorage.setItem("kokao-guided-story-draft-v1:99", "7");
    renderWorkflow();
    await userEvent.click(await screen.findByTestId("button-guided-approve-script"));
    expect(await screen.findByTestId("status-guided-automatic-cast")).toBeTruthy();
    expect(state.cast).toBeNull();
    expect(screen.queryByTestId("button-guided-save-cast")).toBeNull();
  });

  it("requires an actionable acknowledgement for Romanized non-Latin speech", async () => {
    state.draft = draft({
      setup: { ...draft().setup, locale: "te" },
      scriptApprovedAt: null,
      script: {
        ...script,
        scenes: [{
          ...script.scenes[0],
          lines: [{ ...script.scenes[0].lines[0], text: "Nenu ippudu vastanu." }],
        }],
      },
    });
    localStorage.setItem("kokao-guided-story-draft-v1:99", "7");
    renderWorkflow();

    expect((await screen.findByTestId("warning-guided-native-script")).textContent).toContain(
      "Telugu writing system",
    );
    expect(screen.getByTestId("text-guided-voice-language").textContent).toContain(
      "Higgsfield receives the exact approved dialogue",
    );
    await userEvent.click(screen.getByTestId("button-guided-approve-script"));
    expect(screen.getByTestId("button-guided-approve-script").textContent).toBe("Approve anyway");
    expect(screen.getByTestId("guided-readable-script")).toBeTruthy();
    await userEvent.click(screen.getByTestId("button-guided-approve-script"));
    await waitFor(() => expect(screen.queryByTestId("guided-readable-script")).toBeNull());
  });

  it("requires acknowledgement when only one localized line is Romanized", async () => {
    state.draft = draft({
      setup: { ...draft().setup, locale: "te" },
      scriptApprovedAt: null,
      script: {
        ...script,
        scenes: [{
          ...script.scenes[0],
          lines: [
            { ...script.scenes[0].lines[0], text: "నేను ఇప్పుడు వస్తాను." },
            { ...script.scenes[0].lines[0], id: "l2", text: "Nenu siddhanga unnanu." },
          ],
        }],
      },
    });
    localStorage.setItem("kokao-guided-story-draft-v1:99", "7");
    renderWorkflow();

    expect(await screen.findByTestId("warning-guided-native-script")).toBeTruthy();
    await userEvent.click(screen.getByTestId("button-guided-approve-script"));
    expect(screen.getByTestId("button-guided-approve-script").textContent).toBe("Approve anyway");
  });

  it("keeps exact native-script Unicode unchanged in the editor and saved payload", async () => {
    const exactText = "  నేను వస్తాను — క్షేమంగా! 👋\nதமிழ் வரியும் மாறாது.  ";
    state.draft = draft({
      setup: { ...draft().setup, locale: "te" },
      scriptApprovedAt: null,
      script: {
        ...script,
        scenes: [{
          ...script.scenes[0],
          lines: [{ ...script.scenes[0].lines[0], text: exactText }],
        }],
      },
    });
    localStorage.setItem("kokao-guided-story-draft-v1:99", "7");
    renderWorkflow();

    expect((await screen.findByTestId("input-guided-line-l1") as HTMLTextAreaElement).value)
      .toBe(exactText);
    await userEvent.click(screen.getByTestId("button-guided-toggle-json"));
    const json = (screen.getByTestId("input-guided-script") as HTMLTextAreaElement).value;
    expect((JSON.parse(json) as typeof script).scenes[0].lines[0].text).toBe(exactText);
  });

  it("preserves unsaved readable edits across a background draft refresh", async () => {
    state.draft = draft({ scriptApprovedAt: null });
    localStorage.setItem("kokao-guided-story-draft-v1:99", "7");
    const { client } = renderWorkflow();
    const user = userEvent.setup();

    const line = await screen.findByTestId("input-guided-line-l1");
    await user.clear(line);
    await user.type(line, "A revised line.");
    expect(trackMock).not.toHaveBeenCalledWith("guided_script_revised_saved", expect.anything());

    await user.click(screen.getByTestId("button-guided-save-script"));
    expect(trackMock).toHaveBeenCalledWith("guided_script_revised_saved", {
      role_count: 2,
      scene_count: 1,
    });
  });

  it("shows server-owned automatic progress when analytics throws", async () => {
    state.draft = draft();
    localStorage.setItem("kokao-guided-story-draft-v1:99", "7");
    trackMock.mockImplementation(() => { throw new Error("analytics unavailable"); });
    renderWorkflow();
    const user = userEvent.setup();

    expect(screen.getByTestId("status-guided-automatic-cast").textContent).toContain(
      "server is creating",
    );
    expect(screen.queryByTestId("select-guided-generated-voice-r2")).toBeNull();
    expect(screen.getAllByText(/Dialogue voices are generated automatically/)).toHaveLength(2);
    expect(state.cast).toBeNull();
  });

  it("does not issue a second cast mutation while automatic cast is running", async () => {
    state.draft = draft();
    localStorage.setItem("kokao-guided-story-draft-v1:99", "7");
    renderWorkflow();

    expect(screen.queryByTestId("checkbox-guided-consent")).toBeNull();
    expect(screen.queryByTestId("button-guided-save-cast")).toBeNull();
    expect(state.cast).toBeNull();
  });

  it("keeps a linked storyboard draft visible and opens its active job", async () => {
    state.draft = draft({
      cast: [{ roleId: "lead" }, { roleId: "friend" }],
      storyboardJobId: 43126,
    });
    localStorage.setItem("kokao-guided-story-draft-v1:99", "7");
    state.existingJob = { id: 43126, status: "awaiting_review", storyboard: { scenes: [{}] } };
    const { onJobReady } = renderWorkflow();

    const openJob = await screen.findByTestId("button-guided-enqueue");
    expect(openJob.textContent).toBe("Open existing video job");
    expect(screen.getByTestId("guided-story-workflow")).toBeTruthy();
    expect(localStorage.getItem("kokao-guided-story-draft-v1:99")).toBe("7");
    await userEvent.click(openJob);
    expect(onJobReady).toHaveBeenCalledWith(43126);
    expect(state.enqueued).toBeNull();
  });

  it("highlights the required correction when reopening a failed story", () => {
    state.draft = draft();
    renderWorkflow({
      editRequest: {
        key: 1,
        draftId: 7,
        correctionMessage:
          "Review Backdrop overview, approve the highlighted backdrop, then rebuild.",
      },
    });

    expect(screen.getByTestId("guided-story-correction-required").textContent)
      .toContain("Review Backdrop overview");
  });

  it("returns to the saved draft when the linked job failed before a storyboard existed", async () => {
    state.draft = draft({
      cast: [{ roleId: "lead" }, { roleId: "friend" }],
      storyboardJobId: 43126,
    });
    state.existingJob = { id: 43126, status: "failed", storyboard: null };
    localStorage.setItem("kokao-guided-story-draft-v1:99", "7");
    const { onJobReady } = renderWorkflow();

    expect(screen.getByTestId("button-guided-enqueue").textContent).toBe(
      "Edit story and rebuild legacy storyboard",
    );
    await userEvent.click(screen.getByTestId("button-guided-enqueue"));

    expect(screen.getByTestId("guided-readable-script")).toBeTruthy();
    expect(onJobReady).not.toHaveBeenCalled();
  });

  it("requires and submits fresh attempt consent without redoing cast approvals", async () => {
    const savedCast = script.roles.map((role, index) => ({
      roleId: role.id,
      source: "saved",
      characterId: index + 1,
      outfitId: index + 11,
      brandKitId: null,
      voiceId: index === 0 ? "alloy" : "echo",
      character: {
        name: role.name,
        description: role.description,
        referenceImagePath: `/objects/99/character-${index}.png`,
      },
      outfit: {
        name: "Approved outfit",
        description: "Approved wardrobe",
        referenceImagePath: `/objects/99/outfit-${index}.png`,
      },
      voice: {
        id: index === 0 ? "alloy" : "echo",
        label: `Voice ${index + 1}`,
        provider: "stock",
        providerVoiceId: null,
      },
      isUserRole: false,
      consentGranted: false,
    }));
    state.draft = draft({
      castStrategy: "saved",
      cast: savedCast,
      castApprovals: {
        version: 1,
        draftRevision: 2,
        roles: Object.fromEntries(savedCast.map((member) => [
          member.roleId,
          {
            roleId: member.roleId,
            approvedAt: "2026-01-01T00:00:00.000Z",
            character: {
              referenceImagePath: member.character.referenceImagePath,
              sha256: "a".repeat(64),
            },
            outfit: {
              referenceImagePath: member.outfit.referenceImagePath,
              sha256: "b".repeat(64),
            },
          },
        ])),
      },
    });
    localStorage.setItem("kokao-guided-story-draft-v1:99", "7");
    renderWorkflow();

    expect(
      screen.getByTestId("guided-intrinsic-lipsync-notice").textContent,
    ).toContain(
      "Higgsfield renders the visible ensemble and synchronized audio together",
    );
    expect(screen.queryByTestId("checkbox-guided-studio-lipsync")).toBeNull();
    expect(screen.getByTestId("section-guided-attempt-consent")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reapprove Ari" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reapprove Bo" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Approve / })).toBeNull();
    const directEnqueue = screen.getByTestId("button-guided-enqueue") as HTMLButtonElement;
    expect(directEnqueue.textContent).toBe("Compile final prompt & send to Higgsfield");
    expect(directEnqueue.textContent).not.toContain("storyboard");
    expect(directEnqueue.disabled).toBe(true);

    await userEvent.click(screen.getByTestId("checkbox-guided-attempt-consent"));
    expect((screen.getByTestId("button-guided-enqueue") as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(screen.getByTestId("button-guided-enqueue"));

    expect(state.enqueued).toEqual({ revision: 2, consentGranted: true });
  });

  it("polls an incomplete automatic cast without submitting cast", async () => {
    vi.useFakeTimers();
    state.draft = draft();
    localStorage.setItem("kokao-guided-story-draft-v1:99", "7");
    renderWorkflow();
    expect(state.cast).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_100);
    });
    expect(state.draftRefetches).toBeGreaterThan(0);
    expect(state.cast).toBeNull();
  });

  it("prefills and submits generated character customization", async () => {
    const cast = generatedCast();
    state.draft = draft({ castStrategy: "generated", cast });
    localStorage.setItem("kokao-guided-story-draft-v1:99", "7");
    const generatedCharacters = cast.map((member) => ({
      ...character,
      id: member.characterId,
      name: member.character.name,
      description: member.character.description,
    }));
    renderWorkflow({ characters: generatedCharacters });

    await userEvent.click(screen.getByTestId("button-guided-customize-character-r1"));
    expect((screen.getByTestId("input-guided-custom-character-name") as HTMLInputElement).value).toBe("Ari");
    expect((screen.getByTestId("input-guided-custom-character-description") as HTMLTextAreaElement).value).toBe("Planner appearance");
    expect((screen.getByTestId("input-guided-custom-character-wardrobe") as HTMLTextAreaElement).value).toBe("Planner outfit");
    await userEvent.clear(screen.getByTestId("input-guided-custom-character-name"));
    await userEvent.type(screen.getByTestId("input-guided-custom-character-name"), "Aria");
    await userEvent.click(screen.getByTestId("button-guided-save-custom-character"));
    expect(state.customizationRequest).toEqual({
      draftId: 7,
      roleId: "r1",
      data: {
        revision: 2,
        name: "Aria",
        description: "Planner appearance",
        wardrobeDescription: "Planner outfit",
      },
    });
    expect(screen.queryByTestId("dialog-guided-customize-character")).toBeNull();
  });

  it("keeps customization open with an actionable provider error", async () => {
    const cast = generatedCast();
    state.draft = draft({ castStrategy: "generated", cast });
    state.customizationError = { data: { error: "Portrait regeneration needs reconciliation." } };
    localStorage.setItem("kokao-guided-story-draft-v1:99", "7");
    renderWorkflow({ characters: cast.map((member) => ({ ...character, id: member.characterId })) });
    await userEvent.click(screen.getByTestId("button-guided-customize-character-r1"));
    await userEvent.click(screen.getByTestId("button-guided-save-custom-character"));
    expect((await screen.findByTestId("error-guided-customize-character")).textContent)
      .toContain("needs reconciliation");
    expect(screen.getByTestId("button-guided-save-custom-character")).toBeTruthy();
  });

  it("shows portrait, character sheet, and outfit on each cast approval card", async () => {
    const cast = generatedCast();
    state.draft = draft({ castStrategy: "generated", cast });
    localStorage.setItem("kokao-guided-story-draft-v1:99", "7");
    renderWorkflow({
      characters: cast.map((member) => ({
        ...character,
        id: member.characterId,
        name: member.character.name,
        referenceSheetStatus: "pending",
        referenceSheetImagePath: `/objects/99/sheet-${member.roleId}.png`,
      })),
    });

    const card = await screen.findByTestId("card-guided-cast-approval-r1");
    expect(card.querySelector('[data-testid="img-guided-character-reference"]')?.getAttribute("src"))
      .toContain("/objects/99/generated-r1.png");
    expect(card.querySelector('[data-testid="img-guided-character-sheet-reference"]')?.getAttribute("src"))
      .toContain("/objects/99/sheet-r1.png");
    expect(card.querySelector('[data-testid="img-guided-outfit-reference"]')?.getAttribute("src"))
      .toContain("/objects/99/outfit-r1.png");

    for (const reference of ["character", "character-sheet", "outfit"]) {
      await userEvent.click(
        card.querySelector(`[data-testid="button-enlarge-guided-${reference}-reference"]`)!,
      );
      expect(screen.getByTestId("dialog-guided-cast-review")).toBeTruthy();
      expect(screen.getByTestId("img-guided-reference-sheet").getAttribute("src"))
        .toContain("/objects/99/sheet-r1.png");
      await userEvent.keyboard("{Escape}");
      await waitFor(() =>
        expect(screen.queryByTestId("dialog-guided-cast-review")).toBeNull(),
      );
    }
  });

  it("shows an explicit missing character-sheet state without substituting the portrait", async () => {
    const cast = generatedCast();
    state.draft = draft({ castStrategy: "generated", cast });
    localStorage.setItem("kokao-guided-story-draft-v1:99", "7");
    renderWorkflow({
      characters: cast.map((member) => ({
        ...character,
        id: member.characterId,
        name: member.character.name,
        referenceSheetStatus: "pending",
        referenceSheetImagePath: null,
      })),
    });

    const card = await screen.findByTestId("card-guided-cast-approval-r1");
    expect(
      card.querySelector('[data-testid="status-guided-character-sheet-reference-missing"]')
        ?.textContent,
    ).toContain("No character sheet reference image is available.");
    expect(card.querySelector('[data-testid="img-guided-character-sheet-reference"]')).toBeNull();
    expect(card.querySelector('[data-testid="img-guided-character-reference"]')?.getAttribute("src"))
      .toContain("/objects/99/generated-r1.png");
    expect(
      screen.getByTestId("button-guided-refresh-sheet-r1").textContent,
    ).toContain("Refresh character sheet");
    await userEvent.click(
      card.querySelector('[data-testid="button-enlarge-guided-character-sheet-reference"]')!,
    );
    expect(screen.getByTestId("status-guided-reference-sheet-unavailable").textContent).toContain(
      "complete character sheet is not available",
    );
    expect(screen.getByTestId("button-guided-refresh-reference-sheet")).toBeTruthy();
  });

  it("opens and approves a pending generated sheet directly from the cast card", async () => {
    const cast = generatedCast();
    state.draft = draft({ castStrategy: "generated", cast });
    localStorage.setItem("kokao-guided-story-draft-v1:99", "7");
    renderWorkflow({
      characters: cast.map((member) => ({
        ...character,
        id: member.characterId,
        referenceSheetStatus: "pending",
        referenceSheetImagePath: `/objects/99/sheet-${member.roleId}.png`,
      })),
    });
    expect(screen.queryByTestId("button-guided-approve-cast-r1")).toBeNull();
    expect(screen.getByTestId("button-guided-manage-sheet-r1").textContent).toContain(
      "View full sheet & approve",
    );
    await userEvent.click(
      screen.getAllByTestId("button-enlarge-guided-character-reference")[0],
    );
    expect(screen.getByTestId("dialog-guided-cast-review").className).toContain(
      "overflow-y-auto",
    );
    expect(screen.getByTestId("img-guided-reference-sheet").getAttribute("src")).toContain(
      "/objects/99/sheet-r1.png",
    );
    expect(
      screen.getByTestId("button-guided-customize-character-from-review").textContent,
    ).toContain("Customize Character");
    await userEvent.click(screen.getByTestId("button-guided-approve-reference-sheet"));
    expect(state.referenceSheetReview).toEqual({
      characterId: 101,
      decision: "approve",
    });
    await waitFor(() =>
      expect(screen.queryByTestId("dialog-guided-cast-review")).toBeNull(),
    );
    expect(screen.getByTestId("status-guided-sheet-action-r1").textContent).toContain(
      "Reference sheet approved",
    );
    expect(state.castApprovalRoles.r1?.roleId).toBe("r1");
    expect(screen.queryByTestId("button-guided-manage-sheet-r1")).toBeNull();
    expect(screen.getByTestId("button-guided-approve-cast-r1").textContent).toContain(
      "Reapprove",
    );
    await userEvent.click(screen.getByTestId("button-guided-customize-character-r1"));
    expect(screen.getByTestId("dialog-guided-customize-character")).toBeTruthy();
    expect((screen.getByTestId("button-guided-enqueue") as HTMLButtonElement).disabled).toBe(true);
  });

  it("closes the review after rejecting a sheet and confirms the action on the cast card", async () => {
    const cast = generatedCast();
    state.draft = draft({ castStrategy: "generated", cast });
    localStorage.setItem("kokao-guided-story-draft-v1:99", "7");
    renderWorkflow({
      characters: cast.map((member) => ({
        ...character,
        id: member.characterId,
        referenceSheetStatus: "pending",
        referenceSheetImagePath: `/objects/99/sheet-${member.roleId}.png`,
      })),
    });

    await userEvent.click(screen.getByTestId("button-guided-manage-sheet-r1"));
    await userEvent.click(screen.getByTestId("button-guided-reject-reference-sheet"));

    expect(state.referenceSheetReview).toEqual({
      characterId: 101,
      decision: "reject",
    });
    await waitFor(() =>
      expect(screen.queryByTestId("dialog-guided-cast-review")).toBeNull(),
    );
    expect(screen.getByTestId("status-guided-sheet-action-r1").textContent).toContain(
      "Reference sheet rejected",
    );
  });

  it("automatically approves cast roles whose reference sheets were already approved", async () => {
    const cast = generatedCast();
    state.draft = draft({ castStrategy: "generated", cast });
    localStorage.setItem("kokao-guided-story-draft-v1:99", "7");
    renderWorkflow({
      characters: cast.map((member) => ({
        ...character,
        id: member.characterId,
        referenceSheetStatus: "approved",
        referenceSheetImagePath: `/objects/99/sheet-${member.roleId}.png`,
      })),
    });

    await waitFor(() => {
      expect(state.castApprovalRoles.r1?.roleId).toBe("r1");
      expect(state.castApprovalRoles.r2?.roleId).toBe("r2");
    });
    expect(screen.queryByText("Approve Ari")).toBeNull();
    expect(screen.queryByText("Approve Bo")).toBeNull();
  });

  it("offers stock, ElevenLabs premade, and cloned voices independently of the Brand Kit", async () => {
    state.draft = draft();
    localStorage.setItem("kokao-guided-story-draft-v1:99", "7");
    renderWorkflow();
    const user = userEvent.setup();

    await user.click(screen.getByTestId("button-guided-cast-saved"));
    expect(screen.getByTestId("status-guided-elevenlabs-voices").textContent).toContain(
      "1 ElevenLabs premade voices loaded",
    );
    await user.click(screen.getByTestId("select-guided-voice-r1"));
    expect(screen.getByText("Built-in voices")).toBeTruthy();
    expect(screen.getByText("ElevenLabs premade voices")).toBeTruthy();
    expect(screen.getByText("Your cloned voices")).toBeTruthy();
    expect(screen.getAllByText("Alloy · balanced").length).toBeGreaterThan(0);
    expect(screen.getByText("Rachel")).toBeTruthy();
    expect(screen.getByText("A voice · Studio")).toBeTruthy();
    await user.click(screen.getByText("Rachel"));
    expect(state.cast).toBeNull();
  });

  it("preserves an explicit saved strategy across draft refreshes", async () => {
    state.draft = draft();
    localStorage.setItem("kokao-guided-story-draft-v1:99", "7");
    const { client } = renderWorkflow();
    await userEvent.click(screen.getByTestId("button-guided-cast-saved"));
    expect(screen.getByTestId("button-guided-cast-generated")).toBeTruthy();
    client.setQueryData(["guided", 7], { ...state.draft, revision: 3, castStrategy: null });
    expect(await screen.findByTestId("button-guided-cast-generated")).toBeTruthy();
    expect(screen.queryByTestId("status-guided-automatic-cast")).toBeNull();
  });

  it("uses one selected saved character and generates the remaining roles with AI", async () => {
    state.draft = draft();
    localStorage.setItem("kokao-guided-story-draft-v1:99", "7");
    renderWorkflow();
    const user = userEvent.setup();

    await user.click(screen.getByTestId("button-guided-cast-saved"));
    const useSavedCast = screen.getByTestId("button-guided-save-cast") as HTMLButtonElement;
    expect(useSavedCast.disabled).toBe(true);

    await user.click(screen.getByTestId("select-guided-character-r1"));
    await user.click(screen.getByText("Me"));
    await user.click(screen.getByTestId("checkbox-guided-consent"));

    expect(useSavedCast.disabled).toBe(false);
    expect(screen.getByTestId("button-guided-cast-generated").textContent).toContain(
      "automatic generated cast",
    );
    expect(screen.getByTestId("button-guided-back-to-script").textContent).toContain(
      "Back to scene editor",
    );

    await user.click(useSavedCast);
    await waitFor(() => expect(state.cast).not.toBeNull());
    expect(state.cast.assignments).toEqual([
      expect.objectContaining({
        roleId: "r1",
        source: "saved",
        characterId: 1,
        consentGranted: true,
      }),
      expect.objectContaining({
        roleId: "r2",
        source: "generated",
        characterId: null,
        consentGranted: false,
      }),
    ]);
  });

  it("continuously shows animated server-owned progress while cast work is busy", async () => {
    state.draft = draft();
    localStorage.setItem("kokao-guided-story-draft-v1:99", "7");
    renderWorkflow();

    const progress = await screen.findByTestId("status-guided-automatic-cast");
    expect(progress.textContent).toContain("Preparing every script-defined character");
    expect(progress.querySelector(".animate-spin")).not.toBeNull();
    expect(state.cast).toBeNull();
  });

  it("returns from casting to the scene editor and adds a new editable scene", async () => {
    state.draft = draft({
      setup: { ...draft().setup, durationSeconds: 30 },
    });
    localStorage.setItem("kokao-guided-story-draft-v1:99", "7");
    renderWorkflow();

    await userEvent.click(screen.getByTestId("button-guided-back-to-script"));
    expect(screen.getByTestId("guided-readable-script")).toBeTruthy();
    await userEvent.click(screen.getByTestId("button-guided-add-scene"));

    expect(screen.getByTestId("card-guided-script-scene-scene-2")).toBeTruthy();
    expect((screen.getByTestId("input-guided-scene-visual-scene-2") as HTMLTextAreaElement).value)
      .toBe("Describe what happens in this scene.");
    expect(screen.getByTestId("status-guided-script-unsaved")).toBeTruthy();
  });

  it("adds a character and allows including them in a scene", async () => {
    state.draft = draft({
      setup: { ...draft().setup, durationSeconds: 30 },
      scriptApprovedAt: null,
    });
    localStorage.setItem("kokao-guided-story-draft-v1:99", "7");
    renderWorkflow();

    await userEvent.click(screen.getByTestId("button-guided-add-character"));
    const newCharacterName = screen.getByTestId("input-guided-role-name-role-3") as HTMLInputElement;
    expect(newCharacterName.value).toBe("Character 3");

    await userEvent.click(screen.getByTestId("checkbox-guided-scene-s1-role-role-3"));
    expect(screen.getByTestId("checkbox-guided-scene-s1-role-role-3").getAttribute("data-state"))
      .toBe("checked");
    expect(screen.getByTestId("status-guided-script-unsaved")).toBeTruthy();
  });

  it("allows cast growth beyond four roles and synchronizes generated scene insertion", async () => {
    state.draft = draft({ scriptApprovedAt: null });
    localStorage.setItem("kokao-guided-story-draft-v1:99", "7");
    renderWorkflow();
    const user = userEvent.setup();

    await screen.findByTestId("guided-readable-script");
    await user.click(screen.getByTestId("button-guided-add-character"));
    await user.click(screen.getByTestId("button-guided-add-character"));
    expect(screen.getByTestId("input-guided-role-name-role-4")).toBeTruthy();
    await user.click(screen.getByTestId("button-guided-add-character"));
    expect(screen.getByTestId("input-guided-role-name-role-5")).toBeTruthy();
    expect((screen.getByTestId("button-guided-add-character") as HTMLButtonElement).disabled).toBe(false);

    await user.click(screen.getByTestId("button-guided-insert-scene-0"));
    await user.type(screen.getByTestId("input-guided-insert-scene-0"), "A paper plane interrupts the plan");
    await user.click(screen.getByTestId("button-guided-generate-scene-0"));

    expect(state.sceneRequest).toMatchObject({
      revision: 2,
      insertionIndex: 0,
      description: "A paper plane interrupts the plan",
    });
    expect(state.sceneRequest.script.roles).toHaveLength(5);
    expect(screen.getByTestId("card-guided-script-scene-ai-scene")).toBeTruthy();
    expect(screen.getByTestId("card-guided-script-scene-s1")).toBeTruthy();
    await user.click(screen.getByTestId("button-guided-toggle-json"));
    const json = (screen.getByTestId("input-guided-script") as HTMLTextAreaElement).value;
    expect(json.indexOf('"id": "ai-scene"')).toBeLessThan(json.indexOf('"id": "s1"'));
    expect(json).toContain('"id": "role-5"');
    expect(trackMock).toHaveBeenCalledWith("guided_scene_prompt_opened", {
      insertion_position: 1,
      role_count: 5,
      scene_count: 1,
    });
    expect(trackMock).toHaveBeenCalledWith("guided_scene_generation_succeeded", {
      insertion_position: 1,
      role_count: 5,
      scene_count: 2,
    });
  });

  it("keeps the script unchanged and offers retry when scene generation fails", async () => {
    state.draft = draft({ scriptApprovedAt: null });
    state.sceneError = { data: { error: "Scene provider is temporarily unavailable." } };
    localStorage.setItem("kokao-guided-story-draft-v1:99", "7");
    renderWorkflow();
    const user = userEvent.setup();

    await user.click(await screen.findByTestId("button-guided-insert-scene-1"));
    await user.type(screen.getByTestId("input-guided-insert-scene-1"), "End with a surprise");
    await user.click(screen.getByTestId("button-guided-generate-scene-1"));

    expect(screen.queryByTestId("card-guided-script-scene-ai-scene")).toBeNull();
    expect(screen.getByTestId("error-guided-insert-scene-1").textContent)
      .toContain("Scene provider is temporarily unavailable.");
    expect(screen.getByTestId("button-guided-generate-scene-1").textContent).toBe("Retry");
  });

  it("does not merge a generated scene after the local script changes", async () => {
    state.draft = draft({ scriptApprovedAt: null });
    state.deferScene = true;
    localStorage.setItem("kokao-guided-story-draft-v1:99", "7");
    renderWorkflow();
    const user = userEvent.setup();

    const line = await screen.findByTestId("input-guided-line-l1");
    await user.clear(line);
    await user.type(line, "A revised line.");
    expect(trackMock).not.toHaveBeenCalledWith("guided_script_revised_saved", expect.anything());

    await user.click(screen.getByTestId("button-guided-save-script"));
    expect(trackMock).toHaveBeenCalledWith("guided_script_revised_saved", {
      role_count: 2,
      scene_count: 1,
    });
  });

  it("keeps scene creation working when analytics throws", async () => {
    state.draft = draft({ scriptApprovedAt: null });
    localStorage.setItem("kokao-guided-story-draft-v1:99", "7");
    trackMock.mockImplementation(() => { throw new Error("analytics unavailable"); });
    renderWorkflow();
    const user = userEvent.setup();

    await user.click(await screen.findByTestId("button-guided-insert-scene-1"));
    await user.type(screen.getByTestId("input-guided-insert-scene-1"), "End with a surprise");
    await user.click(screen.getByTestId("button-guided-generate-scene-1"));

    expect(screen.getByTestId("card-guided-script-scene-ai-scene")).toBeTruthy();
  });

  it("does not merge a generated scene after the local script changes", async () => {
    state.draft = draft({ scriptApprovedAt: null });
    state.deferScene = true;
    localStorage.setItem("kokao-guided-story-draft-v1:99", "7");
    renderWorkflow();
    const user = userEvent.setup();

    await user.click(await screen.findByTestId("button-guided-insert-scene-1"));
    await user.type(screen.getByTestId("input-guided-insert-scene-1"), "End with a surprise");
    await user.click(screen.getByTestId("button-guided-generate-scene-1"));
    await user.clear(screen.getByTestId("input-guided-script-title"));
    await user.type(screen.getByTestId("input-guided-script-title"), "A newer local title");
    act(() => state.completeScene?.());

    expect(screen.queryByTestId("card-guided-script-scene-ai-scene")).toBeNull();
    expect(screen.getByTestId("error-guided-insert-scene-1").textContent).toContain("script changed");
    expect((screen.getByTestId("input-guided-script-title") as HTMLInputElement).value).toBe("A newer local title");
  });

  it("keeps built-in voices available when there are no characters or Brand Kits", async () => {
    state.draft = draft();
    localStorage.setItem("kokao-guided-story-draft-v1:99", "7");
    renderWorkflow({ characters: [], brandKits: [] });
    await userEvent.click(screen.getByTestId("button-guided-cast-saved"));
    expect(screen.getByTestId("status-guided-empty-characters")).toBeTruthy();
    await userEvent.click(screen.getByTestId("select-guided-voice-r1"));
    expect(screen.getAllByText("Alloy · balanced").length).toBeGreaterThan(0);
    expect((screen.getByTestId("button-guided-save-cast") as HTMLButtonElement).disabled).toBe(true);
  });

  it("uploads a logo, applies it only to selected scenes, and saves the immutable visual payload", async () => {
    state.draft = draft({ cast: [{ roleId: "r1" }, { roleId: "r2" }] });
    localStorage.setItem("kokao-guided-story-draft-v1:99", "7");
    renderWorkflow();
    const file = new File(["background"], "room.webp", { type: "image/webp" });
    await userEvent.upload(screen.getByTestId("input-guided-logo"), file);
    await waitFor(() => expect(screen.getByTestId("status-guided-logo-selected")).toBeTruthy());
    expect(fetch).toHaveBeenCalledWith("http://upload", expect.objectContaining({ method: "PUT", body: file }));
    await userEvent.click(screen.getByTestId("checkbox-guided-logo-scene-s1"));
    expect((screen.getByTestId("button-guided-enqueue") as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByTestId("button-guided-save-visuals"));
    expect(state.updated).toEqual({
      revision: 2,
      visualChoices: {
        version: 1,
        logo: { path: "/objects/99/uploads/visual.png", sceneIds: ["s1"] },
        location: { mode: "none", imagePath: null, description: null },
        backdropReference: {
          version: 1,
          prompt: "A tidy desk in warm daylight",
          imagePath: "/objects/99/uploads/visual.png",
          sceneIds: ["s1"],
          fingerprint: "a".repeat(64),
          approvedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    });
  });

  it("fails closed on an unapproved backdrop and exposes the dedicated review card", async () => {
    state.draft = draft({
      cast: [{ roleId: "r1" }, { roleId: "r2" }],
      visualChoices: {
        version: 1,
        logo: { path: null, sceneIds: [] },
        location: {
          mode: "image",
          imagePath: "/objects/99/uploads/visual.png",
          description: null,
        },
        backdropReference: {
          version: 1,
          prompt: "Warm desk scene",
          imagePath: "/objects/99/uploads/visual.png",
          sceneIds: ["s1"],
          fingerprint: "b".repeat(64),
          approvedAt: null,
        },
      },
    });
    localStorage.setItem("kokao-guided-story-draft-v1:99", "7");
    renderWorkflow();
    expect(screen.getByTestId("card-guided-backdrop-review")).toBeTruthy();
    expect((screen.getByTestId("button-guided-enqueue") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("status-guided-enqueue-blocked").textContent).toBe(
      "Approve Ari and Bo before starting final generation.",
    );
    expect(screen.queryByTestId("button-guided-approve-cast-r1")).toBeNull();
    expect(screen.getByTestId("button-guided-refresh-sheet-r1").textContent).toContain(
      "Refresh character sheet",
    );
    expect(screen.getByTestId("card-guided-cast-approval-r2").className).toContain("border-amber");
    await userEvent.click(screen.getByTestId("button-enlarge-guided-backdrop"));
    expect(screen.getByTestId("image-enlarged-guided-backdrop")).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByTestId("button-guided-change-outfit-r1"));
    expect(screen.getByTestId("dialog-guided-change-outfit")).toBeTruthy();
  });

  it("syncs server-authored visual changes that keep the same draft revision", async () => {
    const initial = draft({
      cast: [{ roleId: "r1", source: "generated", consentGranted: false }, { roleId: "r2", source: "generated", consentGranted: false }],
      castApprovals: {
        version: 1,
        draftRevision: 2,
        roles: {
          r1: { roleId: "r1", approvedAt: "2026-01-01", character: {}, outfit: {} },
          r2: { roleId: "r2", approvedAt: "2026-01-01", character: {}, outfit: {} },
        },
      },
    });
    state.draft = initial;
    localStorage.setItem("kokao-guided-story-draft-v1:99", "7");
    const { client } = renderWorkflow();

    expect((screen.getByTestId("button-guided-enqueue") as HTMLButtonElement).disabled).toBe(false);

    act(() => {
      client.setQueryData(["guided", initial.id], {
        ...initial,
        revision: initial.revision,
        visualChoices: {
          ...initial.visualChoices,
          location: {
            mode: "text",
            imagePath: null,
            description: "A warmer server-approved desk",
          },
        },
      });
    });

    await waitFor(() => {
      expect((screen.getByTestId("button-guided-enqueue") as HTMLButtonElement).disabled).toBe(false);
      expect(screen.queryByTestId("status-guided-enqueue-blocked")).toBeNull();
    });
  });

  it("shows the approved default beside a scene override and approves only that override", async () => {
    const defaultBackdrop = { version: 1, prompt: "Warm desk", imagePath: "/objects/99/default.png", imageSha256: "d".repeat(64), fingerprint: "d".repeat(64), revision: 2, approvedAt: "2026-01-01" };
    const override = { version: 1, prompt: "Night street", imagePath: "/objects/99/street.png", imageSha256: "o".repeat(64), fingerprint: "o".repeat(64), revision: 2, approvedAt: null };
    state.draft = draft({
      cast: [{ roleId: "r1" }, { roleId: "r2" }],
      visualChoices: { ...draft().visualChoices, backdrops: { version: 1, default: defaultBackdrop, sceneOverrides: { s1: override } } },
    });
    localStorage.setItem("kokao-guided-story-draft-v1:99", "7");
    renderWorkflow();

    expect(screen.getByTestId("card-guided-backdrop-default").textContent).toContain("Default for inheriting scenes");
    expect(screen.getByTestId("card-guided-backdrop-scene-s1").textContent).toContain("Override");
    await userEvent.click(screen.getByTestId("button-approve-guided-backdrop-s1"));
    await waitFor(() => expect(screen.getByTestId("button-approve-guided-backdrop-s1").textContent).toBe("Approved"));
    expect(screen.getByTestId("button-approve-guided-backdrop").textContent).toBe("Approved");
  });

  it("enables approval when a legacy default image is displayed and still needs approval", async () => {
    state.draft = draft({
      cast: [{ roleId: "r1" }, { roleId: "r2" }],
      visualChoices: {
        ...draft().visualChoices,
        backdropReference: {
          version: 1,
          prompt: "Warm kitchen",
          imagePath: "/objects/99/kitchen.png",
          sceneIds: ["s1"],
          fingerprint: "k".repeat(64),
          approvedAt: null,
        },
      },
    });
    localStorage.setItem("kokao-guided-story-draft-v1:99", "7");
    renderWorkflow();

    const approve = screen.getByTestId("button-approve-guided-backdrop") as HTMLButtonElement;
    expect(screen.getByTestId("button-enlarge-guided-backdrop")).toBeTruthy();
    expect(approve.disabled).toBe(false);
    await userEvent.click(approve);
    await waitFor(() => expect(approve.textContent).toBe("Approved"));
  });

  it("removes a scene override when inheriting the default", async () => {
    const approved = { version: 1, prompt: "Warm desk", imagePath: "/objects/99/default.png", imageSha256: "d".repeat(64), fingerprint: "d".repeat(64), revision: 2, approvedAt: "2026-01-01" };
    state.draft = draft({
      cast: [{ roleId: "r1" }, { roleId: "r2" }],
      visualChoices: { ...draft().visualChoices, backdrops: { version: 1, default: approved, sceneOverrides: { s1: { ...approved, prompt: "Street" } } } },
    });
    localStorage.setItem("kokao-guided-story-draft-v1:99", "7");
    renderWorkflow();
    await userEvent.click(screen.getByTestId("button-inherit-guided-backdrop-s1"));
    await waitFor(() => expect(screen.getByTestId("card-guided-backdrop-scene-s1").textContent).toContain("Uses default backdrop"));
  });

  it("requires prompt edits to be prepared before approving the backdrop", async () => {
    state.draft = draft({
      cast: [{ roleId: "r1" }, { roleId: "r2" }],
      visualChoices: {
        version: 1,
        logo: { path: null, sceneIds: [] },
        location: { mode: "image", imagePath: "/objects/99/uploads/visual.png", description: null },
        backdropReference: {
          version: 1,
          prompt: "Warm desk scene",
          imagePath: "/objects/99/uploads/visual.png",
          sceneIds: ["s1"],
          fingerprint: "b".repeat(64),
          approvedAt: null,
        },
      },
    });
    localStorage.setItem("kokao-guided-story-draft-v1:99", "7");
    renderWorkflow();

    const prompt = screen.getByTestId("input-guided-backdrop-prompt");
    await userEvent.clear(prompt);
    await userEvent.type(prompt, "A bright, organized desk scene");
    expect((screen.getByTestId("button-approve-guided-backdrop") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("status-guided-backdrop-unsaved").textContent)
      .toContain("Save backdrop review changes before approval");

    await userEvent.click(screen.getByTestId("button-prepare-guided-backdrop"));
    await waitFor(() => expect(
      (screen.getByTestId("button-approve-guided-backdrop") as HTMLButtonElement).disabled,
    ).toBe(false));
  });

  it("AI-generates the shared backdrop from story context when no input is provided", async () => {
    state.draft = draft({
      cast: [{ roleId: "r1" }, { roleId: "r2" }],
      visualChoices: {
        ...draft().visualChoices,
        backdropReference: undefined,
        backdrops: { version: 1, default: null, sceneOverrides: {} },
      },
    });
    localStorage.setItem("kokao-guided-story-draft-v1:99", "7");
    renderWorkflow();

    const prompt = screen.getByTestId("input-guided-backdrop-prompt") as HTMLTextAreaElement;
    expect(prompt.value).toBe("");
    const generateAll = screen.getByTestId("button-prepare-guided-backdrop") as HTMLButtonElement;
    expect(generateAll.textContent).toBe("AI generate for all scenes");
    expect(generateAll.disabled).toBe(false);
    await userEvent.click(generateAll);

    await waitFor(() => expect(state.generatedImageRequest).not.toBeNull());
    expect(state.generatedImageRequest.prompt).toContain('Guided Story "The plan"');
    expect(state.generatedImageRequest.prompt).toContain("Scene 1: A desk");
    expect(state.generatedImageRequest).toMatchObject({
      guidedStoryDraftId: state.draft.id,
      guidedStoryRevision: state.draft.revision,
    });
  });

  it("keeps expanded story backdrop prompts inside the API limit", () => {
    const expandedDirections = Array.from(
      { length: 9 },
      (_, index) =>
        `Scene ${index + 1}: ${"Detailed location and lighting continuity. ".repeat(12)}`,
    ).join("\n");

    const fitted = fitGuidedBackdropPrompt(expandedDirections);

    expect(fitted.length).toBe(GUIDED_BACKDROP_PROMPT_MAX);
    expect(fitted).toContain("Scene 1:");
    expect(fitted.endsWith("...")).toBe(true);
  });

  it("asks for customization approval before regenerating a backdrop", async () => {
    state.draft = draft({
      cast: [{ roleId: "r1" }, { roleId: "r2" }],
      visualChoices: {
        version: 1,
        logo: { path: null, sceneIds: [] },
        location: { mode: "image", imagePath: "/objects/99/uploads/visual.png", description: null },
        backdropReference: {
          version: 1,
          prompt: "Warm desk scene",
          imagePath: "/objects/99/uploads/visual.png",
          sceneIds: ["s1"],
          fingerprint: "b".repeat(64),
          approvedAt: null,
        },
      },
    });
    localStorage.setItem("kokao-guided-story-draft-v1:99", "7");
    renderWorkflow();

    await userEvent.click(screen.getByTestId("button-regenerate-guided-backdrop"));
    expect(screen.getByText("Customize this backdrop")).toBeTruthy();
    expect(state.generatedImageRequest).toBeNull();

    const customization = screen.getByTestId("input-guided-backdrop-customization");
    await userEvent.clear(customization);
    await userEvent.type(customization, "Keep the layout and add dark walnut walls.");
    await userEvent.click(screen.getByTestId("button-confirm-guided-backdrop-regeneration"));

    await waitFor(() => expect(state.generatedImageRequest).toMatchObject({
      referenceImagePath: "/objects/99/uploads/visual.png",
    }));
    expect(state.generatedImageRequest.prompt).toContain("dark walnut walls");
  });

  it("saves text and uploaded image location choices and blocks enqueue until each change is saved", async () => {
    state.draft = draft({ cast: [{ roleId: "r1" }, { roleId: "r2" }] });
    localStorage.setItem("kokao-guided-story-draft-v1:99", "7");
    renderWorkflow();
    await userEvent.click(screen.getByTestId("button-guided-location-text"));
    await userEvent.type(screen.getByTestId("input-guided-location-description"), "A sunlit library");
    expect((screen.getByTestId("button-guided-enqueue") as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByTestId("button-guided-save-visuals"));
    expect(state.updated.visualChoices.location).toEqual({ mode: "text", imagePath: null, description: "A sunlit library" });
    await userEvent.click(screen.getByTestId("button-guided-location-image"));
    const file = new File(["background"], "room.webp", { type: "image/webp" });
    await userEvent.upload(screen.getByTestId("input-guided-background"), file);
    await waitFor(() => expect(screen.getByTestId("status-guided-background-selected")).toBeTruthy());
    await userEvent.click(screen.getByTestId("button-guided-save-visuals"));
    expect(state.updated.visualChoices.location).toEqual({ mode: "image", imagePath: "/objects/99/uploads/visual.png", description: null });
  });

  it("shows actionable validation, upload, and visual-save errors", async () => {
    state.draft = draft({ cast: [{ roleId: "r1" }, { roleId: "r2" }] });
    localStorage.setItem("kokao-guided-story-draft-v1:99", "7");
    renderWorkflow();
    fireEvent.change(screen.getByTestId("input-guided-logo"), { target: { files: [new File(["x"], "bad.gif", { type: "image/gif" })] } });
    expect(screen.getByTestId("error-guided-visuals").textContent).toContain("PNG, JPEG, or WebP");
    state.uploadError = { data: { error: "Storage unavailable." } };
    fireEvent.change(screen.getByTestId("input-guided-logo"), { target: { files: [new File(["x"], "good.png", { type: "image/png" })] } });
    await waitFor(() => expect(screen.getByTestId("error-guided-visuals").textContent).toContain("Storage unavailable"));
    state.uploadError = null;
    state.updated = "error";
    await userEvent.click(screen.getByTestId("button-guided-save-visuals"));
    await waitFor(() => expect(screen.getByTestId("error-guided-visuals").textContent).toContain("could not be saved"));
  });
});
