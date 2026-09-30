import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

const objects = vi.hoisted(() => new Map<string, { data: Buffer; mime: string }>());
vi.mock("../objectStorage", () => ({
  ObjectStorageService: class {
    async getObjectEntityFile(path: string) {
      const entry = objects.get(path);
      if (!entry) throw new Error("Object not found");
      return {
        getMetadata: async () => [{ size: entry.data.length, contentType: entry.mime }],
        download: async () => [entry.data],
      };
    }
  },
}));

import {
  applyBrandOutro, DISABLED_BRAND_OUTRO, validateBrandOutroSettings,
  verifyBrandOutroAssets, resolveBrandOutroSnapshot,
} from "./brandOutro";
import type { BrandKitPayload } from "@workspace/db";

function ffmpeg(args: string[]): void {
  execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { timeout: 30_000 });
}
function duration(file: string): number {
  return Number(execFileSync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file,
  ], { encoding: "utf8" }).trim());
}
function audioRms(file: string, start: number): number {
  const pcm = execFileSync("ffmpeg", [
    "-v", "error", "-ss", String(start), "-i", file,
    "-t", "0.3", "-vn", "-ac", "1", "-ar", "8000", "-f", "s16le", "pipe:1",
  ], { timeout: 15_000 });
  if (!pcm.length) throw new Error("Missing decoded audio");
  let sum = 0;
  for (let i = 0; i < pcm.length; i += 2) sum += pcm.readInt16LE(i) ** 2;
  return Math.sqrt(sum / (pcm.length / 2));
}
function frameCenterRgb(file: string, start: number): number[] {
  const rgb = execFileSync("ffmpeg", [
    "-v", "error", "-ss", String(start), "-i", file, "-frames:v", "1",
    "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
  ], { timeout: 15_000 });
  return [...rgb.subarray(0, 3)];
}

const settings = {
  enabled: true, mode: "preset", preset: "fade", duration_seconds: 2,
  background_color: "#112233", clip_path: null,
} as const;
const logoPath = "/objects/23/uploads/logo";
const clipPath = "/objects/23/uploads/clip";

