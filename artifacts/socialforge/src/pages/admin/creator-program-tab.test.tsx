import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  CreatorProgramTab,
  buildPatch,
  draftFrom,
  percentToBps,
  rupeesToPaise,
  bpsToPercent,
  paiseToRupees,
  parseField,
  parseSlabs,
  FIELDS,
} from "./creator-program-tab";

const state = vi.hoisted(() => ({
  flags: [] as Array<{ feature: string; label: string; description: string; enabled: boolean }>,
  flagsError: false,
  settings: undefined as Record<string, unknown> | undefined,
  settingsError: false,
  flagMutate: vi.fn(),
  settingsMutate: vi.fn(),
  refetchSettings: vi.fn(),
}));

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../../test/apiClientMock");
  return createApiClientMock({
    useAdminListFeatureFlags: () => ({ data: state.flagsError ? undefined : state.flags, isLoading: false, isError: state.flagsError, refetch: vi.fn() }),
    useAdminGetCreatorSettings: () => ({ data: state.settingsError ? undefined : state.settings, isLoading: false, isError: state.settingsError, refetch: state.refetchSettings }),
    useAdminUpdateFeatureFlag: () => ({ mutate: state.flagMutate, isPending: false }),
    useAdminUpdateCreatorSettings: () => ({ mutate: state.settingsMutate, isPending: false }),
  });
});
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const base = {
  id: 1,
  programEnabled: false,
  commissionSlabs: [{ minReferrals: 0, commissionBps: 1000 }, { minReferrals: 10, commissionBps: 1250 }],
  buyerBonusBps: 500, buyerBonusExpiryDays: 90, holdDays: 30, consumptionThresholdBps: 5000,
  reserveBps: 1000, reserveReleaseDays: 60, minPayoutPaise: 50000, earningExpiryDays: 365,
  attributionDays: 30, triggerMode: "first_purchase" as const, payoutCadence: "monthly" as const,
  tdsRateBps: 1000, autoApproveCreators: false, riskHoldThreshold: 70, newCreatorReviewCount: 3,
};

function renderTab() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <CreatorProgramTab />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.flags = [{ feature: "creatorProgram", label: "Creator Program", description: "", enabled: false }];
  state.settings = { ...base };
  state.flagsError = false;
  state.settingsError = false;
  state.flagMutate.mockReset();
  state.settingsMutate.mockReset();
  state.refetchSettings.mockReset();
});

describe("conversions", () => {
  it("converts percent and rupees exactly", () => {
    expect(percentToBps("12.5")).toBe(1250);
    expect(percentToBps("0.07")).toBe(7);
    expect(percentToBps("100")).toBe(10000);
    expect(rupeesToPaise("499.99")).toBe(49999);
    expect(rupeesToPaise("1.005")).toBeNull();
    expect(rupeesToPaise("-1")).toBeNull();
    expect(rupeesToPaise("abc")).toBeNull();
    expect(bpsToPercent(1250)).toBe("12.50");
    expect(paiseToRupees(50000)).toBe("500");
  });
  it("validates ranges including reserveReleaseDays >= 1", () => {
    const rr = FIELDS.find((f) => f.key === "reserveReleaseDays")!;
    expect(parseField(rr, "0").error).toMatch(/between 1/);
    const pct = FIELDS.find((f) => f.key === "buyerBonusBps")!;
    expect(parseField(pct, "100.01").error).toBeTruthy();
    expect(parseField(pct, "Infinity").error).toBeTruthy();
    expect(parseField(pct, "7.25").value).toBe(725);
  });
  it("validates slabs", () => {
    expect(parseSlabs([{ minReferrals: "1", commissionPercent: "5" }]).value).toBeUndefined();
    expect(parseSlabs([{ minReferrals: "0", commissionPercent: "5" }, { minReferrals: "0", commissionPercent: "6" }]).value).toBeUndefined();
    expect(parseSlabs([{ minReferrals: "0", commissionPercent: "5.5" }]).value).toEqual([{ minReferrals: 0, commissionBps: 550 }]);
  });
  it("patch contains only edited fields and never programEnabled", () => {
    const d = draftFrom(base);
    d.fields.minPayoutPaise = "750.50";
    const { patch } = buildPatch({ ...base, programEnabled: true }, d);
    expect(patch).toEqual({ minPayoutPaise: 75050 });
  });
});

