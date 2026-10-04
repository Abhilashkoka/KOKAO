import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

let source: string;
const upload = vi.fn();
vi.mock("./objectStorage", () => ({
  ObjectStorageService: class {
    async getObjectEntityFile(path: string, tenant: number) {
      if (!path.startsWith(`/objects/${tenant}/`)) throw new Error("Object not found");
      return {
        getMetadata: async () => [{ size: (await stat(source)).size }],
        createReadStream: () => createReadStream(source),
      };
    }
    getObjectEntityUploadURL() { return upload(); }
    normalizeObjectEntityPath() { return "/objects/42/uploads/compatible"; }
  },
}));
import { stageVideo } from "./videoPublishMedia";
const exec = promisify(execFile);
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "reel-test-"));
  source = join(dir, "source.mp4");
  await exec("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=size=540x960:rate=24:duration=3",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=96000:duration=3",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-c:a", "alac", "-y", source]);
});
afterAll(async () => { vi.unstubAllGlobals(); await rm(dir, { recursive: true, force: true }); });
describe("Reel audio preparation", () => {
  it("converts real incompatible audio, preserves encoded video and saves a separate upload", async () => {
    upload.mockResolvedValue("https://storage.invalid/upload");
    vi.stubGlobal("fetch", vi.fn(async (_url, options) => {
      let bytes = 0;
      for await (const chunk of options.body) bytes += chunk.length;
      expect(bytes).toBe(Number(options.headers["Content-Length"]));
      return new Response(null, { status: 200 });
    }));
    const result = await stageVideo("/objects/42/original", 42, "facebook", true);
    try {
      expect(result.videoPath).toBe("/objects/42/uploads/compatible");
      const { stdout } = await exec("ffprobe", ["-v", "error", "-show_streams", "-of", "json", result.localPath]);
      expect(JSON.parse(stdout).streams.find((s: any) => s.codec_type === "audio")).toMatchObject({
        codec_name: "aac", sample_rate: "48000", channels: 2,
      });
      const hash = async (file: string) => (await exec("ffmpeg", ["-v", "error", "-i", file, "-map", "0:v:0", "-c", "copy", "-f", "hash", "-"])).stdout;
      expect(await hash(result.localPath)).toBe(await hash(source));
    } finally { await result.cleanup(); }
    await expect(stat(result.localPath)).rejects.toThrow();
  });
  it("leaves YouTube media unchanged and keeps strict resume validation", async () => {
    upload.mockClear();
    const result = await stageVideo("/objects/42/original", 42, "youtube", true);
    expect(result.videoPath).toBe("/objects/42/original");
    expect(upload).not.toHaveBeenCalled();
    await result.cleanup();
    await expect(stageVideo("/objects/42/original", 42, "instagram")).rejects.toThrow("AAC audio");
    await expect(stageVideo("/objects/99/original", 42, "facebook", true)).rejects.toThrow("Object not found");
  });
});