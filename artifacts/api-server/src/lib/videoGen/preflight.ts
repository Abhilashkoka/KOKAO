import type { VideoJobOptions, VideoPriceCriteria } from "@workspace/db";
import { isProviderHealthy } from "../providerHealth";
import {
  IMAGE_GEN_PROVIDERS,
  imageGenHealthKey,
  isImageGenProviderConfigured,
  getImageGenSelection,
  resolveImageGenProviderDef,
} from "../imageGen";
import {
  getVideoGenProviderDef,
  resolveVideoGenProviderDef,
  getVideoGenSelection,
  isVideoGenProviderConfigured,
  videoGenFailoverProviderIds,
  videoGenHealthKey,
} from "./index";
import {
  stockCandidates,
  stockHealthKey,
  type StockSourceChoice,
} from "./topicVideo/stockSources";
import { TTS_PROVIDERS, isTtsProviderConfigured, ttsHealthKey } from "./topicVideo/tts";
import {
  VOICE_CLONE_PROVIDERS,
  isVoiceCloneProviderConfigured,
} from "../voiceClone";
import { isSarvamConfigured, sarvamTtsHealthKey } from "../sarvamTts";
import { findVideoModel, resolveModelOptions } from "./modelCatalog";
import {
  LATENT_SYNC,
  SYNC_LIPSYNC_2,
  lipSyncModelForQuality,
  portraitLipSyncModel,
} from "./lipSyncModels";
import { isVideoModelPriced } from "../aiCost";
import { effectiveVideoModel } from "./index";
import { videoPriceCriteria } from "./pricing";

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
 * The currently selected video provider PLUS the static providers
 * `generateVideo` can fail over to (configured, with a priced default
 * model — the exact set videoGenFailoverProviderIds computes for the
 * runtime). A job passes when any one of them is healthy, the same bar the
 * runtime uses, so preflight neither refuses a job failover would have
 * served nor funds one the runtime is guaranteed to fail.
 */
