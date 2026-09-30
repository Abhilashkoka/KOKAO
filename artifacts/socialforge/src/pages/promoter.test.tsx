import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import PromoterPage from "./promoter";
import { PromoterCodeField } from "@/components/promoter-code-field";
import { ApiError } from "@workspace/api-client-react";

const mock = vi.hoisted(() => ({
  me: { isLoading: false, isError: true, error: { status: 404, data: { code: "not_a_promoter" } }, data: null } as Record<string, unknown>,
  rows: { isLoading: false, isError: false, data: [] } as Record<string, unknown>,
  mutateApply: vi.fn(), mutateAttach: vi.fn(), invalidate: vi.fn(), toast: vi.fn(),
  feature: true,
}));
vi.mock("@workspace/api-client-react", async original => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  const actual = await original<typeof import("@workspace/api-client-react")>();
  return createApiClientMock({
    ApiError: actual.ApiError,
    usePromoterMe: () => mock.me, usePromoterCommissions: () => mock.rows,
    usePromoterApply: () => ({ mutate: mock.mutateApply, isPending: false }),
    useAttachCreatorCode: () => ({ mutate: mock.mutateAttach, isPending: false }),
  });
});
vi.mock("@tanstack/react-query", async original => ({
  ...await original<typeof import("@tanstack/react-query")>(),
  useQueryClient: () => ({ invalidateQueries: mock.invalidate }),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: mock.toast }) }));
vi.mock("@/lib/features", () => ({ useFeatureFlags: () => ({ isLoading: false, flags: { creatorProgram: mock.feature } }) }));

