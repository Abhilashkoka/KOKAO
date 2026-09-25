import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type OpenAI from "openai";
import { parseModelJsonObject } from "../modelJson";
import { encodeBudgetMs, findFontFile, probeDurationSec, runFfmpeg } from "./slideshow";
import { splitIntoSentences } from "./topicVideo/narration";
import { ASPECT_DIMENSIONS, VideoGenProviderError, type VideoAspect } from "./types";
import { SCREEN_DEMO_MAX_SECONDS } from "./videoTemplates";

const execFileAsync = promisify(execFile);
const FPS = 30;
export const SCREEN_DEMO_MIN_SECONDS = 5;
export const SCREEN_DEMO_SPOKEN_LINE_MAX_CHARS = 85;
export class ScreenDemoInputError extends Error {}

async function withMedia<T>(prefix: string, callback: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try { return await callback(dir); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

export async function probeScreenRecording(recording: Buffer): Promise<{ durationSec: number }> {
  return withMedia("kokao-screen-probe-", async (dir) => {
    await writeFile(join(dir, "rec"), recording);
    const durationSec = await probeDurationSec("rec", dir);
    if (durationSec === null || !Number.isFinite(durationSec))
      throw new ScreenDemoInputError("We could not read that screen recording. Upload an MP4, MOV or WebM file.");
    if (durationSec < SCREEN_DEMO_MIN_SECONDS)
      throw new ScreenDemoInputError(`The screen recording must be at least ${SCREEN_DEMO_MIN_SECONDS} seconds long.`);
    if (durationSec > SCREEN_DEMO_MAX_SECONDS)
      throw new ScreenDemoInputError("Screen recordings can be up to 10 minutes long.");
    return { durationSec: Math.round(durationSec * 100) / 100 };
  });
}

export function screenDemoBeatMaxSeconds(durationSec: number): number {
  return Math.min(SCREEN_DEMO_MAX_SECONDS, Math.ceil(durationSec * 1.5 + 10));
}

/** Frames are optional hints, but an unreadable recording is not optional. */
export async function extractDemoFrames(recording: Buffer, count = 6): Promise<Buffer[]> {
  return withMedia("kokao-screen-frames-", async (dir) => {
    await writeFile(join(dir, "rec"), recording);
    const duration = await probeDurationSec("rec", dir);
    if (!duration || !Number.isFinite(duration))
      throw new ScreenDemoInputError("We could not read that screen recording.");
    const frames: Buffer[] = [];
    for (let i = 0; i < count; i++) {
      const name = `f${i}.jpg`;
      try {
        await runFfmpeg(["-y", "-ss", (duration * (i + 0.5) / count).toFixed(3), "-i", "rec",
          "-frames:v", "1", "-vf", "scale=768:-2", "-q:v", "4", name], dir, 60_000);
        frames.push(await readFile(join(dir, name)));
      } catch (error) {
        throw new VideoGenProviderError(`Could not inspect the screen recording at frame ${i + 1}: ${String(error)}`);
      }
    }
    return frames;
  });
}

export interface ScreenDemoScript { intro: string; steps: string[]; closing: string }
export function demoWordBudget(seconds: number): number {
  return Math.max(12, Math.floor(seconds * 2.4 * 0.85));
}
export function toSingleSpokenLine(text: string, maxChars = SCREEN_DEMO_SPOKEN_LINE_MAX_CHARS): string {
  let line = text.replace(/\s+/gu, " ").replace(/(\d)\.(\d)/gu, "$1 point $2").trim();
  const terminal = /[!?]$/u.test(line) ? line.slice(-1) : ".";
  line = line.replace(/[.!?。！？।]+$/u, "").replace(/[.!?。！？।]/gu, "").trim();
  if (line.length > maxChars - 1) {
    const cut = line.slice(0, maxChars - 1);
    const space = cut.lastIndexOf(" ");
    line = (space > maxChars * 0.5 ? cut.slice(0, space) : cut).replace(/[,;:\s-]+$/u, "");
  }
  return line ? `${line}${terminal}` : "";
}
function sentence(text: string): string {
  const clean = text.replace(/\s+/gu, " ").trim();
  return clean ? /[.!?。！？।]$/u.test(clean) ? clean : `${clean}.` : "";
}
function countWords(text: string): number { return text.trim().split(/\s+/u).filter(Boolean).length; }

export function repairScreenDemoScript(raw: Partial<Record<keyof ScreenDemoScript, unknown>>,
  args: { recordingDurationSec: number; brandName?: string | null }): ScreenDemoScript {
  const intro = toSingleSpokenLine(typeof raw.intro === "string" ? raw.intro : "");
  if (!intro) throw new VideoGenProviderError("The walkthrough script is missing its intro line.");
  if (intro.length < 12) throw new VideoGenProviderError("The walkthrough intro line is too short to voice on its own.");
  let closing = toSingleSpokenLine(typeof raw.closing === "string" ? raw.closing : "");
  const fallback = () => toSingleSpokenLine(args.brandName?.trim()
    ? `Try ${args.brandName.trim()} today` : "Give it a try today");
  if (closing.length < 12) closing = fallback();
  const steps = (Array.isArray(raw.steps) ? raw.steps : [])
    .filter((step): step is string => typeof step === "string").map(sentence).filter(Boolean);
  if (!steps.length) throw new VideoGenProviderError("The walkthrough script has no voiceover for the recording.");
  const sturdy: string[] = [];
  let carry = "";
  for (const step of steps) {
    const joined = carry ? `${carry}, ${step[0]!.toLowerCase()}${step.slice(1)}` : step;
    if (joined.length < 12) { carry = joined.replace(/[.!?。！？।]+$/u, ""); continue; }
    sturdy.push(joined); carry = "";
  }
  if (carry) {
    if (sturdy.length) sturdy[sturdy.length - 1] =
      `${sturdy[sturdy.length - 1]!.replace(/[.!?。！？।]+$/u, "")}, ${carry}.`;
    else sturdy.push(`${carry}.`);
  }
  const budget = Math.ceil(demoWordBudget(args.recordingDurationSec) * 1.15);
  const kept: string[] = [];
  let words = 0;
  for (const step of sturdy) {
    const n = countWords(step);
    if (kept.length && words + n > budget) break;
    kept.push(step); words += n;
  }
  return { intro, steps: kept, closing };
}
export function assembleScreenDemoScript(parts: ScreenDemoScript): string {
  return [parts.intro, ...parts.steps, parts.closing].join(" ");
}
export function userScreenDemoScriptIssues(script: string): string[] {
  const issues: string[] = [];
  const text = script.trim();
  if ((text.match(/^[^.!?。！？।]+[.!?。！？।]*/u)?.[0]?.trim().length ?? 0) > 90)
    issues.push("Keep your first sentence under 90 characters — it is what your character says on camera.");
  if ((text.match(/[^.!?。！？।]+[.!?。！？।]*\s*$/u)?.[0]?.trim().length ?? 0) > 90)
    issues.push("Keep your last sentence under 90 characters — it is your character's closing line.");
  if (splitIntoSentences(text).length < 3)
    issues.push("Your script needs at least three full sentences: an intro for your character, the walkthrough, and a closing line.");
  return issues;
}
export function buildScreenDemoScriptPrompt(args: { brief: string; recordingDurationSec: number;
  brandName?: string | null; brandVoice?: string | null; cta?: string | null; hasFrames: boolean }) {
  const system = [
    "You write voiceover scripts for short app and software walkthrough videos.",
    "The video has three parts: a presenter says ONE intro sentence on camera, then a screen recording plays while a voiceover narrates it, then the presenter says ONE closing sentence on camera.",
    'Return JSON only: {"intro": string, "steps": string[], "closing": string}.',
    `intro: one sentence, at most 14 words and ${SCREEN_DEMO_SPOKEN_LINE_MAX_CHARS} characters. Name the problem the app solves or the outcome it gives. No greetings.`,
    `steps: the voiceover for the recording in screen order, about ${demoWordBudget(args.recordingDurationSec)} words in total. Never more.`,
    "Describe only what the viewer can actually see. Do not invent features, numbers, prices, or claims.",
    `closing: one sentence, at most 14 words and ${SCREEN_DEMO_SPOKEN_LINE_MAX_CHARS} characters, naming the brand and next step.`,
    "Use no abbreviations with full stops, emojis, hashtags or stage directions.",
  ].join("\n");
  const user = [
    `What the app is and what to highlight: ${args.brief.trim() || "(not given — infer from the screens)"}`,
    args.brandName?.trim() ? `Brand name: ${args.brandName.trim()}` : null,
    args.cta?.trim() ? `Call to action for the closing: ${args.cta.trim()}` : null,
    args.brandVoice?.trim() ? `Brand voice: ${args.brandVoice.trim()}` : null,
    `Recording length: ${Math.round(args.recordingDurationSec)} seconds.`,
    args.hasFrames ? "The attached images are frames from the recording, in order. Narrate what they show."
      : "No frames are available; keep the steps general to the brief and avoid specific UI details.",
  ].filter(Boolean).join("\n");
  return { system, user };
}

export async function writeScreenDemoScript(args: { client: OpenAI; model: string;
  requestParams?: Record<string, unknown>; brief: string; recordingDurationSec: number;
  frames: Buffer[]; brandName?: string | null; brandVoice?: string | null; cta?: string | null
}): Promise<{ script: string; parts: ScreenDemoScript; usedFrames: boolean }> {
  const ask = async (frames: Buffer[]) => {
    const prompt = buildScreenDemoScriptPrompt({ ...args, hasFrames: frames.length > 0 });
    const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
      { type: "text", text: prompt.user },
      ...frames.map((frame) => ({ type: "image_url" as const,
        image_url: { url: `data:image/jpeg;base64,${frame.toString("base64")}`, detail: "low" as const } })),
    ];
    const response = await args.client.chat.completions.create({
      model: args.model,
      messages: [{ role: "system", content: prompt.system },
        { role: "user", content: frames.length ? content : prompt.user }],
      max_completion_tokens: 2048,
      response_format: { type: "json_object" },
      ...(args.requestParams ?? {}),
    });
    const parsed = (parseModelJsonObject(response.choices[0]?.message?.content ?? "{}") ?? {}) as
      Partial<Record<keyof ScreenDemoScript, unknown>>;
    return repairScreenDemoScript(parsed, args);
  };
  let parts: ScreenDemoScript;
  let usedFrames = args.frames.length > 0;
  try { parts = await ask(args.frames); }
  catch (error) {
    // Only a model's explicit image-capability rejection warrants losing visual grounding.
    const message = String(error).toLowerCase();
    if (!usedFrames || !/(image|vision|multimodal)/u.test(message)
      || !/(support|unsupported|not available|does not accept|invalid)/u.test(message)) throw error;
    usedFrames = false;
    parts = await ask([]);
  }
  return { script: assembleScreenDemoScript(parts), parts, usedFrames };
}

function ffmpegColor(value?: string | null): string | null {
  const match = /^#?([0-9a-fA-F]{6})$/u.exec(value?.trim() ?? "");
  return match ? `0x${match[1]!.toUpperCase()}` : null;
}

export async function fitScreenDemoClip(args: { recording: Buffer; targetSec: number;
  aspectRatio: VideoAspect; background?: string | null }): Promise<Buffer> {
  return withMedia("kokao-screen-demo-", async (dir) => {
    await writeFile(join(dir, "rec"), args.recording);
    const recordingSec = await probeDurationSec("rec", dir);
    if (!recordingSec || !Number.isFinite(recordingSec))
      throw new VideoGenProviderError("Cannot measure the screen recording.");
    const { width, height } = ASPECT_DIMENSIONS[args.aspectRatio];
    const duration = Math.max(recordingSec, args.targetSec);
    const hold = Math.max(0, args.targetSec - recordingSec);
    const pad = hold > 0.01 ? `,tpad=stop_mode=clone:stop_duration=${hold.toFixed(3)}` : "";
    const fg = `scale=${Math.floor(width * 0.94 / 2) * 2}:${Math.floor(height * 0.94 / 2) * 2}:force_original_aspect_ratio=decrease,setsar=1`;
    const solid = ffmpegColor(args.background);
    const graph = solid
      ? `[0:v]fps=${FPS}${pad},${fg}[fg];color=c=${solid}:s=${width}x${height}:r=${FPS}:d=${duration.toFixed(3)}[bg];[bg][fg]overlay=(W-w)/2:(H-h)/2:shortest=1,format=yuv420p[v]`
      : `[0:v]fps=${FPS}${pad},split[a][b];[a]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},boxblur=24:2,eq=brightness=-0.08[bg];[b]${fg}[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1,format=yuv420p[v]`;
    await runFfmpeg(["-y", "-i", "rec", "-filter_complex", graph, "-map", "[v]", "-an",
      "-t", duration.toFixed(3), "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
      "-pix_fmt", "yuv420p", "demo.mp4"], dir, encodeBudgetMs(duration));
    return readFile(join(dir, "demo.mp4"));
  });
}

export type EndCardAnimation = "fade_up" | "logo_scale" | "slide_in";
export interface EndCardInput {
  width: number; height: number; durationSec: number; animation: EndCardAnimation;
  background?: string | null; logo?: Buffer | null; brandName?: string | null;
  tagline?: string | null; cta?: string | null;
}
export function endCardTextColor(backgroundHex: string): string {
  const match = /^#?([0-9a-fA-F]{6})$/u.exec(backgroundHex.trim());
  if (!match) return "0x1F2937";
  const rgb = Number.parseInt(match[1]!, 16);
  const channel = (value: number) => {
    const s = value / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const light = 0.2126 * channel((rgb >> 16) & 255) +
    0.7152 * channel((rgb >> 8) & 255) + 0.0722 * channel(rgb & 255);
  return light > 0.45 ? "0x1F2937" : "0xFFFFFF";
}
export function endCardLines(input: Pick<EndCardInput, "brandName" | "tagline" | "cta">) {
  return [{ key: "brand", text: input.brandName?.trim() ?? "", scale: 14 },
    { key: "tagline", text: input.tagline?.trim() ?? "", scale: 26 },
    { key: "cta", text: input.cta?.trim() ?? "", scale: 30 }]
    .filter((line) => line.text.length > 0);
}

export async function renderEndCard(input: EndCardInput): Promise<Buffer> {
  return withMedia("kokao-end-card-", async (dir) => {
    const { width, height } = input;
    const duration = Math.max(1.5, Math.min(8, input.durationSec));
    const bgHex = ffmpegColor(input.background) ? input.background!.trim() : "#F4F1EC";
    const bg = ffmpegColor(bgHex)!;
    const ink = endCardTextColor(bgHex);
    const minSide = Math.min(width, height);
    const font = await findFontFile();
    const lines = font ? endCardLines(input) : [];
    const hasLogo = Boolean(input.logo?.length);
    if (hasLogo) await writeFile(join(dir, "logo"), input.logo!);
    const logoH = hasLogo ? Math.round(minSide * (lines.length ? 0.22 : 0.3)) : 0;
    const sizes = lines.map((line) => Math.round(minSide / line.scale));
    const gap = Math.round(minSide * 0.035);
    const blockH = logoH + sizes.reduce((sum, size) => sum + Math.round(size * 1.25), 0) +
      gap * Math.max(0, lines.length + Number(hasLogo) - 1);
    let cursor = Math.round((height - blockH) / 2);
    const logoY = cursor;
    if (hasLogo) cursor += logoH + gap;
    const IN = 0.7;
    const ease = (start: number) => `min(1,max(0,(t-${start})/${IN}))`;
    const rise = (start: number, px: number) => `${px}*(1-${ease(start)})*(1-${ease(start)})`;
    const filters: string[] = [];
    let last = "[0:v]";
    if (hasLogo) {
      const maxLogoW = Math.round(width * 0.6);
      let logoChain = `[1:v]format=rgba,scale=w=${maxLogoW}:h=${logoH}:force_original_aspect_ratio=decrease`;
      let x = "(W-w)/2";
      let y = `${logoY}`;
      if (input.animation === "logo_scale") {
        logoChain += `,scale=w='iw*(0.6+0.4*${ease(0)})':h=-1:eval=frame`;
        y = `${logoY}+(${logoH}-h)/2`;
      } else if (input.animation === "slide_in") {
        x = `(W-w)/2-(W/2+w)*(1-${ease(0)})*(1-${ease(0)})`;
      } else {
        y = `${logoY}+${rise(0, Math.round(minSide * 0.05))}`;
      }
      filters.push(`${logoChain},fade=t=in:st=0:d=${IN}:alpha=1[logo]`);
      filters.push(`${last}[logo]overlay=x='${x}':y='${y}':eval=frame[v0]`);
      last = "[v0]";
    }
    for (const [index, line] of lines.entries()) {
      const file = `line${index}.txt`;
      await writeFile(join(dir, file), line.text.replace(/\r?\n/gu, " "));
      const size = sizes[index]!;
      const start = (hasLogo ? 0.25 : 0) + index * 0.15;
      const yBase = cursor;
      cursor += Math.round(size * 1.25) + gap;
      const y = input.animation === "slide_in" ? `${yBase}` :
        `${yBase}+${rise(start, Math.round(minSide * 0.03))}`;
      const x = input.animation === "slide_in"
        ? `(w-text_w)/2+(w/2+text_w)*(1-${ease(start)})*(1-${ease(start)})`
        : "(w-text_w)/2";
      filters.push(`${last}drawtext=fontfile=${font}:textfile=${file}:fontsize=${size}:fontcolor=${ink}:` +
        `x='${x}':y='${y}':alpha='${ease(start)}'[t${index}]`);
      last = `[t${index}]`;
    }
    filters.push(`${last}fade=t=in:st=0:d=0.25,format=yuv420p[v]`);
    await runFfmpeg(["-y", "-f", "lavfi", "-i",
      `color=c=${bg}:s=${width}x${height}:r=${FPS}:d=${duration.toFixed(3)}`,
      ...(hasLogo ? ["-loop", "1", "-t", duration.toFixed(3), "-i", "logo"] : []),
      "-f", "lavfi", "-t", duration.toFixed(3), "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
      "-filter_complex", filters.join(";"), "-map", "[v]", "-map", `${hasLogo ? 2 : 1}:a`,
      "-t", duration.toFixed(3), "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
      "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "card.mp4"],
    dir, encodeBudgetMs(duration));
    return readFile(join(dir, "card.mp4"));
  });
}

async function probeStreams(file: string, cwd: string): Promise<Array<{
  codec_type: string; width?: number; height?: number
}>> {
  const { stdout } = await execFileAsync("ffprobe",
    ["-v", "error", "-show_streams", "-of", "json", file], { cwd, timeout: 30_000 });
  return JSON.parse(stdout).streams ?? [];
}
export async function appendEndCard(video: Buffer, card: Buffer): Promise<Buffer> {
  return withMedia("kokao-end-card-join-", async (dir) => {
    await writeFile(join(dir, "main.mp4"), video);
    await writeFile(join(dir, "card.mp4"), card);
    const streams = await probeStreams("main.mp4", dir);
    const picture = streams.find((stream) => stream.codec_type === "video");
    if (!picture?.width || !picture.height)
      throw new VideoGenProviderError("Cannot measure the video before adding the end card.");
    const mainSec = await probeDurationSec("main.mp4", dir);
    const cardSec = await probeDurationSec("card.mp4", dir);
    if (!mainSec || !cardSec) throw new VideoGenProviderError("Cannot measure the end card or video.");
    const norm = `fps=${FPS},scale=${picture.width}:${picture.height},setsar=1,format=yuv420p`;
    const audio = "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo";
    const mainHasAudio = streams.some((stream) => stream.codec_type === "audio");
    const graph = [
      `[0:v]${norm}[v0]`, `[1:v]${norm}[v1]`,
      mainHasAudio ? `[0:a]${audio}[a0]` :
        `anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${mainSec.toFixed(3)}[a0]`,
      `[1:a]${audio}[a1]`, "[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]",
    ].join(";");
    await runFfmpeg(["-y", "-i", "main.mp4", "-i", "card.mp4", "-filter_complex", graph,
      "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "veryfast",
      "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k",
      "-movflags", "+faststart", "out.mp4"], dir, encodeBudgetMs(mainSec + cardSec));
    return readFile(join(dir, "out.mp4"));
  });
}

export async function resolveScreenDemoScript(args: {
  screenDemo: { scriptMode: "auto" | "user"; script?: string | null;
    generatedScript?: string | null; recordingDurationSec: number;
    endCard?: { cta?: string | null } | null };
  brief: string; brandName?: string | null; brandVoice?: string | null;
  loadRecording: () => Promise<Buffer>;
  textClient: () => Promise<{ client: OpenAI; model: string; requestParams?: Record<string, unknown> }>;
  onStage?: (stage: string) => void;
}): Promise<{ script: string; generated: boolean }> {
  if (args.screenDemo.scriptMode === "user") {
    const script = args.screenDemo.script?.trim() ?? "";
    const issues = userScreenDemoScriptIssues(script);
    if (issues.length) throw new ScreenDemoInputError(issues.join(" "));
    return { script, generated: false };
  }
  if (args.screenDemo.generatedScript?.trim())
    return { script: args.screenDemo.generatedScript.trim(), generated: false };
  args.onStage?.("Watching your screen recording");
  const frames = await extractDemoFrames(await args.loadRecording());
  args.onStage?.("Writing the walkthrough script");
  const text = await args.textClient();
  const written = await writeScreenDemoScript({
    ...text, brief: args.brief, recordingDurationSec: args.screenDemo.recordingDurationSec,
    frames, brandName: args.brandName, brandVoice: args.brandVoice,
    cta: args.screenDemo.endCard?.cta ?? null,
  });
  return { script: written.script, generated: true };
}