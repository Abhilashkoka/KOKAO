/* eslint-disable no-console */
// Inspect a lip-synced video for the failure that matters: a mouth that keeps
// moving while nobody is speaking.
//
// Usage: node scripts/src/lipsync-inspect.mjs <video.mp4> [outDir]
//
// Why a script and not a QA gate: the check that would have to run inside
// verifyRenderedVideo is a measurement, and the obvious ffmpeg-only
// measurements do not separate the two cases. On a real failing sample,
// motion in the mouth band during silence measured 2.0-3.0x global motion,
// and during speech 2.1-3.2x — completely overlapping, because head and hand
// movement swamp the mouth. Gating on that would fail good jobs and refund
// credits for nothing.
//
// The eyeball test, though, is unambiguous. So this finds every silent span
// and lays the frames inside it out as one contact sheet per span. If the
// mouth is open and articulating in a sheet, the sync is wrong — no judgement
// call required.

import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const video = process.argv[2];
const outDir = process.argv[3] || "lipsync-inspect";
if (!video) {
  console.error("usage: node scripts/src/lipsync-inspect.mjs <video.mp4> [outDir]");
  process.exit(2);
}

/**
 * Silence quieter than this, for at least this long, counts as a pause.
 * -35dB rather than a tighter floor: breath and room tone between sentences
 * sit above -40dB, and a stricter threshold missed two of the three real
 * pauses in the sample this was built against.
 */
const SILENCE_DB = -35;
const MIN_SILENCE_SEC = 0.35;
/** Frames laid out per contact sheet. */
const FRAMES_PER_SHEET = 12;

function ffmpeg(args) {
  return new Promise((resolve) => {
    const proc = spawn("ffmpeg", args);
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("close", (code) => resolve({ code, stderr }));
    proc.on("error", () => resolve({ code: 1, stderr: "" }));
  });
}

function ffprobe(args) {
  return new Promise((resolve) => {
    const proc = spawn("ffprobe", args);
    let stdout = "";
    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.on("close", () => resolve(stdout.trim()));
    proc.on("error", () => resolve(""));
  });
}

/** Every silent span in the audio track, as {startSec, endSec}. */
async function findSilences(file) {
  const { stderr } = await ffmpeg([
    "-i", file,
    "-af", `silencedetect=n=${SILENCE_DB}dB:d=${MIN_SILENCE_SEC}`,
    "-f", "null", "-",
  ]);
  const spans = [];
  let start = null;
  for (const line of stderr.split("\n")) {
    const began = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (began) start = Number.parseFloat(began[1]);
    const ended = line.match(/silence_end:\s*([\d.]+)/);
    if (ended && start !== null) {
      spans.push({ startSec: Math.max(0, start), endSec: Number.parseFloat(ended[1]) });
      start = null;
    }
  }
  return spans;
}

async function main() {
  const durationSec = Number.parseFloat(
    await ffprobe([
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      video,
    ]),
  );
  if (!Number.isFinite(durationSec)) {
    console.error(`Could not read ${video} — is it a video file?`);
    process.exit(1);
  }

  const silences = await findSilences(video);
  console.log(`${video} — ${durationSec.toFixed(2)}s`);
  if (silences.length === 0) {
    console.log(
      `No pause of ${MIN_SILENCE_SEC}s or longer found. Nothing to check: this test needs ` +
        "silence in the narration to be meaningful.",
    );
    return;
  }

  await rm(outDir, { recursive: true, force: true }).catch(() => {});
  await mkdir(outDir, { recursive: true });

  console.log(`${silences.length} pause(s) found. Contact sheets in ${outDir}/\n`);
  let index = 0;
  for (const span of silences) {
    index += 1;
    const lengthSec = span.endSec - span.startSec;
    // Trim the very edges: the frames either side of a pause legitimately
    // carry the mouth closing and reopening.
    const from = span.startSec + Math.min(0.08, lengthSec / 6);
    const window = Math.max(0.05, lengthSec - 2 * Math.min(0.08, lengthSec / 6));
    const fps = Math.max(2, Math.min(30, FRAMES_PER_SHEET / window));
    const name = `silence-${String(index).padStart(2, "0")}-${span.startSec.toFixed(2)}s.png`;

    const { code } = await ffmpeg([
      "-y",
      "-ss", from.toFixed(3),
      "-t", window.toFixed(3),
      "-i", video,
      "-vf", `fps=${fps.toFixed(3)},scale=480:-2,tile=4x3`,
      "-frames:v", "1",
      join(outDir, name),
    ]);
    const status = code === 0 ? name : "(frame extraction failed)";
    console.log(
      `  ${index}. ${span.startSec.toFixed(2)}s – ${span.endSec.toFixed(2)}s ` +
        `(${lengthSec.toFixed(2)}s)  ->  ${status}`,
    );
  }

  await writeFile(
    join(outDir, "README.txt"),
    [
      `Lip-sync inspection for ${video}`,
      "",
      "Each PNG shows the frames inside one silent span of the narration.",
      "Nobody is speaking during any frame in these sheets.",
      "",
      "PASS: mouths are closed, or closed and still, across the sheet.",
      "FAIL: the mouth is open and changing shape from frame to frame —",
      "      the sync is not following the audio.",
      "",
      "Zoom to 100% and watch the lips, not the face.",
      "",
    ].join("\n"),
  );

  console.log(
    "\nOpen each sheet and look at the lips. Nobody is speaking in any of these " +
      "frames — an open, changing mouth means the sync is wrong.",
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
