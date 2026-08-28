import { writeFile, readFile, mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { db, videoStyleProfilesTable } from "@workspace/db";
import type { VideoStyleProfilePayload, VideoStyleCaptionStyle } from "@workspace/db";
import { and, eq, or } from "drizzle-orm";
import { getTextGenClient } from "../textGen";
import { usageAccountingParams } from "../aiCost";
import { logger } from "../logger";
import { transcribeAudio } from "../asr";
import { withTimeout } from "./retry";
import { probeDurationSec, runFfmpeg } from "./slideshow";
import { assertTemplateSafe, UnsafeTemplateError } from "./videoTemplates";

/**
 * Reference video → reusable style profile.
 *
 * "Make one like this" is the request behind most short-form briefs, and the
 * reference the user has in mind is usually a video they can point at. This
 * module turns that video into a small structural description: what is
 * measurable is measured with ffmpeg and the transcript (duration, narration
 * speed), and the rest — hook shape, caption treatment, energy, framing — is
 * described by one vision call over evenly-sampled frames.
 *
 * What is deliberately NOT extracted: the reference's footage, audio, music,
 * or wording. A style profile describes *how* a video is built, never *what*
 * it says, so applying one cannot reproduce someone else's content.
 */

/** One vision call, bounded — analysis is interactive, the user is waiting. */
const VISION_TIMEOUT_MS = 90_000;

/** Frames shown to the vision model. Enough to read pacing, cheap enough to
 * stay a single call. */
export const REFERENCE_FRAME_COUNT = 6;

/** Frame height sent to the model; style is legible well below source res. */
const FRAME_HEIGHT = 360;

/** Only the first few minutes are analyzed — style is established early, and
 * ASR providers charge by audio length. */
export const MAX_ANALYZED_SEC = 180;

/** Longest reference we accept at all (a feature-length upload is a mistake). */
export const MAX_REFERENCE_SEC = 60 * 60;

/** Transcript kept for the UI preview. */
const TRANSCRIPT_EXCERPT_CHARS = 400;

export class ReferenceAnalysisError extends Error {}

/** A request may have completed provider-side despite the missing response. */
export class ReferenceProviderIndeterminateError extends ReferenceAnalysisError {
  constructor(message: string) {
    super(message);
    this.name = "ReferenceProviderIndeterminateError";
  }
}

function isConfirmedProviderRejection(error: unknown): boolean {
  const status =
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number"
      ? error.status
      : undefined;
  return (
    status !== undefined &&
    status >= 400 &&
    status < 500 &&
    ![408, 409, 425, 429].includes(status)
  );
}

/**
 * Evenly-spaced sample timestamps across a clip, pulled in from both ends so
 * the first and last frames (fades, end cards) don't dominate the sample.
 */
export function frameTimestamps(durationSec: number, count: number): number[] {
  const total = Number.isFinite(durationSec) ? Math.max(0, durationSec) : 0;
  const n = Math.max(1, Math.trunc(count));
  if (total <= 0) return [0];
  // Sample at the midpoint of n equal slices: for n=6 that is 1/12, 3/12, ...
  const step = total / n;
  return Array.from({ length: n }, (_, i) =>
    Math.min(total, Number((step * (i + 0.5)).toFixed(3))),
  );
}

/** Narration speed from a transcript. 0 when there is nothing to measure. */
export function wordsPerMinute(text: string, durationSec: number): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  if (words === 0 || !Number.isFinite(durationSec) || durationSec <= 0) return 0;
  return Math.round((words / durationSec) * 60);
}

function clampString(value: unknown, max: number, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed ? trimmed.slice(0, max) : fallback;
}

function toCaptionStyle(value: unknown): VideoStyleCaptionStyle {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (text === "none" || text === "no" || text === "off") return "none";
  // Word-by-word / karaoke / kinetic captions all map to our dynamic style;
  // anything else legible becomes sentence subtitles.
  if (text === "dynamic" || text === "word" || text === "karaoke" || text === "kinetic") {
    return "dynamic";
  }
  return "classic";
}

