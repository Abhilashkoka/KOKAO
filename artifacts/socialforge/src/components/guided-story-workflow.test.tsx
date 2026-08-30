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

const state: { draft: any; existingJob: any; created: any; cast: any; castError: unknown; approvalError: unknown; updated: any; uploadError: unknown; enqueued: any; sceneRequest: any; sceneError: unknown; deferScene: boolean; completeScene: null | (() => void) } = {
  draft: undefined,
  existingJob: null,
  created: null,
  cast: null,
  castError: null,
  approvalError: null,
  updated: null,
  uploadError: null,
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
  rolePlans: { "15": { allowed: [2], recommended: 2 }, "30": { allowed: [2, 3], recommended: 2 } },
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
    useGetGuidedStoryDraft: (id: number, options: any) =>
      useQuery({
        queryKey: ["guided", id],
        queryFn: async () => state.draft,
        initialData: state.draft,
        enabled: options?.query?.enabled,
        staleTime: Infinity,
      }),
    useGetVideoJob: () => ({ data: state.existingJob, isLoading: false }),
    useCreateGuidedStoryDraft: mutation((vars) => {
      state.created = vars.data;
      return { id: 7, revision: 1, version: 1, setup: { ...vars.data, aspectRatio: "9:16", width: 1080, height: 1920, safeArea: contract.safeArea }, script: null, scriptApprovedAt: null, userRoleId: null, castStrategy: null, cast: [], duplicateAssignmentConfirmed: false, scriptGeneration: null, storyboardJobId: null, estimates: { scriptUnits: 1, castAssetUnits: 2, previewUnits: 3, finalAdditionalUnits: 4, totalRemainingUnits: 10 }, createdAt: "", updatedAt: "" };
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
    useUpdateGuidedStoryDraft: mutation((vars) => {
      if (state.updated === "error") throw { data: { error: "Visual choices could not be saved." } };
      state.updated = vars.data;
      return { ...state.draft, ...vars.data, revision: state.draft.revision + 1 };
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
      };
    }),
    useEnqueueGuidedStoryDraft: mutation((vars) => {
      state.enqueued = vars.data;
      return { id: 99 };
    }),
    useRequestUploadUrl: () => ({
      mutateAsync: async () => {
        if (state.uploadError) throw state.uploadError;
        return { uploadURL: "http://upload", objectPath: "/objects/99/uploads/visual.png" };
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

import { GuidedStoryWorkflow } from "./guided-story-workflow";

const kit = { id: 3, name: "Studio", activeVersion: { payload: { brand_voice: { mode: "cloned", provider_voice_id: "voice-a", cloned_label: "A voice", preset_voice: "nova", voices: [{ id: "voice-a", label: "A voice" }] } } } };
const character = {
  id: 1,
  name: "Me",
  description: "A person",
  referenceImagePath: null,
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
  return { id: 7, revision: 2, version: 1, setup: { genre: "comedy", platform: "instagram_reels", durationSeconds: 15, locale: "en", topic: "A tidy desk", roleCount: 2, brandKitId: 3, aspectRatio: "9:16", width: 1080, height: 1920, safeArea: contract.safeArea }, script, scriptApprovedAt: "2026-01-01", userRoleId: null, castStrategy: null, cast: [], duplicateAssignmentConfirmed: false, scriptGeneration: null, storyboardJobId: null, estimates: { scriptUnits: 1, castAssetUnits: 2, previewUnits: 3, finalAdditionalUnits: 4, totalRemainingUnits: 10 }, createdAt: "", updatedAt: "", ...overrides };
}
function renderWorkflow(options: { characters?: any[]; brandKits?: any[] } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onJobReady = vi.fn();
  return {
    client,
    onJobReady,
    ...render(<QueryClientProvider client={client}><TooltipProvider><GuidedStoryWorkflow tenantId={99} characters={options.characters ?? [character]} brandKits={options.brandKits ?? [kit]} onManageCharacters={vi.fn()} onJobReady={onJobReady} /></TooltipProvider></QueryClientProvider>),
  };
}

beforeEach(() => { state.draft = undefined; state.created = null; state.cast = null; state.castError = null; state.approvalError = null; state.updated = null; state.uploadError = null; state.enqueued = null; state.sceneRequest = null; state.sceneError = null; state.deferScene = false; state.completeScene = null; trackMock.mockReset(); vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 })); localStorage.clear(); cleanup(); });

describe("GuidedStoryWorkflow", () => {
  it("uses the server platform duration role contract and blocks incomplete setup", async () => {
    renderWorkflow();
    expect((screen.getByTestId("button-guided-create-draft") as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByTestId("select-guided-platform"));
    await userEvent.click(screen.getByText("instagram reels"));
    expect(screen.getByTestId("text-guided-format").textContent).toContain("1080×1920");
    expect(screen.queryByTestId("button-guided-role-count-3")).toBeNull();
    await userEvent.click(screen.getByTestId("button-guided-duration-30"));
    expect((screen.getByTestId("button-guided-role-count-3") as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(screen.getByTestId("select-guided-brand-kit"));
    await userEvent.click(screen.getByText("Studio"));
    await userEvent.type(screen.getByTestId("input-guided-topic"), "A story about sorting a desk");
    await userEvent.click(screen.getByTestId("button-guided-create-draft"));
    expect(state.created).toMatchObject({ platform: "instagram_reels", durationSeconds: 30, roleCount: 2 });
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

  it("preserves unsaved readable edits across a background draft refresh", async () => {
    state.draft = draft({ scriptApprovedAt: null });
    localStorage.setItem("kokao-guided-story-draft-v1:99", "7");
    const { client } = renderWorkflow();
    const user = userEvent.setup();

    const line = await screen.findByTestId("input-guided-line-l1");
    await user.clear(line);
    await user.type(line, "Keep this local edit.");
    act(() => {
      client.setQueryData(["guided", 7], draft({
        revision: 3,
        scriptApprovedAt: null,
        script: { ...script, title: "Background title" },
      }));
    });

    expect((screen.getByTestId("input-guided-line-l1") as HTMLTextAreaElement).value).toBe("Keep this local edit.");
    expect((screen.getByTestId("input-guided-script-title") as HTMLInputElement).value).toBe("The plan");
    expect(screen.getByTestId("status-guided-script-unsaved")).toBeTruthy();
  });

  it("requires saved character, voice and fresh consent before saving saved cast", async () => {
    state.draft = draft();
    localStorage.setItem("kokao-guided-story-draft-v1:99", "7");
    renderWorkflow();
    await userEvent.click(screen.getByTestId("button-guided-user-role-r1"));
    await userEvent.click(screen.getByTestId("button-guided-cast-saved"));
    expect((screen.getByTestId("button-guided-save-cast") as HTMLButtonElement).disabled).toBe(true);
    for (const role of ["r1", "r2"]) {
      await userEvent.click(screen.getByTestId(`select-guided-character-${role}`));
      await userEvent.click(screen.getAllByText("Me").at(-1)!);
      await userEvent.click(screen.getByTestId(`select-guided-voice-${role}`));
      await userEvent.click(screen.getAllByText("A voice · Studio").at(-1)!);
    }
    expect((screen.getByTestId("button-guided-save-cast") as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByTestId("checkbox-guided-consent"));
    expect(screen.getByTestId("checkbox-guided-duplicate-confirmation")).toBeTruthy();
    await userEvent.click(screen.getByTestId("checkbox-guided-duplicate-confirmation"));
    await userEvent.click(screen.getByTestId("button-guided-save-cast"));
    expect(state.cast).toMatchObject({ strategy: "saved", duplicateAssignmentConfirmed: true });
    expect(state.cast.assignments).toHaveLength(2);
    expect(await screen.findByTestId("status-guided-cast-complete")).toBeTruthy();
    expect(screen.getByTestId("button-guided-enqueue")).toBeTruthy();
    expect(state.draft.revision).toBe(2);
    await userEvent.click(screen.getByTestId("button-guided-enqueue"));
    expect(state.enqueued).toEqual({ revision: 3 });
  });

  it("guides the user to choose their role before generating the remaining cast", async () => {
    state.draft = draft();
    localStorage.setItem("kokao-guided-story-draft-v1:99", "7");
    renderWorkflow();
    const user = userEvent.setup();

    await user.click(screen.getByTestId("button-guided-cast-generated"));

    expect(screen.getByTestId("error-guided-user-role").textContent).toContain(
      "Choose your character",
    );
    for (const role of ["none", "r1", "r2"]) {
      expect(screen.getByTestId(`button-guided-user-role-${role}`).className).toContain(
        "ring-amber-400",
      );
    }

    await user.click(screen.getByTestId("button-guided-user-role-r1"));
    expect(screen.queryByTestId("error-guided-user-role")).toBeNull();
    expect(screen.getByTestId("status-guided-ready-generate-cast").textContent).toContain(
      "click “Generate remaining cast”",
    );

    await user.click(screen.getByTestId("button-guided-cast-generated"));
    expect(screen.queryByTestId("status-guided-ready-generate-cast")).toBeNull();
    expect(screen.getByTestId("select-guided-generated-voice-r2")).toBeTruthy();
  });

  it("allows the user to play no character and generates the full cast", async () => {
    state.draft = draft();
    localStorage.setItem("kokao-guided-story-draft-v1:99", "7");
    renderWorkflow();

    await userEvent.click(screen.getByTestId("button-guided-user-role-none"));
    expect(screen.getByTestId("button-guided-user-role-none").getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByTestId("checkbox-guided-consent")).toBeNull();
    expect((screen.getByTestId("button-guided-save-cast") as HTMLButtonElement).disabled).toBe(false);

    await userEvent.click(screen.getByTestId("button-guided-save-cast"));
    expect(state.cast.assignments.every((item: any) => item.isUserRole === false)).toBe(true);
    expect(state.cast.assignments.every((item: any) => item.source === "generated")).toBe(true);
  });

  it("opens the existing storyboard job instead of silently re-enqueueing it", async () => {
    state.draft = draft({
      cast: [{ roleId: "lead" }, { roleId: "friend" }],
      storyboardJobId: 43126,
    });
    localStorage.setItem("kokao-guided-story-draft-v1:99", "7");
    state.existingJob = { id: 43126, status: "awaiting_review", storyboard: { scenes: [{}] } };
    const { onJobReady } = renderWorkflow();

    expect(screen.getByTestId("button-guided-enqueue").textContent).toBe(
      "Open existing storyboard job",
    );
    await userEvent.click(screen.getByTestId("button-guided-enqueue"));

    expect(onJobReady).toHaveBeenCalledWith(43126);
    expect(state.enqueued).toBeNull();
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
      "Edit story and rebuild storyboard",
    );
    await userEvent.click(screen.getByTestId("button-guided-enqueue"));

    expect(screen.getByTestId("guided-readable-script")).toBeTruthy();
    expect(onJobReady).not.toHaveBeenCalled();
  });

  it("offers stock, ElevenLabs premade, and cloned voices independently of the Brand Kit", async () => {
    state.draft = draft();
    localStorage.setItem("kokao-guided-story-draft-v1:99", "7");
    renderWorkflow();
    const user = userEvent.setup();

    await user.click(screen.getByTestId("button-guided-user-role-none"));
    expect(screen.getByTestId("status-guided-elevenlabs-voices").textContent).toContain(
      "1 ElevenLabs premade voices loaded",
    );
    await user.click(screen.getByTestId("select-guided-generated-voice-r1"));
    expect(screen.getByText("Built-in voices")).toBeTruthy();
    expect(screen.getByText("ElevenLabs premade voices")).toBeTruthy();
    expect(screen.getByText("Your cloned voices")).toBeTruthy();
    expect(screen.getAllByText("Alloy · balanced").length).toBeGreaterThan(0);
    expect(screen.getByText("Rachel")).toBeTruthy();
    expect(screen.getByText("A voice · Studio")).toBeTruthy();
    await user.click(screen.getByText("Rachel"));

    await user.click(screen.getByTestId("button-guided-save-cast"));
    expect(state.cast.assignments.find((item: any) => item.roleId === "r1").voiceId)
      .toBe("elevenlabs:premade:el-rachel");
  });

  it("shows the server error and a retry action when saving cast fails", async () => {
    state.draft = draft();
    state.castError = { data: { error: "This cast checkpoint needs to be retried." } };
    localStorage.setItem("kokao-guided-story-draft-v1:99", "7");
    renderWorkflow();

    await userEvent.click(screen.getByTestId("button-guided-user-role-none"));
    await userEvent.click(screen.getByTestId("button-guided-save-cast"));

    expect((await screen.findByTestId("error-guided-save-cast")).textContent)
      .toContain("This cast checkpoint needs to be retried.");
    expect(screen.getByTestId("button-guided-save-cast").textContent)
      .toContain("Retry saving cast");
  });

  it("continuously shows animated role progress while cast work is busy", async () => {
    state.draft = draft();
    state.castError = {
      data: { error: "Cast generation is already in progress for role meena." },
    };
    localStorage.setItem("kokao-guided-story-draft-v1:99", "7");
    renderWorkflow();

    await userEvent.click(screen.getByTestId("button-guided-user-role-none"));
    await userEvent.click(screen.getByTestId("button-guided-save-cast"));

    const progress = await screen.findByTestId("status-guided-cast-progress");
    expect(progress.textContent).toContain("Generating meena’s cast…");
    expect(progress.querySelector(".animate-spin")).not.toBeNull();
    expect(screen.getByTestId("button-guided-save-cast").textContent)
      .toContain("Generating meena…");
    expect(screen.queryByTestId("error-guided-save-cast")).toBeNull();
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

  it("allows cast growth to four roles and synchronizes generated scene insertion", async () => {
    state.draft = draft({ scriptApprovedAt: null });
    localStorage.setItem("kokao-guided-story-draft-v1:99", "7");
    renderWorkflow();
    const user = userEvent.setup();

    await screen.findByTestId("guided-readable-script");
    await user.click(screen.getByTestId("button-guided-add-character"));
    await user.click(screen.getByTestId("button-guided-add-character"));
    expect(screen.getByTestId("input-guided-role-name-role-4")).toBeTruthy();
    expect((screen.getByTestId("button-guided-add-character") as HTMLButtonElement).disabled).toBe(true);

    await user.click(screen.getByTestId("button-guided-insert-scene-0"));
    await user.type(screen.getByTestId("input-guided-insert-scene-0"), "A paper plane interrupts the plan");
    await user.click(screen.getByTestId("button-guided-generate-scene-0"));

    expect(state.sceneRequest).toMatchObject({
      revision: 2,
      insertionIndex: 0,
      description: "A paper plane interrupts the plan",
    });
    expect(state.sceneRequest.script.roles).toHaveLength(4);
    expect(screen.getByTestId("card-guided-script-scene-ai-scene")).toBeTruthy();
    expect(screen.getByTestId("card-guided-script-scene-s1")).toBeTruthy();
    await user.click(screen.getByTestId("button-guided-toggle-json"));
    const json = (screen.getByTestId("input-guided-script") as HTMLTextAreaElement).value;
    expect(json.indexOf('"id": "ai-scene"')).toBeLessThan(json.indexOf('"id": "s1"'));
    expect(json).toContain('"id": "role-4"');
    expect(trackMock).toHaveBeenCalledWith("guided_scene_prompt_opened", {
      insertion_position: 1,
      role_count: 4,
      scene_count: 1,
    });
    expect(trackMock).toHaveBeenCalledWith("guided_scene_generation_succeeded", {
      insertion_position: 1,
      role_count: 4,
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

    expect(screen.getByTestId("error-guided-insert-scene-1").textContent).toContain("temporarily unavailable");
    expect(screen.getByTestId("button-guided-generate-scene-1").textContent).toBe("Retry");
    expect(screen.queryByTestId("card-guided-script-scene-ai-scene")).toBeNull();
    expect(screen.getAllByTestId(/card-guided-script-scene-/)).toHaveLength(1);

    await user.click(screen.getByTestId("button-guided-generate-scene-1"));
    expect(trackMock).toHaveBeenCalledWith("guided_scene_retry_requested", {
      insertion_position: 2,
      role_count: 2,
      scene_count: 1,
    });
  });

  it("tracks a revised script only after it is saved", async () => {
    state.draft = draft({ scriptApprovedAt: null });
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
    await userEvent.click(screen.getByTestId("button-guided-user-role-r1"));
    expect(screen.getByTestId("status-guided-empty-characters")).toBeTruthy();
    await userEvent.click(screen.getByTestId("select-guided-voice-r1"));
    expect(screen.getAllByText("Alloy · balanced").length).toBeGreaterThan(0);
    expect((screen.getByTestId("button-guided-save-cast") as HTMLButtonElement).disabled).toBe(true);
  });

  it("uploads a logo, applies it only to selected scenes, and saves the immutable visual payload", async () => {
    state.draft = draft({ cast: [{ roleId: "r1" }, { roleId: "r2" }] });
    localStorage.setItem("kokao-guided-story-draft-v1:99", "7");
    renderWorkflow();
    const file = new File(["logo"], "logo.png", { type: "image/png" });
    await userEvent.upload(screen.getByTestId("input-guided-logo"), file);
    await waitFor(() => expect(screen.getByTestId("status-guided-logo-selected")).toBeTruthy());
    expect(fetch).toHaveBeenCalledWith("http://upload", expect.objectContaining({ method: "PUT", body: file }));
    await userEvent.click(screen.getByTestId("checkbox-guided-logo-scene-s1"));
    expect((screen.getByTestId("button-guided-enqueue") as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByTestId("button-guided-save-visuals"));
    expect(state.updated).toEqual({ revision: 2, visualChoices: { logo: { path: "/objects/99/uploads/visual.png", sceneIds: ["s1"] }, location: { mode: "none", imagePath: null, description: null } } });
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