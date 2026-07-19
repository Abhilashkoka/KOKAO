import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { BrandProvider, useBrand } from "./brand";

const mockState: { brand: Record<string, unknown> | undefined } = {
  brand: undefined,
};

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  return createApiClientMock({
    useGetAppBrand: () => ({ data: mockState.brand, isLoading: !mockState.brand }),
  });
});

vi.mock("@assets/kokao-lockup_1783325983377.svg", () => ({
  default: "default-lockup.svg",
}));

function Probe() {
  const { appName, logoUrl } = useBrand();
  return (
    <div>
      <span data-testid="app-name">{appName}</span>
      <span data-testid="logo-url">{logoUrl}</span>
    </div>
  );
}

function renderProbe() {
  return render(
    <BrandProvider>
      <Probe />
    </BrandProvider>,
  );
}

const CACHE_KEY = "kokao-app-brand-cache";

describe("BrandProvider brand caching", () => {
  beforeEach(() => {
    localStorage.clear();
    mockState.brand = undefined;
  });

  it("falls back to the bundled default with no fetch and no cache", () => {
    renderProbe();
    expect(screen.getByTestId("app-name").textContent).toBe("KOKAO");
    expect(screen.getByTestId("logo-url").textContent).toBe("default-lockup.svg");
  });

  it("shows the cached custom brand while the fetch is still loading", () => {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ appName: "Acme", logoUrl: "/acme-logo.png" }),
    );
    renderProbe();
    expect(screen.getByTestId("app-name").textContent).toBe("Acme");
    expect(screen.getByTestId("logo-url").textContent).toBe("/acme-logo.png");
  });

  it("persists the fetched brand to the cache and prefers it over stale cache", () => {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ appName: "Stale", logoUrl: "/stale.png" }),
    );
    mockState.brand = { appName: "Fresh", logoUrl: "/fresh.png", iconUrl: null };
    renderProbe();
    expect(screen.getByTestId("app-name").textContent).toBe("Fresh");
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "{}");
    expect(cached.appName).toBe("Fresh");
    expect(cached.logoUrl).toBe("/fresh.png");
  });

  it("reverts to defaults when branding was cleared server-side", () => {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ appName: "Old", logoUrl: "/old.png" }),
    );
    mockState.brand = { appName: null, logoUrl: null, iconUrl: null };
    renderProbe();
    expect(screen.getByTestId("app-name").textContent).toBe("KOKAO");
    expect(screen.getByTestId("logo-url").textContent).toBe("default-lockup.svg");
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "{}");
    expect(cached.appName).toBeNull();
  });

  it("survives corrupt cache contents", () => {
    localStorage.setItem(CACHE_KEY, "{not json");
    renderProbe();
    expect(screen.getByTestId("app-name").textContent).toBe("KOKAO");
  });
});
