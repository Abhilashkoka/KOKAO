/* eslint-disable no-console */
// Spokesperson lip-sync bake-off on Atlas Cloud.
//
// Runs one character image + one voice track through each OmniHuman model on
// Atlas Cloud and writes the clips, a results.json and a side-by-side
// comparison page. Standalone: no database, no tenant wallet, no job rows.
//
// Usage:
//   ATLASCLOUD_API_KEY=... node scripts/src/lipsync-bakeoff.mjs \
//     --image <https-url | local.png> \
//     --audio <https-url | local.mp3 | local.mp4 (voice is extracted)> \
//     [--label telugu] [--models v2.0,v1.5] [--prompt "..."] [--max-sec 20]
//
// Paid calls are checkpointed per model+label: a rerun resumes the accepted
// prediction instead of paying for a second one. Delete the label's
// checkpoint.json to force a fresh paid run.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

const GENERATE_URL = "https://api.atlascloud.ai/api/v1/model/generateVideo";
const PREDICTION_URL = "https://api.atlascloud.ai/api/v1/model/prediction";
const POLL_MS = Number(process.env.POLL_MS ?? 5_000);
const DEADLINE_MS = 30 * 60 * 1000;
const DONE = new Set(["completed", "succeeded", "success"]);
const FAILED = new Set(["failed", "error", "canceled", "cancelled"]);

/** Atlas model ids and list price per output second (USD), read 2026-10-30. */
const MODELS = {
  "v2.0": { id: "bytedance/avatar-omni-human-v2.0", usdPerSec: 0.07, maxSec: 300 },
  "v1.5": { id: "bytedance/avatar-omni-human-v1.5", usdPerSec: 0.12, maxSec: 60 },
};

const DEFAULT_PROMPT =
  "A calm, trustworthy doctor speaking directly to camera in a bright clinic. " +
  "Natural head movement, subtle hand gestures, steady eye contact, static medium close-up. " +
  "Mouth closed and still during pauses.";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const apiKey = process.env.ATLASCLOUD_API_KEY?.trim();
const imageArg = arg("image");
const audioArg = arg("audio");
const label = (arg("label", "test")).replace(/[^a-z0-9_-]/gi, "-");
const modelKeys = arg("models", "v2.0,v1.5").split(",").map((s) => s.trim());
const prompt = arg("prompt", DEFAULT_PROMPT);
const maxSec = Number(arg("max-sec", "20"));

if (!apiKey || !imageArg || !audioArg) {
  console.error(
    "usage: ATLASCLOUD_API_KEY=... node scripts/src/lipsync-bakeoff.mjs " +
      "--image <url|file> --audio <url|file> [--label telugu] [--models v2.0,v1.5]",
  );
  process.exit(2);
}
for (const key of modelKeys) {
  if (!MODELS[key]) {
    console.error(`unknown model "${key}". Use: ${Object.keys(MODELS).join(", ")}`);
    process.exit(2);
  }
}

const outDir = resolve("attached_assets/generated_videos/lipsync-bakeoff", label);
await mkdir(outDir, { recursive: true });
const checkpointPath = resolve(outDir, "checkpoint.json");
const checkpoint = existsSync(checkpointPath)
  ? JSON.parse(await readFile(checkpointPath, "utf8"))
  : {};
const saveCheckpoint = () =>
  writeFile(checkpointPath, JSON.stringify(checkpoint, null, 2), { mode: 0o600 });

const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4" };

/** https URLs pass through; local files go up as data URIs. */
async function toInput(value) {
  if (/^https:\/\//i.test(value)) return value;
  const path = resolve(value);
  const mime = MIME[extname(path).toLowerCase()];
  if (!mime) throw new Error(`unsupported file type: ${value}`);
  return `data:${mime};base64,${(await readFile(path)).toString("base64")}`;
}

/** Audio length in seconds via ffprobe (local file or URL). */
function probeSeconds(value) {
  const r = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration",
    "-of", "default=nw=1:nk=1", value], { encoding: "utf8" });
  const sec = Number(r.stdout.trim());
  return Number.isFinite(sec) && sec > 0 ? sec : null;
}

