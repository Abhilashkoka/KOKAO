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
