import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Role-gated pages must fail closed while /api/me is still loading: no
 * privileged page shell may render until the role is known. Each page
 * shows a loading placeholder instead.
 */

const meState: { data: unknown; isLoading: boolean } = {
  data: undefined,
  isLoading: true,
};

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  return createApiClientMock({
    useGetMe: () => meState,
  });
});

function renderWithClient(ui: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>{ui}</QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  meState.data = undefined;
  meState.isLoading = true;
});

// Each test dynamically imports a full page bundle (so the api-client mock is
// in place first); under full-suite CPU contention that import alone can
// exceed the default 5s timeout, so this file gets a larger one.
describe("role-gated pages while /me is unresolved", { timeout: 30_000 }, () => {
  it("admin page shows only a loading placeholder", async () => {
    const { AdminPage } = await import("./admin/index");
    renderWithClient(<AdminPage />);
    expect(screen.getByTestId("admin-loading")).toBeTruthy();
    expect(screen.queryByText("Admin")).toBeNull();
    expect(screen.queryByTestId("tab-tenants")).toBeNull();
  });

  it("app branding settings show only a loading placeholder", async () => {
    const { AppBrandingSettings } = await import(
      "../components/app-branding-settings"
    );
    renderWithClient(<AppBrandingSettings />);
    expect(screen.getByTestId("app-branding-loading")).toBeTruthy();
    expect(screen.queryByText(/Branding/)).toBeNull();
  });

  it("health page shows only a loading placeholder", async () => {
    const { HealthPage } = await import("./health");
    renderWithClient(<HealthPage />);
    expect(screen.getByTestId("health-loading")).toBeTruthy();
    expect(screen.queryByText("Account Health")).toBeNull();
  });

  it("admin page renders the shell once a superadmin resolves", async () => {
    meState.data = { isSuperadmin: true, isOwner: true };
    meState.isLoading = false;
    const { AdminPage } = await import("./admin/index");
    renderWithClient(<AdminPage />);
    expect(screen.queryByTestId("admin-loading")).toBeNull();
    expect(screen.getByTestId("tab-tenants")).toBeTruthy();
  });
});