describe("CreatorProgramTab", () => {
  it("never mutates on load and shows inactive", () => {
    renderTab();
    expect(state.flagMutate).not.toHaveBeenCalled();
    expect(state.settingsMutate).not.toHaveBeenCalled();
    expect(screen.getByTestId("status-effective").textContent).toBe("Inactive");
    expect(screen.getAllByText("Unverified")).toHaveLength(3);
  });

  it("enables the flag only after in-app confirmation", () => {
    renderTab();
    fireEvent.click(screen.getByTestId("switch-flag"));
    expect(state.flagMutate).not.toHaveBeenCalled();
    expect(screen.getByTestId("dialog-confirm-enable").textContent).toMatch(/manually/);
    fireEvent.click(screen.getByTestId("button-cancel-enable"));
    expect(state.flagMutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("switch-flag"));
    fireEvent.click(screen.getByTestId("button-confirm-enable"));
    expect(state.flagMutate).toHaveBeenCalledWith(
      { feature: "creatorProgram", data: { enabled: true } }, expect.anything(),
    );
  });

  it("enables programEnabled only after confirmation, disables immediately", () => {
    renderTab();
    fireEvent.click(screen.getByTestId("switch-program"));
    expect(state.settingsMutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("button-confirm-enable"));
    expect(state.settingsMutate).toHaveBeenCalledWith({ data: { programEnabled: true } }, expect.anything());
  });

  it("disable is immediate without dialog", () => {
    state.settings = { ...base, programEnabled: true };
    renderTab();
    fireEvent.click(screen.getByTestId("switch-program"));
    expect(screen.queryByTestId("dialog-confirm-enable")).toBeNull();
    expect(state.settingsMutate).toHaveBeenCalledWith({ data: { programEnabled: false } }, expect.anything());
  });

  it("reports partial state and effective only when both on", () => {
    state.flags[0].enabled = true;
    const { unmount } = renderTab();
    expect(screen.getByTestId("status-effective").textContent).toBe("Inactive");
    expect(screen.getByTestId("text-partial-state")).toBeTruthy();
    unmount();
    state.settings = { ...base, programEnabled: true };
    renderTab();
    expect(screen.getByTestId("status-effective").textContent).toBe("Effectively active");
  });

  it("shows error with retry and no synthetic defaults", () => {
    state.settingsError = true;
    renderTab();
    expect(screen.getByTestId("status-effective").textContent).toBe("Status unknown");
    expect(screen.queryByTestId("input-holdDays")).toBeNull();
    fireEvent.click(screen.getByTestId("button-retry-settings"));
    expect(state.refetchSettings).toHaveBeenCalled();
  });

  it("saves only edited fields; blocks invalid input", () => {
    renderTab();
    fireEvent.change(screen.getByTestId("input-reserveReleaseDays"), { target: { value: "0" } });
    expect(screen.getByTestId("error-reserveReleaseDays")).toBeTruthy();
    fireEvent.click(screen.getByTestId("button-save-settings"));
    expect(state.settingsMutate).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId("input-reserveReleaseDays"), { target: { value: "60" } });
    fireEvent.change(screen.getByTestId("input-tdsRateBps"), { target: { value: "2.5" } });
    fireEvent.click(screen.getByTestId("button-save-settings"));
    expect(state.settingsMutate).toHaveBeenCalledTimes(1);
    expect(state.settingsMutate.mock.calls[0][0]).toEqual({ data: { tdsRateBps: 250 } });
  });

  it("surfaces save errors and keeps edits", () => {
    state.settingsMutate.mockImplementation((_v, o) => { o.onError(new Error("x")); o.onSettled(); });
    renderTab();
    fireEvent.change(screen.getByTestId("input-holdDays"), { target: { value: "14" } });
    fireEvent.click(screen.getByTestId("button-save-settings"));
    expect(screen.getByTestId("error-save")).toBeTruthy();
    expect((screen.getByTestId("input-holdDays") as HTMLInputElement).value).toBe("14");
  });

  it("guards duplicate pending writes", () => {
    renderTab();
    fireEvent.change(screen.getByTestId("input-holdDays"), { target: { value: "14" } });
    fireEvent.click(screen.getByTestId("button-save-settings"));
    fireEvent.click(screen.getByTestId("button-save-settings"));
    expect(state.settingsMutate).toHaveBeenCalledTimes(1);
  });
});
