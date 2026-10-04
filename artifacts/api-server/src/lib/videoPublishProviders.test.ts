import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("./platformFetch", () => ({ platformFetch: vi.fn() }));
vi.mock("./videoPublishMedia", () => ({ stageVideo: vi.fn(async () => ({ size: 12, localPath: "/unused", cleanup: vi.fn() })) }));
vi.mock("./objectStorage", () => ({ ObjectStorageService: class { getSignedDownloadURL = vi.fn(async () => "https://storage.example/signed"); } }));
vi.mock("./secretCrypto", () => ({ encryptJson: JSON.stringify, decryptJson: JSON.parse }));
import { platformFetch } from "./platformFetch";
import { driveInstagram, driveFacebook, driveYoutube, validateYoutubeSession, youtubeResumeOffset, type VideoUpload } from "./videoPublishProviders";
import { validateVideoMetadata } from "./videoPublishValidation";
const fetchMock = vi.mocked(platformFetch);
const row = (patch: Partial<VideoUpload> = {}): VideoUpload => ({
  id: 1, tenantId: 10, contentItemId: 20, platform: "instagram", videoPath: "/objects/10/test",
  metadata: { destination: "instagram", format: "reel", title: "Reviewed", description: "Exact reviewed copy", privacy: "public", madeForKids: false },
  state: "queued", externalId: null, containerId: null, encryptedSession: null, accountId: "123", error: null, permalink: null, createdAt: new Date(), updatedAt: new Date(), lastAttemptAt: new Date(), ...patch,
});
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
beforeEach(() => vi.clearAllMocks());
describe("native video provider contracts", () => {
  it.each(["instagram", "facebook", "youtube"])("restores a rejected %s create for reconnect without weakening timeout fences", async platform => {
    const upload = row({ platform });
    const save = vi.fn(async (patch: Partial<VideoUpload>) => { Object.assign(upload, patch); });
    fetchMock.mockResolvedValueOnce(response({ error: { code: 190 } }, 401));
    const drive = () => platform === "instagram" ? driveInstagram(upload, "t", "123", save) : platform === "facebook" ? driveFacebook(upload, "t", "123", save) : driveYoutube(upload, "t", save);
    await expect(drive()).rejects.toThrow("Reconnect");
    expect(upload.state).toBe("queued");
    fetchMock.mockRejectedValueOnce(new Error("lost response"));
    await expect(drive()).rejects.toThrow("lost response");
    expect(upload.state).toBe("creating");
    await expect(drive()).rejects.toThrow(/interrupted/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it.each([190, 10, 200, 299])("retries an explicitly rejected Instagram publication (code %s) after reconnect using the same container", async code => {
    const upload = row({ containerId: "original", state: "processing" });
    const save = vi.fn(async (patch: Partial<VideoUpload>) => { Object.assign(upload, patch); });
    fetchMock.mockResolvedValueOnce(response({ status_code: "FINISHED" })).mockResolvedValueOnce(response({ error: { code } }, 400));
    await expect(driveInstagram(upload, "t", "123", save)).rejects.toThrow("Reconnect");
    expect(upload.state).toBe("processing");
    fetchMock.mockResolvedValueOnce(response({ status_code: "FINISHED" })).mockResolvedValueOnce(response({ id: "published" }));
    await driveInstagram(upload, "new-token", "123", save);
    expect(upload.externalId).toBe("published");
    expect((fetchMock.mock.calls[3][1]?.body as URLSearchParams).get("creation_id")).toBe("original");
  });
  it.each([10, 200])("restores a Meta create rejected with HTTP 400 code %s", async code => {
    fetchMock.mockResolvedValueOnce(response({ error: { code } }, 400));
    const save = vi.fn();
    await expect(driveInstagram(row(), "t", "123", save)).rejects.toThrow("Reconnect");
    expect(save).toHaveBeenLastCalledWith({ state: "queued" });
  });
  it("creates an Instagram Reel from the owned video, not a thumbnail", async () => {
    fetchMock.mockResolvedValueOnce(response({ id: "container" }));
    const save = vi.fn();
    await driveInstagram(row(), "token", "123", save);
    expect(save.mock.calls[0][0]).toEqual({ state: "creating" });
    const body = fetchMock.mock.calls[0][1]?.body as URLSearchParams;
    expect(body.get("media_type")).toBe("REELS");
    expect(body.get("caption")).toBe("Exact reviewed copy");
    expect(body.get("image_url")).toBeNull();
    expect(save).toHaveBeenLastCalledWith({ containerId: "container", state: "processing" });
  });
  it("does not publish a processing Instagram container", async () => {
    fetchMock.mockResolvedValueOnce(response({ status_code: "IN_PROGRESS" }));
    await driveInstagram(row({ containerId: "c", state: "processing" }), "t", "123", vi.fn());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("reconciles a lost Instagram commit without another write", async () => {
    fetchMock.mockResolvedValueOnce(response({ status_code: "PUBLISHED" }));
    const save = vi.fn();
    await driveInstagram(row({ containerId: "c", state: "committing" }), "t", "123", save);
    expect(save).toHaveBeenCalledWith({ state: "published" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("never repeats an ambiguous create", async () => {
    await expect(driveFacebook(row({ platform: "facebook", state: "creating" }), "t", "123", vi.fn())).rejects.toThrow("interrupted");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("Facebook ready is not published", async () => {
    fetchMock.mockResolvedValueOnce(response({ status: { video_status: "ready", uploading_phase: { status: "completed" }, processing_phase: { status: "completed" } } })).mockResolvedValueOnce(response({ success: true }));
    const save = vi.fn();
    await driveFacebook(row({ externalId: "44", state: "processing", platform: "facebook" }), "t", "123", save);
    expect(save).toHaveBeenCalledWith({ state: "committing" });
    expect(save).not.toHaveBeenCalledWith(expect.objectContaining({ state: "published" }));
  });
  it("YouTube processing stays processing and respects applied visibility", async () => {
    const save = vi.fn();
    fetchMock.mockResolvedValueOnce(response({ items: [{ status: { uploadStatus: "uploaded" }, processingDetails: { processingStatus: "processing" } }] }));
    await driveYoutube(row({ externalId: "yt", platform: "youtube" }), "t", save);
    expect(save).toHaveBeenCalledWith({ state: "processing" });
    fetchMock.mockResolvedValueOnce(response({ items: [{ status: { uploadStatus: "processed", privacyStatus: "private" } }] }));
    await driveYoutube(row({ externalId: "yt", platform: "youtube" }), "t", save);
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ state: "published", error: expect.stringContaining("private") }));
  });
  it("resumes an already completed YouTube transfer by querying the session", async () => {
    fetchMock.mockResolvedValueOnce(response({ id: "existing" }));
    const save = vi.fn();
    await driveYoutube(row({ platform: "youtube", state: "uploading", encryptedSession: JSON.stringify({ url: "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=test", size: 12 }) }), "t", save);
    expect(fetchMock.mock.calls[0][1]?.headers).toEqual(expect.objectContaining({ "Content-Range": "bytes */12" }));
    expect(save).toHaveBeenCalledWith({ externalId: "existing", state: "processing" });
  });
  it("rejects credential redirection and malformed resume offsets", () => {
    expect(() => validateYoutubeSession("https://evil.example/upload/youtube/v3/videos")).toThrow();
    expect(() => youtubeResumeOffset(new Response(null, { headers: { range: "bytes=0-99" } }), 12)).toThrow();
    expect(youtubeResumeOffset(new Response(null, { headers: { range: "bytes=0-7" } }), 12)).toBe(8);
  });
  it("blocks unsupported or mismatched destinations and invalid YouTube copy", () => {
    expect(validateVideoMetadata("twitter", row().metadata)).toMatch(/only/);
    expect(validateVideoMetadata("youtube", row().metadata)).toMatch(/Review/);
    expect(validateVideoMetadata("youtube", { ...row().metadata, destination: "youtube", format: "video", title: "x".repeat(101) })).toMatch(/title/);
  });
  it("does not expose raw revoked-credential responses", async () => {
    fetchMock.mockResolvedValueOnce(response({ error: { message: "secret", code: 190 } }, 401));
    await expect(driveInstagram(row(), "t", "123", vi.fn())).rejects.toThrow("Reconnect");
  });
});