/** Measurements the model must not be allowed to invent. */
export interface ReferenceMeasurements {
  durationSec: number;
  wordsPerMinute: number;
  transcript: string;
}

/**
 * Validate a vision reply into a payload, with the measured numbers layered on
 * top of anything the model said about them. Returns null when the reply is
 * unusable, so callers can treat analysis as failed rather than save noise.
 */
export function parseStyleProfile(
  raw: unknown,
  measured: ReferenceMeasurements,
): VideoStyleProfilePayload | null {
  if (!raw || typeof raw !== "object") return null;
  const reply = raw as Record<string, unknown>;
  const hookShape = clampString(reply.hookShape, 200, "");
  const scriptGuidance = clampString(reply.scriptGuidance, 800, "");
  // A profile with neither a hook nor guidance has nothing to steer with.
  if (!hookShape && !scriptGuidance) return null;

  const rawScenes = Number(reply.sceneCount);
  const sceneCount =
    Number.isFinite(rawScenes) && rawScenes >= 1 ? Math.min(60, Math.trunc(rawScenes)) : 1;
  const duration = Math.max(0, Math.round(measured.durationSec * 10) / 10);
  const avgSceneSec = duration > 0 ? Math.round((duration / sceneCount) * 10) / 10 : 0;

  const notes = Array.isArray(reply.visualNotes) ? reply.visualNotes : [];
  const visualNotes = notes
    .map((note) => clampString(note, 160, ""))
    .filter((note): note is string => note.length > 0)
    .slice(0, 6);

  return {
    version: 1,
    hookShape: hookShape || "opens straight on the subject",
    pacing: { sceneCount, avgSceneSec, wordsPerMinute: measured.wordsPerMinute },
    captionStyle: toCaptionStyle(reply.captionStyle),
    energy: clampString(reply.energy, 60, "neutral"),
    visualNotes,
    scriptGuidance: scriptGuidance || hookShape,
    sourceDurationSec: duration,
    transcriptExcerpt: measured.transcript.trim().slice(0, TRANSCRIPT_EXCERPT_CHARS),
  };
}

/**
 * The block injected into the script prompt when a job carries a style
 * profile. Describes structure only — pacing, hook, sentence length — never
 * the reference's subject matter.
 */
export function buildStyleGuidance(payload: VideoStyleProfilePayload): string {
  const parts: string[] = [];
  if (payload.hookShape) parts.push(`Open the same way: ${payload.hookShape}.`);
  if (payload.energy) parts.push(`Energy: ${payload.energy}.`);
  if (payload.pacing.wordsPerMinute > 0) {
    parts.push(
      `Pace the narration at roughly ${payload.pacing.wordsPerMinute} words per minute.`,
    );
  }
  if (payload.pacing.avgSceneSec > 0) {
    parts.push(
      `The reference cuts about every ${payload.pacing.avgSceneSec}s, so keep sentences short enough to land inside one shot.`,
    );
  }
  if (payload.scriptGuidance) parts.push(payload.scriptGuidance);
  return parts.join(" ");
}

/**
 * Resolve a saved style profile into a script-prompt guidance block, or null.
 * A workspace can use its own reference or a published, safety-checked
 * platform template. Any other row yields no guidance.
 */
export async function loadStyleGuidance(
  tenantId: number,
  styleProfileId: number | null | undefined,
): Promise<string | null> {
  if (!styleProfileId) return null;
  const row = (
    await db
      .select()
      .from(videoStyleProfilesTable)
      .where(
        and(
          eq(videoStyleProfilesTable.id, styleProfileId),
            or(
              eq(videoStyleProfilesTable.tenantId, tenantId),
              and(
                eq(videoStyleProfilesTable.scope, "platform"),
                eq(videoStyleProfilesTable.published, true),
              ),
            ),
        ),
      )
      .limit(1)
  )[0];
  if (!row) return null;
  if (row.scope === "platform") {
    try {
      assertTemplateSafe(row);
    } catch (error) {
      if (error instanceof UnsafeTemplateError) return null;
      throw error;
    }
  }
  const guidance = buildStyleGuidance(row.payload);
  return guidance.trim() ? guidance : null;
}