async function atlas(url, init) {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
  });
  const body = await res.json().catch(() => null);
  const code = typeof body?.code === "number" ? body.code : null;
  if (!res.ok || (code !== null && code !== 0 && code !== 200)) {
    const msg = typeof body?.message === "string" ? body.message : JSON.stringify(body)?.slice(0, 300);
    const hint = res.status === 402
      ? " — top up Atlas credits, or this model needs a one-time unlock payment like Seedance did."
      : /real|human|person|face|sensitive|policy/i.test(msg ?? "")
        ? " — Atlas flagged the character image. Try a less photoreal/stylised sheet."
        : "";
    throw new Error(`Atlas ${res.status}${code ? ` code ${code}` : ""}: ${msg}${hint}`);
  }
  return body?.data ?? {};
}

function firstOutputUrl(outputs) {
  const list = Array.isArray(outputs) ? outputs : outputs ? [outputs] : [];
  for (const item of list) {
    if (typeof item === "string" && /^https?:\/\//.test(item)) return item;
    if (item && typeof item === "object") {
      const u = item.url ?? item.video ?? item.video_url;
      if (typeof u === "string") return u;
    }
  }
  return null;
}

for (const [flag, value] of [["--image", imageArg], ["--audio", audioArg]]) {
  if (!/^https:\/\//i.test(value) && !existsSync(resolve(value))) {
    console.error(`${flag} file not found: ${resolve(value)}\nUpload it to the workspace and use its exact name (quote names with spaces).`);
    process.exit(2);
  }
}

/** A video file as --audio: pull its voice track out with ffmpeg. */
const VIDEO_EXT = new Set([".mp4", ".mov", ".webm", ".mkv", ".m4v", ".3gp"]);
let audioSource = audioArg;
if (VIDEO_EXT.has(extname(audioArg.split("?")[0]).toLowerCase())) {
  const extracted = resolve(outDir, "voice.mp3");
  const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i",
    /^https:\/\//i.test(audioArg) ? audioArg : resolve(audioArg),
    "-vn", "-ac", "1", "-ar", "44100", "-b:a", "128k", extracted], { encoding: "utf8" });
  if (r.status !== 0 || !existsSync(extracted)) {
    console.error(`could not extract audio from ${audioArg}: ${(r.stderr || r.error?.message || "").trim().slice(0, 300)}`);
    process.exit(2);
  }
  console.log(`extracted voice track → ${extracted}`);
  audioSource = extracted;
}

const audioSec = probeSeconds(existsSync(audioSource) ? resolve(audioSource) : audioSource);
if (audioSec === null) console.warn("could not read audio length; skipping length guard");
else {
  console.log(`audio: ${audioSec.toFixed(1)}s`);
  if (audioSec > maxSec) {
    console.error(`audio is ${audioSec.toFixed(1)}s, over --max-sec ${maxSec}. Trim it or raise --max-sec.`);
    process.exit(2);
  }
}

const imageInput = await toInput(imageArg);
const audioInput = await toInput(audioSource);
const results = [];

