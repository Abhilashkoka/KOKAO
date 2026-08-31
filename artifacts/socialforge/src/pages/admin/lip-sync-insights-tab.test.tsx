import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const mockHook = vi.fn();

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../../test/apiClientMock");
  return createApiClientMock({
    useGetStudioLipSyncAnalytics: (...args: unknown[]) => mockHook(...args),
  });
});

import { LipSyncInsightsTab } from "./lip-sync-insights-tab";

beforeEach(() => {
  cleanup();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-31T12:00:00.000Z"));
  mockHook.mockReset();
  mockHook.mockReturnValue({
    data: {
      status: "available",
      groupBy: "workflow",
      minimumGroupSize: 5,
      groups: [
        {
          group: "guided_story",
          status: "available",
          toggleEnabled: 8,
          accepted: 5,
          eligible: 4,
          skipped: 1,
          succeeded: 3,
          failed: 1,
          recovered: 1,
          finished: 4,
          finishRate: 0.8,
        },
        { group: "animate_photo", status: "suppressed" },
      ],
    },
    isLoading: false,
    isError: false,
  });
});

describe("LipSyncInsightsTab", () => {
  it("renders available funnel outcomes and hides small-group counts", () => {
    render(<LipSyncInsightsTab />);
    expect(screen.getByText("Guided Story")).toBeTruthy();
    expect(screen.getByText("80.0%")).toBeTruthy();
    expect(screen.getByText("Finished")).toBeTruthy();
    expect(screen.getByText("Hidden — fewer than 5 accepted submissions")).toBeTruthy();
    expect(screen.queryByText("4 accepted submissions")).toBeNull();
  });

  it("requests each supported coarse grouping", () => {
    render(<LipSyncInsightsTab />);
    const trigger = screen.getByRole("tab", { name: "Funding rail" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter", code: "Enter" });
    expect(mockHook).toHaveBeenLastCalledWith({
      groupBy: "funding_rail",
      from: "2026-08-01T12:00:00.000Z",
      to: "2026-08-31T12:00:00.000Z",
    });
  });

  it("propagates preset and custom ranges and rejects unsafe custom windows", () => {
    render(<LipSyncInsightsTab />);
    fireEvent.click(screen.getByRole("button", { name: "Last 7 days" }));
    expect(mockHook).toHaveBeenLastCalledWith({
      groupBy: "workflow",
      from: "2026-08-24T12:00:00.000Z",
      to: "2026-08-31T12:00:00.000Z",
    });

    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-08-20" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-08-25" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply custom range" }));
    const latest = mockHook.mock.calls.at(-1)?.[0];
    expect(latest.groupBy).toBe("workflow");
    expect(latest.from).toBe(new Date(2026, 7, 20, 0, 0, 0, 0).toISOString());
    expect(latest.to).toBe(new Date(2026, 7, 25, 23, 59, 59, 999).toISOString());

    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-08-30" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-08-20" } });
    expect(
      (screen.getByRole("button", { name: "Apply custom range" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText(/Choose dates in order/)).toBeTruthy();
  });

  it("explains empty and insufficient data states", () => {
    mockHook.mockReturnValueOnce({
      data: { status: "empty", groupBy: "workflow", minimumGroupSize: 5, groups: [] },
      isLoading: false,
      isError: false,
    });
    const view = render(<LipSyncInsightsTab />);
    expect(screen.getByText(/No optional lip-sync usage was recorded/)).toBeTruthy();

    view.unmount();
    mockHook.mockReturnValueOnce({
      data: {
        status: "insufficient",
        groupBy: "workflow",
        minimumGroupSize: 5,
        groups: [{ group: "guided_story", status: "suppressed" }],
      },
      isLoading: false,
      isError: false,
    });
    render(<LipSyncInsightsTab />);
    expect(screen.getByText(/More usage is needed/)).toBeTruthy();
  });
});