import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReportAiError, claimStatusText } from "./report-ai-error";

const state = vi.hoisted(() => ({
  eligibility: {} as any,
  goodwill: {} as any,
  create: vi.fn(),
}));
vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  return createApiClientMock({
    useGetVideoJobErrorClaim: () => ({ data: state.eligibility }),
    useGetVideoJobGoodwill: () => ({ data: state.goodwill }),
    useCreateAiErrorClaim: () => ({ mutate: state.create, isPending: false }),
  });
});

function renderIt(onOpenSmartEdit = vi.fn()) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ReportAiError jobId={7} videoPath="/objects/1/v.mp4" onOpenSmartEdit={onOpenSmartEdit} />
    </QueryClientProvider>,
  );
  return onOpenSmartEdit;
}

beforeEach(() => {
  state.eligibility = { eligible: true, reason: null, windowDays: 7, claim: null };
  state.goodwill = { active: true, smartEditFreeAvailable: true, smartEditFreeSeconds: 3, imageRedosLeft: 0, monthlyBudgetLeft: 50 };
  state.create.mockReset();
});

it("is hidden when the guarantee does not apply", () => {
  state.eligibility = { eligible: false, reason: "off", windowDays: 7, claim: null };
  renderIt();
  expect(screen.queryByTestId("button-report-ai-error")).toBeNull();
});

it("offers the free Smart Edit fix first", () => {
  const onOpen = renderIt();
  fireEvent.click(screen.getByTestId("button-report-ai-error"));
  expect(screen.getByTestId("button-ai-error-fix").textContent).toContain("Fix it free");
  fireEvent.click(screen.getByTestId("button-ai-error-fix"));
  expect(onOpen).toHaveBeenCalled();
  expect(state.create).not.toHaveBeenCalled();
});

it("files a claim for the marked range", () => {
  renderIt();
  fireEvent.click(screen.getByTestId("button-report-ai-error"));
  fireEvent.click(screen.getByTestId("button-ai-error-claim-instead"));
  fireEvent.click(screen.getByTestId("radio-ai-error-garbled_text"));
  fireEvent.change(screen.getByTestId("input-ai-error-start"), { target: { value: "2" } });
  fireEvent.change(screen.getByTestId("input-ai-error-end"), { target: { value: "6.5" } });
  fireEvent.click(screen.getByTestId("button-ai-error-submit"));
  expect(state.create).toHaveBeenCalledWith(
    { jobId: 7, data: { category: "garbled_text", startSec: 2, endSec: 6.5, note: undefined } },
    expect.anything(),
  );
});

it("refuses a range shorter than half a second without calling the server", () => {
  renderIt();
  fireEvent.click(screen.getByTestId("button-report-ai-error"));
  fireEvent.click(screen.getByTestId("button-ai-error-claim-instead"));
  fireEvent.change(screen.getByTestId("input-ai-error-start"), { target: { value: "3" } });
  fireEvent.change(screen.getByTestId("input-ai-error-end"), { target: { value: "3.2" } });
  fireEvent.click(screen.getByTestId("button-ai-error-submit"));
  expect(screen.getByTestId("error-ai-error-claim")).toBeTruthy();
  expect(state.create).not.toHaveBeenCalled();
});

it("shows an existing claim's outcome instead of the button", () => {
  state.eligibility = {
    eligible: false,
    reason: "already",
    windowDays: 7,
    claim: { status: "approved", creditsRefunded: 12.5, decisionNote: null },
  };
  renderIt();
  expect(screen.getByTestId("text-ai-error-claim-status").textContent).toContain("Refunded 12.5 credits");
  expect(claimStatusText({ status: "rejected", decisionNote: "Change of mind", creditsRefunded: 0 } as never)).toContain(
    "Change of mind",
  );
});
