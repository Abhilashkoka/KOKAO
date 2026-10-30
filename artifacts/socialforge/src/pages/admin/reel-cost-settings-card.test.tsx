import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

const save = vi.fn();

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../../test/apiClientMock");
  return createApiClientMock({
    useAdminGetReelCostSettings: () => ({
      isLoading: false,
      data: {
        settings: {
          tryOnImageQuality: "medium",
          reelResolution: "720p",
          defaultBars: 1,
          heroModeEnabled: true,
          defaultReelStyle: "hero",
          updatedAt: "2026-10-30T05:00:00.000Z",
          updatedBy: "admin@kokao.in",
        },
        history: [
          {
            at: "2026-10-30T05:00:00.000Z",
            by: "admin@kokao.in",
            from: JSON.stringify({ reelResolution: "1080p", defaultBars: 2 }),
            to: JSON.stringify({ reelResolution: "720p", defaultBars: 1 }),
          },
        ],
      },
    }),
    useAdminUpdateReelCostSettings: () => ({ mutate: save, isPending: false }),
  });
});

const { ReelCostSettingsCard } = await import("./reel-cost-settings-card");

describe("Reel cost settings card", () => {
  it("shows who changed what, and saves the form", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ReelCostSettingsCard />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("reel-cost-history").textContent).toContain(
      "Reel resolution: 1080p → 720p · Bars per look: 2 → 1",
    );
    fireEvent.click(screen.getByTestId("reel-cost-hero"));
    fireEvent.click(screen.getByTestId("reel-cost-save"));
    // Turning Hero off moves the default away from it.
    expect(save.mock.calls[0][0].data).toMatchObject({
      heroModeEnabled: false,
      defaultReelStyle: "video",
      reelResolution: "720p",
    });
  });
});
