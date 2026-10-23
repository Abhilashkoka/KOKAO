import { afterEach, describe, expect, it, vi } from "vitest";
import { UploadError, uploadErrorMessage, uploadToStorage } from "./upload-file";

const file = (size = 10, type = "image/jpeg") =>
  Object.defineProperty(new File(["x"], "look.jpg", { type }), "size", { value: size });

describe("uploadToStorage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("retries the storage upload once with a fresh link", async () => {
    const requestUrl = vi
      .fn()
      .mockResolvedValueOnce({ uploadURL: "https://s/1", objectPath: "/objects/a" })
      .mockResolvedValueOnce({ uploadURL: "https://s/2", objectPath: "/objects/b" });
    const put = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValueOnce({ ok: true });
    vi.stubGlobal("fetch", put);
    await expect(uploadToStorage(requestUrl, file())).resolves.toEqual({ objectPath: "/objects/b" });
    expect(put).toHaveBeenCalledTimes(2);
  });

  it("says why when storage keeps refusing", async () => {
    const requestUrl = vi.fn().mockResolvedValue({ uploadURL: "https://s/1", objectPath: "/objects/a" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 403 }));
    const error = await uploadToStorage(requestUrl, file()).catch((e) => e);
    expect(error).toBeInstanceOf(UploadError);
    expect(uploadErrorMessage(error)).toContain("403");
  });

  it("rejects very large files before uploading", async () => {
    const requestUrl = vi.fn();
    const error = await uploadToStorage(requestUrl, file(40 * 1024 * 1024)).catch((e) => e);
    expect(uploadErrorMessage(error)).toContain("under 25 MB");
    expect(requestUrl).not.toHaveBeenCalled();
  });

  it("shows the server's own message and a sign-in hint", () => {
    expect(uploadErrorMessage({ data: { error: "Storage is not configured" } })).toBe("Storage is not configured");
    expect(uploadErrorMessage({ status: 401 })).toContain("sign in again");
  });
});