for (const key of modelKeys) {
  const model = MODELS[key];
  const started = Date.now();
  const row = { model: key, modelId: model.id, label };
  try {
    let id = checkpoint[key]?.id;
    if (id) {
      console.log(`[${key}] resuming prediction ${id}`);
    } else {
      // Persist intent before the paid call so a crash can't double-charge silently.
      checkpoint[key] = { state: "submitting", at: new Date().toISOString() };
      await saveCheckpoint();
      const data = await atlas(GENERATE_URL, {
        method: "POST",
        body: JSON.stringify({ model: model.id, prompt, image_url: imageInput, audio_url: audioInput, seed: -1 }),
      });
      id = data.id;
      if (!id) throw new Error(`no prediction id returned: ${JSON.stringify(data).slice(0, 200)}`);
      checkpoint[key] = { state: "accepted", id, at: new Date().toISOString() };
      await saveCheckpoint();
      console.log(`[${key}] accepted ${id}`);
    }

    let pred;
    for (;;) {
      if (Date.now() - started > DEADLINE_MS) throw new Error("timed out after 30 min (prediction kept in checkpoint; rerun to resume)");
      pred = await atlas(`${PREDICTION_URL}/${id}`, { method: "GET" });
      const status = String(pred.status ?? "").toLowerCase();
      if (DONE.has(status)) break;
      if (FAILED.has(status)) throw new Error(`prediction failed: ${JSON.stringify(pred.error ?? pred).slice(0, 300)}`);
      await new Promise((r) => setTimeout(r, POLL_MS));
    }

    const url = firstOutputUrl(pred.outputs);
    if (!url) throw new Error(`completed without an output URL: ${JSON.stringify(pred.outputs).slice(0, 200)}`);
    const file = `${key}.mp4`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download failed ${res.status}`);
    await writeFile(resolve(outDir, file), Buffer.from(await res.arrayBuffer()));

    const videoSec = probeSeconds(resolve(outDir, file));
    const reported = Number(pred.actual_cost_usd ?? pred.cost_usd);
    Object.assign(row, {
      ok: true,
      file,
      renderSec: Math.round((Date.now() - started) / 1000),
      videoSec,
      costUsd: Number.isFinite(reported) ? reported : null,
      estimatedUsd: videoSec ? +(videoSec * model.usdPerSec).toFixed(3) : null,
    });
    checkpoint[key] = { ...checkpoint[key], state: "completed", file };
    await saveCheckpoint();
    console.log(`[${key}] done → ${file} (${row.renderSec}s render)`);
  } catch (err) {
    Object.assign(row, { ok: false, error: err.message, renderSec: Math.round((Date.now() - started) / 1000) });
    if (checkpoint[key]?.state === "submitting") {
      checkpoint[key] = { state: "rejected", error: err.message };
      await saveCheckpoint();
    }
    console.error(`[${key}] FAILED: ${err.message}`);
  }
  results.push(row);
}

await writeFile(resolve(outDir, "results.json"), JSON.stringify({ label, audioSec, prompt, results }, null, 2));

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const card = (r) => `
  <section class="card">
    <h2>OmniHuman ${esc(r.model)}</h2>
    ${r.ok ? `<video src="${esc(r.file)}" controls playsinline></video>` : `<div class="err">${esc(r.error)}</div>`}
    <dl>
      <dt>Cost</dt><dd>${r.costUsd != null ? `$${r.costUsd} (Atlas)` : r.estimatedUsd != null ? `~$${r.estimatedUsd} (est.)` : "—"}</dd>
      <dt>Render</dt><dd>${r.renderSec}s</dd>
      <dt>Length</dt><dd>${r.videoSec ? `${r.videoSec.toFixed(1)}s` : "—"}</dd>
    </dl>
    <p class="score">Score 1–5: lip accuracy · face match · Telugu mouth shapes · mouth still in pauses</p>
  </section>`;

await writeFile(resolve(outDir, "index.html"), `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Lipsync Bake-off</title>
<style>
  :root { --bg:#faf7f5; --card:#fff; --ink:#2b2b33; --mute:#8a8794; --accent:#c9b8f5; --err:#f6d5d5; }
  body { margin:0; padding:24px 16px; background:var(--bg); color:var(--ink); font:15px/1.5 system-ui,sans-serif; }
  h1 { font-weight:600; margin:0 0 4px; } .sub { color:var(--mute); margin:0 0 24px; }
  .grid { display:grid; gap:16px; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); }
  .card { background:var(--card); border-radius:16px; padding:16px; border:1px solid #eee; }
  .card h2 { font-size:16px; margin:0 0 12px; border-left:4px solid var(--accent); padding-left:8px; }
  video { width:100%; border-radius:10px; background:#000; }
  dl { display:grid; grid-template-columns:auto 1fr; gap:4px 12px; margin:12px 0 0; }
  dt { color:var(--mute); } dd { margin:0; }
  .err { background:var(--err); border-radius:10px; padding:12px; font-size:13px; }
  .score { color:var(--mute); font-size:12px; margin:12px 0 0; }
</style>
<h1>Lipsync bake-off · ${esc(label)}</h1>
<p class="sub">Audio ${audioSec ? audioSec.toFixed(1) + "s" : "?"} · Atlas Cloud · ${new Date().toLocaleString("en-IN")}</p>
<div class="grid">${results.map(card).join("")}</div>`);

console.log(`\nOpen ${resolve(outDir, "index.html")}`);
console.log(`Check pauses: node scripts/src/lipsync-inspect.mjs ${resolve(outDir, "v2.0.mp4")}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
