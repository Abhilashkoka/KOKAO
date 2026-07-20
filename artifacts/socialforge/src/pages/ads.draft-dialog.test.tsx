import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Regression guard for the LinkedIn new-campaign-group draft flow:
 * - Campaign create mode shows the campaign-group picker, daily budget and
 *   schedule fields, and blocks submit until a group is chosen.
 * - Picking "Create a new campaign group…" switches the dialog to group
 *   mode: daily budget and schedule are hidden, lifetime budget stays, and
 *   a back link returns to campaign mode.
 * - Group-mode submit sends targetType campaign_group WITHOUT dailyBudget,
 *   campaignGroupId, objective, or schedule fields.
 * - Approving a draft invalidates the LinkedIn campaign-groups list so a
 *   freshly applied group shows up in the picker.
 */

// Radix menus/dialogs need a few APIs jsdom doesn't implement.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
if (typeof globalThis.ResizeObserver === "undefined") {
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

const createDraftMutate = vi.fn();
const approveMutate = vi.fn();

const mockState = {
  groups: [{ id: "grp_1", name: "Always On", status: "ACTIVE" }] as Array<{
    id: string;
    name: string;
    status: string;
  }>,
  drafts: [] as Array<Record<string, unknown>>,
};

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  return createApiClientMock({
    useListLinkedinCampaignGroups: () => ({
      data: { groups: mockState.groups },
      isLoading: false,
    }),
    getListLinkedinCampaignGroupsQueryKey: (params?: unknown) => [
      "/api/ads/linkedin/campaign-groups",
      params,
    ],
    useCreateAdDraft: () => ({ mutate: createDraftMutate, isPending: false }),
    useListAdDrafts: () => ({ data: mockState.drafts, isLoading: false }),
    useApproveAdDraft: () => ({ mutate: approveMutate, isPending: false }),
    useRejectAdDraft: () => ({ mutate: vi.fn(), isPending: false }),
  });
});

// Imported after the mock so the mocked module is picked up.
import { DraftDialog, DraftsSection } from "./ads";

const CREATE_FORM = {
  action: "create" as "create" | "update",
  targetType: "campaign",
  targetId: null as string | null,
  currentName: "",
  name: "",
  status: "",
  dailyBudget: "",
  lifetimeBudget: "",
  startTime: "",
  stopTime: "",
  objective: "OUTCOME_TRAFFIC",
  bidAmount: "",
  bidStrategy: "",
};

let queryClient: QueryClient;

function renderDraftDialog(
  onClose: () => void = () => {},
  platform = "linkedin",
  formOverrides: Partial<typeof CREATE_FORM> = {},
) {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <DraftDialog
        connectionId={7}
        platform={platform}
        form={{ ...CREATE_FORM, ...formOverrides }}
        onClose={onClose}
      />
    </QueryClientProvider>,
  );
}

function submittedPayload(): Record<string, unknown> {
  expect(createDraftMutate).toHaveBeenCalledTimes(1);
  return (createDraftMutate.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
}

async function switchToGroupMode(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId("select-draft-campaign-group"));
  await user.click(await screen.findByTestId("option-create-campaign-group"));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockState.groups = [{ id: "grp_1", name: "Always On", status: "ACTIVE" }];
  mockState.drafts = [];
});

afterEach(() => {
  cleanup();
});

