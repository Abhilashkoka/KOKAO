import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FeatureControlsCard } from "./feature-controls-card";

const updateFeature = vi.fn();
const features = [
  {
    feature: "videoGen",
    label: "Video Studio",
    description: "Master switch.",
    enabled: true,
  },
  {
    feature: "videoTextToVideo",
    label: "Video Studio — Text to Video",
    description: "Text clips.",
    enabled: true,
  },
  {
    feature: "videoAnimatePhoto",
    label: "Video Studio — Animate Photo",
    description: "Animated photos.",
    enabled: true,
  },
  {
    feature: "videoSlideshow",
    label: "Video Studio — Photo Slideshow",
    description: "Photo slideshows.",
    enabled: true,
  },
  {
    feature: "videoTopicToVideo",
    label: "Video Studio — Topic to Video",
    description: "Topic videos.",
    enabled: true,
  },
  {
    feature: "lipSync",
    label: "Lip-Synced Spokesperson Videos",
    description: "Existing spokesperson switch.",
    enabled: true,
  },
];

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../../test/apiClientMock");
  return createApiClientMock({
    useAdminListFeatureFlags: () => ({ data: features, isLoading: false }),
    useAdminUpdateFeatureFlag: () => ({
      mutate: updateFeature,
      isPending: false,
    }),
    useAdminGetAdsSettings: () => ({ data: { enabled: true }, isLoading: false }),
    useAdminUpdateAdsSettings: () => ({ mutate: vi.fn(), isPending: false }),
  });
});

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

function renderCard() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <FeatureControlsCard />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  updateFeature.mockClear();
});

describe("FeatureControlsCard Video Studio controls", () => {
  it("shows the master, four individual modes, and existing spokesperson switch", () => {
    renderCard();
    fireEvent.click(screen.getByTestId("toggle-feature-controls-card"));

    for (const feature of features) {
      expect(screen.getByTestId(`switch-feature-${feature.feature}`)).toBeTruthy();
      expect(screen.getByText(feature.label)).toBeTruthy();
    }
  });

  it("updates an individual mode without changing the master or spokesperson controls", () => {
    renderCard();
    fireEvent.click(screen.getByTestId("toggle-feature-controls-card"));
    fireEvent.click(screen.getByTestId("switch-feature-videoAnimatePhoto"));

    expect(updateFeature).toHaveBeenCalledTimes(1);
    expect(updateFeature.mock.calls[0][0]).toEqual({
      feature: "videoAnimatePhoto",
      data: { enabled: false },
    });
    expect(screen.getByTestId("switch-feature-videoGen")).toBeTruthy();
    expect(screen.getByTestId("switch-feature-lipSync")).toBeTruthy();
  });
});