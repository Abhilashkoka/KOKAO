/**
 * Regression guard: Analytics page tab-switcher reads ?tab= correctly and
 * blocks non-superadmin users.
 *
 * The orchestration in index.tsx owns: URL → activeTab mapping, ScopeProvider
 * value, superadmin gate, and loading state. This suite guards all four.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Radix UI components need these browser APIs in jsdom.
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

// ── Wouter mock ──────────────────────────────────────────────────────────────
// useSearch drives activeTab; useLocation[1] is called by handleTabChange.
const mockRoute = { search: "" };
const setLocationSpy = vi.hoisted(() => vi.fn());

vi.mock("wouter", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("wouter");
  return {
    ...actual,
    useSearch: () => mockRoute.search,
    useLocation: () => ["/analytics", setLocationSpy],
  };
});

// ── Tab-component mocks ───────────────────────────────────────────────────────
// Each real tab imports its own data hooks. Mocking the modules lets us verify
// the routing layer without needing to stub every inner query.
vi.mock("./audience-tab", () => ({
  AudienceTab: () => <div data-testid="tab-content-audience">AudienceTab</div>,
}));
vi.mock("./acquisition-tab", () => ({
  AcquisitionTab: () => (
    <div data-testid="tab-content-acquisition">AcquisitionTab</div>
  ),
}));
vi.mock("./funnels-tab", () => ({
  FunnelsTab: () => <div data-testid="tab-content-funnels">FunnelsTab</div>,
}));
vi.mock("./engagement-tab", () => ({
  EngagementTab: () => (
    <div data-testid="tab-content-engagement">EngagementTab</div>
  ),
}));
vi.mock("./revenue-tab", () => ({
  RevenueTab: () => <div data-testid="tab-content-revenue">RevenueTab</div>,
}));
vi.mock("./data-consumption-tab", () => ({
  DataConsumptionTab: () => (
    <div data-testid="tab-content-data">DataConsumptionTab</div>
  ),
}));
vi.mock("./reliability-tab", () => ({
  ReliabilityTab: () => (
    <div data-testid="tab-content-reliability">ReliabilityTab</div>
  ),
}));
vi.mock("./consent-tab", () => ({
  ConsentTab: () => <div data-testid="tab-content-consent">ConsentTab</div>,
}));

// ── API mock ──────────────────────────────────────────────────────────────────
const mockMe: { data: any } = { data: undefined };

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../../test/apiClientMock");
  return createApiClientMock({
    useGetMe: () => ({ data: mockMe.data, isLoading: mockMe.data === undefined }),
    useAdminListTenants: () => ({
      data: [
        { id: 10, name: "Workspace A", email: "a@example.com" },
        { id: 11, name: "Workspace B", email: "b@example.com" },
      ],
      isLoading: false,
    }),
  });
});

// Imported after mocks so the hoisted vi.mock factories are in effect.
import { AnalyticsPage } from "./index";

// ── Helpers ───────────────────────────────────────────────────────────────────
const superadmin = { isSuperadmin: true, id: 1, email: "admin@example.com" };
const regularUser = { isSuperadmin: false, id: 2, email: "user@example.com" };

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const ui = () => (
    <QueryClientProvider client={client}>
      <AnalyticsPage />
    </QueryClientProvider>
  );
  const result = render(ui());
  return { ...result, rerenderPage: () => result.rerender(ui()) };
}

function tabState(testId: string): string | null {
  return screen.getByTestId(testId).getAttribute("data-state");
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  mockRoute.search = "";
  mockMe.data = superadmin;
});

// ── Tab-from-URL routing ──────────────────────────────────────────────────────
describe("AnalyticsPage – tab-from-URL routing", () => {
  it("defaults to the Audience tab when no ?tab= param is present", () => {
    renderPage();
    expect(tabState("tab-audience")).toBe("active");
    expect(tabState("tab-funnels")).toBe("inactive");
    expect(screen.getByTestId("tab-content-audience")).toBeTruthy();
  });

  it("?tab=funnels activates the Funnels tab and renders its content", () => {
    mockRoute.search = "tab=funnels";
    renderPage();
    expect(tabState("tab-funnels")).toBe("active");
    expect(tabState("tab-audience")).toBe("inactive");
    expect(screen.getByTestId("tab-content-funnels")).toBeTruthy();
  });

  it("?tab=revenue activates the Revenue tab and renders its content", () => {
    mockRoute.search = "tab=revenue";
    renderPage();
    expect(tabState("tab-revenue")).toBe("active");
    expect(tabState("tab-audience")).toBe("inactive");
    expect(screen.getByTestId("tab-content-revenue")).toBeTruthy();
  });

  it("?tab=engagement activates the Engagement tab", () => {
    mockRoute.search = "tab=engagement";
    renderPage();
    expect(tabState("tab-engagement")).toBe("active");
    expect(screen.getByTestId("tab-content-engagement")).toBeTruthy();
  });

  it("?tab=data activates the Data Consumption tab", () => {
    mockRoute.search = "tab=data";
    renderPage();
    expect(tabState("tab-data")).toBe("active");
    expect(screen.getByTestId("tab-content-data")).toBeTruthy();
  });

  it("?tab=reliability activates the Reliability tab", () => {
    mockRoute.search = "tab=reliability";
    renderPage();
    expect(tabState("tab-reliability")).toBe("active");
    expect(screen.getByTestId("tab-content-reliability")).toBeTruthy();
  });

  it("?tab=consent activates the Consent tab", () => {
    mockRoute.search = "tab=consent";
    renderPage();
    expect(tabState("tab-consent")).toBe("active");
    expect(screen.getByTestId("tab-content-consent")).toBeTruthy();
  });

  it("falls back to the Audience tab for an unknown ?tab= value", () => {
    mockRoute.search = "tab=bogus";
    renderPage();
    expect(tabState("tab-audience")).toBe("active");
    expect(screen.getByTestId("tab-content-audience")).toBeTruthy();
  });
});

// ── Tab-change navigation ─────────────────────────────────────────────────────
describe("AnalyticsPage – tab-change navigation", () => {
  it("calls setLocation with /analytics?tab=<id> when a non-audience tab is clicked", () => {
    renderPage();
    fireEvent.mouseDown(screen.getByTestId("tab-funnels"), { button: 0 });
    expect(setLocationSpy).toHaveBeenCalledWith("/analytics?tab=funnels", {
      replace: true,
    });
  });

  it("calls setLocation with bare /analytics when the Audience tab is clicked", () => {
    mockRoute.search = "tab=funnels";
    renderPage();
    fireEvent.mouseDown(screen.getByTestId("tab-audience"), { button: 0 });
    expect(setLocationSpy).toHaveBeenCalledWith("/analytics", {
      replace: true,
    });
  });

  it("re-renders to the correct tab after search changes", () => {
    const { rerenderPage } = renderPage();
    expect(tabState("tab-audience")).toBe("active");

    mockRoute.search = "tab=revenue";
    rerenderPage();
    expect(tabState("tab-revenue")).toBe("active");
    expect(tabState("tab-audience")).toBe("inactive");
    expect(screen.getByTestId("tab-content-revenue")).toBeTruthy();
  });
});

// ── Access control ────────────────────────────────────────────────────────────
describe("AnalyticsPage – access control", () => {
  it("shows the loading spinner while /me is unresolved", () => {
    mockMe.data = undefined;
    renderPage();
    expect(screen.getByTestId("analytics-loading")).toBeTruthy();
    expect(screen.queryByTestId("tab-audience")).toBeNull();
  });

  it("shows the access-denied view for a non-superadmin user", () => {
    mockMe.data = regularUser;
    renderPage();
    expect(screen.getByText("Access denied")).toBeTruthy();
    expect(
      screen.getByText("Analytics are available to platform administrators only."),
    ).toBeTruthy();
    expect(screen.queryByTestId("tab-audience")).toBeNull();
  });

  it("renders the full dashboard for a superadmin user", () => {
    mockMe.data = superadmin;
    renderPage();
    expect(screen.queryByText("Access denied")).toBeNull();
    expect(screen.getByTestId("tab-audience")).toBeTruthy();
    expect(screen.getByTestId("tab-funnels")).toBeTruthy();
  });

  it("shows the tenant-filter dropdown only for superadmin users", () => {
    mockMe.data = superadmin;
    renderPage();
    expect(screen.getByTestId("select-analytics-tenant")).toBeTruthy();
  });
});