describe("DraftDialog LinkedIn campaign create mode", () => {
  it("shows the group picker, daily budget, and schedule fields", () => {
    renderDraftDialog();
    expect(screen.getByText("Draft a new campaign")).toBeTruthy();
    expect(screen.getByTestId("select-draft-campaign-group")).toBeTruthy();
    expect(screen.getByTestId("input-draft-daily-budget")).toBeTruthy();
    expect(screen.getByTestId("input-draft-lifetime-budget")).toBeTruthy();
    expect(screen.getByTestId("input-draft-start")).toBeTruthy();
    expect(screen.getByTestId("input-draft-stop")).toBeTruthy();
    // LinkedIn campaigns have no objective picker.
    expect(screen.queryByTestId("select-draft-objective")).toBeNull();
  });

  it("keeps Save disabled until a campaign group is chosen", async () => {
    const user = userEvent.setup();
    renderDraftDialog();
    fireEvent.change(screen.getByTestId("input-draft-name"), {
      target: { value: "LI Launch" },
    });
    const submit = screen.getByTestId("button-submit-draft") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    await user.click(screen.getByTestId("select-draft-campaign-group"));
    await user.click(await screen.findByText("Always On"));
    expect((screen.getByTestId("button-submit-draft") as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("submits a campaign draft with the chosen campaignGroupId", async () => {
    const user = userEvent.setup();
    renderDraftDialog();
    fireEvent.change(screen.getByTestId("input-draft-name"), {
      target: { value: "LI Launch" },
    });
    fireEvent.change(screen.getByTestId("input-draft-daily-budget"), {
      target: { value: "10000" },
    });
    await user.click(screen.getByTestId("select-draft-campaign-group"));
    await user.click(await screen.findByText("Always On"));
    fireEvent.click(screen.getByTestId("button-submit-draft"));

    expect(createDraftMutate).toHaveBeenCalledTimes(1);
    const payload = (createDraftMutate.mock.calls[0]![0] as { data: Record<string, unknown> })
      .data;
    expect(payload.targetType).toBe("campaign");
    expect(payload.campaignGroupId).toBe("grp_1");
    expect(payload.dailyBudget).toBe(10000);
    expect(payload.objective).toBeUndefined();
  });
});

describe("DraftDialog group mode switching", () => {
  it("switches to group mode and hides campaign-only fields", async () => {
    const user = userEvent.setup();
    renderDraftDialog();
    await switchToGroupMode(user);

    expect(screen.getByText("Draft a new campaign group")).toBeTruthy();
    expect(screen.queryByTestId("input-draft-daily-budget")).toBeNull();
    expect(screen.queryByTestId("input-draft-start")).toBeNull();
    expect(screen.queryByTestId("input-draft-stop")).toBeNull();
    expect(screen.queryByTestId("select-draft-campaign-group")).toBeNull();
    // Lifetime budget stays available for group creates.
    expect(screen.getByTestId("input-draft-lifetime-budget")).toBeTruthy();
    expect(screen.getByTestId("button-back-to-campaign")).toBeTruthy();
  });

  it("returns to campaign mode via the back link", async () => {
    const user = userEvent.setup();
    renderDraftDialog();
    await switchToGroupMode(user);
    fireEvent.click(screen.getByTestId("button-back-to-campaign"));

    expect(screen.getByText("Draft a new campaign")).toBeTruthy();
    expect(screen.getByTestId("select-draft-campaign-group")).toBeTruthy();
    expect(screen.getByTestId("input-draft-daily-budget")).toBeTruthy();
    expect(screen.queryByTestId("button-back-to-campaign")).toBeNull();
  });

  it("submits a campaign_group draft without campaign-only fields", async () => {
    const user = userEvent.setup();
    renderDraftDialog();
    fireEvent.change(screen.getByTestId("input-draft-name"), {
      target: { value: "Q3 Group" },
    });
    await switchToGroupMode(user);
    fireEvent.change(screen.getByTestId("input-draft-lifetime-budget"), {
      target: { value: "500000" },
    });
    const submit = screen.getByTestId("button-submit-draft") as HTMLButtonElement;
    // No group selection required in group mode.
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);

    expect(createDraftMutate).toHaveBeenCalledTimes(1);
    const payload = (createDraftMutate.mock.calls[0]![0] as { data: Record<string, unknown> })
      .data;
    expect(payload.targetType).toBe("campaign_group");
    expect(payload.action).toBe("create");
    expect(payload.name).toBe("Q3 Group");
    expect(payload.lifetimeBudget).toBe(500000);
    expect(payload.dailyBudget).toBeUndefined();
    expect(payload.campaignGroupId).toBeUndefined();
    expect(payload.objective).toBeUndefined();
    expect(payload.startTime).toBeUndefined();
    expect(payload.stopTime).toBeUndefined();
  });
});

describe("DraftDialog Google", () => {
  it("campaign create shows objective and schedule but hides lifetime budget", async () => {
    const user = userEvent.setup();
    renderDraftDialog(() => {}, "google", { objective: "SEARCH" });

    expect(screen.getByTestId("select-draft-objective")).toBeTruthy();
    expect(screen.getByTestId("input-draft-daily-budget")).toBeTruthy();
    // Google has no lifetime budget anywhere.
    expect(screen.queryByTestId("input-draft-lifetime-budget")).toBeNull();
    expect(screen.getByTestId("input-draft-start")).toBeTruthy();
    expect(screen.getByTestId("input-draft-stop")).toBeTruthy();
    // No LinkedIn campaign-group picker.
    expect(screen.queryByTestId("select-draft-campaign-group")).toBeNull();

    // Objective options are the Google channel types.
    await user.click(screen.getByTestId("select-draft-objective"));
    expect(await screen.findByText("Performance Max")).toBeTruthy();
    expect(screen.getByText("Display")).toBeTruthy();
    expect(screen.queryByText("Traffic")).toBeNull();
  });

  it("campaign create payload includes objective/dailyBudget/schedule, no lifetimeBudget or campaignGroupId", () => {
    renderDraftDialog(() => {}, "google", { objective: "SEARCH" });
    fireEvent.change(screen.getByTestId("input-draft-name"), {
      target: { value: "G Search" },
    });
    fireEvent.change(screen.getByTestId("input-draft-daily-budget"), {
      target: { value: "5000" },
    });
    fireEvent.change(screen.getByTestId("input-draft-start"), {
      target: { value: "2026-08-01T00:00:00+0000" },
    });
    fireEvent.change(screen.getByTestId("input-draft-stop"), {
      target: { value: "2026-08-31T00:00:00+0000" },
    });
    fireEvent.click(screen.getByTestId("button-submit-draft"));

    const payload = submittedPayload();
    expect(payload.targetType).toBe("campaign");
    expect(payload.objective).toBe("SEARCH");
    expect(payload.dailyBudget).toBe(5000);
    expect(payload.startTime).toBe("2026-08-01T00:00:00+0000");
    expect(payload.stopTime).toBe("2026-08-31T00:00:00+0000");
    expect(payload.lifetimeBudget).toBeUndefined();
    expect(payload.campaignGroupId).toBeUndefined();
  });

  it("ad group edit relabels daily budget as CPC bid and hides lifetime budget and schedule", () => {
    renderDraftDialog(() => {}, "google", {
      action: "update",
      targetType: "adset",
      targetId: "ag_1",
      currentName: "Ad group A",
      name: "Ad group A",
    });

    expect(screen.getByText("Default CPC bid (minor units)")).toBeTruthy();
    expect(screen.getByTestId("input-draft-daily-budget")).toBeTruthy();
    expect(screen.queryByTestId("input-draft-lifetime-budget")).toBeNull();
    expect(screen.queryByTestId("input-draft-start")).toBeNull();
    expect(screen.queryByTestId("input-draft-stop")).toBeNull();
    expect(screen.queryByTestId("select-draft-objective")).toBeNull();

    fireEvent.change(screen.getByTestId("input-draft-daily-budget"), {
      target: { value: "150" },
    });
    fireEvent.click(screen.getByTestId("button-submit-draft"));
    const payload = submittedPayload();
    expect(payload.targetType).toBe("adset");
    expect(payload.targetId).toBe("ag_1");
    expect(payload.dailyBudget).toBe(150);
    expect(payload.objective).toBeUndefined();
    expect(payload.lifetimeBudget).toBeUndefined();
    // Name unchanged: not resent.
    expect(payload.name).toBeUndefined();
  });

  it("ad edit locks the name field and never submits a name", () => {
    renderDraftDialog(() => {}, "google", {
      action: "update",
      targetType: "ad",
      targetId: "ad_1",
      currentName: "My ad",
      name: "My ad",
      status: "PAUSED",
    });

    const nameInput = screen.getByTestId("input-draft-name") as HTMLInputElement;
    expect(nameInput.disabled).toBe(true);
    fireEvent.change(nameInput, { target: { value: "Renamed" } });
    fireEvent.click(screen.getByTestId("button-submit-draft"));

    const payload = submittedPayload();
    expect(payload.targetType).toBe("ad");
    expect(payload.name).toBeUndefined();
    expect(payload.status).toBe("PAUSED");
  });
});

describe("DraftDialog TikTok", () => {
  it("campaign create remaps the Meta default objective to TRAFFIC and hides schedule", async () => {
    const user = userEvent.setup();
    // Form arrives with the Meta default; TikTok must remap it.
    renderDraftDialog(() => {}, "tiktok", { objective: "OUTCOME_TRAFFIC" });

    expect(screen.getByTestId("select-draft-objective")).toBeTruthy();
    expect(screen.getByTestId("input-draft-daily-budget")).toBeTruthy();
    expect(screen.getByTestId("input-draft-lifetime-budget")).toBeTruthy();
    // TikTok campaigns never show schedule fields.
    expect(screen.queryByTestId("input-draft-start")).toBeNull();
    expect(screen.queryByTestId("input-draft-stop")).toBeNull();

    await user.click(screen.getByTestId("select-draft-objective"));
    expect(await screen.findByText("Video views")).toBeTruthy();
    expect(screen.getByText("App promotion")).toBeTruthy();
    expect(screen.queryByText("Performance Max")).toBeNull();

    // Close the menu, then submit and confirm the remapped objective.
    await user.keyboard("{Escape}");
    fireEvent.change(screen.getByTestId("input-draft-name"), {
      target: { value: "TT Launch" },
    });
    fireEvent.click(screen.getByTestId("button-submit-draft"));
    const payload = submittedPayload();
    expect(payload.objective).toBe("TRAFFIC");
  });

  it("campaign create payload omits schedule even if the form carried times", () => {
    renderDraftDialog(() => {}, "tiktok", {
      objective: "OUTCOME_TRAFFIC",
      startTime: "2026-08-01T00:00:00+0000",
      stopTime: "2026-08-31T00:00:00+0000",
    });
    fireEvent.change(screen.getByTestId("input-draft-name"), {
      target: { value: "TT Launch" },
    });
    fireEvent.change(screen.getByTestId("input-draft-daily-budget"), {
      target: { value: "2000" },
    });
    fireEvent.click(screen.getByTestId("button-submit-draft"));

    const payload = submittedPayload();
    expect(payload.targetType).toBe("campaign");
    expect(payload.objective).toBe("TRAFFIC");
    expect(payload.dailyBudget).toBe(2000);
    expect(payload.startTime).toBeUndefined();
    expect(payload.stopTime).toBeUndefined();
    expect(payload.campaignGroupId).toBeUndefined();
  });

  it("ad group edit shows budgets and schedule and submits them", () => {
    renderDraftDialog(() => {}, "tiktok", {
      action: "update",
      targetType: "adset",
      targetId: "ag_tt",
      currentName: "TT group",
      name: "TT group",
      dailyBudget: "999",
    });

    expect(screen.getByTestId("input-draft-daily-budget")).toBeTruthy();
    expect(screen.getByTestId("input-draft-lifetime-budget")).toBeTruthy();
    expect(screen.getByTestId("input-draft-start")).toBeTruthy();
    expect(screen.getByTestId("input-draft-stop")).toBeTruthy();

    fireEvent.change(screen.getByTestId("input-draft-name"), {
      target: { value: "TT group renamed" },
    });
    fireEvent.change(screen.getByTestId("input-draft-daily-budget"), {
      target: { value: "2500" },
    });
    fireEvent.change(screen.getByTestId("input-draft-start"), {
      target: { value: "2026-08-01 00:00:00" },
    });
    fireEvent.change(screen.getByTestId("input-draft-stop"), {
      target: { value: "2026-08-31 00:00:00" },
    });
    fireEvent.click(screen.getByTestId("button-submit-draft"));
    const payload = submittedPayload();
    expect(payload.targetType).toBe("adset");
    expect(payload.name).toBe("TT group renamed");
    expect(payload.dailyBudget).toBe(2500);
    expect(payload.startTime).toBe("2026-08-01 00:00:00");
    expect(payload.stopTime).toBe("2026-08-31 00:00:00");
  });

  it("ad edit hides budgets and schedule", () => {
    renderDraftDialog(() => {}, "tiktok", {
      action: "update",
      targetType: "ad",
      targetId: "ad_tt",
      currentName: "TT ad",
      name: "TT ad",
    });

    expect(screen.queryByTestId("input-draft-daily-budget")).toBeNull();
    expect(screen.queryByTestId("input-draft-lifetime-budget")).toBeNull();
    expect(screen.queryByTestId("input-draft-start")).toBeNull();
    expect(screen.queryByTestId("input-draft-stop")).toBeNull();
  });
});

describe("DraftDialog Meta", () => {
  it("campaign create shows Meta objectives, both budgets, and schedule", async () => {
    const user = userEvent.setup();
    renderDraftDialog(() => {}, "meta");

    expect(screen.getByTestId("select-draft-objective")).toBeTruthy();
    expect(screen.getByTestId("input-draft-daily-budget")).toBeTruthy();
    expect(screen.getByTestId("input-draft-lifetime-budget")).toBeTruthy();
    expect(screen.getByTestId("input-draft-start")).toBeTruthy();
    expect(screen.getByTestId("input-draft-stop")).toBeTruthy();
    expect(screen.queryByTestId("select-draft-campaign-group")).toBeNull();

    await user.click(screen.getByTestId("select-draft-objective"));
    expect(await screen.findByText("Awareness")).toBeTruthy();
    expect(screen.getByText("Sales")).toBeTruthy();
    expect(screen.queryByText("Search")).toBeNull();
  });

  it("campaign create submits an OUTCOME_* objective with budgets and schedule", () => {
    renderDraftDialog(() => {}, "meta");
    fireEvent.change(screen.getByTestId("input-draft-name"), {
      target: { value: "Meta Launch" },
    });
    fireEvent.change(screen.getByTestId("input-draft-daily-budget"), {
      target: { value: "3000" },
    });
    fireEvent.change(screen.getByTestId("input-draft-lifetime-budget"), {
      target: { value: "90000" },
    });
    fireEvent.change(screen.getByTestId("input-draft-start"), {
      target: { value: "2026-09-01T00:00:00+0000" },
    });
    fireEvent.click(screen.getByTestId("button-submit-draft"));

    const payload = submittedPayload();
    expect(payload.targetType).toBe("campaign");
    expect(payload.objective).toBe("OUTCOME_TRAFFIC");
    expect(payload.dailyBudget).toBe(3000);
    expect(payload.lifetimeBudget).toBe(90000);
    expect(payload.startTime).toBe("2026-09-01T00:00:00+0000");
    expect(payload.campaignGroupId).toBeUndefined();
  });

  it("ad set edit shows budgets and schedule but no objective, and omits objective from the payload", () => {
    renderDraftDialog(() => {}, "meta", {
      action: "update",
      targetType: "adset",
      targetId: "as_1",
      currentName: "Meta set",
      name: "Meta set",
    });

    expect(screen.getByTestId("input-draft-daily-budget")).toBeTruthy();
    expect(screen.getByTestId("input-draft-lifetime-budget")).toBeTruthy();
    expect(screen.queryByTestId("select-draft-objective")).toBeNull();
    // Meta ad sets carry their own schedule (end_time), so the schedule
    // fields render for ad set edits on Meta.
    expect(screen.getByTestId("input-draft-start")).toBeTruthy();
    expect(screen.getByTestId("input-draft-stop")).toBeTruthy();

    fireEvent.change(screen.getByTestId("input-draft-daily-budget"), {
      target: { value: "1500" },
    });
    fireEvent.change(screen.getByTestId("input-draft-stop"), {
      target: { value: "2026-10-31T00:00:00+0000" },
    });
    fireEvent.click(screen.getByTestId("button-submit-draft"));
    const payload = submittedPayload();
    expect(payload.targetType).toBe("adset");
    expect(payload.targetId).toBe("as_1");
    expect(payload.dailyBudget).toBe(1500);
    expect(payload.objective).toBeUndefined();
    expect(payload.startTime).toBeUndefined();
    expect(payload.stopTime).toBe("2026-10-31T00:00:00+0000");
  });
});

describe("DraftsSection approve invalidates the group list", () => {
  it("refreshes the LinkedIn campaign-groups query after an applied approval", async () => {
    mockState.drafts = [
      {
        id: 42,
        status: "draft",
        action: "create",
        targetType: "campaign_group",
        targetName: "Q3 Group",
        platform: "linkedin",
        changes: [],
        createdByEmail: "owner@example.com",
        createdAt: new Date().toISOString(),
      },
    ];
    approveMutate.mockImplementation(
      (_vars: unknown, opts?: { onSuccess?: (res: unknown) => void }) => {
        opts?.onSuccess?.({ status: "applied", verifyStatus: "verified" });
      },
    );

    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    render(
      <QueryClientProvider client={queryClient}>
        <DraftsSection isOwner canManage />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByTestId("button-approve-draft-42"));
    fireEvent.click(await screen.findByTestId("button-confirm-approve"));

    expect(approveMutate).toHaveBeenCalledTimes(1);
    // One of the invalidations must match the LinkedIn campaign-groups query.
    const predicates = invalidateSpy.mock.calls
      .map((c) => (c[0] as { predicate?: (q: { queryKey: unknown[] }) => boolean })?.predicate)
      .filter((p): p is (q: { queryKey: unknown[] }) => boolean => typeof p === "function");
    const matchesGroups = predicates.some((p) =>
      p({ queryKey: ["/api/ads/linkedin/campaign-groups", { connectionId: 7 }] }),
    );
    expect(matchesGroups).toBe(true);
  });
});
