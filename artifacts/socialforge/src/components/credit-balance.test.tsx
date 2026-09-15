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