async function videoGenKeys(variantCriteria: VideoPriceCriteria): Promise<string[]> {
  const selection = await getVideoGenSelection();
  const def = await resolveVideoGenProviderDef(selection.provider);
  if (!def) return [];
  const keys = (await isVideoGenProviderConfigured(def)) ? [videoGenHealthKey(def.id)] : [];
  for (const id of await videoGenFailoverProviderIds(def.id, variantCriteria)) {
    keys.push(videoGenHealthKey(id));
  }
  return keys;
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
  // An admin-added custom provider never appears in the static catalog, but
  // when it is the current selection the runtime WILL route to it first — so
  // count it, or a deployment configured with only a custom provider would be
  // refused jobs it can serve.
  const selection = await getImageGenSelection();
  if (selection.provider.startsWith("custom:")) {
    const def = await resolveImageGenProviderDef(selection.provider);
    if (def && (await isImageGenProviderConfigured(def))) keys.push(imageGenHealthKey(def.id));
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

function modeForVideoJob(
  engine: string,
  options: VideoJobOptions | null,
): "text" | "image" {
  return (
    (engine === "text_to_video" && options?.characterId == null) ||
    (engine === "dialogue_lip_sync" && !options?.characterDialogue)
  )
    ? "text"
    : "image";
}

/**
 * Check that everything this job will reach is configured and not currently
 * in a failing state. Returns null when the job is safe to fund.
 */
export async function preflightVideoJob(
  engine: string,
  options: VideoJobOptions | null,
): Promise<PreflightIssue | null> {
  const visualsSource = options?.visualsSource ?? "stock";
  const isPresenterBroll = Boolean(options?.presenterVideoPath && options?.videoTemplateId);
  const wantsAiMusic = !options?.musicPath && Boolean(options?.musicPrompt?.trim());
  const modelOptions = resolveModelOptions(options, 5);
  const genericCriteria = videoPriceCriteria(modelOptions);

  // 1) AI video generation: the two clip engines, and character scenes, which
  //    animate every keyframe.
  const needsVideoGen =
    engine === "text_to_video" ||
    engine === "image_to_video" ||
    engine === "dialogue_lip_sync" ||
    (engine === "topic_to_video" &&
      !isPresenterBroll &&
      (visualsSource === "character" || visualsSource === "ai_video"));
  if (needsVideoGen) {
    const frozen = options?.resolvedVideoModel;
    if (frozen) {
      if (frozen.mode !== modeForVideoJob(engine, options)) {
        return {
          status: 400,
          message: `Frozen video model ${frozen.provider}/${frozen.model} is incompatible with this job mode.`,
        };
      }
      const frozenDef = await resolveVideoGenProviderDef(frozen.provider);
      if (!frozenDef || !(await isVideoGenProviderConfigured(frozenDef))) {
        return {
          status: 400,
          message: `Frozen video provider ${frozen.provider} is not configured for model ${frozen.model}.`,
        };
      }
      const frozenDurations = frozen.permittedDurationSec ?? [frozen.durationSec];
      if (!(await Promise.all(frozenDurations.map((durationSec) => isVideoModelPriced({
        provider: frozen.provider,
        model: frozen.model,
        durationSec: Math.max(0.1, durationSec),
        variantCriteria: videoPriceCriteria(frozen),
      }).catch(() => false)))).every(Boolean)) {
        return {
          status: 400,
          message: `Frozen video model ${frozen.provider}/${frozen.model} has no authoritative provider-specific price for this variant.`,
        };
      }
      const health = evaluate(
        [videoGenHealthKey(frozen.provider)],
        `Frozen video provider ${frozen.provider} is not configured.`,
        `The selected video model ${frozen.provider}/${frozen.model} is not responding right now. ${TRY_AGAIN}`,
      );
      if (health) return health;
    }
    // A PICKED model pins the provider for this job: failover to a different
    // provider would silently serve a different model than the tenant paid a
    // premium multiplier for, so the picked model's provider must itself be
    // configured and healthy. Checked before funding, like everything here.
    const picked = frozen ? null : findVideoModel(options?.modelId);
    const mode = modeForVideoJob(engine, options);
    if (picked) {
      const pickedProvider = getVideoGenProviderDef(picked.provider);
      const pickedModel = picked.models[mode];
      if (
        !pickedModel ||
        !(await isVideoModelPriced({
          provider: picked.provider,
          model: pickedModel,
          durationSec: Math.max(0.1, options?.durationSec ?? 5),
          variantCriteria: genericCriteria,
        }).catch(() => false))
      ) {
        return {
          status: 400,
          message: `${picked.label} pricing is unavailable. Ask an administrator to configure its exact provider price before generating.`,
        };
      }
      const configured = pickedProvider
        ? await isVideoGenProviderConfigured(pickedProvider)
        : false;
      const issue = evaluate(
        configured ? [videoGenHealthKey(picked.provider)] : [],
        `${picked.label} runs on ${pickedProvider?.label ?? picked.provider}, which is not configured. Pick a different model, or ask an admin to save that provider's API key.`,
        `${picked.label} is not responding right now. ${TRY_AGAIN} Picking a different model works immediately.`,
      );
      if (issue) return issue;
    }
    const selectedDef = frozen
      ? null
      : await resolveVideoGenProviderDef((await getVideoGenSelection()).provider);
    if (!picked && selectedDef) {
      const selection = await getVideoGenSelection();
      const selectedModel = effectiveVideoModel(
        selectedDef,
        mode,
        mode === "text" ? selection.textToVideoModel : selection.imageToVideoModel,
      );
      if (
        !(await isVideoModelPriced({
          provider: selectedDef.id,
          model: selectedModel,
          durationSec: Math.max(0.1, options?.durationSec ?? 5),
          variantCriteria: genericCriteria,
        }).catch(() => false))
      ) {
        return {
          status: 400,
          message: `AI video model ${selectedDef.id}/${selectedModel} has no authoritative price. Ask an administrator to configure it before generating.`,
        };
      }
    }
    const keyHint = selectedDef?.envKey
      ? ` or set the ${selectedDef.envKey} secret`
      : "";
    const issue = frozen || picked
      ? null
      : evaluate(
          await videoGenKeys(genericCriteria),
          `AI video generation is not configured: save a ${selectedDef?.label ?? "video provider"} API key in the admin dashboard${keyHint}.`,
          `The AI video provider is not responding right now. ${TRY_AGAIN}`,
        );
    if (issue) return issue;
  }

  // 2) Image generation: AI b-roll scenes, and character keyframes (which are
  //    edits of the locked outfit reference).
  const needsImageGen =
    (engine === "topic_to_video" &&
      (visualsSource === "ai" || visualsSource === "ai_video" || visualsSource === "character")) ||
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
  if (engine === "topic_to_video" && !isPresenterBroll) {
    const issue = evaluate(
      await ttsKeys(),
      "Narration is not configured: no text-to-speech provider is available.",
      `Every narration voice provider is failing right now. ${TRY_AGAIN}`,
    );
    if (issue) return issue;
  }

  // 4b) Lip-sync runs on Replicate's LatentSync (pinned — the video+audio
  //     input contract IS the feature) and speaks the script first, so it
  //     needs the Replicate token and a narration provider.
  if (engine === "lip_sync" || engine === "dialogue_lip_sync") {
    const replicate = getVideoGenProviderDef("replicate");
    const configured = replicate ? await isVideoGenProviderConfigured(replicate) : false;
    const issue = evaluate(
      configured ? [videoGenHealthKey("replicate")] : [],
      "Lip-synced videos need Replicate: save an API token in the admin dashboard or set the REPLICATE_API_TOKEN secret.",
      `The lip-sync provider is not responding right now. ${TRY_AGAIN}`,
    );
    if (issue) return issue;
    // Portrait mode needs a model that takes an IMAGE plus audio, and there
    // is no safe default to pin — so refuse here, before funding, with the
    // one thing an admin has to do rather than a failed job four minutes in.
    let selectedLipSyncModel: string;
    if (options?.sourceImagePath) {
      const { lipSyncPortraitModel: configuredModel } = await getVideoGenSelection();
      if (!portraitLipSyncModel(configuredModel)) {
        return {
          status: 400,
          message:
            "Portrait lip sync is not set up yet: an admin needs to save a portrait lip-sync model in the video settings. Uploading a video works today.",
        };
      }
      selectedLipSyncModel = configuredModel!;
    } else if (options?.characterDialogue?.lipSyncModel === SYNC_LIPSYNC_2.model) {
      selectedLipSyncModel = SYNC_LIPSYNC_2.model;
    } else if (options?.characterDialogue?.lipSyncModel === LATENT_SYNC.model) {
      selectedLipSyncModel = LATENT_SYNC.model;
    } else {
      selectedLipSyncModel = lipSyncModelForQuality(options?.lipSyncQuality).model;
    }
    if (
      !(await isVideoModelPriced({
        provider: "replicate",
        model: selectedLipSyncModel,
        durationSec: Math.max(0.1, options?.durationSec ?? 5),
        variantCriteria: videoPriceCriteria({
          hasReferenceVideo: Boolean(options?.sourceVideoPath),
        }),
      }).catch(() => false))
    ) {
      return {
        status: 400,
        message: `Lip-sync model replicate/${selectedLipSyncModel} has no authoritative price. Ask an administrator to configure it before generating.`,
      };
    }
    // Text-to-speech is only reached when there is a script to voice. A job
    // that brought its own recording must not be refused for a missing TTS
    // provider it will never call.
    if (!options?.audioPath) {
      const tts = evaluate(
        await ttsKeys(),
        "Narration is not configured: no text-to-speech provider is available.",
        `Every narration voice provider is failing right now. ${TRY_AGAIN}`,
      );
      if (tts) return tts;
    }
  }

  // Optional Studio finishing is a separately frozen operation. It uses the
  // snapshot model rather than mutable admin defaults and is checked before
  // the base job reserves any funding.
  if (options?.studioLipSync) {
    const snapshot = options.studioLipSync;
    if (
      engine === "lip_sync" ||
      engine === "dialogue_lip_sync" ||
      engine === "slideshow" ||
      snapshot.plan.length === 0 ||
      !snapshot.consent.likeness ||
      !snapshot.consent.voice
    ) {
      return {
        status: 400,
        message: "The optional lip-sync scene plan is incompatible or lacks consent.",
      };
    }
    const replicate = getVideoGenProviderDef("replicate");
    const configured = replicate ? await isVideoGenProviderConfigured(replicate) : false;
    const issue = evaluate(
      configured ? [videoGenHealthKey("replicate")] : [],
      "Optional Studio lip-sync needs Replicate configured before generation.",
      `The optional lip-sync provider is not responding right now. ${TRY_AGAIN}`,
    );
    if (issue) return issue;
    const durations = snapshot.plan.map((scene) => scene.durationSec);
    if (!(await Promise.all(durations.map((durationSec) =>
      isVideoModelPriced({
        provider: snapshot.provider,
        model: snapshot.model,
        durationSec,
        variantCriteria: videoPriceCriteria({ hasReferenceVideo: true }),
      }).catch(() => false),
    ))).every(Boolean)) {
      return {
        status: 400,
        message: `Optional lip-sync model ${snapshot.provider}/${snapshot.model} has no authoritative price for every planned scene.`,
      };
    }
  }

  // 4c) Localized dub: always needs Replicate (LatentSync lip-sync).
  //     Additionally needs either:
  //       stock      → the selected stock TTS provider (OpenAI or Sarvam)
  //       brand_voice → ElevenLabs voice-clone key
  //       source_voice → ElevenLabs Dubbing key (same credential)
  if (engine === "localized_dub") {
    // Replicate is always required (for LatentSync).
    const replicate = getVideoGenProviderDef("replicate");
    const replicateConfigured = replicate ? await isVideoGenProviderConfigured(replicate) : false;
    const replicateIssue = evaluate(
      replicateConfigured ? [videoGenHealthKey("replicate")] : [],
      "Localized dubbing requires Replicate: save an API token in the admin dashboard or set the REPLICATE_API_TOKEN secret.",
      `The lip-sync provider (Replicate) is not responding right now. ${TRY_AGAIN}`,
    );
    if (replicateIssue) return replicateIssue;
    if (
      !(await isVideoModelPriced({
        provider: "replicate",
        model: LATENT_SYNC.model,
        durationSec: Math.max(0.1, options?.durationSec ?? 5),
        variantCriteria: videoPriceCriteria({ hasReferenceVideo: true }),
      }).catch(() => false))
    ) {
      return {
        status: 400,
        message: `Lip-sync model replicate/${LATENT_SYNC.model} has no authoritative price. Ask an administrator to configure it before generating.`,
      };
    }

    const voiceMode = options?.localizedTrack?.voiceMode ?? "stock";

    if (voiceMode === "brand_voice" || voiceMode === "source_voice") {
      // Both brand_voice and source_voice require the ElevenLabs key.
      const elDef = VOICE_CLONE_PROVIDERS.find((p) => p.id === "elevenlabs");
      const elConfigured = elDef ? await isVoiceCloneProviderConfigured(elDef) : false;
      const label =
        voiceMode === "brand_voice"
          ? "Brand-voice dubbing requires the ElevenLabs API key (for the cloned voice). Add it in the admin dashboard."
          : "Source-voice dubbing requires the ElevenLabs API key (for the Dubbing API). Add it in the admin dashboard.";
      const elIssue = evaluate(
        elConfigured ? ["voice_clone:elevenlabs"] : [],
        label,
        `The ElevenLabs voice provider is not responding right now. ${TRY_AGAIN}`,
      );
      if (elIssue) return elIssue;
    } else {
      // stock mode: check the selected stock TTS provider (not the full registry —
      // Deepgram Aura is English-only and is NOT valid for Indic dubbing).
      const localizedTrackProvider = options?.localizedTrack?.provider ?? "openai";
      const ttsDef = TTS_PROVIDERS.find((p) => p.id === localizedTrackProvider);
      const ttsConfigured =
        localizedTrackProvider === "sarvam"
          ? await isSarvamConfigured()
          : ttsDef
            ? await isTtsProviderConfigured(ttsDef)
            : false;
      const healthKey =
        localizedTrackProvider === "sarvam"
          ? sarvamTtsHealthKey()
          : ttsHealthKey(localizedTrackProvider);
      const ttsIssue = evaluate(
        ttsConfigured ? [healthKey] : [],
        `Localized dubbing requires the ${localizedTrackProvider} TTS provider, which is not configured.`,
        `The ${localizedTrackProvider} TTS provider is not responding right now. ${TRY_AGAIN}`,
      );
      if (ttsIssue) return ttsIssue;
    }
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
