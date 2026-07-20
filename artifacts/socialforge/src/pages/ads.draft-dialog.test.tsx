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
        currency="USD"
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
      target: { value: "100" },
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
      target: { value: "5000" },
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

describe("DraftDialog campaign group budget removal", () => {
  const GROUP_UPDATE = {
    action: "update" as const,
    targetType: "campaign_group",
    targetId: "grp_1",
    currentName: "Always On",
    name: "Always On",
    lifetimeBudget: "200000",
  };

  it("clearing the lifetime budget on a group edit sends removeLifetimeBudget", () => {
    renderDraftDialog(() => {}, "linkedin", GROUP_UPDATE);
    fireEvent.change(screen.getByTestId("input-draft-lifetime-budget"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByTestId("button-submit-draft"));

    const payload = submittedPayload();
    expect(payload.targetType).toBe("campaign_group");
    expect(payload.targetId).toBe("grp_1");
    expect(payload.removeLifetimeBudget).toBe(true);
    expect(payload.lifetimeBudget).toBeUndefined();
  });

  it("keeping or changing the budget does not send removeLifetimeBudget", () => {
    renderDraftDialog(() => {}, "linkedin", GROUP_UPDATE);
    fireEvent.change(screen.getByTestId("input-draft-lifetime-budget"), {
      target: { value: "3000" },
    });
    fireEvent.click(screen.getByTestId("button-submit-draft"));

    const payload = submittedPayload();
    expect(payload.lifetimeBudget).toBe(300000);
    expect(payload.removeLifetimeBudget).toBeUndefined();
  });

  it("a group that never had a budget does not send removeLifetimeBudget", () => {
    renderDraftDialog(() => {}, "linkedin", {
      ...GROUP_UPDATE,
      lifetimeBudget: "",
      status: "PAUSED",
    });
    fireEvent.click(screen.getByTestId("button-submit-draft"));

    const payload = submittedPayload();
    expect(payload.removeLifetimeBudget).toBeUndefined();
    expect(payload.lifetimeBudget).toBeUndefined();
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
    renderDraftDialog(() => {}, "google", {
      objective: "SEARCH",
      startTime: "2026-08-01T00:00:00+0000",
      stopTime: "2026-08-31T00:00:00+0000",
    });
    fireEvent.change(screen.getByTestId("input-draft-name"), {
      target: { value: "G Search" },
    });
    fireEvent.change(screen.getByTestId("input-draft-daily-budget"), {
      target: { value: "50" },
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

    expect(screen.getByText("Default CPC bid (USD)")).toBeTruthy();
    expect(screen.getByTestId("input-draft-daily-budget")).toBeTruthy();
    expect(screen.queryByTestId("input-draft-lifetime-budget")).toBeNull();
    expect(screen.queryByTestId("input-draft-start")).toBeNull();
    expect(screen.queryByTestId("input-draft-stop")).toBeNull();
    expect(screen.queryByTestId("select-draft-objective")).toBeNull();

    fireEvent.change(screen.getByTestId("input-draft-daily-budget"), {
      target: { value: "1.5" },
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
      target: { value: "60" },
    });
    fireEvent.click(screen.getByTestId("button-submit-draft"));

    const payload = submittedPayload();
    expect(payload.targetType).toBe("campaign");
    expect(payload.objective).toBe("TRAFFIC");
    expect(payload.dailyBudget).toBe(6000);
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
      startTime: "2026-08-01 00:00:00",
      stopTime: "2026-08-31 00:00:00",
    });

    expect(screen.getByTestId("input-draft-daily-budget")).toBeTruthy();
    expect(screen.getByTestId("input-draft-lifetime-budget")).toBeTruthy();
    expect(screen.getByTestId("input-draft-start")).toBeTruthy();
    expect(screen.getByTestId("input-draft-stop")).toBeTruthy();

    fireEvent.change(screen.getByTestId("input-draft-name"), {
      target: { value: "TT group renamed" },
    });
    fireEvent.change(screen.getByTestId("input-draft-daily-budget"), {
      target: { value: "25" },
    });
    fireEvent.click(screen.getByTestId("button-submit-draft"));
    const payload = submittedPayload();
    expect(payload.targetType).toBe("adset");
    expect(payload.name).toBe("TT group renamed");
    expect(payload.dailyBudget).toBe(2500);
    expect(payload.startTime).toBe("2026-08-01 00:00:00");
    expect(payload.stopTime).toBe("2026-08-31 00:00:00");
  });

  it("blocks a campaign create with a daily budget below TikTok's minimum", () => {
    renderDraftDialog(() => {}, "tiktok", { objective: "OUTCOME_TRAFFIC" });
    fireEvent.change(screen.getByTestId("input-draft-name"), {
      target: { value: "TT Launch" },
    });
    fireEvent.change(screen.getByTestId("input-draft-daily-budget"), {
      target: { value: "20" },
    });

    const error = screen.getByTestId("text-tiktok-budget-min-error");
    expect(error.textContent).toContain("at least 50");
    expect(
      (screen.getByTestId("button-submit-draft") as HTMLButtonElement).disabled,
    ).toBe(true);

    // Raising to the minimum clears the error and re-enables submit.
    fireEvent.change(screen.getByTestId("input-draft-daily-budget"), {
      target: { value: "50" },
    });
    expect(screen.queryByTestId("text-tiktok-budget-min-error")).toBeNull();
    expect(
      (screen.getByTestId("button-submit-draft") as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("blocks a zero TikTok budget too", () => {
    renderDraftDialog(() => {}, "tiktok", { objective: "OUTCOME_TRAFFIC" });
    fireEvent.change(screen.getByTestId("input-draft-name"), {
      target: { value: "TT Launch" },
    });
    fireEvent.change(screen.getByTestId("input-draft-daily-budget"), {
      target: { value: "0" },
    });

    expect(
      screen.getByTestId("text-tiktok-budget-min-error").textContent,
    ).toContain("at least 50");
    expect(
      (screen.getByTestId("button-submit-draft") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("blocks an ad group edit with a lifetime budget below TikTok's minimum", () => {
    renderDraftDialog(() => {}, "tiktok", {
      action: "update",
      targetType: "adset",
      targetId: "ag_tt",
      currentName: "TT group",
      name: "TT group",
    });
    fireEvent.change(screen.getByTestId("input-draft-lifetime-budget"), {
      target: { value: "19" },
    });

    const error = screen.getByTestId("text-tiktok-budget-min-error");
    expect(error.textContent).toContain("ad group");
    expect(error.textContent).toContain("at least 20");
    expect(
      (screen.getByTestId("button-submit-draft") as HTMLButtonElement).disabled,
    ).toBe(true);

    // Clearing the budget removes the error (no budget change drafted).
    fireEvent.change(screen.getByTestId("input-draft-lifetime-budget"), {
      target: { value: "" },
    });
    expect(screen.queryByTestId("text-tiktok-budget-min-error")).toBeNull();
  });

  it("ad group edit shows the current budget type and warns on a mode flip", () => {
    // Ad group currently runs a lifetime (total) budget.
    renderDraftDialog(() => {}, "tiktok", {
      action: "update",
      targetType: "adset",
      targetId: "ag_tt",
      currentName: "TT group",
      name: "TT group",
      lifetimeBudget: "50000",
    });

    expect(screen.getByTestId("text-budget-mode").textContent).toContain(
      "lifetime (total)",
    );
    expect(screen.queryByTestId("alert-budget-mode-flip")).toBeNull();

    // Entering a daily budget would flip the mode on apply.
    fireEvent.change(screen.getByTestId("input-draft-daily-budget"), {
      target: { value: "25" },
    });
    const alert = screen.getByTestId("alert-budget-mode-flip");
    expect(alert.textContent).toContain("lifetime (total) to daily");

    // Clearing it removes the warning again.
    fireEvent.change(screen.getByTestId("input-draft-daily-budget"), {
      target: { value: "" },
    });
    expect(screen.queryByTestId("alert-budget-mode-flip")).toBeNull();
  });

  it("ad group edit with a daily budget warns only when switched to lifetime", () => {
    renderDraftDialog(() => {}, "tiktok", {
      action: "update",
      targetType: "adset",
      targetId: "ag_tt",
      currentName: "TT group",
      name: "TT group",
      dailyBudget: "3000",
    });

    expect(screen.getByTestId("text-budget-mode").textContent).toContain("daily");
    expect(screen.queryByTestId("alert-budget-mode-flip")).toBeNull();

    // Raising the daily budget keeps the mode: no warning.
    fireEvent.change(screen.getByTestId("input-draft-daily-budget"), {
      target: { value: "90" },
    });
    expect(screen.queryByTestId("alert-budget-mode-flip")).toBeNull();

    // Clearing daily and entering lifetime flips it: warn.
    fireEvent.change(screen.getByTestId("input-draft-daily-budget"), {
      target: { value: "" },
    });
    fireEvent.change(screen.getByTestId("input-draft-lifetime-budget"), {
      target: { value: "500" },
    });
    expect(
      screen.getByTestId("alert-budget-mode-flip").textContent,
    ).toContain("daily to lifetime (total)");
  });

  it("campaign edit shows the current budget type and warns on a mode flip", () => {
    renderDraftDialog(() => {}, "tiktok", {
      action: "update",
      targetType: "campaign",
      targetId: "c_tt",
      currentName: "TT campaign",
      name: "TT campaign",
      dailyBudget: "5000",
    });

    expect(screen.getByTestId("text-budget-mode").textContent).toContain(
      "campaign currently uses a daily budget",
    );
    expect(screen.queryByTestId("alert-budget-mode-flip")).toBeNull();

    // Clearing daily and entering lifetime flips the campaign mode: warn.
    fireEvent.change(screen.getByTestId("input-draft-daily-budget"), {
      target: { value: "" },
    });
    fireEvent.change(screen.getByTestId("input-draft-lifetime-budget"), {
      target: { value: "700" },
    });
    const alert = screen.getByTestId("alert-budget-mode-flip");
    expect(alert.textContent).toContain("campaign's budget type");
    expect(alert.textContent).toContain("daily to lifetime (total)");
  });

  it("campaign edit with no budget (unlimited) notes it and warns when a budget is drafted", () => {
    renderDraftDialog(() => {}, "tiktok", {
      action: "update",
      targetType: "campaign",
      targetId: "c_tt",
      currentName: "TT campaign",
      name: "TT campaign",
    });

    expect(screen.getByTestId("text-budget-mode").textContent).toContain(
      "currently has no budget (unlimited)",
    );
    expect(screen.queryByTestId("alert-budget-mode-flip")).toBeNull();

    // Drafting a daily budget onto an unlimited campaign caps spend: warn.
    fireEvent.change(screen.getByTestId("input-draft-daily-budget"), {
      target: { value: "40" },
    });
    const alert = screen.getByTestId("alert-budget-mode-flip");
    expect(alert.textContent).toContain("give this campaign a daily budget");
    expect(alert.textContent).toContain("no budget (unlimited)");

    // Clearing it removes the warning again.
    fireEvent.change(screen.getByTestId("input-draft-daily-budget"), {
      target: { value: "" },
    });
    expect(screen.queryByTestId("alert-budget-mode-flip")).toBeNull();
  });

  it("Meta ad set edit shows the current budget type and warns on a mode flip", () => {
    renderDraftDialog(() => {}, "meta", {
      action: "update",
      targetType: "adset",
      targetId: "as_1",
      currentName: "Meta set",
      name: "Meta set",
      lifetimeBudget: "50000",
    });

    const note = screen.getByTestId("text-budget-mode");
    expect(note.textContent).toContain("Meta ad set");
    expect(note.textContent).toContain("lifetime (total)");
    expect(screen.queryByTestId("alert-budget-mode-flip")).toBeNull();

    // Drafting a daily budget flips the mode: warn.
    fireEvent.change(screen.getByTestId("input-draft-daily-budget"), {
      target: { value: "25" },
    });
    const alert = screen.getByTestId("alert-budget-mode-flip");
    expect(alert.textContent).toContain("ad set's budget type");
    expect(alert.textContent).toContain("lifetime (total) to daily");

    // Clearing it removes the warning again.
    fireEvent.change(screen.getByTestId("input-draft-daily-budget"), {
      target: { value: "" },
    });
    expect(screen.queryByTestId("alert-budget-mode-flip")).toBeNull();
  });

  it("Meta campaign edit with a daily budget warns only when switched to lifetime", () => {
    renderDraftDialog(() => {}, "meta", {
      action: "update",
      targetType: "campaign",
      targetId: "c_meta",
      currentName: "Meta campaign",
      name: "Meta campaign",
      dailyBudget: "5000",
    });

    expect(screen.getByTestId("text-budget-mode").textContent).toContain(
      "Meta campaign currently uses a daily budget",
    );
    expect(screen.queryByTestId("alert-budget-mode-flip")).toBeNull();

    // Raising the daily budget keeps the mode: no warning.
    fireEvent.change(screen.getByTestId("input-draft-daily-budget"), {
      target: { value: "90" },
    });
    expect(screen.queryByTestId("alert-budget-mode-flip")).toBeNull();

    // Clearing daily and entering lifetime flips it: warn.
    fireEvent.change(screen.getByTestId("input-draft-daily-budget"), {
      target: { value: "" },
    });
    fireEvent.change(screen.getByTestId("input-draft-lifetime-budget"), {
      target: { value: "500" },
    });
    expect(
      screen.getByTestId("alert-budget-mode-flip").textContent,
    ).toContain("daily to lifetime (total)");
  });

  it("Meta ad set with no budget of its own notes it and warns when a budget is drafted", () => {
    // CBO campaign: the ad set carries no budget itself.
    renderDraftDialog(() => {}, "meta", {
      action: "update",
      targetType: "adset",
      targetId: "as_cbo",
      currentName: "CBO set",
      name: "CBO set",
    });

    expect(screen.getByTestId("text-budget-mode").textContent).toContain(
      "currently has no budget of its own",
    );
    expect(screen.queryByTestId("alert-budget-mode-flip")).toBeNull();

    fireEvent.change(screen.getByTestId("input-draft-daily-budget"), {
      target: { value: "40" },
    });
    const alert = screen.getByTestId("alert-budget-mode-flip");
    expect(alert.textContent).toContain("give this ad set a daily budget");
    expect(alert.textContent).toContain("no budget of its own");
  });

  it("hides the budget-type note outside TikTok/Meta budget-holder edits", () => {
    // Google ad group edit: no budget-type note.
    renderDraftDialog(() => {}, "google", {
      action: "update",
      targetType: "adset",
      targetId: "ag_g",
      currentName: "G group",
      name: "G group",
      dailyBudget: "5000",
    });
    expect(screen.queryByTestId("text-budget-mode")).toBeNull();
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
    renderDraftDialog(() => {}, "meta", {
      startTime: "2026-09-01T00:00:00+0000",
    });
    fireEvent.change(screen.getByTestId("input-draft-name"), {
      target: { value: "Meta Launch" },
    });
    fireEvent.change(screen.getByTestId("input-draft-daily-budget"), {
      target: { value: "30" },
    });
    fireEvent.change(screen.getByTestId("input-draft-lifetime-budget"), {
      target: { value: "900" },
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
      stopTime: "2026-10-31T00:00:00+0000",
    });

    expect(screen.getByTestId("input-draft-daily-budget")).toBeTruthy();
    expect(screen.getByTestId("input-draft-lifetime-budget")).toBeTruthy();
    expect(screen.queryByTestId("select-draft-objective")).toBeNull();
    // Meta ad sets carry their own schedule (end_time), so the schedule
    // fields render for ad set edits on Meta.
    expect(screen.getByTestId("input-draft-start")).toBeTruthy();
    expect(screen.getByTestId("input-draft-stop")).toBeTruthy();

    fireEvent.change(screen.getByTestId("input-draft-daily-budget"), {
      target: { value: "15" },
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

describe("DraftDialog schedule date pickers", () => {
  it("prefills existing ISO values as a readable date and enabled time input", () => {
    renderDraftDialog(() => {}, "meta", {
      action: "update",
      targetType: "adset",
      targetId: "as_1",
      currentName: "Meta set",
      name: "Meta set",
      stopTime: "2026-10-31T00:00:00+0000",
    });
    const stopButton = screen.getByTestId("input-draft-stop");
    // Rendered in the viewer's local timezone; must show a real date, not ISO.
    expect(stopButton.textContent).toMatch(/2026/);
    expect(stopButton.textContent).not.toContain("Pick a date");
    const timeInput = screen.getByTestId("input-draft-stop-time") as HTMLInputElement;
    expect(timeInput.disabled).toBe(false);
    // Empty start field shows the placeholder and no clear button.
    expect(screen.getByTestId("input-draft-start").textContent).toContain("Pick a date");
    expect(screen.queryByTestId("input-draft-start-clear")).toBeNull();
  });

  it("clearing a prefilled end date omits stopTime from the payload (no change)", () => {
    renderDraftDialog(() => {}, "meta", {
      action: "update",
      targetType: "adset",
      targetId: "as_1",
      currentName: "Meta set",
      name: "Meta set",
      stopTime: "2026-10-31T00:00:00+0000",
    });
    fireEvent.click(screen.getByTestId("input-draft-stop-clear"));
    expect(screen.getByTestId("input-draft-stop").textContent).toContain("Pick a date");
    fireEvent.click(screen.getByTestId("button-submit-draft"));
    const payload = submittedPayload();
    expect(payload.stopTime).toBeUndefined();
  });

  it("picking a date from the calendar submits a valid ISO string with offset", async () => {
    const user = userEvent.setup();
    renderDraftDialog(() => {}, "meta");
    fireEvent.change(screen.getByTestId("input-draft-name"), {
      target: { value: "Meta Launch" },
    });
    await user.click(screen.getByTestId("input-draft-start"));
    // Pick the 15th of the currently displayed month.
    await user.click(await screen.findByText("15"));
    // Set the time-of-day on the picked date.
    fireEvent.change(screen.getByTestId("input-draft-start-time"), {
      target: { value: "09:30" },
    });
    fireEvent.click(screen.getByTestId("button-submit-draft"));

    const payload = submittedPayload();
    const startTime = payload.startTime as string;
    // ISO-8601 with a numeric UTC offset, e.g. 2026-07-15T09:30:00+0530.
    expect(startTime).toMatch(/^\d{4}-\d{2}-\d{2}T09:30:00[+-]\d{4}$/);
    const parsed = new Date(startTime);
    expect(Number.isNaN(parsed.getTime())).toBe(false);
    expect(parsed.getDate()).toBe(15);
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
