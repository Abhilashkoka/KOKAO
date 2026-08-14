/**
 * Superadmin Actual Cost Report card — rendering of spend/cost/margin.
 *
 * The API reports per-tenant totalCostPaise vs displaySpendPaise (including
 * mixed flat/cost_plus months); the margin figures are derived CLIENT-side
 * as displaySpend - cost. These tests pin that the rendered spend, cost and
 * margin match the payload exactly, and that a negative-margin tenant row is
 * highlighted (text-destructive) rather than hidden or clamped.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Radix needs a few APIs jsdom doesn't implement.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

interface MonthTotal {
  month: string;
  captionCount: number;
  imageCount: number;
  videoCount: number;
  totalCostPaise: number;
  displaySpendPaise: number;
  unknownCount: number;
}

interface TenantRow {
  tenantId: number;
  name: string | null;
  email: string | null;
  captionCount: number;
  imageCount: number;
  videoCount: number;
  captionCostPaise: number;
  imageCostPaise: number;
  videoCostPaise: number;
  unknownCaptionCount: number;
  unknownImageCount: number;
  unknownVideoCount: number;
  totalCostPaise: number;
  displaySpendPaise: number;
}

interface Report {
  month: string;
  months: string[];
  displayRates: { captionPaise: number; imagePaise: number; videoPaise: number };
  summary: MonthTotal;
  trend: MonthTotal[];
  tenants: TenantRow[];
}

// Mixed-mode month mirroring the route test's scenario: tenant 11 is a
// cost_plus tenant whose displayed spend exceeds actual cost (positive
// margin); tenant 22 is a flat-mode tenant whose real provider cost blew
// past the flat display rate (NEGATIVE margin) with unknown-cost events.
const TENANT_POSITIVE: TenantRow = {
  tenantId: 11,
  name: "Plus Co",
  email: "plus@example.com",
  captionCount: 2,
  imageCount: 2,
  videoCount: 1,
  captionCostPaise: 300,
  imageCostPaise: 0,
  videoCostPaise: 8000,
  unknownCaptionCount: 0,
  unknownImageCount: 2,
  unknownVideoCount: 0,
  totalCostPaise: 8300,
  displaySpendPaise: 12550,
};

const TENANT_NEGATIVE: TenantRow = {
  tenantId: 22,
  name: "Flat Ltd",
  email: "flat@example.com",
  captionCount: 1,
  imageCount: 0,
  videoCount: 2,
  captionCostPaise: 700,
  imageCostPaise: 0,
  videoCostPaise: 24000,
  unknownCaptionCount: 0,
  unknownImageCount: 0,
  unknownVideoCount: 1,
  totalCostPaise: 24700,
  displaySpendPaise: 20550,
};

const CUR: MonthTotal = {
  month: "2026-08",
  captionCount: 3,
  imageCount: 2,
  videoCount: 3,
  totalCostPaise: 33000,
  displaySpendPaise: 33100, // overall margin +100
  unknownCount: 3,
};

const PREV: MonthTotal = {
  month: "2026-07",
  captionCount: 4,
  imageCount: 1,
  videoCount: 0,
  totalCostPaise: 9000,
  displaySpendPaise: 4000, // negative month in the trend
  unknownCount: 0,
};

const REPORT: Report = {
  month: "2026-08",
  months: ["2026-08", "2026-07"],
  displayRates: { captionPaise: 550, imagePaise: 1100, videoPaise: 11000 },
  summary: CUR,
  trend: [CUR, PREV],
  tenants: [TENANT_POSITIVE, TENANT_NEGATIVE],
};

const mockState: { report: Report } = { report: REPORT };

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../../test/apiClientMock");
  return createApiClientMock({
    useAdminGetAiCostReport: () => ({ data: mockState.report, isLoading: false }),
    useAdminGetAiCostCampaigns: () => ({ data: undefined, isLoading: false }),
  });
});

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { AiCostReportCard } from "./ai-tab";

const inr = (paise: number) =>
  `\u20B9${(paise / 100).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

function renderCard() {
  const result = render(
    <QueryClientProvider client={new QueryClient()}>
      <AiCostReportCard />
    </QueryClientProvider>,
  );
  // Card renders collapsed by default; expand it.
  fireEvent.click(screen.getByTestId("toggle-ai-cost-report-card"));
  return result;
}

beforeEach(() => {
  cleanup();
  mockState.report = REPORT;
});

describe("AiCostReportCard figures", () => {
  it("renders summary spend, cost and derived margin straight from the payload", () => {
    renderCard();
    expect(screen.getByTestId("text-summary-actual-cost").textContent).toBe(
      inr(33000), // ₹330.00
    );
    expect(screen.getByTestId("text-summary-display-spend").textContent).toBe(
      inr(33100),
    );
    const margin = screen.getByTestId("text-summary-margin");
    expect(margin.textContent).toBe(inr(100)); // 33100 - 33000
    expect(margin.className).not.toContain("text-destructive");
    expect(screen.getByTestId("text-summary-generations").textContent).toBe("8");
  });

  it("renders each tenant row's cost, displayed spend and margin from the payload", () => {
    renderCard();
    const row = within(screen.getByTestId("row-cost-tenant-11"));
    const cells = screen
      .getByTestId("row-cost-tenant-11")
      .querySelectorAll("td");
    // Columns: tenant, captions, caption cost, images, image cost, videos,
    // video cost, actual cost, displayed spend, margin, unknown.
    expect(cells[7].textContent).toBe(inr(8300));
    expect(cells[8].textContent).toBe(inr(12550));
    expect(cells[9].textContent).toBe(inr(4250)); // 12550 - 8300
    expect(cells[9].className).not.toContain("text-destructive");
    expect(row.getByText("Plus Co")).toBeTruthy();
    // Unknown-cost events surface as a badge, never silently dropped.
    expect(cells[10].textContent).toContain("2 events");
  });

  it("shows a negative tenant margin highlighted, not hidden", () => {
    renderCard();
    const cells = screen
      .getByTestId("row-cost-tenant-22")
      .querySelectorAll("td");
    expect(cells[7].textContent).toBe(inr(24700));
    expect(cells[8].textContent).toBe(inr(20550));
    // Margin is negative: -₹41.50, rendered AND highlighted.
    expect(cells[9].textContent).toBe(inr(-4150));
    expect(cells[9].className).toContain("text-destructive");
  });

  it("highlights a negative overall margin in the summary tile", () => {
    mockState.report = {
      ...REPORT,
      summary: { ...CUR, totalCostPaise: 40000, displaySpendPaise: 33100 },
    };
    renderCard();
    const margin = screen.getByTestId("text-summary-margin");
    expect(margin.textContent).toBe(inr(-6900));
    expect(margin.className).toContain("text-destructive");
  });

  it("derives per-month margins in the trend table, flagging negative months", () => {
    renderCard();
    const cur = screen.getByTestId("row-trend-2026-08").querySelectorAll("td");
    // Trend columns: month, captions, images, videos, cost, spend, margin, unknown.
    expect(cur[4].textContent).toBe(inr(33000));
    expect(cur[5].textContent).toBe(inr(33100));
    expect(cur[6].textContent).toBe(inr(100));
    expect(cur[6].className).not.toContain("text-destructive");

    const prev = screen.getByTestId("row-trend-2026-07").querySelectorAll("td");
    expect(prev[4].textContent).toBe(inr(9000));
    expect(prev[5].textContent).toBe(inr(4000));
    expect(prev[6].textContent).toBe(inr(-5000));
    expect(prev[6].className).toContain("text-destructive");
  });
});
