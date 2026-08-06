import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProviderHealthCard } from "./provider-health-card";

type Report = {
  textFailover: {
    selectedProvider: string;
    active: boolean;
    divertedTo: string | null;
  };
  providers: Array<Record<string, unknown>>;
  generatedAt: string;
};

const mockState: { report: Report; isLoading: boolean } = {
  isLoading: false,
  report: {
    textFailover: { selectedProvider: "builtin", active: false, divertedTo: null },
    providers: [],
    generatedAt: new Date().toISOString(),
  },
};

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../../test/apiClientMock");
  return createApiClientMock({
    useAdminGetProviderHealth: () => ({
      data: mockState.isLoading ? undefined : mockState.report,
      isLoading: mockState.isLoading,
    }),
  });
});

function entry(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    key: "textgen:builtin",
    family: "textgen",
    providerId: "builtin",
    label: "Built-in (OpenAI)",
    selected: false,
    healthy: true,
    breakerOpenUntil: null,
    consecutiveFailures: 0,
    lastFailureMessage: null,
    samples: 0,
    successes: 0,
    typicalLatencyMs: null,
    ...overrides,
  };
}

function renderCard() {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <ProviderHealthCard />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockState.isLoading = false;
});

describe("ProviderHealthCard", () => {
  it("shows healthy providers with stats and no failover banner", () => {
    mockState.report = {
      textFailover: { selectedProvider: "builtin", active: false, divertedTo: null },
      providers: [
        entry({ selected: true, samples: 10, successes: 9, typicalLatencyMs: 850 }),
        entry({
          key: "imagegen:gemini",
          family: "imagegen",
          providerId: "gemini",
          label: "Gemini",
        }),
      ],
      generatedAt: new Date().toISOString(),
    };
    renderCard();

    expect(screen.getByTestId("text-no-failover")).toBeTruthy();
    expect(screen.queryByTestId("banner-text-failover-active")).toBeNull();
    expect(
      screen.getByTestId("badge-provider-healthy-textgen:builtin"),
    ).toBeTruthy();
    expect(
      screen.getByTestId("badge-provider-selected-textgen:builtin"),
    ).toBeTruthy();
    expect(
      screen.getByTestId("text-provider-success-rate-textgen:builtin").textContent,
    ).toContain("90% (9/10)");
    // Never-called provider shows placeholders, not flattering numbers.
    expect(
      screen.getByTestId("text-provider-success-rate-imagegen:gemini").textContent,
    ).toContain("—");
  });

  it("shows the failover banner and open-breaker badge when text is diverted", () => {
    mockState.report = {
      textFailover: {
        selectedProvider: "openrouter",
        active: true,
        divertedTo: "builtin",
      },
      providers: [
        entry({
          key: "textgen:openrouter",
          providerId: "openrouter",
          label: "OpenRouter",
          selected: true,
          healthy: false,
          breakerOpenUntil: new Date(Date.now() + 60_000).toISOString(),
          consecutiveFailures: 3,
          lastFailureMessage: "503 upstream",
          samples: 5,
          successes: 2,
        }),
        entry({}),
      ],
      generatedAt: new Date().toISOString(),
    };
    renderCard();

    const banner = screen.getByTestId("banner-text-failover-active");
    expect(banner.textContent).toContain("openrouter");
    expect(banner.textContent).toContain("builtin");
    expect(
      screen.getByTestId("badge-provider-open-textgen:openrouter").textContent,
    ).toContain("Breaker open");
    expect(
      screen.getByTestId("badge-provider-diverted-textgen:openrouter"),
    ).toBeTruthy();
    expect(screen.getByText("503 upstream")).toBeTruthy();
  });
});
