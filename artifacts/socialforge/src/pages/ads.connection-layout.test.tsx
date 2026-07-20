import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Layout regression guard for the Ads page connection cards.
 *
 * The four platform connection cards (Meta, Google, TikTok, LinkedIn) were
 * converted from a 2-column grid to stacked full-width horizontal cards:
 * each card stacks vertically under a `space-y-4` container and lays out its
 * header/actions side by side via a `flex flex-col lg:flex-row` body wrapper.
 * A future edit could silently reintroduce the `lg:grid-cols-2` wrapper or
 * drop the horizontal split, so these tests pin the structure.
 */

// Contract guard: mocks are typed against the generated OpenAPI types so a
// spec reshape breaks this suite at compile time.
import type { AdsModuleStatus, AdAccountConnection } from "@workspace/api-client-react";

const adsStatus: AdsModuleStatus = {
  enabled: true,
  platforms: [
    { platform: "meta", available: true },
    { platform: "google", available: true },
    { platform: "tiktok", available: true },
    { platform: "linkedin", available: true },
  ],
};

const mockState: {
  connections: AdAccountConnection[];
} = {
  connections: [],
};

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  return createApiClientMock({
    useGetMe: () => ({ data: { isSuperadmin: false }, isLoading: false }),
    useGetAdsStatus: () => ({ data: adsStatus, isLoading: false }),
    useListAdConnections: () => ({ data: mockState.connections, isLoading: false }),
  });
});

import { AdsPage } from "./ads";

const CONNECT_BUTTON_IDS = [
  "button-connect-meta-ads",
  "button-connect-google-ads",
  "button-connect-tiktok-ads",
  "button-connect-linkedin-ads",
] as const;

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AdsPage />
    </QueryClientProvider>,
  );
}

/** The card body wrapper that splits header (left) from actions (right). */
function bodyWrapperOf(el: HTMLElement): HTMLElement | null {
  return el.closest('div[class*="lg:flex-row"]');
}

/** The Card element is the direct parent of the flex body wrapper. */
function cardOf(el: HTMLElement): HTMLElement {
  const wrapper = bodyWrapperOf(el);
  expect(wrapper).not.toBeNull();
  const card = wrapper!.parentElement;
  expect(card).not.toBeNull();
  return card!;
}