/** Extract a mono 16 kHz mp3 of the first MAX_ANALYZED_SEC. Null on failure. */
async function extractAudio(dir: string, input: string): Promise<Buffer | null> {
  try {
    await runFfmpeg(
      [
        "-y",
        "-i",
        input,
        "-t",
        String(MAX_ANALYZED_SEC),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-b:a",
        "64k",
        "audio.mp3",
      ],
      dir,
    );
    return await readFile(join(dir, "audio.mp3"));
  } catch (err) {
    // A reference with no audio track is normal (silent b-roll edits).
    logger.warn({ err }, "Reference audio extraction failed; analyzing visuals only");
    return null;
  }
}

/** Grab one downscaled JPEG per timestamp. Frames that fail are skipped. */
async function extractFrames(
  dir: string,
  input: string,
  timestamps: number[],
): Promise<Buffer[]> {
  const frames: Buffer[] = [];
  for (const [index, seconds] of timestamps.entries()) {
    const name = `frame_${String(index).padStart(2, "0")}.jpg`;
    try {
      await runFfmpeg(
        [
          "-y",
          "-ss",
          seconds.toFixed(3),
          "-i",
          input,
          "-frames:v",
          "1",
          "-vf",
          `scale=-2:${FRAME_HEIGHT}`,
          "-q:v",
          "4",
          name,
        ],
        dir,
      );
      frames.push(await readFile(join(dir, name)));
    } catch (err) {
      logger.warn({ err, seconds }, "Reference frame extraction failed; skipping frame");
    }
  }
  return frames;
}

function buildAnalysisPrompt(measured: ReferenceMeasurements, frameCount: number): string {
  const transcriptBlock = measured.transcript.trim()
    ? `\n\n## Transcript of the narration:\n${measured.transcript.trim().slice(0, 4000)}`
    : "\n\n## Transcript: none (no speech detected).";
  return `# Role: Short-form video editor reverse-engineering a style

You are shown ${frameCount} frames sampled evenly across a ${measured.durationSec.toFixed(1)}s short-form video, in chronological order.

Describe the video's STYLE so another video on a completely different subject can be built the same way. Describe structure, pacing, framing, and caption treatment only — never the subject matter, brand, or wording of this specific video.${transcriptBlock}

## Rules:
1. Reply with strict JSON only, exactly this shape:
{"hookShape": "...", "sceneCount": <number>, "captionStyle": "classic" | "dynamic" | "none", "energy": "...", "visualNotes": ["...", "..."], "scriptGuidance": "..."}
2. "hookShape": how the opening seconds grab attention, as a reusable pattern ("question straight to camera", "bold claim over a fast pan").
3. "sceneCount": how many DISTINCT visual scenes you can see across the frames (a lower bound is fine).
4. "captionStyle": "dynamic" if captions appear a word or few words at a time (karaoke/kinetic), "classic" for full-sentence subtitles, "none" if there is no burned-in text.
5. "energy": one or two words ("calm", "high-energy", "punchy and dry").
6. "visualNotes": up to 6 short observations about framing, colour, motion, and text placement.
7. "scriptGuidance": 2-3 sentences telling a script writer how to write for this style — sentence length, tone, how to end. Do not mention this video's topic.`;
}

export interface AnalyzeReferenceParams {
  videoBytes: Buffer;
  /** The tenant's selected text model (must be vision-capable). */
  tenantAiModel: string;
  /**
   * Called immediately after the model returns, before parsing its payload.
   * Wallet-funded callers use this boundary to durably acknowledge paid work.
   */
  onProviderSuccess?: (meta: {
    provider: string;
    model: string;
    inputTokens?: number;
    outputTokens?: number;
  }) => Promise<void>;
}

/**
 * Analyze a reference video into a style profile.
 *
 * Throws ReferenceAnalysisError when the video is unreadable or the vision
 * model gives nothing usable — the caller refunds and reports it, because a
 * blank profile is worse than no profile. Transcription is fail-soft: a silent
 * reference just yields a visual-only profile with wordsPerMinute 0.
 */
