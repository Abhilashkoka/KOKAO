import { beforeEach, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { CreditBalancePill, CreditUsageCard } from "./credit-balance";

const state = vi.hoisted(() => ({
  result: {} as any,
  hook: vi.fn(),
}));
vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  return createApiClientMock({
    useGetCredits: (options: unknown) => { state.hook(options); return state.result; },
  });
});

beforeEach(() => {
  state.hook.mockClear();
  state.result = { data: { total: 500, purchased: 500, granted: 0, mode: "shadow", funded: false }, isLoading: false };
});

it("shows saved purchased credits without claiming they fund generation in shadow mode", () => {
  render(<CreditUsageCard />);
  expect(screen.getByText("500")).toBeTruthy();
  expect(screen.getByText(/Generation still uses your current wallet or quota/)).toBeTruthy();
  expect(screen.getByText("Purchased credits never expire.")).toBeTruthy();
  expect(state.hook).toHaveBeenCalledWith(expect.objectContaining({
    query: expect.objectContaining({ refetchInterval: 30000, refetchOnMount: "always" }),
  }));
});

it("keeps purchased credits visible even when metering is off", () => {
  state.result.data.mode = "off";
  render(<CreditBalancePill />);
  expect(screen.getByTestId("badge-credit-balance").textContent).toContain("500");
});

it("does not show a failed balance request as zero credits", () => {
  state.result = { isError: true, isLoading: false };
  render(<CreditUsageCard />);
  expect(screen.getByRole("status").textContent).toContain("unavailable");
  expect(screen.queryByText("0.0")).toBeNull();
});

it("shows an unavailable message in the sidebar when the balance request fails", () => {
  state.result = { isError: true, isLoading: false };
  render(<CreditBalancePill />);
  expect(screen.getByRole("status").textContent).toContain("Credit balance unavailable");
  expect(screen.queryByTestId("badge-credit-balance")).toBeNull();
});

it("keeps the last known balance visible while background refresh retries", () => {
  state.result.isError = true;
  render(<CreditUsageCard />);
  expect(screen.getByText("500")).toBeTruthy();
  expect(screen.getByRole("status").textContent).toContain("last known balance");
});

it("labels pending and ambiguous ledger entries without showing a failed zero", () => {
  state.result.data.history = [
    {
      id: 11,
      kind: "spend",
      credits: -2.5,
      balanceAfter: 497.5,
      settlementStatus: "pending",
      createdAt: "2025-01-01T00:00:00.000Z",
    },
    {
      id: 12,
      kind: "spend",
      credits: -1,
      balanceAfter: 496.5,
      settlementStatus: "ambiguous",
      createdAt: "2025-01-01T00:00:00.000Z",
    },
    {
      id: 13,
      kind: "purchase",
      credits: 10,
      balanceAfter: 506.5,
      settlementStatus: null,
      createdAt: "2025-01-01T00:00:00.000Z",
    },
  ];

  render(<CreditUsageCard />);

  expect(screen.getByText("Pending")).toBeTruthy();
  expect(screen.getByText("Ambiguous")).toBeTruthy();
  expect(screen.getByTestId("credit-history-entry-11").textContent).toContain(
    "-2.5 credits",
  );
  expect(screen.queryByText(/failed/i)).toBeNull();
});