describe("brand video outro", () => {
  it("keeps legacy/disabled kits off and rejects invalid and foreign paths", async () => {
    expect(await resolveBrandOutroSnapshot(23, null)).toEqual(DISABLED_BRAND_OUTRO);
    expect(validateBrandOutroSettings(undefined, 23, null)).toEqual(DISABLED_BRAND_OUTRO);
    expect(validateBrandOutroSettings(settings, 23, "/api/storage/objects/23/uploads/logo").logoPath).toBe(logoPath);
    expect(() => validateBrandOutroSettings(settings, 23, "/api/storage/objects/24/uploads/logo")).toThrow("tenant-owned");
    expect(() => validateBrandOutroSettings(settings, 23, "https://example.com/logo.png")).toThrow("tenant-owned");
    expect(() => validateBrandOutroSettings(settings, 23, null)).toThrow("primary logo");
    expect(() => validateBrandOutroSettings({ ...settings, duration_seconds: 9 }, 23, logoPath)).toThrow("Invalid");
    expect(() => validateBrandOutroSettings({ ...settings, background_color: "red" }, 23, logoPath)).toThrow("Invalid");
    expect(() => validateBrandOutroSettings({ ...settings, mode: "upload", clip_path: "/objects/24/uploads/clip" }, 23, logoPath)).toThrow("tenant-owned");
    expect(() => validateBrandOutroSettings({ ...settings, mode: "upload", clip_path: null }, 23, logoPath)).toThrow("uploaded");
  });

  it("checks the actual uploaded container and logo, not just client MIME", async () => {
    objects.set(clipPath, { data: Buffer.from("not video"), mime: "video/mp4" });
    const payload = {
      logos: { primary: { url: logoPath, type: "primary" } },
      video_outro: { ...settings, mode: "upload", clip_path: clipPath },
    } as BrandKitPayload;
    await expect(verifyBrandOutroAssets(payload, 23)).rejects.toThrow();
    objects.set(logoPath, { data: Buffer.from("not image"), mime: "image/png" });
    payload.video_outro = { ...settings };
    await expect(verifyBrandOutroAssets(payload, 23)).rejects.toThrow();
  });

  it.each([0.5, 11])("rejects a real but out-of-range %ss MP4", async (seconds) => {
    const dir = mkdtempSync(join(tmpdir(), "outro-duration-test-"));
    try {
      ffmpeg(["-f", "lavfi", "-i", `color=c=blue:s=32x32:r=10:d=${seconds}`,
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", join(dir, "clip.mp4")]);
      objects.set(clipPath, { data: readFileSync(join(dir, "clip.mp4")), mime: "video/mp4" });
      const payload = {
        logos: { primary: null },
        video_outro: { ...settings, mode: "upload", clip_path: clipPath },
      } as BrandKitPayload;
      await expect(verifyBrandOutroAssets(payload, 23)).rejects.toThrow("1–10 seconds");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(["fade", "zoom", "slide"] as const)("renders a %s logo outro after video while keeping source audio", async (preset) => {
    const dir = mkdtempSync(join(tmpdir(), "outro-test-"));
    try {
      ffmpeg(["-f", "lavfi", "-i", "color=c=red:s=160x90:r=30:d=1.3",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=1.3",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", join(dir, "in.mp4")]);
      objects.set(logoPath, { data: await sharp({
        create: { width: 40, height: 24, channels: 4, background: "#00ff00" },
      }).png().toBuffer(), mime: "image/png" });
      const snapshot = validateBrandOutroSettings({ ...settings, preset }, 23, logoPath);
      const input = readFileSync(join(dir, "in.mp4"));
      const output = await applyBrandOutro(input, snapshot, 23);
      writeFileSync(join(dir, "out.mp4"), output);
      expect(duration(join(dir, "out.mp4"))).toBeGreaterThan(duration(join(dir, "in.mp4")) + 1.7);
      expect(duration(join(dir, "out.mp4"))).toBeLessThan(3.6);
      expect(frameCenterRgb(join(dir, "out.mp4"), 0.3)[0]).toBeGreaterThan(180);
      expect(frameCenterRgb(join(dir, "out.mp4"), 2)[0]).toBeLessThan(100);
      expect(audioRms(join(dir, "out.mp4"), 0.3)).toBeGreaterThan(100);
      expect(audioRms(join(dir, "out.mp4"), 2)).toBeLessThan(100);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40_000);

  it("appends a letterboxed silent uploaded WebM after an audio source", async () => {
    const dir = mkdtempSync(join(tmpdir(), "outro-upload-test-"));
    try {
      ffmpeg(["-f", "lavfi", "-i", "color=c=red:s=160x90:r=30:d=1.2",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=1.2",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", join(dir, "in.mp4")]);
      ffmpeg(["-f", "lavfi", "-i", "color=c=blue:s=90x160:r=30:d=1.5",
        "-c:v", "libvpx-vp9", "-an", join(dir, "clip.webm")]);
      objects.set(clipPath, { data: readFileSync(join(dir, "clip.webm")), mime: "video/webm" });
      const snapshot = validateBrandOutroSettings({ ...settings, mode: "upload", clip_path: clipPath }, 23, null);
      const output = await applyBrandOutro(readFileSync(join(dir, "in.mp4")), snapshot, 23);
      writeFileSync(join(dir, "out.mp4"), output);
      expect(duration(join(dir, "out.mp4"))).toBeGreaterThan(2.5);
      expect(audioRms(join(dir, "out.mp4"), 0.3)).toBeGreaterThan(100);
      expect(audioRms(join(dir, "out.mp4"), 2)).toBeLessThan(100);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40_000);

  it("pads a source without audio and retains uploaded clip audio", async () => {
    const dir = mkdtempSync(join(tmpdir(), "outro-audio-test-"));
    try {
      ffmpeg(["-f", "lavfi", "-i", "color=c=red:s=160x90:r=30:d=1.2",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", join(dir, "in.mp4")]);
      ffmpeg(["-f", "lavfi", "-i", "color=c=blue:s=90x160:r=30:d=1.5",
        "-f", "lavfi", "-i", "sine=frequency=800:duration=1.5",
        "-c:v", "libvpx-vp9", "-c:a", "libopus", "-shortest", join(dir, "clip.webm")]);
      objects.set(clipPath, { data: readFileSync(join(dir, "clip.webm")), mime: "video/webm" });
      const snapshot = validateBrandOutroSettings({ ...settings, mode: "upload", clip_path: clipPath }, 23, null);
      const output = await applyBrandOutro(readFileSync(join(dir, "in.mp4")), snapshot, 23);
      writeFileSync(join(dir, "out.mp4"), output);
      expect(duration(join(dir, "out.mp4"))).toBeGreaterThan(2.5);
      expect(audioRms(join(dir, "out.mp4"), 0.3)).toBeLessThan(100);
      expect(audioRms(join(dir, "out.mp4"), 1.7)).toBeGreaterThan(100);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40_000);
});