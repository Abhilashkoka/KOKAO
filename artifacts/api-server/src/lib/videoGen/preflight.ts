import type { VideoJobOptions } from "@workspace/db";
import { isProviderHealthy } from "../providerHealth";
import {
  IMAGE_GEN_PROVIDERS,
  imageGenHealthKey,
  isImageGenProviderConfigured,
} from "../imageGen";
import {
  getVideoGenProviderDef,
  getVideoGenSelection,
  isVideoGenProviderConfigured,
  videoGenHealthKey,
} from "./index";
import {
  stockCandidates,
  stockHealthKey,
  type StockSourceChoice,
} from "./topicVideo/stockSources";
import { TTS_PROVIDERS, isTtsProviderConfigured, ttsHealthKey } from "./topicVideo/tts";

/**
 * Dependency preflight for video jobs.
 *
 * A topic video is a chain of six or seven provider calls that runs for
 * minutes. Discovering at minute four that the platform has no stock-footage
 * key — or that every image provider has been 503-ing for the last two —
 * costs the tenant a queued job, a failure notification, and a refund that
 * only returns the credits, never the wait.
 *
 * So the dependencies are checked BEFORE funding, where refusing is free:
 *  - nothing configured for a capability the job needs  → 400, a platform
 *    misconfiguration the tenant cannot fix but should be told about plainly;
 *  - configured but every candidate's circuit breaker is open → 503, a
 *    "come back in a few minutes" that never touches quota or credits.
 *
 * Deliberately NOT a health probe: no network calls, no latency added to the
 * request. It reads the same in-process breaker state the failover paths
 * already maintain, so it only ever knows what real jobs have already learned.
 *
 * A capability passes as soon as ONE of its interchangeable candidates is
 * healthy — the same bar the runtime failover uses, so preflight never refuses
 * a job that would actually have succeeded.
 */

export interface PreflightIssue {
  /** 400 = a key is missing; 503 = configured but currently failing. */
  status: 400 | 503;
  message: string;
}

/** No configured candidate → 400. All configured, none healthy → 503. */
function evaluate(
  healthKeys: string[],
  unconfigured: string,
  unavailable: string,
): PreflightIssue | null {
  if (healthKeys.length === 0) return { status: 400, message: unconfigured };
  if (healthKeys.some(isProviderHealthy)) return null;
  return { status: 503, message: unavailable };
}

/**
 * ONLY the currently selected video provider — `generateVideo` never fails
 * over to another provider, it only walks a model chain WITHIN the selected
 * one, so counting an unselected-but-healthy provider here would fund jobs
 * the runtime is guaranteed to fail.
 */
async function videoGenKeys(): Promise<string[]> {
  const selection = await getVideoGenSelection();
  const def = getVideoGenProviderDef(selection.provider);
  if (!def) return [];
  return (await isVideoGenProviderConfigured(def)) ? [videoGenHealthKey(def.id)] : [];
}

/**
 * Every configured image provider, since `generateImage` falls back across
 * them. Reference-image support is not filtered here: a provider that cannot
 * take a reference still renders the scene from prompt text, so it affects
 * likeness, not availability.
 */
async function imageGenKeys(): Promise<string[]> {
  const keys: string[] = [];
  for (const def of IMAGE_GEN_PROVIDERS) {
    if (await isImageGenProviderConfigured(def)) keys.push(imageGenHealthKey(def.id));
  }
  return keys;
}

/**
 * Exactly the sources the job will really try — the same list `gatherStockClips`
 * walks, so preflight can neither refuse a job the runtime would have served nor
 * fund one the runtime will reject for a missing key.
 */
async function stockKeys(choice: StockSourceChoice): Promise<string[]> {
  const sources = await stockCandidates(choice);
  return sources.map((source) => stockHealthKey(source.def.id));
}