const account = (status: string) => ({
  status, displayName: "Promoter", appliedAt: "2025-01-01", statusReason: "Please contact support",
  codes: [{ code: "KC-ABCDEFGH" }],
  commission: { currentBps: 1000, nextSlabAt: 5, nextSlabBps: 1200, qualifyingPurchases: 1, isNegotiatedRate: false },
  earnings: { pending: 100, held: 0, payable: 50, paid: 0, grossDriven: 1000, awaitingActivation: 0, inHoldWindow: 2 },
  terms: { holdDays: 30, consumptionThresholdBps: 2500, minPayout: 1000, payoutCadence: "monthly" },
});
const failure = (status: number, code?: string) => new ApiError(
  new Response(null, { status }),
  code ? { code, error: "Request failed" } : { error: "Request failed" },
  { method: "GET", url: "/api/promoter/me" },
);
beforeEach(() => {
  mock.me = { isLoading: false, isError: true, error: failure(404, "not_a_promoter"), data: null };
  mock.rows = { isLoading: false, isError: false, data: [] };
  mock.feature = true;
  mock.mutateApply.mockReset(); mock.mutateAttach.mockReset(); mock.invalidate.mockReset(); mock.toast.mockReset();
});
afterEach(cleanup);
describe("promoter UI", () => {
  it("renders application only for not_a_promoter 404, closed for feature_disabled 403, and honest errors otherwise", () => {
    const view = render(<PromoterPage />);
    expect(screen.getByText("Become a promoter")).toBeTruthy();
    mock.me = { isLoading: false, isError: true, error: failure(403, "feature_disabled") };
    view.rerender(<PromoterPage />);
    expect(screen.getByText("Promoter programme is closed")).toBeTruthy();
    mock.me = { isLoading: false, isError: true, error: failure(500) };
    view.rerender(<PromoterPage />);
    expect(screen.getByText("Couldn't load your promoter account")).toBeTruthy();
    expect(screen.queryByText("Become a promoter")).toBeNull();
  });
  it("renders every lifecycle status and keeps suspended earnings visible without a usable code", () => {
    const view = render(<PromoterPage />);
    for (const [status, label] of [["applied", "Application under review"], ["rejected", "Application not approved"], ["approved", "Ready to pay"], ["suspended", "Ready to pay"]]) {
      mock.me = { isLoading: false, isError: false, data: account(status) };
      view.rerender(<PromoterPage />);
      expect(screen.getByText(label)).toBeTruthy();
      expect(Boolean(screen.queryByTestId("promoter-code"))).toBe(status === "approved");
    }
    expect(screen.getByTestId("promoter-suspended")).toBeTruthy();
  });
  it("requires valid name, channel and agreement and invalidates me after applying", () => {
    render(<PromoterPage />);
    const button = screen.getByTestId("button-promoter-apply") as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(screen.getByRole("alert").textContent).toContain("Enter your name or brand");
    expect(screen.getByRole("alert").textContent).toContain("Accept the promoter agreement");
    expect(mock.mutateApply).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId("input-promoter-name"), { target: { value: "Name" } });
    fireEvent.change(screen.getByTestId("input-promoter-channels"), { target: { value: "invalid" } });
    fireEvent.click(screen.getByTestId("checkbox-promoter-agreement"));
    fireEvent.click(button);
    expect(screen.getByRole("alert").textContent).toContain("platform then handle");
    expect(mock.mutateApply).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId("input-promoter-channels"), { target: { value: "instagram @valid" } });
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(mock.mutateApply).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ agreementAccepted: true }) }), expect.any(Object));
    act(() => mock.mutateApply.mock.calls[0][1].onSuccess({ message: "Applied" }));
    expect(mock.invalidate).toHaveBeenCalledWith({ queryKey: expect.any(Array) });
    expect(screen.getByText("Application under review")).toBeTruthy();
  });
  it("keeps application details and displays API errors so the user can retry", () => {
    render(<PromoterPage />);
    fireEvent.change(screen.getByTestId("input-promoter-name"), { target: { value: "Name" } });
    fireEvent.change(screen.getByTestId("input-promoter-channels"), { target: { value: "instagram @valid" } });
    fireEvent.click(screen.getByTestId("checkbox-promoter-agreement"));
    fireEvent.click(screen.getByTestId("button-promoter-apply"));
    act(() => mock.mutateApply.mock.calls[0][1].onError(new ApiError(
      new Response(null, { status: 503 }), { error: "Please try again shortly." },
      { method: "POST", url: "/api/promoter/apply" },
    )));
    expect(screen.getByRole("alert").textContent).toBe("Please try again shortly.");
    expect((screen.getByTestId("input-promoter-name") as HTMLInputElement).value).toBe("Name");
    fireEvent.click(screen.getByTestId("button-promoter-apply"));
    expect(mock.mutateApply).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("explains only nonzero pending reasons and renders no identities or risk details", () => {
    mock.me = { isLoading: false, isError: false, data: account("approved") };
    mock.rows = { isLoading: false, isError: false, data: [{ id: 1, workspace: "Workspace #7", purchasedOn: "2025-01-01", gross: 1000, commission: 100, state: "held", reason: "Under review", riskSignals: ["same_email_domain"], buyerEmail: "private@example.com" }] };
    render(<PromoterPage />);
    expect(screen.getByText(/2 in the 30-day refund window/)).toBeTruthy();
    expect(screen.queryByText(/waiting on activation/)).toBeNull();
    expect(screen.getByText("Under review")).toBeTruthy();
    expect(screen.queryByText(/private@example.com|same_email_domain/)).toBeNull();
  });
  it("keeps code on failure and shows returned API detail; success displays bonus and removes input", () => {
    render(<PromoterCodeField />);
    fireEvent.change(screen.getByTestId("input-promoter-code"), { target: { value: "kc-test1234" } });
    fireEvent.click(screen.getByTestId("button-apply-promoter-code"));
    act(() => mock.mutateAttach.mock.calls[0][1].onError(new ApiError(
      new Response(null, { status: 400 }),
      { error: "Code expired", code: "expired" },
      { method: "POST", url: "/api/credits/creator-code" },
    )));
    expect((screen.getByTestId("input-promoter-code") as HTMLInputElement).value).toBe("KC-TEST1234");
    expect(mock.toast).toHaveBeenCalledWith(expect.objectContaining({ description: "Code expired" }));
    act(() => mock.mutateAttach.mock.calls[0][1].onSuccess({ ok: true, code: "KC-TEST1234", promoter: "Name", bonusBps: 1000, message: "Applied" }));
    expect(screen.getByTestId("promoter-code-applied")).toBeTruthy();
    expect(screen.getByText(/10% bonus credits/)).toBeTruthy();
    expect(screen.queryByTestId("input-promoter-code")).toBeNull();
    // Mutation callback sets component state and invalidates balances.
    expect(mock.invalidate).toHaveBeenCalledWith({ queryKey: expect.any(Array) });
  });
  it("does not show code entry when platform feature is disabled", () => {
    mock.feature = false;
    const { container } = render(<PromoterCodeField />);
    expect(container.textContent).toBe("");
  });
});