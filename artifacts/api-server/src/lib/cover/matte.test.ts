import { describe, it, expect, beforeEach, vi } from "vitest";
import sharp from "sharp";
const fetchMock = vi.fn(), keyMock = vi.fn(), imagesEdit = vi.fn();
vi.mock("../webFetch", () => ({ assertPublicHost: vi.fn(async () => {}) }));
vi.mock("../imageGen/types", async importOriginal => ({
  ...await importOriginal<typeof import("../imageGen/types")>(),
  imageGenFetch: (...args: unknown[]) => fetchMock(...args),
}));
vi.mock("../videoGen", () => ({
  getVideoGenProviderDef: () => ({ id: "replicate", envKey: "REPLICATE_API_TOKEN" }),
  resolveVideoGenApiKey: (...args: unknown[]) => keyMock(...args),
}));
vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: { images: { edit: (...a: unknown[]) => imagesEdit(...a) } }, toFile: async (buf: Buffer) => buf,
}));
import { extractSubjectMatte } from "./matte";
const SOURCE = await sharp({ create: { width: 300, height: 400, channels: 3, background: "#555" } }).png().toBuffer();
const CUTOUT = await sharp(Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="150" height="200"><circle cx="75" cy="100" r="50" fill="#fff"/></svg>'
)).png().toBuffer();
const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
beforeEach(() => { fetchMock.mockReset(); keyMock.mockReset(); imagesEdit.mockReset(); });
describe("extractSubjectMatte", () => {
  it("resolves the Replicate version and scales alpha to source dimensions", async () => {
    keyMock.mockResolvedValue("test-key");
    fetchMock.mockResolvedValueOnce(json({ latest_version: { id: "v123" } }))
      .mockResolvedValueOnce(json({ status: "succeeded", output: "https://replicate.delivery/out.png" }))
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => CUTOUT });
    const result = await extractSubjectMatte(SOURCE);
    expect(result?.provider).toBe("replicate");
    expect(fetchMock.mock.calls[1]![0]).toBe("https://api.replicate.com/v1/predictions");
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body).version).toBe("v123");
    expect(await sharp(result!.matte).metadata()).toMatchObject({ width: 300, height: 400, channels: 1 });
    const raw = await sharp(result!.matte).extractChannel(0).raw().toBuffer();
    expect(raw[200 * 300 + 150]).toBeGreaterThan(200); expect(raw[5 * 300 + 5]).toBeLessThan(20);
  });
  it("falls back to built-in when Replicate fails", async () => {
    keyMock.mockResolvedValue("test-key");
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => "boom", json: async () => ({}) });
    imagesEdit.mockResolvedValue({ data: [{ b64_json: CUTOUT.toString("base64") }] });
    const result = await extractSubjectMatte(SOURCE);
    expect(result?.provider).toBe("openai");
    expect(await sharp(result!.matte).metadata()).toMatchObject({ width: 300, height: 400 });
  });
  it("returns null when no provider can produce a matte", async () => {
    keyMock.mockResolvedValue(null); imagesEdit.mockRejectedValue(new Error("moderation_blocked"));
    await expect(extractSubjectMatte(SOURCE)).resolves.toBeNull();
  });
});