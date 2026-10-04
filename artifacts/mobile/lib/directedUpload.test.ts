import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  platform: { OS: "web" },
  pick: vi.fn(), nativeUpload: vi.fn(),
}));
vi.mock("react-native", () => ({ Platform: mocks.platform }));
vi.mock("expo-document-picker", () => ({ getDocumentAsync: mocks.pick }));
vi.mock("expo-file-system/legacy", () => ({
  uploadAsync: mocks.nativeUpload, FileSystemUploadType: { BINARY_CONTENT: 0 },
}));
import { pickDirectedFiles, uploadDirectedFile } from "./directedUpload";

const picked = { uri: "file:///local/demo.mp4", name: "demo.mp4", size: 100, type: "video/mp4" };
const prepare = vi.fn();

describe("Director upload transport with local fixtures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.platform.OS = "web";
    prepare.mockResolvedValue({ uploadURL: "https://storage.example.test/upload", objectPath: "/objects/fixture" });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("limits selected files, infers missing MIME, and handles cancellation", async () => {
    mocks.pick.mockResolvedValue({ canceled: false, assets: [
      { uri: "file:///logo.PNG", name: "logo.PNG", size: 30 },
      { uri: "file:///demo.mp4", name: "demo.mp4", size: 20 },
    ] });
    expect(await pickDirectedFiles(1)).toEqual([
      { uri: "file:///logo.PNG", name: "logo.PNG", size: 30, type: "image/png", file: undefined },
    ]);
    expect(mocks.pick).toHaveBeenCalledWith(expect.objectContaining({ copyToCacheDirectory: true, multiple: false }));
    mocks.pick.mockResolvedValue({ canceled: true });
    expect(await pickDirectedFiles(3)).toEqual([]);
  });

  it("PUTs exact browser file bytes, returning only the server-owned path", async () => {
    const file = new Blob(["local fixture"], { type: "video/mp4" });
    const fetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetch);
    expect(await uploadDirectedFile({ ...picked, file }, prepare)).toBe("/objects/fixture");
    expect(prepare).toHaveBeenCalledWith({ name: picked.name, size: picked.size, contentType: picked.type });
    expect(fetch).toHaveBeenCalledWith("https://storage.example.test/upload", {
      method: "PUT", headers: { "Content-Type": "video/mp4" }, body: file,
    });
  });

  it("uploads native file URIs as binary and rejects failed HTTP responses", async () => {
    mocks.platform.OS = "ios";
    mocks.nativeUpload.mockResolvedValue({ status: 200 });
    expect(await uploadDirectedFile(picked, prepare)).toBe("/objects/fixture");
    expect(mocks.nativeUpload).toHaveBeenCalledWith("https://storage.example.test/upload", picked.uri, {
      httpMethod: "PUT", uploadType: 0, headers: { "Content-Type": "video/mp4" },
    });
    mocks.nativeUpload.mockResolvedValue({ status: 403 });
    await expect(uploadDirectedFile(picked, prepare)).rejects.toThrow("Upload failed");
  });

  it("rejects browser upload and preparation errors instead of marking assets ready", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    await expect(uploadDirectedFile({ ...picked, file: new Blob(["fixture"]) }, prepare)).rejects.toThrow("Upload failed");
    prepare.mockRejectedValue(new Error("Permission denied"));
    await expect(uploadDirectedFile(picked, prepare)).rejects.toThrow("Permission denied");
  });
});