/* eslint-disable no-console */
// Build one full-length audio track per speaker from a scene's dialogue lines.
//
// Usage: node scripts/src/multispeaker-audio.mjs scene.json [outDir]
//
// Every multi-speaker lip-sync route needs the same thing: for each character,
// a track as long as the whole scene, carrying only that character's lines at
// their real timecodes. Native two-speaker models (InfiniteTalk, MultiTalk)
// take these as left_audio / right_audio. The crop-and-composite route feeds
// one per pass. Either way this is the piece that has to be exact.
//
// scene.json:
// {
//   "durationSec": 8.0,
//   "lines": [
//     { "speaker": "doctor",  "audio": "line1.wav", "startSec": 0.0 },
//     { "speaker": "patient", "audio": "line2.wav", "startSec": 2.4 },
//     { "speaker": "doctor",  "audio": "line3.wav", "startSec": 5.1 }
//   ]
// }
//
// Two things this gets right that are easy to get wrong:
//
//  - The gaps are NOT digital silence. Every sample being zero made LatentSync
//    hold the mouth half-open with a black void where the teeth should be,
//    instead of closing it. The same -60 dBFS floor the character path now uses
//    goes under these tracks, for the same reason.
//  - Every output is exactly durationSec long, to the sample. Lip-sync models
//    take video and audio as separate files and assume they start together, so
//    a track that is short by a frame is a mouth that is wrong by a frame.

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const scenePath = process.argv[2];
const outDir = process.argv[3] || "multispeaker-audio";
if (!scenePath) {
  console.error("usage: node scripts/src/multispeaker-audio.mjs scene.json [outDir]");
  process.exit(2);
}

/** Peak amplitude of the noise floor, dB below full scale. Matches narration.ts. */
const NOISE_FLOOR_DBFS = -60;
const SAMPLE_RATE = 24_000;

function ffmpeg(args) {
  return new Promise((resolve_, reject) => {
    const proc = spawn("ffmpeg", args);
    let stderr = "";
    proc.stderr.on("data", (c) => {
      stderr = (stderr + c.toString()).slice(-4000);
    });
    proc.on("close", (code) =>
      code === 0 ? resolve_() : reject(new Error(`ffmpeg ${code}: ${stderr.slice(-400)}`)),
    );
    proc.on("error", reject);
  });
}

function parseWav(buffer) {
  let offset = 12;
  let format = null;
  let pcm = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = buffer.subarray(offset + 8, Math.min(offset + 8 + size, buffer.length));
    if (id === "fmt ") {
      format = {
        channels: body.readUInt16LE(2),
        sampleRate: body.readUInt32LE(4),
        byteRate: body.readUInt32LE(8),
        blockAlign: body.readUInt16LE(12),
        bitsPerSample: body.readUInt16LE(14),
      };
    } else if (id === "data") pcm = Buffer.from(body);
    offset += 8 + size + (size % 2);
  }
  if (!format || !pcm) throw new Error("not a PCM WAV");
  return { format, pcm };
}

function buildWav(format, pcm) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(format.channels, 22);
  h.writeUInt32LE(format.sampleRate, 24);
  h.writeUInt32LE(format.byteRate, 28);
  h.writeUInt16LE(format.blockAlign, 32);
  h.writeUInt16LE(format.bitsPerSample, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** Normalize any input to mono 16-bit PCM at SAMPLE_RATE. */
async function toPcm(inputPath, workDir, index) {
  const out = join(workDir, `norm_${index}.wav`);
  await ffmpeg([
    "-y", "-i", inputPath,
    "-ac", "1", "-ar", String(SAMPLE_RATE), "-c:a", "pcm_s16le",
    out,
  ]);
  return parseWav(await readFile(out));
}

function applyNoiseFloor(pcm) {
  const peak = Math.max(1, Math.round(32767 * Math.pow(10, NOISE_FLOOR_DBFS / 20)));
  let seed = (pcm.length * 2654435761) % 4294967296;
  for (let o = 0; o + 2 <= pcm.length; o += 2) {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    const mixed = pcm.readInt16LE(o) + ((seed % (2 * peak + 1)) - peak);
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, mixed)), o);
  }
  return pcm;
}

async function main() {
  const scene = JSON.parse(await readFile(scenePath, "utf8"));
  const base = dirname(resolve(scenePath));
  await mkdir(outDir, { recursive: true });

  const blockAlign = 2;
  const byteRate = SAMPLE_RATE * blockAlign;
  const format = {
    channels: 1,
    sampleRate: SAMPLE_RATE,
    byteRate,
    blockAlign,
    bitsPerSample: 16,
  };
  const totalBytes = Math.round((scene.durationSec * byteRate) / blockAlign) * blockAlign;

  const speakers = [...new Set(scene.lines.map((l) => l.speaker))];
  const tracks = new Map(speakers.map((s) => [s, Buffer.alloc(totalBytes)]));

  console.log(`scene: ${scene.durationSec}s, ${scene.lines.length} lines, ${speakers.length} speakers\n`);

  let i = 0;
  for (const line of scene.lines) {
    const { pcm } = await toPcm(join(base, line.audio), outDir, i++);
    const at = Math.round((line.startSec * byteRate) / blockAlign) * blockAlign;
    const room = Math.max(0, totalBytes - at);
    const take = Math.min(pcm.length, room);
    if (take < pcm.length) {
      console.warn(
        `  ! ${line.audio} overruns the scene by ${((pcm.length - take) / byteRate).toFixed(2)}s and was cut`,
      );
    }
    pcm.copy(tracks.get(line.speaker), at, 0, take);
    console.log(
      `  ${line.speaker.padEnd(10)} ${line.startSec.toFixed(2)}s  ${(take / byteRate).toFixed(2)}s  ${line.audio}`,
    );
  }

  console.log("");
  for (const [speaker, pcm] of tracks) {
    const path = join(outDir, `${speaker}.wav`);
    await writeFile(path, buildWav(format, applyNoiseFloor(pcm)));
    console.log(`  -> ${path}  (${(pcm.length / byteRate).toFixed(3)}s)`);
  }
  console.log(
    `\nEvery track is exactly ${(totalBytes / byteRate).toFixed(3)}s, with a ${NOISE_FLOOR_DBFS} dBFS floor` +
      " where nobody is speaking.",
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
