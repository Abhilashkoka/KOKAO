/**
 * Regression guard: the mobile Accounts screen shows a warning banner when an
 * ad connection (Meta/LinkedIn/TikTok/Google Ads) has status "connected" but
 * verifyStatus "failed", telling the user to reconnect on the web Ads page.
 */
import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockState: { adConnections: Array<Record<string, unknown>> } = {
  adConnections: [],
};

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("./apiClientMock");
  return createApiClientMock({
    useListAdConnections: () => ({
      data: mockState.adConnections,
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
      isRefetching: false,
    }),
  });
});

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("@expo/vector-icons", () => ({
  Feather: Object.assign(() => null, { glyphMap: {} }),
}));

import AccountsScreen from "../app/(tabs)/accounts";

function renderScreen() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AccountsScreen />
    </QueryClientProvider>,
  );
}

describe("Accounts screen ad connection banner", () => {
  beforeEach(() => {
    cleanup();
    mockState.adConnections = [];
  });

  it("shows a warning when an ad connection has lost access", () => {
    mockState.adConnections = [
      {
        platform: "meta",
        status: "connected",
        verifyStatus: "failed",
        adAccountName: "Acme Ads",
      },
    ];
    renderScreen();
    expect(screen.getByText(/Ad account connection lost/)).toBeTruthy();
    expect(screen.getByText(/Meta Ads \(Acme Ads\)/)).toBeTruthy();
    expect(screen.getByText(/reconnect on the\s*web Ads page/)).toBeTruthy();
  });

  it("lists multiple failed ad connections", () => {
    mockState.adConnections = [
      { platform: "meta", status: "connected", verifyStatus: "failed" },
      { platform: "tiktok", status: "connected", verifyStatus: "failed" },
    ];
    renderScreen();
    expect(screen.getByText(/Meta Ads, TikTok Ads/)).toBeTruthy();
    expect(screen.getByText(/have lost access/)).toBeTruthy();
  });

  it("shows no banner when ad connections are healthy or disconnected", () => {
    mockState.adConnections = [
      { platform: "meta", status: "connected", verifyStatus: "ok" },
      { platform: "linkedin", status: "disconnected", verifyStatus: "failed" },
    ];
    renderScreen();
    expect(screen.queryByText(/Ad account connection lost/)).toBeNull();
  });
});
