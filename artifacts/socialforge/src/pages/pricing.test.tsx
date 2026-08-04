import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * The public /pricing page must render the live plan catalog for signed-out
 * visitors and inject Product/Offer JSON-LD whose prices match what the page
 * displays (paise-backed prices win over the display label; label-only plans
 * are parsed; unparseable labels are omitted from offers, never guessed).
 */

const PLANS = [
  {
    id: "free",
    name: "Free",
    priceLabel: "$0 / mo",
    limits: { captions: 20, images: 10, videos: 3, brandKits: 1, scheduledPosts: 10 },
    features: ["20 AI captions / month"],
    teamSeats: 0,
    watermark: true,
    billingMode: "quota",
    priceInr: null,
  },
  {
    id: "payg",
    name: "Pay As You Go",
    priceLabel: "No monthly fee",
    limits: { captions: 0, images: 0, videos: 0, brandKits: 3, scheduledPosts: 50 },
    features: ["Wallet billing"],
    teamSeats: 0,
    watermark: false,
    billingMode: "wallet",
    priceInr: null,
  },
  {
    id: "pro",
    name: "Pro",
    priceLabel: "₹2,499 / mo",
    limits: { captions: 500, images: 200, videos: 50, brandKits: 10, scheduledPosts: 200 },
    features: ["500 AI captions / month"],
    teamSeats: 0,
    watermark: false,
    billingMode: "quota",
    priceInr: 249900,
    priceInrYearly: 2499000,
  },
];

vi.mock("@/lib/brand", () => ({
  useBrand: () => ({ logoUrl: null, appName: "KOKAO" }),
}));

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  return createApiClientMock({
    useListPlans: () => ({ data: PLANS, isLoading: false, isError: false }),
  });
});

import { PricingPage } from "./pricing";

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PricingPage />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  document.getElementById("pricing-jsonld")?.remove();
  document.querySelector('link[rel="canonical"]')?.remove();
});

describe("public pricing page", () => {
  it("renders every plan with its displayed price and features", () => {
    renderPage();
    expect(screen.getByTestId("pricing-plan-free").textContent).toContain("$0 / mo");
    expect(screen.getByTestId("pricing-plan-payg").textContent).toContain("No monthly fee");
    expect(screen.getByTestId("pricing-plan-pro").textContent).toContain("₹2,499 / mo");
    expect(screen.getByText("500 AI captions / month")).toBeTruthy();
  });

  it("injects Product/Offer JSON-LD matching displayed prices and skips unpriced plans", async () => {
    renderPage();
    await waitFor(() =>
      expect(document.getElementById("pricing-jsonld")).not.toBeNull(),
    );
    const jsonLd = JSON.parse(
      document.getElementById("pricing-jsonld")!.textContent ?? "{}",
    );
    expect(jsonLd["@type"]).toBe("Product");
    const offers = jsonLd.offers as Array<{ name: string; price: string; priceCurrency: string }>;
    // Free: parsed from "$0 / mo". Pro: authoritative paise price wins,
    // plus an annual offer for its yearly price.
    expect(offers).toEqual([
      expect.objectContaining({ name: "KOKAO Free plan", price: "0", priceCurrency: "USD" }),
      expect.objectContaining({ name: "KOKAO Pro plan", price: "2499.00", priceCurrency: "INR" }),
      expect.objectContaining({ name: "KOKAO Pro plan (annual)", price: "24990.00", priceCurrency: "INR" }),
    ]);
    // "No monthly fee" is not a price — never invent an Offer for it.
    expect(offers.some((o) => o.name.includes("Pay As You Go"))).toBe(false);
  });

  it("points the canonical link at /pricing while mounted and restores it on unmount", () => {
    // index.html ships a home-page canonical; the page must override it.
    const canonical = document.createElement("link");
    canonical.rel = "canonical";
    canonical.href = "https://app.kokao.in/";
    document.head.appendChild(canonical);

    const { unmount } = renderPage();
    expect(canonical.href).toBe("https://app.kokao.in/pricing");
    unmount();
    expect(canonical.href).toBe("https://app.kokao.in/");
  });

  it("shows the billing-cycle toggle and switches yearly-priced plans to annual totals", () => {
    renderPage();
    // Toggle is present because Pro carries a yearly price; monthly is default.
    expect(screen.getByTestId("billing-cycle-toggle")).toBeTruthy();
    expect(screen.getByTestId("pricing-plan-pro").textContent).toContain("₹2,499 / mo");

    fireEvent.click(screen.getByTestId("billing-cycle-yearly"));
    // 2499000 paise = ₹24,990 / yr; saving vs 12 × ₹2,499 = ₹29,988 → 17%.
    expect(screen.getByTestId("pricing-plan-pro-yearly-price").textContent).toContain("₹24,990 / yr");
    expect(screen.getByTestId("pricing-plan-pro-yearly-savings").textContent).toContain("Save 17% vs monthly");
    // Plans without a yearly price keep their monthly label.
    expect(screen.getByTestId("pricing-plan-free").textContent).toContain("$0 / mo");
    expect(screen.getByTestId("pricing-plan-payg").textContent).toContain("No monthly fee");
  });

  it("includes an annual Offer in the JSON-LD only for yearly-priced plans", async () => {
    renderPage();
    await waitFor(() =>
      expect(document.getElementById("pricing-jsonld")).not.toBeNull(),
    );
    const jsonLd = JSON.parse(
      document.getElementById("pricing-jsonld")!.textContent ?? "{}",
    );
    const offers = jsonLd.offers as Array<{ name: string; price: string; priceCurrency: string }>;
    expect(offers).toContainEqual(
      expect.objectContaining({
        name: "KOKAO Pro plan (annual)",
        price: "24990.00",
        priceCurrency: "INR",
      }),
    );
    expect(offers.filter((o) => o.name.includes("(annual)"))).toHaveLength(1);
  });

  it("removes the JSON-LD script on unmount so other routes don't carry it", async () => {
    const { unmount } = renderPage();
    await waitFor(() =>
      expect(document.getElementById("pricing-jsonld")).not.toBeNull(),
    );
    unmount();
    expect(document.getElementById("pricing-jsonld")).toBeNull();
  });
});