export async function analyzeReferenceVideo(
  params: AnalyzeReferenceParams,
): Promise<VideoStyleProfilePayload> {
  const dir = await mkdtemp(join(tmpdir(), "kokao-reference-"));
  try {
    const input = "reference";
    await writeFile(join(dir, input), params.videoBytes);

    const probed = await probeDurationSec(input, dir);
    if (!probed) {
      throw new ReferenceAnalysisError(
        "That file could not be read as a video. Try an MP4 or MOV export.",
      );
    }
    if (probed > MAX_REFERENCE_SEC) {
      throw new ReferenceAnalysisError(
        "That video is too long to analyze. Use a short-form cut (under an hour).",
      );
    }
    // Style lives in the opening minutes; everything downstream measures the
    // analyzed window, not the full file.
    const analyzedSec = Math.min(probed, MAX_ANALYZED_SEC);

    const audio = await extractAudio(dir, input);
    let transcript = "";
    if (audio && audio.length > 0) {
      try {
        const result = await transcribeAudio({
          buffer: audio,
          mimeType: "audio/mpeg",
          filename: "reference.mp3",
        });
        transcript = result.text ?? "";
      } catch (err) {
        // No ASR provider configured, or the provider refused: keep going.
        logger.warn({ err }, "Reference transcription failed; analyzing visuals only");
      }
    }

    const frames = await extractFrames(
      dir,
      input,
      frameTimestamps(analyzedSec, REFERENCE_FRAME_COUNT),
    );
    if (frames.length === 0) {
      throw new ReferenceAnalysisError(
        "No frames could be read from that video. Try re-exporting it as MP4.",
      );
    }

    const measured: ReferenceMeasurements = {
      durationSec: analyzedSec,
      wordsPerMinute: wordsPerMinute(transcript, analyzedSec),
      transcript,
    };

    const textGen = await getTextGenClient(params.tenantAiModel, {
      capability: "multimodal",
    });
    const content: (
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string } }
    )[] = [
      { type: "text", text: buildAnalysisPrompt(measured, frames.length) },
      ...frames.map((frame) => ({
        type: "image_url" as const,
        image_url: { url: `data:image/jpeg;base64,${frame.toString("base64")}` },
      })),
    ];

    let completion;
    try {
      const request = textGen.client.chat.completions
        .create({
            model: textGen.model,
            messages: [
              {
                role: "system",
                content:
                  "You reverse-engineer the style of short-form videos and reply with strict JSON only.",
              },
              { role: "user", content },
            ],
            max_completion_tokens: 2048,
            response_format: { type: "json_object" },
            ...usageAccountingParams(textGen.provider),
          })
        .then(async (result) => {
          await params.onProviderSuccess?.({
            provider: textGen.provider,
            model: textGen.model,
            inputTokens: result.usage?.prompt_tokens,
            outputTokens: result.usage?.completion_tokens,
          });
          return result;
        });
      completion = await withTimeout(
        () => request,
        VISION_TIMEOUT_MS,
        "Reference analysis",
      );
    } catch (err) {
      logger.warn({ err }, "Reference style analysis call failed");
      const message =
        "The AI could not read that video's style. Make sure your text model supports images, then try again.";
      if (isConfirmedProviderRejection(err)) throw new ReferenceAnalysisError(message);
      throw new ReferenceProviderIndeterminateError(message);
    }

    let raw: unknown;
    try {
      raw = JSON.parse(completion.choices[0]?.message?.content ?? "");
    } catch (err) {
      logger.warn({ err }, "Reference style analysis response was not valid JSON");
      throw new ReferenceAnalysisError(
        "The AI could not read that video's style. Make sure your text model supports images, then try again.",
      );
    }

    const payload = parseStyleProfile(raw, measured);
    if (!payload) {
      throw new ReferenceAnalysisError(
        "The AI returned an unusable style description. Please try again.",
      );
    }
    return payload;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
