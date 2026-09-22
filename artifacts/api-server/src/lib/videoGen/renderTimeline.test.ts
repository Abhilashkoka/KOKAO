import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actualClipDuration, preserveLipSyncTail, renderedTimeline, rebaseRenderedCues } from "./renderTimeline";
import { concatClips } from "./postprocess";
import { trimCharacterDialogueClipStrict, composeCharacterDialogue } from "./characterDialogueCompose";
import { composeTopicVideo } from "./topicVideo/compose";
import { runFfmpeg } from "./slideshow";
import { ASPECT_DIMENSIONS } from "./types";
import { replaceAudio } from "../localization/dub";

describe("complete provider footage", () => {
  it("rebases 4+5+5.5 planning onto 5+5+8 without modifying the plan", () => {
    const plan = [4, 5, 5.5];
    expect(renderedTimeline(plan, [5, 5, 8]).map(({ startSec, endSec }) => [startSec, endSec])).toEqual([[0, 5], [5, 10], [10, 18]]);
    expect(plan).toEqual([4, 5, 5.5]);
    const cues = [{ startSec: 0, endSec: 4 }, { startSec: 4, endSec: 9 }, { startSec: 9, endSec: 14.5 }];
    expect(rebaseRenderedCues(cues, renderedTimeline(plan, [5, 5, 8]))).toEqual([
      { startSec: 0, endSec: 4 }, { startSec: 5, endSec: 10 }, { startSec: 10, endSec: 15.5 },
    ]);
    expect(cues[2]).toEqual({ startSec: 9, endSec: 14.5 });
    expect(() => rebaseRenderedCues(cues, renderedTimeline(plan, [3, 5, 8]))).toThrow(/will not be shortened/);
    expect(() => renderedTimeline(plan, [5, NaN, 8])).toThrow();
  });

  it("real ffmpeg retains all three tail markers and rebases narration; native audio also lasts 18s", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kokao-full-footage-test-"));
    const originalDimensions = { ...ASPECT_DIMENSIONS["1:1"] };
    // Small frame, identical production graph. No provider calls or DB writes.
    Object.assign(ASPECT_DIMENSIONS["1:1"], { width: 160, height: 160 });
    try {
      const durations = [5, 5, 8];
      const clips: Buffer[] = [];
      for (const [index, duration] of durations.entries()) {
        await runFfmpeg(["-y", "-f", "lavfi", "-i", `color=red:s=160x160:r=30:d=${duration}`,
          "-f", "lavfi", "-i", `sine=frequency=440:duration=${duration}`, "-vf",
          `drawbox=color=lime:t=fill:enable='gte(t,${duration - .4})'`,
          "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", `${index}.mp4`], dir);
        clips.push(await readFile(join(dir, `${index}.mp4`)));
      }
      await runFfmpeg(["-y", "-f", "lavfi", "-i", "sine=frequency=600:duration=14.5", "-c:a", "pcm_s16le", "voice.wav"], dir);
      const narration = await readFile(join(dir, "voice.wav"));
      const joined = await concatClips(clips);
      expect(await actualClipDuration(joined)).toBeCloseTo(18, 0);
      const dubbed = await replaceAudio(joined, narration);
      expect(Math.abs((await actualClipDuration(dubbed)) - 18)).toBeLessThan(0.08);
      for (const nativeAudio of [false, true]) {
        const video = await composeTopicVideo({
          clips, narrationWav: narration, cues: nativeAudio ? [] : [
            { text: "First", startSec: 0, endSec: 4 },
            { text: "Second", startSec: 4, endSec: 9 },
            { text: "Third", startSec: 9, endSec: 14.5 },
          ], totalDurationSec: 14.5, aspectRatio: "1:1", subtitles: false,
          preserveGeneratedClips: true, nativeAudio,
          sceneMap: [4, 5, 5.5].map((durationSec, clipIndex) => ({ durationSec, clipIndex })),
        });
        expect(Math.abs((await actualClipDuration(video)) - 18)).toBeLessThan(0.08);
        await writeFile(join(dir, "out.mp4"), video);
        for (const position of [4.8, 9.8, 17.8]) {
          await runFfmpeg(["-y", "-ss", String(position), "-i", "out.mp4", "-frames:v", "1", "-vf", "scale=1:1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pixel.rgb"], dir);
          const pixel = await readFile(join(dir, "pixel.rgb"));
          expect(pixel[1]).toBeGreaterThan(180);
          expect(pixel[0]).toBeLessThan(70);
        }
        {
          const audioChecks: Array<readonly [number, boolean]> = nativeAudio
            ? [[4.8, true], [9.8, true], [17.8, true]]
            : [[4.5, false], [5.2, true], [10.2, true], [16, false]];
          for (const [position, audible] of audioChecks) {
            await runFfmpeg(["-y", "-ss", String(position), "-i", "out.mp4", "-t", "0.1", "-vn", "-ac", "1", "-f", "s16le", "samples.raw"], dir);
            const samples = await readFile(join(dir, "samples.raw"));
            let sum = 0;
            for (let i = 0; i < samples.length; i += 2) sum += samples.readInt16LE(i) ** 2;
            const rms = Math.sqrt(sum / (samples.length / 2));
            expect(audible ? rms > 100 : rms < 10).toBe(true);
          }
        }
      }
      const dialogue = await trimCharacterDialogueClipStrict(clips[2]!, 5.5, narration);
      expect(await actualClipDuration(dialogue)).toBeCloseTo(8, 0);
      const composed = await composeCharacterDialogue({ clips, scenes: [4, 5, 5.5].map((narrationDurationSec) => ({ text: "Test", narrationDurationSec })), subtitles: false, fontCandidates: [], direction: "ltr" });
      expect(composed.durationSec).toBeCloseTo(18, 0);
      await runFfmpeg(["-y", "-i", "2.mp4", "-t", "5.5", "-c", "copy", "short.mp4"], dir);
      const restored = await preserveLipSyncTail(await readFile(join(dir, "short.mp4")), clips[2]!);
      expect(Math.abs((await actualClipDuration(restored)) - 8)).toBeLessThan(0.08);
      await writeFile(join(dir, "restored.mp4"), restored);
      await runFfmpeg(["-y", "-ss", "7.8", "-i", "restored.mp4", "-frames:v", "1", "-vf", "scale=1:1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pixel.rgb"], dir);
      expect((await readFile(join(dir, "pixel.rgb")))[1]).toBeGreaterThan(180);
    } finally {
      Object.assign(ASPECT_DIMENSIONS["1:1"], originalDimensions);
      await rm(dir, { recursive: true, force: true });
    }
  }, 180_000);
});