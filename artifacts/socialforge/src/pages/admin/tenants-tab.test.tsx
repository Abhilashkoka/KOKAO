import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const accountGrantMutate = vi.fn();
const correctionMutate = vi.fn();
const toast = vi.fn();

const tenant = {
  id: 42,
  name: "Unified Workspace",
  email: "unified@example.com",
  plan: "free",
  aiModel: "gpt",
  isSuperadmin: false,
  isAllowlisted: false,
  billingMode: "quota" as const,
  effectiveBillingMode: "quota" as const,
  walletBalancePaise: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  counts: {
    content: 4,
    brandKits: 2,
    scheduledPosts: 0,
    connectedAccounts: 1,
  },
  usage: { captions: 9, images: 3, periodStart: "2026-01-01T00:00:00.000Z" },
  credits: { captionCredits: 5, imageCredits: 2, videoCredits: 1 },
  balance: { purchased: 12, granted: 3, total: 15, grantedExpiresAt: null },
  creditAccountExists: true,
  legacyConversion: {
    pending: true,
    captionCredits: 5,
    imageCredits: 2,
    videoCredits: 1,
  },
};

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../../test/apiClientMock");
  return createApiClientMock({
    useGetMe: () => ({
      data: { isOwner: true },
      isLoading: false,
    }),
    useAdminListTenants: () => ({
      data: [tenant],
      isLoading: false,
    }),
    useListPlans: () => ({
      data: [{ id: "free", name: "Free" }],
      isLoading: false,
    }),
    useAdminGetAiSpendSettings: () => ({
      data: { videoCostPaise: 500 },
      isLoading: false,
    }),
    useAdminGetAiCostConfig: () => ({
      data: { usdToInrPaise: 8000 },
      isLoading: false,
    }),
    useAdminGrantCreditAccount: () => ({
      mutate: accountGrantMutate,
      isPending: false,
    }),
    useAdminCorrectPurchasedCredits: () => ({
      mutate: correctionMutate,
      isPending: false,
    }),
  });
});

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast }),
}));

vi.mock("@/lib/features", () => ({
  useFeatureFlags: () => ({ flags: { wallet: false } }),
}));

import { TenantsTab } from "./tenants-tab";

function renderTab() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <TenantsTab />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  accountGrantMutate.mockClear();
  correctionMutate.mockClear();
  toast.mockClear();
  tenant.balance = { purchased: 12, granted: 3, total: 15, grantedExpiresAt: null };
  tenant.creditAccountExists = true;
});

