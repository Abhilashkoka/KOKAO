import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Regression guard for the Meta ad set bid column in the campaign detail
 * dialog:
 * - The "Bid" column renders strategy + amount (minor units -> major, e.g.
 *   "Cost cap · USD 2.50") and falls back to "—" when unset.
 * - The column only exists for Meta; other platforms never show it.
 * - Clicking edit prefills the draft form with the raw minor-unit bidAmount
 *   and bidStrategy, and DraftDialog converts the amount to major units.
 */

// Radix dialogs need a few APIs jsdom doesn't implement.
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

type AdSet = {
  id: string;
  name: string;
  status: string;
  effectiveStatus: string;
  startTime: string | null;
  stopTime: string | null;
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  bidStrategy: string | null;
  bidAmount: number | null;
  metrics: { impressions: number; clicks: number; spend: number };
};

const mockState = {
  adSets: [] as AdSet[],
};

const createDraftMutate = vi.fn();

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  return createApiClientMock({
    useGetAdCampaignDetail: () => ({
      data: {
        campaign: { id: "c_1", name: "Summer Push" },
        adSets: mockState.adSets,
        ads: [],
      },
      isLoading: false,
      error: null,
    }),
    useCreateAdDraft: () => ({ mutate: createDraftMutate, isPending: false }),
  });
});

// Imported after the mock so the mocked module is picked up.
import { CampaignDetailDialog, DraftDialog } from "./ads";

const METRICS = { impressions: 1000, clicks: 10, spend: 12.34 };

function adSet(overrides: Partial<AdSet>): AdSet {
  return {
    id: "as_1",
    name: "Ad set A",
    status: "ACTIVE",
    effectiveStatus: "ACTIVE",
    startTime: null,
    stopTime: null,
    dailyBudget: 1000,
    lifetimeBudget: null,
    bidStrategy: null,
    bidAmount: null,
    metrics: METRICS,
    ...overrides,
  };
}

let queryClient: QueryClient;

function renderDetail(platform: string, onEdit: (form: any) => void = () => {}) {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <CampaignDetailDialog
        connectionId={7}
        platform={platform}
        campaignId="c_1"
        datePreset="last_30d"
        currency="USD"
        canManage
        onEdit={onEdit}
        onClose={() => {}}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockState.adSets = [];
});

afterEach(() => {
  cleanup();
});

describe("CampaignDetailDialog Meta ad set bid column", () => {
  it("renders strategy + amount converted from minor units", () => {
    mockState.adSets = [
      adSet({ id: "as_1", bidStrategy: "COST_CAP", bidAmount: 250 }),
    ];
    renderDetail("meta");

    expect(screen.getByText("Bid")).toBeTruthy();
    expect(screen.getByTestId("text-adset-bid-as_1").textContent).toBe(
      "Cost cap · USD 2.5",
    );
  });

  it("renders each known strategy label and passes unknown strategies through", () => {
    mockState.adSets = [
      adSet({ id: "as_1", bidStrategy: "LOWEST_COST_WITHOUT_CAP", bidAmount: null }),
      adSet({ id: "as_2", bidStrategy: "LOWEST_COST_WITH_BID_CAP", bidAmount: 1050 }),
      adSet({ id: "as_3", bidStrategy: "SOME_NEW_STRATEGY", bidAmount: 100 }),
    ];
    renderDetail("meta");

    expect(screen.getByTestId("text-adset-bid-as_1").textContent).toBe(
      "Lowest cost",
    );
    expect(screen.getByTestId("text-adset-bid-as_2").textContent).toBe(
      "Bid cap · USD 10.5",
    );
    expect(screen.getByTestId("text-adset-bid-as_3").textContent).toBe(
      "SOME_NEW_STRATEGY · USD 1",
    );
  });

  it("shows a dash when both strategy and amount are unset", () => {
    mockState.adSets = [adSet({ id: "as_1" })];
    renderDetail("meta");

    expect(screen.getByTestId("text-adset-bid-as_1").textContent).toBe("—");
  });

  it("shows the bare amount when only the amount is set", () => {
    mockState.adSets = [adSet({ id: "as_1", bidAmount: 75 })];
    renderDetail("meta");

    expect(screen.getByTestId("text-adset-bid-as_1").textContent).toBe(
      "USD 0.75",
    );
  });

  it("omits the Bid column entirely for non-Meta platforms", () => {
    mockState.adSets = [
      adSet({ id: "as_1", bidStrategy: "COST_CAP", bidAmount: 250 }),
    ];
    renderDetail("linkedin");

    expect(screen.queryByText("Bid")).toBeNull();
    expect(screen.queryByTestId("text-adset-bid-as_1")).toBeNull();
  });
});

