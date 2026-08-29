import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";

// Radix Select uses these browser methods while opening its menu.
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = () => {};
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

const state: { draft: any; created: any; cast: any; enqueued: any } = {
  draft: undefined,
  created: null,
  cast: null,
  enqueued: null,
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
      } finally {
        options?.onSettled?.();
      }
    },
  });
  return createApiClientMock({
    getGetGuidedStoryDraftQueryKey: (id: number) => ["guided", id],
    useListGuidedStoryPlatforms: () => ({ data: [contract], isLoading: false }),
    useGetGuidedStoryDraft: (id: number, options: any) =>
      useQuery({
        queryKey: ["guided", id],
        queryFn: async () => state.draft,
        initialData: state.draft,
        enabled: options?.query?.enabled,
        staleTime: Infinity,
      }),
    useCreateGuidedStoryDraft: mutation((vars) => {
      state.created = vars.data;
      return { id: 7, revision: 1, version: 1, setup: { ...vars.data, aspectRatio: "9:16", width: 1080, height: 1920, safeArea: contract.safeArea }, script: null, scriptApprovedAt: null, userRoleId: null, castStrategy: null, cast: [], duplicateAssignmentConfirmed: false, scriptGeneration: null, storyboardJobId: null, estimates: { scriptUnits: 1, castAssetUnits: 2, previewUnits: 3, finalAdditionalUnits: 4, totalRemainingUnits: 10 }, createdAt: "", updatedAt: "" };
    }),
    useCastGuidedStoryDraft: mutation((vars) => {
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
  });
});

import { GuidedStoryWorkflow } from "./guided-story-workflow";

const kit = { id: 3, name: "Studio", activeVersion: { payload: { brand_voice: { mode: "cloned", provider_voice_id: "voice-a", cloned_label: "A voice", preset_voice: "nova", voices: [{ id: "voice-a", label: "A voice" }] } } } };
const character = { id: 1, name: "Me", description: "A person", referenceImagePath: null, outfits: [{ id: 11, name: "Jacket", description: "Blue", referenceImagePath: null }] };
function draft(overrides: Record<string, unknown> = {}) {
  return { id: 7, revision: 2, version: 1, setup: { genre: "comedy", platform: "instagram_reels", durationSeconds: 15, locale: "en", topic: "A tidy desk", roleCount: 2, brandKitId: 3, aspectRatio: "9:16", width: 1080, height: 1920, safeArea: contract.safeArea }, script, scriptApprovedAt: "2026-01-01", userRoleId: null, castStrategy: null, cast: [], duplicateAssignmentConfirmed: false, scriptGeneration: null, storyboardJobId: null, estimates: { scriptUnits: 1, castAssetUnits: 2, previewUnits: 3, finalAdditionalUnits: 4, totalRemainingUnits: 10 }, createdAt: "", updatedAt: "", ...overrides };
}
function renderWorkflow(options: { characters?: any[]; brandKits?: any[] } = {}) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><TooltipProvider><GuidedStoryWorkflow tenantId={99} characters={options.characters ?? [character]} brandKits={options.brandKits ?? [kit]} onManageCharacters={vi.fn()} onJobReady={vi.fn()} /></TooltipProvider></QueryClientProvider>);
}

beforeEach(() => { state.draft = undefined; state.created = null; state.cast = null; state.enqueued = null; localStorage.clear(); cleanup(); });

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
      await userEvent.click(screen.getAllByText("A voice").at(-1)!);
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

  it("shows character and voice empty states instead of allowing casting", async () => {
    state.draft = draft();
    localStorage.setItem("kokao-guided-story-draft-v1:99", "7");
    renderWorkflow({ characters: [], brandKits: [] });
    await userEvent.click(screen.getByTestId("button-guided-user-role-r1"));
    expect(screen.getByTestId("status-guided-empty-characters")).toBeTruthy();
    expect(screen.getByTestId("status-guided-empty-voices")).toBeTruthy();
    expect((screen.getByTestId("button-guided-save-cast") as HTMLButtonElement).disabled).toBe(true);
  });
});