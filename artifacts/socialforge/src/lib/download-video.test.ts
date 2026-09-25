import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadVideo } from "./download-video";

const fetchMock = vi.fn();
const createObjectURL = vi.fn((_blob: Blob) => "blob:owned-video");
const revokeObjectURL = vi.fn();
let clicked: { href: string; filename: string }[];

beforeEach(() => {
  vi.useFakeTimers();
  clicked = [];
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("URL", Object.assign(class extends URL {}, { createObjectURL, revokeObjectURL }));
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push({ href: this.href, filename: this.download });
  });
});
afterEach(() => {
  vi.runAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("authenticated video download", () => {
  it("saves fetched video bytes via a Blob URL, never via private navigation", async () => {
    const bytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);
    fetchMock.mockResolvedValue(new Response(bytes, { headers: { "Content-Type": "video/mp4" } }));
    await downloadVideo("/objects/4/uploads/video.mp4", "kokao-video-42.mp4", "test-token");
    expect(fetchMock).toHaveBeenCalledWith("/api/storage/objects/4/uploads/video.mp4", {
      credentials: "include", headers: { Authorization: "Bearer test-token" },
    });
    const blob = createObjectURL.mock.calls[0]?.[0] as unknown as Blob;
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
    expect(clicked).toEqual([{ href: "blob:owned-video", filename: "kokao-video-42.mp4" }]);
    expect(document.querySelector("a[download]")).toBeNull();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:owned-video");
  });

  it.each([
    [401, /session has expired/],
    [403, /permission/],
    [404, /no longer available/],
    [500, /failed \(500\)/],
  ])("reports HTTP %s without downloading an error body", async (status, message) => {
    fetchMock.mockResolvedValue(new Response('{"error":"Failed"}', { status: status as number }));
    await expect(downloadVideo("/objects/4/video.mp4", "video.mp4", null)).rejects.toThrow(message as RegExp);
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(clicked).toEqual([]);
  });

  it.each(["https://other.example/video.mp4", "/objects/../secret", "/objects/4/%2e%2e/secret", "/objects/4/video?query"])(
    "rejects unsafe paths before sending credentials: %s", async (path) => {
      await expect(downloadVideo(path, "video.mp4", "test-token")).rejects.toThrow(/invalid storage path/);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("does not download a redirected sign-in page or empty file", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<html>Sign in</html>", { headers: { "Content-Type": "text/html" } }));
    await expect(downloadVideo("/objects/4/video.mp4", "video.mp4", null)).rejects.toThrow(/did not return a video/);
    fetchMock.mockResolvedValueOnce(new Response(null, { headers: { "Content-Type": "video/mp4" } }));
    await expect(downloadVideo("/objects/4/video.mp4", "video.mp4", null)).rejects.toThrow(/empty/);
    expect(clicked).toEqual([]);
  });
});