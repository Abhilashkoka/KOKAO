import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const accountGrantMutate = vi.fn();

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
  });
});

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
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
  tenant.creditAccountExists = true;
});

describe("TenantsTab credit-first workspace table", () => {
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