describe("TenantsTab credit-first workspace table", () => {
  function openCorrection() {
    tenant.balance = { purchased: 1135, granted: 3, total: 1138, grantedExpiresAt: null };
    renderTab();
    fireEvent.click(screen.getByRole("button", { name: "Manual adjustment" }));
    fireEvent.change(screen.getByLabelText("Purchased credits to deduct"), { target: { value: "92.724" } });
    fireEvent.change(screen.getByLabelText("Correction operation reference"), { target: { value: "video:13:rate-card-correction" } });
    fireEvent.change(screen.getByLabelText("Correction reason"), { target: { value: "Approved total 97.724 minus 5 already charged" } });
  }

  it.each([
    ["Purchased credits to deduct", "-92.724", /positive amount.*minus sign/i],
    ["Purchased credits to deduct", "92.7241", /at most 3 decimal places/i],
    ["Purchased credits to deduct", "1135.001", /exceeds the purchased balance of 1135.000/i],
    ["Correction operation reference", "", /grey example is a placeholder/i],
    ["Correction operation reference", "video 13", /Remove spaces/i],
    ["Correction reason", "   ", /Enter the reason and authorization/i],
  ])("identifies invalid %s input %s without submitting", (label, value, message) => {
    openCorrection();
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
    fireEvent.click(screen.getByRole("button", { name: "Review purchased debit" }));
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ description: expect.stringMatching(message) }));
    expect(screen.queryByRole("button", { name: "Debit purchased credits" })).toBeNull();
    expect(correctionMutate).not.toHaveBeenCalled();
  });

  it("requires confirmation of exact purchased before/after and prevents duplicate submission", () => {
    openCorrection();
    expect(screen.getByText("Purchased balance: 1135.000")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Review purchased debit" }));
    expect(correctionMutate).not.toHaveBeenCalled();
    expect(screen.getByText(/purchased 1135.000 → 1042.276 credits/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(correctionMutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Review purchased debit" }));
    const confirm = screen.getByRole("button", { name: "Debit purchased credits" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    // Even if the hook's pending state has not yet rendered, another review
    // cannot submit a duplicate request while the first one is unresolved.
    fireEvent.click(screen.getByRole("button", { name: "Review purchased debit" }));
    fireEvent.click(screen.getByRole("button", { name: "Debit purchased credits" }));
    expect(correctionMutate).toHaveBeenCalledTimes(1);
    expect(correctionMutate.mock.calls[0][0]).toEqual({
      id: 42, data: {
        amountMilli: 92724, expectedPurchasedMilli: 1135000,
        reference: "video:13:rate-card-correction",
        reason: "Approved total 97.724 minus 5 already charged",
      },
    });
    expect(accountGrantMutate).not.toHaveBeenCalled();
  });

  it("retains amount and reference after network error and retries the identical operation", () => {
    openCorrection();
    fireEvent.click(screen.getByRole("button", { name: "Review purchased debit" }));
    fireEvent.click(screen.getByRole("button", { name: "Debit purchased credits" }));
    const [original, callbacks] = correctionMutate.mock.calls[0];
    act(() => callbacks.onError(new Error("Network unavailable")));
    expect((screen.getByLabelText("Purchased credits to deduct") as HTMLInputElement).value).toBe("92.724");
    expect((screen.getByLabelText("Correction operation reference") as HTMLInputElement).value).toBe("video:13:rate-card-correction");
    fireEvent.click(screen.getByRole("button", { name: "Review purchased debit" }));
    fireEvent.click(screen.getByRole("button", { name: "Debit purchased credits" }));
    expect(correctionMutate).toHaveBeenCalledTimes(2);
    expect(correctionMutate.mock.calls[1][0]).toEqual(original);
  });

  it("puts unified credits in the primary table and keeps legacy details explicit", async () => {
    renderTab();

    expect(screen.getByText("Unified Credits")).toBeTruthy();
    expect(screen.getByTestId("text-unified-credits-42").textContent).toContain(
      "15 credits",
    );
    expect(screen.queryByText("Captions")).toBeNull();
    expect(screen.queryByText("Images")).toBeNull();
    expect(screen.getByText("Actual: Legacy quota")).toBeTruthy();
    expect(screen.getByText("Migration pending")).toBeTruthy();

    fireEvent.click(screen.getByTestId("button-credit-details-42"));
    expect(screen.getByTestId("text-details-unified-total").textContent).toBe("15");
    expect(screen.getByText("Legacy balance (not unified)")).toBeTruthy();
    expect(screen.getByText(/5 captions · 2 images · 1 videos/)).toBeTruthy();
  });

  it("uses the canonical account adjustment for workspaces that have one", () => {
    renderTab();
    fireEvent.click(screen.getByRole("button", { name: "Manual adjustment" }));
    fireEvent.change(screen.getByTestId("input-grant-unified"), {
      target: { value: "2.5" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply adjustment" }));

    expect(accountGrantMutate).toHaveBeenCalledWith(
      {
        id: 42,
        data: { credits: 2.5, note: undefined },
      },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it("labels the legacy adjustment controls when no canonical account exists", () => {
    tenant.creditAccountExists = false;
    renderTab();
    fireEvent.click(screen.getByRole("button", { name: "Manual adjustment" }));

    expect(screen.getByText("Adjust legacy credits for Unified Workspace")).toBeTruthy();
    expect(screen.getByText("Legacy captions")).toBeTruthy();
    expect(screen.getByTestId("input-grant-videos")).toBeTruthy();
    expect(screen.queryByTestId("input-grant-unified")).toBeNull();
  });
});
