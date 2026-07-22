import { db, tenantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../../logger";
import { VideoGenProviderError, type VideoAspect } from "../types";
import { generateTopicScript } from "./script";
import { splitIntoSentences, synthesizeNarration, type NarrationVoice } from "./narration";
import {
  resolveStockSource,
  searchStockClips,
  downloadStockClip,
  type StockSourceChoice,
  type StockClip,
} from "./stockSources";
import { composeTopicVideo } from "./compose";

export { NARRATION_VOICES, type NarrationVoice } from "./narration";
export {
  STOCK_SOURCES,
  getStockSourceDef,
  isStockSourceConfigured,
  getStockKeySource,
  setStoredStockKey,
  clearStoredStockKey,
  type StockSourceChoice,
  type StockSourceDef,
  type StockKeySource,
} from "./stockSources";

/**
 * Topic to Video: topic → AI script → stock footage → TTS narration →
 * subtitles → one composed MP4. The pipeline design is ported from
 * MoneyPrinterTurbo (MIT, https://github.com/harry0703/MoneyPrinterTurbo),
 * reimplemented natively on this codebase's textGen routing, OpenAI audio
 * integration, and ffmpeg composition.
 */

/** Overall wall-clock budget for one topic video (LLM + TTS + downloads + encode). */
export const TOPIC_VIDEO_TOTAL_DEADLINE_MS = 10 * 60 * 1000;

/** Distinct stock clips to download; scenes cycle through them. */
const MAX_STOCK_CLIPS = 6;

export interface TopicVideoParams {
  tenantId: number;
  topic: string;
  aspectRatio: VideoAspect;
  voice: NarrationVoice;
  stockSource: StockSourceChoice;
  subtitles: boolean;
  paragraphCount: number;
  music?: Buffer | null;
}

export interface TopicVideoResult {
  buffer: Buffer;
  /** The stock source that supplied the footage. */
  provider: string;
  /** The text model that wrote the script. */
  model: string;
}

function checkDeadline(startedAt: number): void {
  if (Date.now() - startedAt > TOPIC_VIDEO_TOTAL_DEADLINE_MS) {
    throw new VideoGenProviderError(
      "Topic video generation timed out. Try a shorter length, or try again.",
    );
  }
}

/**
 * Gather up to MAX_STOCK_CLIPS distinct clips, round-robining across search
 * terms so the footage follows the script's visual order. Search or download
 * failures for one term never sink the job while any clip is available.
 */
async function gatherStockClips(
  stockSource: StockSourceChoice,
  searchTerms: string[],
  aspect: VideoAspect,
  neededScenes: number,
  startedAt: number,
): Promise<{ clips: Buffer[]; provider: string }> {
  const { def, apiKey } = await resolveStockSource(stockSource);
  const wanted = Math.max(1, Math.min(MAX_STOCK_CLIPS, neededScenes));

  const perTerm: StockClip[][] = [];
  for (const term of searchTerms) {
    checkDeadline(startedAt);
    try {
      perTerm.push(await searchStockClips(def, apiKey, term, aspect));
    } catch (err) {
      logger.warn({ err, term, source: def.id }, "stock search failed for term");
      perTerm.push([]);
    }
  }

  // Interleave: first candidate of each term, then second of each, ...
  const seenUrls = new Set<string>();
  const candidates: StockClip[] = [];
  const deepest = Math.max(0, ...perTerm.map((list) => list.length));
  for (let depth = 0; depth < deepest; depth++) {
    for (const list of perTerm) {
      const clip = list[depth];
      if (clip && !seenUrls.has(clip.url)) {
        seenUrls.add(clip.url);
        candidates.push(clip);
      }
    }
  }
  if (candidates.length === 0) {
    throw new VideoGenProviderError(
      `No stock footage found on ${def.label} for this topic. Try rephrasing it.`,
    );
  }

  const clips: Buffer[] = [];
  for (const candidate of candidates) {
    if (clips.length >= wanted) break;
    checkDeadline(startedAt);
    try {
      clips.push(await downloadStockClip(candidate));
    } catch (err) {
      logger.warn({ err, url: candidate.url }, "stock clip download failed; trying next");
    }
  }
  if (clips.length === 0) {
    throw new VideoGenProviderError(
      `Could not download any stock footage from ${def.label}. Please try again.`,
    );
  }
  return { clips, provider: def.id };
}

export async function generateTopicVideo(params: TopicVideoParams): Promise<TopicVideoResult> {
  const startedAt = Date.now();
  const topic = params.topic.trim();
  if (!topic) {
    throw new VideoGenProviderError("A topic is required.");
  }

  const tenant = (
    await db.select().from(tenantsTable).where(eq(tenantsTable.id, params.tenantId)).limit(1)
  )[0];
  if (!tenant) {
    throw new VideoGenProviderError("Tenant not found.");
  }

  // 1) Script + ordered stock search terms in one completion.
  const { script, searchTerms, model } = await generateTopicScript({
    tenantAiModel: tenant.aiModel,
    topic,
    paragraphCount: params.paragraphCount,
  });
  checkDeadline(startedAt);

  // 2) Sentence-level narration with exact timings.
  const sentences = splitIntoSentences(script);
  if (sentences.length === 0) {
    throw new VideoGenProviderError("The AI returned an empty script. Please try again.");
  }
  const narration = await synthesizeNarration(sentences, params.voice);
  checkDeadline(startedAt);

  // 3) Stock footage to cover every scene.
  const { clips, provider } = await gatherStockClips(
    params.stockSource,
    searchTerms,
    params.aspectRatio,
    narration.cues.length,
    startedAt,
  );
  checkDeadline(startedAt);

  // 4) Compose.
  const buffer = await composeTopicVideo({
    clips,
    narrationWav: narration.wav,
    cues: narration.cues,
    totalDurationSec: narration.totalDurationSec,
    aspectRatio: params.aspectRatio,
    subtitles: params.subtitles,
    music: params.music ?? null,
  });
  return { buffer, provider, model };
}
