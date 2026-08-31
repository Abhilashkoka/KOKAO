import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { probeDurationSec, runFfmpeg } from "./slideshow";
import { composeApprovedStillAudioClip, resolveExactFont, trimCharacterDialogueClipStrict } from "./characterDialogueCompose";

describe("resolveExactFont", () => {
  it.each([
    ["Noto Sans Telugu", "NotoSansTelugu.ttf"],
    ["Noto Sans Tamil", "NotoSansTamil.ttf"],
    ["Noto Sans Devanagari", "NotoSansDevanagari.ttf"],
  ])("resolves the bundled %s face without host font installation", async (family, filename) => {
    const font = await resolveExactFont([family]);

    expect(font.family).toBe(family);
    expect(font.file.endsWith(`/assets/fonts/${filename}`)).toBe(true);
  });
});

describe("trimCharacterDialogueClipStrict", () => {
  it("holds the final frame when the provider clip is shorter than narration", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kokao-character-dialogue-test-"));
    try {
      await runFfmpeg([
        "-y", "-f", "lavfi", "-i", "color=c=black:s=320x240:d=1",
        "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "short.mp4",
      ], dir);
      const trimmed = await trimCharacterDialogueClipStrict(await readFile(join(dir, "short.mp4")), 1.4);
      await writeFile(join(dir, "trimmed.mp4"), trimmed);

      const duration = await probeDurationSec("trimmed.mp4", dir);
      expect(duration).not.toBeNull();
      expect(Math.abs(duration! - 1.4)).toBeLessThanOrEqual(0.1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("composeApprovedStillAudioClip", () => {
  it("makes an exact local still clip without a video provider", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kokao-guided-dialogue-test-"));
    try {
      await runFfmpeg([
        "-y", "-f", "lavfi", "-i", "color=c=black:s=320x240:d=1",
        "-frames:v", "1", "still.png",
      ], dir);
      await runFfmpeg([
        "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1.2",
        "-c:a", "pcm_s16le", "line.wav",
      ], dir);
      const clip = await composeApprovedStillAudioClip(
        await readFile(join(dir, "still.png")),
        await readFile(join(dir, "line.wav")),
        1.2,
      );
      await writeFile(join(dir, "clip.mp4"), clip);
      const duration = await probeDurationSec("clip.mp4", dir);
      expect(duration).not.toBeNull();
      expect(Math.abs(duration! - 1.2)).toBeLessThanOrEqual(0.1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});