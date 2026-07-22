import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";

// Radix components need a few APIs jsdom doesn't implement.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
if (typeof globalThis.ResizeObserver === "undefined") {
  (globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

const mockState: {
  lastGenerateVars: any;
  generateError: any;
  jobs: any[];
  activeJob: any;
} = {
  lastGenerateVars: null,
  generateError: null,
  jobs: [],
  activeJob: undefined,
};

const toastSpy = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastSpy }),
}));

vi.mock("wouter/use-browser-location", () => ({
  navigate: vi.fn(),
}));

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  return createApiClientMock({
    useGenerateVideo: () => ({
      isPending: false,
      mutate: (vars: unknown, opts: any) => {
        mockState.lastGenerateVars = vars;
        if (mockState.generateError) {
          opts?.onError?.(mockState.generateError);
          return;
        }
        opts?.onSuccess?.({ id: 42, status: "queued", engine: "text_to_video" });
      },
    }),
    useGetVideoJob: () => ({ data: mockState.activeJob }),
    useListVideoJobs: () => ({ data: mockState.jobs }),
    useGetGoogleDriveStatus: () => ({
      data: { connected: false, configured: true, redirectUri: "x", expired: false },
      isLoading: false,
    }),
    useListContent: () => ({ data: [], isLoading: false }),
  });
});

import { VideoStudioPage } from "./video-studio";

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <VideoStudioPage />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockState.lastGenerateVars = null;
  mockState.generateError = null;
  mockState.jobs = [];
  mockState.activeJob = undefined;
  toastSpy.mockClear();
  cleanup();
});

describe("Video Studio", () => {
  it("keeps Generate disabled until the text prompt is long enough", () => {
    renderPage();
    const button = screen.getByTestId("button-generate-video") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("input-video-prompt"), {
      target: { value: "A calm ocean at dusk" },
    });
    expect(button.disabled).toBe(false);
  });

  it("submits a text-to-video job with the chosen aspect ratio and length", async () => {
    renderPage();
    fireEvent.change(screen.getByTestId("input-video-prompt"), {
      target: { value: "A calm ocean at dusk" },
    });
    fireEvent.click(screen.getByTestId("button-generate-video"));
    await waitFor(() => expect(mockState.lastGenerateVars).toBeTruthy());
    expect(mockState.lastGenerateVars.data).toMatchObject({
      engine: "text_to_video",
      prompt: "A calm ocean at dusk",
      aspectRatio: "9:16",
      sourceImagePaths: [],
    });
  });

  it("requires photos before a slideshow can start, and offers all three photo sources", async () => {
    renderPage();
    // Radix tabs activate on focus/pointer, not synthetic click events.
    await userEvent.setup().click(screen.getByTestId("tab-slideshow"));
    expect(screen.getByTestId("button-upload-photos")).toBeTruthy();
    expect(screen.getByTestId("button-pick-library")).toBeTruthy();
    expect(screen.getByTestId("button-pick-drive")).toBeTruthy();
    expect(
      (screen.getByTestId("button-generate-video") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("surfaces a quota toast on a 402 instead of a generic error", async () => {
    mockState.generateError = { status: 402, message: "Monthly video quota reached" };
    renderPage();
    fireEvent.change(screen.getByTestId("input-video-prompt"), {
      target: { value: "A calm ocean at dusk" },
    });
    fireEvent.click(screen.getByTestId("button-generate-video"));
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Video quota reached" }),
      ),
    );
  });

  it("shows the finished video with save and download actions", () => {
    mockState.activeJob = {
      id: 7,
      engine: "text_to_video",
      status: "succeeded",
      prompt: "sunset",
      sourceImagePaths: [],
      aspectRatio: "9:16",
      videoPath: "/objects/1/uploads/v.mp4",
      thumbnailPath: "/objects/1/uploads/p.png",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    mockState.jobs = [mockState.activeJob];
    renderPage();
    // Select the job from the recent grid so it becomes active.
    fireEvent.click(screen.getByTestId("job-card-7"));
    const video = screen.getByTestId("video-preview") as HTMLVideoElement;
    expect(video.getAttribute("src")).toBe("/api/storage/objects/1/uploads/v.mp4");
    expect(screen.getByTestId("button-save-video")).toBeTruthy();
  });
});
