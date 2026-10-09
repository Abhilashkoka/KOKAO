import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AppLayout } from "./layout";

const state = vi.hoisted(() => ({
  error: null as { status: number } | null,
  loaded: true,
  signedIn: true,
  signOut: vi.fn(),
  reload: vi.fn(),
  refetch: vi.fn(),
}));
vi.mock("@clerk/react", () => ({
  useAuth: () => ({ isLoaded: state.loaded, isSignedIn: state.signedIn, signOut: state.signOut }),
  useClerk: () => ({ session: { reload: state.reload } }),
  UserButton: () => null,
}));
vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  return createApiClientMock({
    getGetMeQueryKey: () => ["/api/me"],
    useGetMe: () => ({
      data: { isSuperadmin: true, team: { role: "owner" } },
      error: state.error,
      refetch: state.refetch,
    }),
  });
});
vi.mock("wouter", () => ({
  useLocation: () => ["/dashboard", vi.fn()],
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock("@/lib/brand", () => ({
  useBrand: () => ({ appName: "KOKAO", logoUrl: "/logo.svg", sidebarLogoHeight: 80 }),
}));
vi.mock("@/lib/features", () => ({ useFeatureFlags: () => ({ flags: {} }) }));
vi.mock("@/components/notifications-banner", () => ({ NotificationsBanner: () => null }));
vi.mock("@/components/pending-invite-banner", () => ({ PendingInviteBanner: () => null }));
vi.mock("@/components/onboarding-wizard", () => ({ OnboardingWizard: () => null }));
vi.mock("@/components/team-welcome-dialog", () => ({ TeamWelcomeDialog: () => null }));
vi.mock("@/components/wallet-balance", () => ({ WalletBalancePill: () => null }));
vi.mock("@/components/credit-balance", () => ({ CreditBalancePill: () => null }));
vi.mock("@/components/generation-indicator", () => ({ GenerationIndicator: () => null }));
vi.mock("@/hooks/use-idle-logout", () => ({ IdleLogoutWarning: () => null }));

beforeEach(() => {
  vi.clearAllMocks();
  state.error = null;
  state.loaded = true;
  state.signedIn = true;
  state.reload.mockResolvedValue(undefined);
  state.refetch.mockResolvedValue({ isError: false });
});
afterEach(cleanup);

describe("workspace session verification boundary", () => {
  it("hides cached admin navigation and workspace content on 401 without destroying Clerk's session", () => {
    state.error = { status: 401 };
    render(<AppLayout><div>Private workspace content</div></AppLayout>);
    expect(screen.getByRole("heading", { name: "Reconnect your sign-in" })).toBeTruthy();
    expect(screen.queryByText("Private workspace content")).toBeNull();
    expect(screen.queryByText("Admin")).toBeNull();
    expect(state.signOut).not.toHaveBeenCalled();
  });

  it("returns to the verified workspace after an explicit retry", async () => {
    state.error = { status: 401 };
    const view = render(<AppLayout><div>Private workspace content</div></AppLayout>);
    fireEvent.click(screen.getByRole("button", { name: "Retry connection" }));
    await waitFor(() => expect(state.refetch).toHaveBeenCalledTimes(1));
    state.error = null;
    view.rerender(<AppLayout><div>Private workspace content</div></AppLayout>);
    expect(screen.getByText("Private workspace content")).toBeTruthy();
    expect(screen.getByText("Admin")).toBeTruthy();
    expect(state.signOut).not.toHaveBeenCalled();
  });

  it("does not treat a server outage as an instruction to sign out", () => {
    state.error = { status: 503 };
    render(<AppLayout><div>Private workspace content</div></AppLayout>);
    expect(state.signOut).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "Reconnect your sign-in" })).toBeNull();
  });
});
