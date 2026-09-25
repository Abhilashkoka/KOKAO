import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { VideoDownloadButton } from "./video-download-button";

const mocks = vi.hoisted(() => ({
  getToken: vi.fn(),
  download: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("@clerk/react", () => ({ useAuth: () => ({ getToken: mocks.getToken }) }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/lib/download-video", () => ({ downloadVideo: mocks.download }));
beforeEach(() => {
  vi.resetAllMocks();
  mocks.getToken.mockResolvedValue("test-token");
});
afterEach(cleanup);

it("shows busy state, prevents duplicate requests, and passes the current token", async () => {
  let finish!: () => void;
  mocks.download.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
  render(<VideoDownloadButton objectPath="/objects/4/video.mp4" filename="video-4.mp4" testId="download" />);
  fireEvent.click(screen.getByTestId("download"));
  fireEvent.click(screen.getByTestId("download"));
  expect(screen.getByTestId("download").getAttribute("aria-busy")).toBe("true");
  expect(screen.getByText("Downloading…")).toBeTruthy();
  await waitFor(() => expect(mocks.download).toHaveBeenCalledWith("/objects/4/video.mp4", "video-4.mp4", "test-token"));
  expect(mocks.download).toHaveBeenCalledTimes(1);
  finish();
  await waitFor(() => expect(screen.getByTestId("download").getAttribute("aria-busy")).toBe("false"));
});

it("shows actionable errors and enables retry", async () => {
  mocks.download.mockRejectedValue(new Error("Your session has expired. Sign in again, then retry the download."));
  render(<VideoDownloadButton objectPath="/objects/4/video.mp4" filename="video-4.mp4" testId="download" />);
  fireEvent.click(screen.getByTestId("download"));
  await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({
    title: "Could not download video",
    description: expect.stringContaining("Sign in again"),
    variant: "destructive",
  })));
  expect((screen.getByTestId("download") as HTMLButtonElement).disabled).toBe(false);
});