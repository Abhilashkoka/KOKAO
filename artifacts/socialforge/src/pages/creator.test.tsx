import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ApiError } from "@workspace/api-client-react";
import CreatorPortalPage from "./creator";

const m = vi.hoisted(() => ({
  me: {} as Record<string, unknown>, promoter: {} as Record<string, unknown>, consent: {} as Record<string, unknown>,
  updateConsent: vi.fn(), signOut: vi.fn(), refetchMe: vi.fn(), refetchPromoter: vi.fn(),
}));
vi.mock("@clerk/react", () => ({ UserButton: () => null, useAuth: () => ({ isLoaded: true, isSignedIn: true, signOut: m.signOut }) }));
vi.mock("@workspace/api-client-react", async original => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  const actual = await original<typeof import("@workspace/api-client-react")>();
  return createApiClientMock({
    ApiError: actual.ApiError,
    useGetMe: () => m.me, usePromoterMe: () => m.promoter, useGetConsent: () => m.consent,
    useUpdateConsent: () => ({ mutate: m.updateConsent, isPending: false }),
    usePromoterCommissions: () => ({ isLoading: false, isError: false, data: [] }),
    usePromoterApply: () => ({ mutate: vi.fn(), isPending: false }),
    useGetPromoterPayoutDetails: () => ({ isLoading: false, isError: false, data: { onFile: false } }),
    useGetPromoterPayouts: () => ({ isLoading: false, isError: false, data: { payouts: [], balance: { owedBack: 0 } } }),
    useSavePromoterPayoutDetails: () => ({ mutate: vi.fn(), isPending: false }),
  });
});
vi.mock("@tanstack/react-query", async original => ({ ...await original<typeof import("@tanstack/react-query")>(), useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/analytics", () => ({ setConsentState: vi.fn() }));
vi.mock("@/components/onboarding-wizard", () => ({ OnboardingWizard: () => { throw new Error("wizard must not render"); } }));

const fail = (status: number, code?: string) => new ApiError(new Response(null, { status }), code ? { code, error: "x" } : { error: "x" }, { method: "GET", url: "/api" });
const account = (status: string) => ({
  status, appliedAt: "2025-01-01", statusReason: "Reason given", codes: [{ code: "KC-ABCDEFGH" }],
  commission: { currentBps: 1000, nextSlabAt: null, nextSlabBps: null, qualifyingPurchases: 1, isNegotiatedRate: false },
  earnings: { pending: 0, held: 0, payable: 50, paid: 0, grossDriven: 1000, awaitingActivation: 0, inHoldWindow: 0 },
  terms: { holdDays: 30, consumptionThresholdBps: 2500, minPayout: 1000, payoutCadence: "monthly" },
});
beforeEach(() => {
  m.me = { isLoading: false, isError: false, data: { email: "c@example.test" }, refetch: m.refetchMe };
  m.consent = { isLoading: false, isError: false, data: { responded: true } };
  m.promoter = { isLoading: false, isError: false, data: account("approved"), refetch: m.refetchPromoter };
  vi.clearAllMocks();
});
afterEach(cleanup);

describe("CreatorPortalPage", () => {
  it("shows creator shell only, no workspace sidebar or wizard", () => {
    render(<CreatorPortalPage />);
    expect(screen.getByTestId("text-creator-portal").textContent).toBe("Creator Portal");
    expect(screen.queryByLabelText("Workspace navigation")).toBeNull();
    expect(screen.queryByText("AI Studio")).toBeNull();
    expect(screen.getByTestId("promoter-code").textContent).toBe("KC-ABCDEFGH");
    expect(screen.getByRole("heading", { name: "Creator dashboard" })).toBeTruthy();
    fireEvent.click(screen.getByTestId("button-creator-signout"));
    expect(m.signOut).toHaveBeenCalledWith({ redirectUrl: "/creator" });
  });
  it("signs out only on 401; 5xx shows retry", () => {
    m.me = { isLoading: false, isError: true, error: fail(503), refetch: m.refetchMe };
    const v = render(<CreatorPortalPage />);
    fireEvent.click(screen.getByTestId("button-creator-shell-retry"));
    expect(m.refetchMe).toHaveBeenCalled();
    expect(m.signOut).not.toHaveBeenCalled();
    m.me = { isLoading: false, isError: true, error: fail(401), refetch: m.refetchMe };
    v.rerender(<CreatorPortalPage />);
    expect(m.signOut).toHaveBeenCalledTimes(1);
  });
  it("consent gate defaults off, continues without analytics, and survives save failure", () => {
    m.consent = { isLoading: false, isError: false, data: { responded: false } };
    render(<CreatorPortalPage />);
    expect(screen.queryByTestId("creator-dashboard")).toBeNull();
    expect(screen.getByTestId("switch-consent-analytics").getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByTestId("button-creator-consent-continue"));
    expect(m.updateConsent.mock.calls[0][0]).toEqual({ data: { analytics: false, deviceDetails: false, locationCoarse: false, locationPrecise: false } });
    const opts = m.updateConsent.mock.calls[0][1] as { onError: () => void };
    act(() => opts.onError());
    fireEvent.click(screen.getByTestId("button-creator-consent-skip"));
    expect(screen.getByTestId("creator-dashboard")).toBeTruthy();
  });
  it("covers lifecycle states", () => {
    m.promoter = { isLoading: false, isError: true, error: fail(404, "not_a_promoter"), refetch: m.refetchPromoter };
    const v = render(<CreatorPortalPage />);
    expect(screen.getByTestId("creator-apply")).toBeTruthy();
    m.promoter = { isLoading: false, isError: false, data: account("applied") }; v.rerender(<CreatorPortalPage />);
    expect(screen.getByText("Your application is awaiting review. Check back here for updates.")).toBeTruthy();
    m.promoter = { isLoading: false, isError: false, data: account("rejected") }; v.rerender(<CreatorPortalPage />);
    expect(screen.getByText("Reason given")).toBeTruthy();
    m.promoter = { isLoading: false, isError: false, data: account("suspended") }; v.rerender(<CreatorPortalPage />);
    expect(screen.getByTestId("promoter-suspended")).toBeTruthy();
    expect(screen.queryByTestId("promoter-code")).toBeNull();
    m.promoter = { isLoading: false, isError: true, error: fail(403, "feature_disabled") }; v.rerender(<CreatorPortalPage />);
    expect(screen.getByTestId("creator-closed")).toBeTruthy();
    m.promoter = { isLoading: false, isError: true, error: fail(500), refetch: m.refetchPromoter }; v.rerender(<CreatorPortalPage />);
    fireEvent.click(screen.getByTestId("button-creator-retry"));
    expect(m.refetchPromoter).toHaveBeenCalled();
  });
});
