import { describe, it, expect, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { createHash } from "node:crypto";
const assetData = vi.hoisted(() => ({ bytes: Buffer.alloc(0), mime: "image/png" }));
vi.mock("../objectStorage", () => ({
  ObjectStorageService: class {
    async getObjectEntityFile() {
      return {
        getMetadata: async () => [{ contentType: assetData.mime, size: assetData.bytes.length }],
        download: async () => [assetData.bytes],
      };
    }
  },
}));
vi.mock("../brandKit/service", () => ({ loadActivePayload: vi.fn(async () => null) }));
vi.mock("../characters", () => ({ getCharacterDetail: vi.fn(), resolveOutfit: vi.fn(), loadReferenceImage: vi.fn() }));
vi.mock("./personalLikenessVideo", () => ({ freezePersonalLikenessVideoConsent: vi.fn(), assertFrozenPersonalLikenessVideoConsent: vi.fn() }));
vi.mock("../textGen", () => ({ getTextGenClient: vi.fn() }));
vi.mock("../aiCost", () => ({ usageAccountingParams: vi.fn(() => ({})) }));
vi.mock("@workspace/db", () => ({ db: {}, tenantsTable: {} }));
import { validateDirectedInput, freezeDirectedVideo, directorSystemPrompt, finishDirectedVideo } from "./directedVideo";
import { loadActivePayload } from "../brandKit/service";

describe("single-generation direction boundaries", () => {
  it("freezes an explicitly selected logo without mutating the frozen outro object", async () => {
    assetData.bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: "red" } }).png().toBuffer();
    vi.mocked(loadActivePayload).mockResolvedValueOnce({
      payload: {
        identity: { brand_name: "Test", tagline: "" },
        colors: { primary: [{ hex: "#123456" }] },
        logos: { primary: { url: "/api/storage/objects/1/logo.png" } },
        voice: {},
      },
    } as never);
    const result = await freezeDirectedVideo({ ending: "logo" }, 1, 30, 1);
    expect(result.outro.enabled).toBe(true);
    expect(result.outro.logoSha256).toBe(createHash("sha256").update(assetData.bytes).digest("hex"));
  });
  it("accepts a topic with all optional branding absent", async () => {
    const result = await freezeDirectedVideo({}, 1, 30);
    expect(result.directed.assets).toEqual([]);
    expect(result.directed.brandContext).toBe("");
    expect(result.outro.enabled).toBe(false);
  });
  it("rejects hidden server fields and unknown nested keys", () => {
    expect(() => validateDirectedInput({ compiledPrompt: "bypass" }, 30)).toThrow();
    expect(() => validateDirectedInput({ assets: [{ objectPath: "/objects/1/a", startSec: 0, endSec: 2, placement: "corner", sha256: "forged" }] }, 30)).toThrow();
  });
  it("rejects invalid windows, oversized overlays and unsupported durations", () => {
    for (const [startSec, endSec] of [[5, 2], [-1, 3], [0, 31], [0, NaN]]) {
      expect(() => validateDirectedInput({ overlays: [{ text: "hello", startSec, endSec }] }, 30)).toThrow();
    }
    expect(() => validateDirectedInput({ overlays: [{ text: "a".repeat(161), startSec: 0, endSec: 3 }] }, 30)).toThrow();
    expect(() => validateDirectedInput({}, 60)).toThrow();
  });
  it("rejects foreign asset paths and unavailable explicit branding, rather than dropping them", async () => {
    await expect(freezeDirectedVideo({ assets: [{ objectPath: "/objects/2/image", startSec: 0, endSec: 2, placement: "corner" }] }, 1, 30)).rejects.toThrow();
    await expect(freezeDirectedVideo({ ending: "logo" }, 1, 30)).rejects.toThrow();
    await expect(freezeDirectedVideo({ brandImage: "primary" }, 1, 30)).rejects.toThrow();
    await expect(freezeDirectedVideo({}, 1, 30, 123)).rejects.toThrow();
  });
  it("keeps exact assets local and avoids unsupported audio promises", () => {
    expect(directorSystemPrompt(30, false, true)).toContain("no native audio");
    expect(directorSystemPrompt(30, true, true)).toContain("approved character reference");
    expect(directorSystemPrompt(30, true, false)).toContain("do not redraw");
  });
  it("locally renders literal overlay characters while preserving duration and audio", async () => {
    const dir = await mkdtemp(join(tmpdir(), "directed-test-"));
    try {
      execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=360x640:r=24:d=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:v", "libx264", "-c:a", "aac", join(dir, "in.mp4")]);
      const { directed } = await freezeDirectedVideo({ overlays: [{ text: "100% real: KOKAO's offer", startSec: 0, endSec: 1.8 }] }, 1, 2);
      const result = await finishDirectedVideo(await readFile(join(dir, "in.mp4")), directed, 1);
      const { writeFile } = await import("node:fs/promises");
      await writeFile(join(dir, "out.mp4"), result);
      const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", join(dir, "out.mp4")], { encoding: "utf8" }));
      expect(Number(probe.format.duration)).toBeLessThan(2.2);
      expect(probe.streams.some((s: { codec_type: string }) => s.codec_type === "audio")).toBe(true);
      expect(probe.streams[0].width).toBe(360);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 30000);
  it("fits an exact image only in its chosen interval and rejects changed bytes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "directed-asset-test-"));
    try {
      assetData.bytes = await sharp({ create: { width: 100, height: 100, channels: 3, background: "#ff0000" } }).png().toBuffer();
      const { directed } = await freezeDirectedVideo({ assets: [{ objectPath: "/objects/1/red.png", startSec: 0, endSec: 1, placement: "full_frame" }] }, 1, 2);
      expect(directed.assets[0]?.sha256).toBe(createHash("sha256").update(assetData.bytes).digest("hex"));
      execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=360x640:r=24:d=2", "-c:v", "libx264", join(dir, "in.mp4")]);
      const source = await readFile(join(dir, "in.mp4"));
      const result = await finishDirectedVideo(source, directed, 1);
      const { writeFile } = await import("node:fs/promises");
      await writeFile(join(dir, "out.mp4"), result);
      for (const [time, channel] of [["0.5", 0], ["1.5", 2]] as const) {
        const frame = execFileSync("ffmpeg", ["-v", "error", "-ss", time, "-i", join(dir, "out.mp4"), "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"]);
        const pixel = await sharp(frame).extract({ left: 180, top: 320, width: 1, height: 1 }).raw().toBuffer();
        expect(pixel[channel]).toBeGreaterThan(200);
      }
      assetData.bytes = await sharp({ create: { width: 100, height: 100, channels: 3, background: "#00ff00" } }).png().toBuffer();
      await expect(finishDirectedVideo(source, directed, 1)).rejects.toThrow(/changed/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 30000);
});