describe("edit prefill of bid fields", () => {
  it("passes the raw minor-unit bidAmount and bidStrategy to the edit form", () => {
    mockState.adSets = [
      adSet({ id: "as_1", bidStrategy: "COST_CAP", bidAmount: 250 }),
    ];
    const onEdit = vi.fn();
    renderDetail("meta", onEdit);

    fireEvent.click(screen.getByTestId("button-edit-adset-as_1"));

    expect(onEdit).toHaveBeenCalledTimes(1);
    const form = onEdit.mock.calls[0]![0];
    expect(form.action).toBe("update");
    expect(form.targetType).toBe("adset");
    expect(form.targetId).toBe("as_1");
    expect(form.bidAmount).toBe("250");
    expect(form.bidStrategy).toBe("COST_CAP");
  });

  it("leaves bid fields empty when the ad set has no bid", () => {
    mockState.adSets = [adSet({ id: "as_1" })];
    const onEdit = vi.fn();
    renderDetail("meta", onEdit);

    fireEvent.click(screen.getByTestId("button-edit-adset-as_1"));

    const form = onEdit.mock.calls[0]![0];
    expect(form.bidAmount).toBe("");
    expect(form.bidStrategy).toBe("");
  });

  function renderDraftDialog(
    bid: { bidAmount: string; bidStrategy: string },
    platform: string = "meta",
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
          form={{
            action: "update",
            targetType: "adset",
            targetId: "as_1",
            currentName: "Ad set A",
            name: "Ad set A",
            status: "",
            // The ad set holds its own budget; the budget-less warning path
            // is covered in ads.draft-dialog.test.tsx.
            dailyBudget: "2000",
            lifetimeBudget: "",
            startTime: "",
            stopTime: "",
            objective: "OUTCOME_TRAFFIC",
            ...bid,
          }}
          onClose={() => {}}
        />
      </QueryClientProvider>,
    );
  }

  it("submitting untouched prefilled bid fields drafts no bid change", () => {
    renderDraftDialog({ bidAmount: "250", bidStrategy: "COST_CAP" });

    fireEvent.click(screen.getByTestId("button-submit-draft"));

    expect(createDraftMutate).toHaveBeenCalledTimes(1);
    const payload = createDraftMutate.mock.calls[0]![0].data;
    expect(payload.bidAmount).toBeUndefined();
    expect(payload.bidStrategy).toBeUndefined();
  });

  it("submitting a changed bid amount sends only the amount", () => {
    renderDraftDialog({ bidAmount: "250", bidStrategy: "COST_CAP" });

    fireEvent.change(screen.getByTestId("input-draft-bid-amount"), {
      target: { value: "5" },
    });
    fireEvent.click(screen.getByTestId("button-submit-draft"));

    const payload = createDraftMutate.mock.calls[0]![0].data;
    expect(payload.bidAmount).toBe(500);
    expect(payload.bidStrategy).toBeUndefined();
  });

  it("changing only the strategy to a capped one still sends the unchanged amount", () => {
    renderDraftDialog({ bidAmount: "250", bidStrategy: "LOWEST_COST_WITH_BID_CAP" });

    fireEvent.click(screen.getByTestId("select-draft-bid-strategy"));
    fireEvent.click(screen.getByText("Cost cap"));
    fireEvent.click(screen.getByTestId("button-submit-draft"));

    const payload = createDraftMutate.mock.calls[0]![0].data;
    expect(payload.bidStrategy).toBe("COST_CAP");
    expect(payload.bidAmount).toBe(250);
  });

  it("entering a fresh bid submits minor units and the chosen strategy", () => {
    renderDraftDialog({ bidAmount: "", bidStrategy: "" });

    fireEvent.click(screen.getByTestId("select-draft-bid-strategy"));
    fireEvent.click(screen.getByText("Cost cap"));
    fireEvent.change(screen.getByTestId("input-draft-bid-amount"), {
      target: { value: "2.5" },
    });
    fireEvent.click(screen.getByTestId("button-submit-draft"));

    expect(createDraftMutate).toHaveBeenCalledTimes(1);
    const payload = createDraftMutate.mock.calls[0]![0].data;
    expect(payload.bidAmount).toBe(250);
    expect(payload.bidStrategy).toBe("COST_CAP");
  });

  it("submitting with both bid fields blank sends no bid keys", () => {
    renderDraftDialog({ bidAmount: "", bidStrategy: "" });

    fireEvent.click(screen.getByTestId("button-submit-draft"));

    expect(createDraftMutate).toHaveBeenCalledTimes(1);
    const payload = createDraftMutate.mock.calls[0]![0].data;
    expect("bidAmount" in payload).toBe(false);
    expect("bidStrategy" in payload).toBe(false);
  });

  it("choosing Lowest cost (no cap) disables the amount and omits it on submit", () => {
    renderDraftDialog({ bidAmount: "250", bidStrategy: "COST_CAP" });

    fireEvent.click(screen.getByTestId("select-draft-bid-strategy"));
    fireEvent.click(screen.getByText("Lowest cost (no cap)"));

    const amount = screen.getByTestId("input-draft-bid-amount") as HTMLInputElement;
    expect(amount.disabled).toBe(true);

    fireEvent.click(screen.getByTestId("button-submit-draft"));

    const payload = createDraftMutate.mock.calls[0]![0].data;
    expect(payload.bidStrategy).toBe("LOWEST_COST_WITHOUT_CAP");
    expect(payload.bidAmount).toBeUndefined();
  });

  it("never renders bid controls for a non-Meta ad set edit", () => {
    renderDraftDialog({ bidAmount: "250", bidStrategy: "COST_CAP" }, "linkedin");

    expect(screen.queryByTestId("select-draft-bid-strategy")).toBeNull();
    expect(screen.queryByTestId("input-draft-bid-amount")).toBeNull();

    fireEvent.click(screen.getByTestId("button-submit-draft"));

    const payload = createDraftMutate.mock.calls[0]![0].data;
    expect("bidAmount" in payload).toBe(false);
    expect("bidStrategy" in payload).toBe(false);
  });

  it("DraftDialog prefills the bid amount in major units and the strategy", () => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <DraftDialog
          connectionId={7}
          platform="meta"
          currency="USD"
          form={{
            action: "update",
            targetType: "adset",
            targetId: "as_1",
            currentName: "Ad set A",
            name: "Ad set A",
            status: "ACTIVE",
            dailyBudget: "1000",
            lifetimeBudget: "",
            startTime: "",
            stopTime: "",
            objective: "OUTCOME_TRAFFIC",
            bidAmount: "250",
            bidStrategy: "COST_CAP",
          }}
          onClose={() => {}}
        />
      </QueryClientProvider>,
    );

    const amount = screen.getByTestId("input-draft-bid-amount") as HTMLInputElement;
    expect(amount.value).toBe("2.5");
    // The strategy select trigger shows the current strategy label.
    expect(
      screen.getByTestId("select-draft-bid-strategy").textContent,
    ).toContain("Cost cap");
  });
});