function makeConnection(
  platform: string,
  id: number,
  overrides: Partial<AdAccountConnection> = {},
): AdAccountConnection {
  return {
    id,
    platform,
    adAccountId: `act_${platform}_${id}`,
    adAccountName: `${platform} account`,
    currency: "USD",
    status: "connected",
    verifyStatus: "ok",
    verifyError: null,
    verifiedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("Ads page connection card layout", () => {
  beforeEach(() => {
    cleanup();
    mockState.connections = [];
  });

  it("renders all four platform connection cards with their connect actions", () => {
    renderPage();
    for (const id of CONNECT_BUTTON_IDS) {
      expect(screen.getByTestId(id)).toBeTruthy();
    }
  });

  /**
   * The outer connection area: TikTok and LinkedIn cards are its direct
   * children; the Meta+Google pair sits in ConnectionSection's own
   * space-y-4 stack, which is also a direct child of this area.
   */
  function connectionAreaOf(): HTMLElement {
    const tiktok = cardOf(screen.getByTestId("button-connect-tiktok-ads"));
    const area = tiktok.parentElement!;
    expect(area.className).toContain("space-y-4");
    return area;
  }

  it("does not wrap the connection cards in a 2-column grid", () => {
    renderPage();
    const area = connectionAreaOf();
    expect(area.querySelector('[class*="grid-cols-2"]')).toBeNull();
    // No ancestor of any card (up to the connection area) may be a grid.
    for (const id of CONNECT_BUTTON_IDS) {
      const card = cardOf(screen.getByTestId(id));
      for (let el: HTMLElement | null = card.parentElement; el; el = el.parentElement) {
        const cls = el.className;
        expect(typeof cls === "string" && /\bgrid\b/.test(cls)).toBe(false);
        if (el === area) break;
      }
    }
  });

  it("stacks the cards as full-width siblings under one connection area", () => {
    renderPage();
    const area = connectionAreaOf();
    const meta = cardOf(screen.getByTestId("button-connect-meta-ads"));
    const google = cardOf(screen.getByTestId("button-connect-google-ads"));
    const tiktok = cardOf(screen.getByTestId("button-connect-tiktok-ads"));
    const linkedin = cardOf(screen.getByTestId("button-connect-linkedin-ads"));
    // All four are distinct cards.
    expect(new Set([meta, google, tiktok, linkedin]).size).toBe(4);
    // TikTok and LinkedIn are direct siblings in the connection area.
    expect(tiktok.parentElement).toBe(area);
    expect(linkedin.parentElement).toBe(area);
    // Meta and Google share ConnectionSection's own vertical stack, which is
    // itself a direct child of the same connection area.
    expect(meta.parentElement).toBe(google.parentElement);
    expect(meta.parentElement?.className).toContain("space-y-4");
    expect(meta.parentElement?.parentElement).toBe(area);
  });

  it("each card body uses the stacked-to-horizontal flex split", () => {
    renderPage();
    for (const id of CONNECT_BUTTON_IDS) {
      const wrapper = bodyWrapperOf(screen.getByTestId(id));
      expect(wrapper).not.toBeNull();
      const cls = wrapper!.className;
      expect(cls).toContain("flex");
      expect(cls).toContain("flex-col");
      expect(cls).toContain("lg:flex-row");
      // Header is capped on the left, content grows and right-aligns actions.
      const header = wrapper!.querySelector('[class*="lg:max-w-sm"]');
      expect(header).not.toBeNull();
      const content = wrapper!.querySelector('[class*="lg:flex-1"]');
      expect(content).not.toBeNull();
    }
  });
});

const CONNECTED_TESTIDS = [
  { name: "text-ad-account-name", disconnect: "button-disconnect-meta-ads" },
  { name: "text-google-account-name", disconnect: "button-disconnect-google-ads" },
  { name: "text-tiktok-advertiser-name", disconnect: "button-disconnect-tiktok-ads" },
  { name: "text-linkedin-ad-account-name", disconnect: "button-disconnect-linkedin-ads" },
] as const;

describe("Ads page connection card layout (connected accounts)", () => {
  beforeEach(() => {
    cleanup();
    mockState.connections = [
      makeConnection("meta", 1),
      makeConnection("google", 2),
      makeConnection("tiktok", 3),
      makeConnection("linkedin", 4),
    ];
  });

  it("renders the account name and disconnect action inside each card's flex-row body", () => {
    renderPage();
    for (const { name, disconnect } of CONNECTED_TESTIDS) {
      const nameEl = screen.getByTestId(name);
      const disconnectEl = screen.getByTestId(disconnect);
      const nameWrapper = bodyWrapperOf(nameEl);
      const disconnectWrapper = bodyWrapperOf(disconnectEl);
      expect(nameWrapper).not.toBeNull();
      expect(disconnectWrapper).not.toBeNull();
      // Name and actions share the same card body split.
      expect(disconnectWrapper).toBe(nameWrapper);
      const cls = nameWrapper!.className;
      expect(cls).toContain("flex");
      expect(cls).toContain("flex-col");
      expect(cls).toContain("lg:flex-row");
      // Actions live in the growing content column that right-aligns them.
      const content = nameWrapper!.querySelector('[class*="lg:flex-1"]');
      expect(content).not.toBeNull();
      expect(content!.contains(nameEl)).toBe(true);
      expect(content!.contains(disconnectEl)).toBe(true);
    }
  });

  it("keeps the connected cards stacked as full-width siblings, not a grid", () => {
    renderPage();
    const meta = cardOf(screen.getByTestId("text-ad-account-name"));
    const google = cardOf(screen.getByTestId("text-google-account-name"));
    const tiktok = cardOf(screen.getByTestId("text-tiktok-advertiser-name"));
    const linkedin = cardOf(screen.getByTestId("text-linkedin-ad-account-name"));
    expect(new Set([meta, google, tiktok, linkedin]).size).toBe(4);

    const area = tiktok.parentElement!;
    expect(area.className).toContain("space-y-4");
    expect(linkedin.parentElement).toBe(area);
    expect(meta.parentElement).toBe(google.parentElement);
    expect(meta.parentElement?.className).toContain("space-y-4");
    expect(meta.parentElement?.parentElement).toBe(area);

    expect(area.querySelector('[class*="grid-cols-2"]')).toBeNull();
    for (const card of [meta, google, tiktok, linkedin]) {
      for (let el: HTMLElement | null = card.parentElement; el; el = el.parentElement) {
        const cls = el.className;
        expect(typeof cls === "string" && /\bgrid\b/.test(cls)).toBe(false);
        if (el === area) break;
      }
    }
  });
});
