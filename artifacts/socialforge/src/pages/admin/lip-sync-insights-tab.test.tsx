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
    expect(mockHook).toHaveBeenLastCalledWith({ groupBy: "funding_rail" });
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