async function ttsKeys(): Promise<string[]> {
  const keys: string[] = [];
  for (const def of TTS_PROVIDERS) {
    if (await isTtsProviderConfigured(def)) keys.push(ttsHealthKey(def.id));
  }
  return keys;
}

const TRY_AGAIN = "Nothing was charged — please try again in a few minutes.";

/**
 * Check that everything this job will reach is configured and not currently
 * in a failing state. Returns null when the job is safe to fund.
 */
export async function preflightVideoJob(
  engine: string,
  options: VideoJobOptions | null,
): Promise<PreflightIssue | null> {
  const visualsSource = options?.visualsSource ?? "stock";
  const wantsAiMusic = !options?.musicPath && Boolean(options?.musicPrompt?.trim());

  // 1) AI video generation: the two clip engines, and character scenes, which
  //    animate every keyframe.
  const needsVideoGen =
    engine === "text_to_video" ||
    engine === "image_to_video" ||
    (engine === "topic_to_video" && visualsSource === "character");
  if (needsVideoGen) {
    const selectedDef = getVideoGenProviderDef((await getVideoGenSelection()).provider);
    const keyHint = selectedDef?.envKey
      ? ` or set the ${selectedDef.envKey} secret`
      : "";
    const issue = evaluate(
      await videoGenKeys(),
      `AI video generation is not configured: save a ${selectedDef?.label ?? "video provider"} API key in the admin dashboard${keyHint}.`,
      `The AI video provider is not responding right now. ${TRY_AGAIN}`,
    );
    if (issue) return issue;
  }

  // 2) Image generation: AI b-roll scenes, and character keyframes (which are
  //    edits of the locked outfit reference).
  const needsImageGen =
    (engine === "topic_to_video" && (visualsSource === "ai" || visualsSource === "character")) ||
    (engine === "text_to_video" && options?.characterId != null);
  if (needsImageGen) {
    const issue = evaluate(
      await imageGenKeys(),
      "AI image generation is not configured: pick a provider and save its API key in the admin dashboard.",
      `Every configured image provider is failing right now. ${TRY_AGAIN}`,
    );
    if (issue) return issue;
  }

  // 3) Stock footage for a stock-visuals topic video.
  if (engine === "topic_to_video" && visualsSource === "stock") {
    const choice = (options?.stockSource ?? "auto") as StockSourceChoice;
    const issue = evaluate(
      await stockKeys(choice),
      choice === "auto"
        ? "No stock footage source is configured. Add a Pexels or Pixabay API key (free at pexels.com/api or pixabay.com/api/docs) in the admin settings."
        : `The ${choice} stock source is not configured. Add its API key in the admin settings or pick a different source.`,
      choice === "auto"
        ? `Every configured stock footage source is failing right now. ${TRY_AGAIN}`
        : `The ${choice} stock source is failing right now. ${TRY_AGAIN}`,
    );
    if (issue) return issue;
  }

  // 4) Narration: every topic video is spoken.
  if (engine === "topic_to_video") {
    const issue = evaluate(
      await ttsKeys(),
      "Narration is not configured: no text-to-speech provider is available.",
      `Every narration voice provider is failing right now. ${TRY_AGAIN}`,
    );
    if (issue) return issue;
  }

  // 5) An AI music bed runs on Replicate's MusicGen, which shares the video
  //    token — checked separately because a slideshow needs nothing else.
  if (wantsAiMusic && (engine === "topic_to_video" || engine === "slideshow")) {
    const replicate = getVideoGenProviderDef("replicate");
    const configured = replicate ? await isVideoGenProviderConfigured(replicate) : false;
    const issue = evaluate(
      configured ? [videoGenHealthKey("replicate")] : [],
      "AI music needs Replicate: save an API token in the admin dashboard or set the REPLICATE_API_TOKEN secret (uploading a track works without it).",
      `The AI music provider is not responding right now. ${TRY_AGAIN} Uploading your own track works either way.`,
    );
    if (issue) return issue;
  }

  return null;
}
