import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { needsSpendConfirmation, useSpendConfirmation, type SpendQuote } from "./spend-guard";
import {
  CreditQuoteSummary,
  CreditUsageCard,
  creditRateLabel,
  describeCreditValue,
} from "./credit-balance";

const state = vi.hoisted(() => ({
  credits: {} as any,
  quotes: {} as Record<string, any>,
}));
vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  return createApiClientMock({
    useGetCredits: () => state.credits,
    useQuoteCredits: (params: { action: string }) => ({ data: state.quotes[params.action] }),
  });
});

beforeEach(() => {
  state.credits = {
    data: {
      total: 400,
      purchased: 400,
      granted: 0,
      mode: "enforce",
      funded: true,
      history: [],
      spendGuard: { confirmAboveCredits: 100, confirmAbovePercent: 25 },
    },
    isLoading: false,
  };
  state.quotes = {};
});

it("asks above either threshold and treats 0 as off (same rule as the server)", () => {
  const guard = { confirmAboveCredits: 100, confirmAbovePercent: 25 };
  expect(needsSpendConfirmation(guard, 50, 1000)).toBe(false);
  expect(needsSpendConfirmation(guard, 101, 10_000)).toBe(true);
  expect(needsSpendConfirmation(guard, 60, 200)).toBe(true);
  expect(needsSpendConfirmation({ confirmAboveCredits: 0, confirmAbovePercent: 0 }, 900, 900)).toBe(false);
});

function Harness({ quote, run }: { quote: SpendQuote; run: () => void }) {
  const spend = useSpendConfirmation();
  return (
    <>
      <button onClick={() => spend.guard(quote, "Generate", run)}>go</button>
      {spend.dialog}
    </>
  );
}

const bigQuote: SpendQuote = { credits: 150, balance: 400, balanceAfter: 250, sufficient: true };
const smallQuote: SpendQuote = { credits: 20, balance: 400, balanceAfter: 380, sufficient: true };

it("runs a small action straight away", () => {
  const run = vi.fn();
  render(<Harness quote={smallQuote} run={run} />);
  fireEvent.click(screen.getByText("go"));
  expect(run).toHaveBeenCalledTimes(1);
  expect(screen.queryByTestId("dialog-spend-confirm")).toBeNull();
});

it("holds a big action until the itemised price is confirmed", () => {
  const run = vi.fn();
  render(<Harness quote={bigQuote} run={run} />);
  fireEvent.click(screen.getByText("go"));
  expect(run).not.toHaveBeenCalled();
  expect(screen.getByTestId("dialog-spend-confirm").textContent).toContain("150 credits");
  fireEvent.click(screen.getByTestId("button-spend-confirm"));
  expect(run).toHaveBeenCalledTimes(1);
});

it("does nothing when the big action is cancelled", () => {
  const run = vi.fn();
  render(<Harness quote={bigQuote} run={run} />);
  fireEvent.click(screen.getByText("go"));
  fireEvent.click(screen.getByTestId("button-spend-cancel"));
  expect(run).not.toHaveBeenCalled();
});

it("never gates a workspace that is not paying with credits", () => {
  state.credits.data.funded = false;
  const run = vi.fn();
  render(<Harness quote={bigQuote} run={run} />);
  fireEvent.click(screen.getByText("go"));
  expect(run).toHaveBeenCalledTimes(1);
});

it("labels quote lines in plain words, not rate keys", () => {
  render(
    <CreditQuoteSummary
      credits={42}
      balanceAfter={358}
      sufficient
      lines={[
        { rateKey: "video", quantity: 30, credits: 30 },
        { rateKey: "image", quantity: 4, credits: 12 },
      ]}
    />,
  );
  const text = screen.getByTestId("credit-quote-summary").textContent ?? "";
  expect(text).toContain("Video (per second)");
  expect(text).toContain("Scene images");
  expect(creditRateLabel("lipsync")).toBe("Lip sync (per second)");
});

it("says what a balance buys, priced from the live rate card", () => {
  expect(describeCreditValue(400, { videoCredits: 40, imageCredits: 3 })).toBe(
    "≈ 10 videos of 30s, or ≈ 133 images",
  );
  expect(describeCreditValue(0, { videoCredits: 40, imageCredits: 3 })).toBeNull();
  state.quotes = { video: { credits: 40 }, image: { credits: 3 } };
  render(<CreditUsageCard />);
  expect(screen.getByTestId("text-credit-value").textContent).toContain("≈ 10 videos of 30s");
});
