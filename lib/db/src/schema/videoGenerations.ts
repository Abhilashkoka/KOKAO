import {
  pgTable,
  text,
  serial,
  integer,
  timestamp,
  jsonb,
} from "drizzle-orm/pg-core";
import type { ResolvedCreativeBrief } from "./creativeDirection";
import type { VideoPriceCriteria } from "./aiCost";

/**
 * One row per video generation job. Video generation is long-running (AI
 * providers can take minutes; the slideshow encoder is CPU-bound), so the
 * request only creates this row and the work runs as an in-process background
 * job (lib/backgroundJobs.ts) that persists its own progress here. Clients
 * poll GET /ai/video-jobs/{id} until status is succeeded or failed.
 *
 * status: queued | processing | awaiting_review | succeeded | failed
 * engine: text_to_video | image_to_video | slideshow | topic_to_video |
 * dialogue_lip_sync
 *
 * awaiting_review is the storyboard pause: the job planned its scenes, voiced
 * the narration and generated a preview still per scene, then stopped before
 * the expensive half so the user can edit the plan. Approving resumes it.
 */

/**
 * Output aspect ratios. Kept in lockstep with VideoAspect on the api-server
 * (lib/videoGen/types.ts), which owns the pixel dimensions for each. Rows
 * written before a ratio existed simply never carry it, so widening this is
 * additive and needs no migration.
 */
export type VideoJobAspect = "16:9" | "9:16" | "1:1" | "4:5" | "4:3" | "3:4" | "21:9";

export type VideoDurationMode = "script_derived";
export type VideoScriptDetailLevel = "concise" | "standard" | "detailed";
export type VideoVisualStrategy = "stock" | "ai" | "ai_video" | "character";

/** Immutable long-form template settings resolved and snapshotted at enqueue. */
export interface VideoTemplateRuntimeSettings {
  durationMode: VideoDurationMode;
  maxDurationSeconds: number;
  speakingRateWpm: number;
  scriptDetailLevel: VideoScriptDetailLevel;
  minSceneDurationSeconds: number;
  maxSceneDurationSeconds: number;
  minSceneCount: number;
  maxSceneCount: number;
  visualStrategy: VideoVisualStrategy;
}

/** Options captured at enqueue time so the job is fully self-describing. */
export interface VideoJobOptions {
  /**
   * Immutable hybrid character-story contract captured from a portable
   * platform template at enqueue. Character/outfit/voice are tenant values
   * resolved by the route; the template contributes roles only.
   */
  hybridStory?: {
    version: 1;
    pattern: Array<{
      kind: "character_opening" | "story_animation" | "character_interlude" | "character_closing";
      maxDurationSeconds: number;
    }>;
    characterId: number;
    outfitId: number;
    /** Server-authored identity inputs, frozen at enqueue for deterministic retries. */
    characterSnapshot?: {
      referenceImagePath: string;
      characterName: string;
      characterDescription: string;
      outfitReferenceImagePath: string;
      outfitName: string;
      outfitDescription: string;
    };
    lipSyncConsent: true;
  } | null;
  /**
   * Local-only recomposition of a completed Topic Video. Repair children never
   * reserve funding or call providers; they reuse the source row's immutable
   * narration, scene checkpoints, music, and visual settings.
   */
  repair?: {
    version: 1;
    chainId: number;
    sourceJobId: number;
    reason: "narration" | "music" | "captions" | "scene_timing" | "audio_visual";
    state: "queued" | "processing" | "succeeded" | "failed";
  } | null;
  /**
   * Funding snapshot for native topic templates. The first unit pays only for
   * planning; once the immutable board exists, `fundedUnits` is replaced with
   * that planning unit plus the board's actual visual workload.  It prevents
   * later narration timing or template edits from changing what was funded.
   */
  storyboardFunding?: {
    version: 1;
    sceneCount: number | null;
    /** Exact full job requirement after the immutable scene plan exists. */
    requiredUnits: number | null;
    /** Units actually held so far (the initial planning slice on shortfall). */
    fundedUnits: number;
    planningUnits: number;
  } | null;
  /** Resolved template settings. Absent on jobs created before long-form templates. */
  templateRuntime?: VideoTemplateRuntimeSettings | null;
  /** Complete post-provider render, durable across finalization/upload retries. */
  renderCheckpoint?: {
    /** provider_raw is normalized/composed on resume; final is ready to deliver. */
    stage?: "provider_raw" | "final";
    path: string;
    provider: string | null;
    model: string | null;
    durationSec: number;
    providerEvents: Array<{
      eventId?: string;
      provider: string;
      model: string;
      durationSec: number | null;
      requestBytes: number;
      label: string;
      costPaise: number | null;
      criteria?: VideoPriceCriteria;
      accounted?: boolean;
      unitWeight?: number;
    }>;
  } | null;
  /** Generic MusicGen checkpoint for engines outside dialogue/presenter flows. */
  musicCheckpoint?: {
    path: string;
    provider: string;
    model: string;
    durationSec: number;
    event: {
      eventId?: string;
      provider: string;
      model: string;
      durationSec: number | null;
      requestBytes: number;
      label: string;
      costPaise: number | null;
      criteria?: VideoPriceCriteria;
      accounted?: boolean;
      unitWeight?: number;
    };
  } | null;
  /**
   * Generic, immutable retry-chain snapshot. This lives on retry children only:
   * failed source rows are never edited to point at their child. `chainId`
   * remains the first failed job for durable provider-event and billing
   * identity, while `sourceJobId` is the immediate failed parent.
   */
  recovery?: {
    version: 1;
    chainId: number;
    sourceJobId: number;
    fundedUnits: number;
    mode: "resume" | "saved_inputs";
    state: "creating" | "queued";
    reusable: string[];
    regenerated: string[];
    /**
     * A complete post-provider render. It is written before terminal job
     * settlement, allowing DB/thumbnail/finalization failures to finish with
     * no provider regeneration.
     */
    rendered?: {
      path: string;
      provider: string | null;
      model: string | null;
      durationSec: number;
      providerEvents: Array<{
        eventId?: string;
        provider: string;
        model: string;
        durationSec: number | null;
        requestBytes: number;
        label: string;
        costPaise: number | null;
        criteria?: VideoPriceCriteria;
        accounted?: boolean;
        unitWeight?: number;
      }>;
    } | null;
  } | null;
  /** Output aspect ratio; drives the encode/prediction resolution. */
  aspectRatio: VideoJobAspect;
  /** AI engines: requested clip length in seconds. */
  durationSec?: number;
  /**
   * Named camera-motion preset applied to every AI shot in this job
   * (lib/videoGen/motionPresets.ts). Null/absent = the built-in "subtle
   * natural motion" instruction, exactly as before presets existed. A
   * storyboard scene may override it per shot.
   */
  motionPreset?: string | null;
  /**
   * Deterministic sampling seed for the job's AI generations. Null/absent =
   * the provider picks, which is what every job did before seeds existed.
   * Only families whose schema carries a seed are ever sent one.
   */
  seed?: number | null;
  /**
   * Optics for every AI shot in this job: which camera body, lens, focal
   * length and aperture it is "shot on" (lib/videoGen/cinematography.ts).
   * Each axis is independently optional; null/absent adds nothing to the
   * prompt, exactly as before cinematography existed.
   */
  cinematography?: {
    camera?: string | null;
    lens?: string | null;
    focalLengthMm?: number | null;
    aperture?: string | null;
  } | null;
  /**
   * The catalog model this job picked (lib/videoGen/modelCatalog.ts on the
   * api-server). Null/absent = the platform-wide admin selection, which is
   * what every job used before per-generation model choice existed — and
   * which is also why an absent value must keep costing exactly one unit per
   * generation. See videoJobUnits().
   */
  modelId?: string | null;
  /** Requested output resolution ("480p" | "720p" | "1080p"). Null = the best
   * the chosen model offers, which is what jobs delivered before tiers. */
  resolution?: string | null;
  /** Quality switch on models that expose one ("basic" | "high"). */
  quality?: string | null;
  /** Ask the model for its own audio (dialogue, SFX) where it can. Null =
   * whatever the model does by default, which is today's behaviour. */
  generateAudio?: boolean | null;
  /** text_to_video: how many shots the storyboard splits the brief into. Each
   * shot is its own AI generation, so this is also the job's unit cost — it is
   * fixed at enqueue time (the reservation is made from it) and the storyboard
   * editor cannot add or remove shots afterwards. */
  shotCount?: number;
  /** Slideshow: seconds each photo is on screen. */
  slideDurationSec?: number;
  /** Slideshow: optional caption burned into the video. */
  overlayText?: string | null;
  /** Slideshow + topic_to_video: optional /objects/... path of a music track. */
  musicPath?: string | null;
  /** Slideshow + topic_to_video: AI-composed music bed description (used
   * only when musicPath is null; costs one extra video unit). */
  musicPrompt?: string | null;
  /** topic_to_video + lip_sync: narration voice. */
  voice?: string;
  /** lip_sync + localized_dub: /objects/... path of the tenant's own base
   * video. lip_sync redraws the mouth; localized_dub replaces the audio track
   * and burns subtitles. */
  sourceVideoPath?: string | null;
  /** topic_to_video curated presenter-overlay format: tenant-owned continuous
   * talking-to-camera take. Its original audio is the narration track. */
  presenterVideoPath?: string | null;
  /** Curated platform template selected at enqueue time. Null for ordinary
   * topic videos and tenant reference styles. */
  videoTemplateId?: number | null;
  /** Immutable creative intent resolved at enqueue time. Absent on legacy jobs. */
  resolvedCreativeBrief?: ResolvedCreativeBrief | null;
  /** Durable presenter render snapshot. Planned once, then reused by review,
   * approval and retries so stock searches / image generations never drift. */
  presenterBroll?: {
    version: 1;
    durationMs: number;
    lines: Array<{
      index: number;
      startMs: number;
      endMs: number;
      text: string;
    }>;
    beats: Array<{
      id: string;
      startMs: number;
      endMs: number;
      query: string;
      kind: "graphic" | "lifestyle" | "product" | "data";
      opacity: number;
      lineIndexes: number[];
      /** Null only between the pre-funding timeline plan and the runner's
       * durable asset-resolution step. Each resolved beat is checkpointed. */
      assetPath: string | null;
      /** Tenant-owned poster/image shown during review. */
      previewPath: string | null;
      assetKind: "video" | "image";
      provider: string | null;
    }>;
    /** Paid generated-image events completed while resolving B-roll. Kept on
     * the snapshot so retries and partial-failure settlement never lose spend. */
    providerEvents?: Array<{
      eventId?: string;
      provider: string;
      model: string;
      durationSec: number | null;
      requestBytes: number;
      label: string;
      costPaise: number | null;
      criteria?: VideoPriceCriteria;
      accounted?: boolean;
      unitWeight?: number;
    }>;
    notes: string[];
  } | null;
  /** Durable MusicGen checkpoint for an uploaded presenter template. */
  presenterMusicCheckpoint?: {
    path?: string;
    provider: string;
    model: string;
    durationSec: number;
    event: {
      eventId?: string;
      provider: string;
      model: string;
      durationSec: number | null;
      requestBytes: number;
      label: string;
      costPaise: number | null;
      criteria?: VideoPriceCriteria;
      accounted?: boolean;
      unitWeight?: number;
    };
  } | null;
  /** lip_sync PORTRAIT mode: /objects/... path of a single headshot whose
   * mouth is animated to the voice track. Mutually exclusive with
   * sourceVideoPath; the route enforces exactly one. */
  sourceImagePath?: string | null;
  /** lip_sync: /objects/... path of an uploaded voice track. When set the
   * script is not synthesised — a real recording speaks instead. */
  audioPath?: string | null;
  /** lip_sync: the user confirmed the footage is their own (or used with
   * permission). Checked at the route; persisted for the audit trail. */
  lipSyncConsent?: boolean;
  /** Video-source lip sync and dialogue: Standard uses pinned LatentSync;
   * High uses Replicate's official sync/lipsync-2 model. Absent = Standard so
   * existing queued jobs and retries keep their original behavior. */
  lipSyncQuality?: "standard" | "high";
  /** dialogue_lip_sync: exact single-speaker text spoken by the generated
   * person. The row prompt remains the visual-generation prompt. */
  dialogue?: string | null;
  /** dialogue_lip_sync: explicit authorization to create the described AI
   * person/likeness and make them appear to speak the dialogue. */
  aiPersonConsent?: boolean;
  /** Immutable multilingual saved-character dialogue render plan. */
  characterDialogue?: {
    version: 1;
    scriptApproved: true;
    /**
     * Replicate model frozen at enqueue time. Absent on legacy rows, which
     * intentionally continue through the original LatentSync path.
     */
    lipSyncModel?: "bytedance/latentsync" | "sync/lipsync-2";
    locale: string;
    modelId: "eleven_v3";
    direction: "ltr" | "rtl";
    script: string;
    fontCandidates: string[];
    scriptName: string;
    characterId: number;
    outfitId: number;
    brandKitId: number;
    scenes: Array<{
      id: string;
      text: string;
      visualPrompt: string;
      estimatedDurationSec: number;
      checkpoint?: {
        narrationPath?: string;
        narrationDurationSec?: number;
        platePath?: string;
        visualEvent?: { eventId?: string; provider: string; model: string; durationSec: number | null; requestBytes: number; label: string; costPaise: number | null; criteria?: VideoPriceCriteria; accounted?: boolean; unitWeight?: number };
        lipSyncPath?: string;
        lipSyncEvent?: { eventId?: string; provider: string; model: string; durationSec: number | null; requestBytes: number; label: string; costPaise: number | null; criteria?: VideoPriceCriteria; accounted?: boolean; unitWeight?: number };
      };
    }>;
    musicCheckpoint?: {
      path?: string;
      provider: string;
      model: string;
      durationSec: number;
      event: { eventId?: string; provider: string; model: string; durationSec: number | null; requestBytes: number; label: string; costPaise: number | null; criteria?: VideoPriceCriteria; accounted?: boolean; unitWeight?: number };
    };
    /** Legacy Character Dialogue retry metadata. New jobs use options.recovery. */
    retry?: { sourceJobId?: number; childJobId?: number; fundedUnits?: number; state?: "creating" | "queued" };
  } | null;
  /** localized_dub: snapshot of the approved, fully timed dub track sent at
   * enqueue time. Immutable after enqueue — the job runner uses this verbatim
   * rather than re-reading the request. */
  localizedTrack?: {
    /** scriptApproved must be true; stored as proof the route checked it. */
    scriptApproved: true;
    /** Target locale for TTS and subtitle burn-in. */
    locale: "te" | "ta" | "hi";
    /**
     * Voice mode for this dub:
     * - "stock"        TTS from provider/model/speaker below (default behaviour).
     * - "brand_voice"  Use the brand kit's cloned ElevenLabs voice (requires brandKitId and a
     *                  configured cloned voice on the kit). provider/model/speaker are ignored.
     * - "source_voice" Use ElevenLabs Dubbing API to preserve the speaker's voice from the source
     *                  video (requires ELEVENLABS_API_KEY configured).
     */
    voiceMode?: "stock" | "brand_voice" | "source_voice";
    /** Provider/model/speaker snapshot used consistently for every cue. */
    provider?: "openai" | "sarvam";
    model?: "gpt-audio" | "bulbul:v3";
    speaker?: string;
    /** Legacy OpenAI rows used voice before provider-aware snapshots existed. */
    voice?: "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer";
    /**
     * Lip-sync consent: must be true for localized_dub (same hard gate as lip_sync).
     * Stored here as proof the route captured consent before running LatentSync.
     */
    lipSyncConsent?: boolean;
    /** Ordered, non-overlapping cues with their exact approved text. */
    cues: Array<{
      index: number;
      startMs: number;
      endMs: number;
      text: string;
    }>;
  } | null;
  /** topic_to_video: stock footage source ("auto" | "pexels" | "pixabay" | "wikimedia"). */
  stockSource?: string;
  /** topic_to_video: burn per-sentence subtitles (default true). */
  subtitles?: boolean;
  /** topic_to_video: "classic" sentence subtitles or "dynamic" word groups. */
  captionStyle?: string;
  /** topic_to_video: script length in paragraphs (~30s each, 1-3). */
  paragraphCount?: number;
  /** topic_to_video: "stock" footage (default) or AI "character" scenes. */
  visualsSource?: string;
  /** Character lock: the tenant character featured in the video. */
  characterId?: number | null;
  /** Costume lock: the outfit the character wears (default outfit if null). */
  outfitId?: number | null;
  /** topic_to_video character mode: costume-change instructions. */
  wardrobeNotes?: string | null;
  /** topic_to_video: brand kit steering voice, caption accent, watermark. */
  brandKitId?: number | null;
  /** topic_to_video: reference-derived style profile steering pacing + hook. */
  styleProfileId?: number | null;
  /** Which kind of video this is ("marketing" | "training" | "social_short").
   * Selects the Prompt Kit script variant layered over the shared rules.
   * Absent = the base script prompt, which is the pre-variant behaviour. */
  scriptVariant?: string | null;
  /** Pause after planning so the user can edit the storyboard before the
   * expensive half runs. Honoured by every engine except ordinary
   * topic_to_video stock videos. Curated presenter-overlay templates resolve
   * and persist their stock assets before pausing, so their plan is reviewable. */
  reviewStoryboard?: boolean;
  /** topic_to_video "ai"/"character" modes: reuse a saved AI scene plan
   * (a prior job's storyboard.aiPlan, possibly hand-edited) instead of
   * planning fresh. Validated strictly at the route; the planners still run
   * it through the same clamps (costume lock, style clamp) as a live reply. */
  suppliedPlan?: { flow: "broll" | "character"; raw: unknown } | null;
  /** Scenes added to the storyboard during review, each funded as one extra
   * unit at insert time. Lives in options so every path that recomputes the
   * job's price from engine+options (usage metering on success, refunds on
   * failure/discard/sweep) stays consistent without knowing about inserts. */
  addedScenes?: number;
}

/**
 * Snapshot of a completed localized_dub job's output, written in the same
 * DB update that flips status → succeeded. Null on all other engine rows.
 */
export interface LocalizedDubResult {
  /** Target locale spoken and burned in. */
  locale: "te" | "ta" | "hi";
  /** Voice mode that was used. */
  voiceMode: "stock" | "brand_voice" | "source_voice";
  /** TTS provider that synthesised the track (null for source_voice path). */
  provider: string | null;
  /** TTS model used (null for source_voice path). */
  model: string | null;
  /** Final cue list as burned (text may differ from approved when source_voice
   * dubbing was used and the provider's own text diverged). */
  finalCues: Array<{
    index: number;
    startMs: number;
    endMs: number;
    text: string;
  }>;
  /** Indices of cues that triggered the timing repair callback. */
  repairedCueIndices: number[];
  /** The /objects/... path of the source video that was dubbed. */
  sourceVideoPath: string;
}

/** One reviewable beat of a video: the narration it covers, the prompt that
 * will generate it, and a preview still of what that prompt produced. */
export interface VideoStoryboardScene {
  /** Mixed hybrid plans distinguish lip-synced character beats from AI animation. */
  beatType?: "character_speaking" | "story_animation" | null;
  /** Hybrid role is immutable and makes opening/closing validation explicit. */
  hybridRole?: "character_opening" | "story_animation" | "character_interlude" | "character_closing" | null;
  /** Original immutable template pattern position; interludes may be omitted. */
  patternIndex?: number | null;
  /** Stable address for edits ("s1", "s2", ...); never reused or renumbered. */
  id: string;
  /** The narration this scene plays under. Editable on narrated (topic)
   * plans: the voiceover is re-recorded to match on approve, and scene lengths
   * follow the new recording. Empty on engines that voice no script. */
  text: string;
  /** What this beat shows. The field the user edits — a generation prompt on
   * every engine except "slide", where it is the caption burned over the photo
   * (empty for no caption). */
  visual: string;
  /** Optional supporting B-roll direction for presenter-style Character
   * Dialogue templates. Dialogue text remains immutable during review. */
  brollVisual?: string | null;
  /** Seconds on screen. Read-only while timelineLocked; otherwise clamped to
   * the plan's durationBounds. */
  durationSec: number;
  /** /objects/... preview still, or null when the preview failed to generate
   * (the scene still renders; only its thumbnail is missing). On "photo" and
   * "slide" plans this is the user's own uploaded photo. */
  previewPath: string | null;
  /**
   * Durable receipt for a deferred paid preview. `prepared` has a minted
   * storage target but no provider call; `provider_succeeded` must never be
   * regenerated and is reconciled from its target; `complete` is reusable.
   */
  previewCheckpoint?: {
    targetPath: string;
    status: "prepared" | "provider_succeeded" | "complete";
    /** Receipt id for the image selected after distinctness analysis. */
    selectedEventId?: string;
    /** Every successful provider attempt, including distinctness replacements. */
    events?: Array<{
      eventId?: string;
      provider: string;
      model: string;
      durationSec: number | null;
      requestBytes: number;
      label: string;
      costPaise: number | null;
      accounted?: boolean;
      unitWeight?: number;
    }>;
    /** Legacy single-attempt receipt. */
    event?: {
      eventId?: string;
      provider: string;
      model: string;
      durationSec: number | null;
      requestBytes: number;
      label: string;
      costPaise: number | null;
      accounted?: boolean;
      unitWeight?: number;
    };
  } | null;
  /** Character mode: the outfit worn in this scene. */
  outfitId: number | null;
  /** "prompt" plans only: the polished generation prompt derived from the
   * approved `visual` (Prompt Kit video_scene_image pass). Written once at
   * first render and reused on retries, so an approved plan always renders
   * from the same prompts. Absent/null = render `visual` as approved. */
  renderVisual?: string | null;
  /**
   * Per-shot camera-motion preset, overriding the job's. This is what a
   * storyboard buys you that a single prompt box cannot: shot 1 can crash
   * zoom while shot 2 holds locked off. Null/absent = inherit the job's
   * motionPreset (and, failing that, the built-in instruction).
   */
  motionPreset?: string | null;
  /**
   * Per-shot sampling seed, recorded on first render and reused on retries so
   * an approved shot renders the same way twice. Editing the scene's `visual`
   * does not clear it: same seed, new prompt is the useful iteration. Set it
   * to null in a PATCH to re-roll freely.
   */
  seed?: number | null;
  /** Paid scene render persisted before normalization/composition. */
  providerCheckpoint?: {
    path: string;
    provider: string;
    model: string;
    durationSec: number;
    event: {
      eventId?: string;
      provider: string;
      model: string;
      durationSec: number | null;
      requestBytes: number;
      label: string;
      costPaise: number | null;
      criteria?: VideoPriceCriteria;
      accounted?: boolean;
      unitWeight?: number;
    };
  } | null;
}

/** How a plan's scenes get rendered, and therefore what is editable on them:
 *
 * - `character` — topic mode: a generated keyframe per scene, animated.
 * - `ai`        — topic mode: a generated still per scene, Ken Burns encoded.
 * - `prompt`    — text_to_video: one AI clip per shot, concatenated. No preview
 *                 still exists, because nothing image-shaped is generated.
 * - `photo`     — image_to_video: the user's own photo animated. The preview is
 *                 that photo, so it costs nothing and cannot be re-rolled.
 * - `slide`     — slideshow: the user's photos, no AI at all. `visual` is the
 *                 per-slide caption.
 *
 * Only `character` and `ai` have re-rollable previews; the rest either have no
 * still or use one the user supplied.
 */
export type VideoStoryboardSource = "character" | "ai" | "ai_video" | "prompt" | "photo" | "slide";

/** True when this plan's previews are generated (and so can be re-rolled). */
export function storyboardPreviewsAreGenerated(
  source: VideoStoryboardSource,
  mode?: VideoStoryboard["mode"],
): boolean {
  if (mode === "character_story" || mode === "character_dialogue") return false;
  return source === "character" || source === "ai" || source === "ai_video";
}

/** The plan a paused job is waiting on. Stored on the job row so approving is
 * a resume rather than a re-plan, and so a client only needs the job GET. */
export interface VideoStoryboard {
  version: 1;
  /** Bounded workflow discriminator. Optional on legacy storyboards. */
  mode?: "standard" | "character_story" | "character_dialogue" | "presenter_broll" | "hybrid_character_story";
  /** True for a curated presenter-overlay plan. It uses the prompt editor but
   * has real persisted previews and fixed presenter audio/timing. */
  presenterBroll?: boolean;
  /** Which pipeline will render these scenes; see VideoStoryboardSource. */
  visualsSource: VideoStoryboardSource;
  /** True when scene lengths are dictated by already-voiced narration, which
   * makes durationSec read-only — editing one would either desync every later
   * scene from the audio or silently change the total length. */
  timelineLocked: boolean;
  /** Per-scene length limits, enforced on edit and at render. Null when the
   * timeline is locked (there is nothing to bound) and on plans written before
   * unlocked timelines existed. */
  durationBounds?: { minSec: number; maxSec: number } | null;
  model: string | null;
  provider: string | null;
  /** Preview regenerations spent so far; capped server-side. */
  regenerations: number;
  /** The voiced narration the scenes are cut against, parked in tenant storage
   * so approving does not have to re-synthesize (and re-bill) it. Null on the
   * engines that voice no script. */
  narration: {
    audioPath: string;
    totalDurationSec: number;
    cues: { text: string; startSec: number; endSec: number }[];
    provider?: string;
    model?: string;
    accountingMode?: "aggregate" | "unmetered" | "independently_settled";
    costPaise?: number | null;
    /** Durable single-track TTS receipt for hybrid funding/retry settlement. */
    event?: {
      eventId?: string;
      provider: string;
      model: string;
      durationSec: number | null;
      requestBytes: number;
      label: string;
      costPaise: number | null;
      accounted?: boolean;
      unitWeight?: number;
      accountingMode?: "aggregate" | "unmetered" | "independently_settled";
    };
  } | null;
  /**
   * Non-spoken verification markers removed from the generated script before
   * narration. They remain durable review findings and block rendering until
   * the underlying claim is revised.
   */
  verificationFindings?: string[];
  scenes: VideoStoryboardScene[];
  /** The scene-planning JSON exactly as the AI returned it, captured when the
   * plan was first made and kept for the life of the job (audit + later
   * customization). Null/absent when planning fell back to defaults or on
   * engines that plan no visuals. */
  aiPlan?: {
    /** Which planner produced it: AI b-roll ({style,prompts}) or character
     * scenes ({scenes:[{visual,outfitId}]}). */
    flow: "broll" | "character";
    raw: unknown;
    capturedAt: string;
  } | null;
}

export const videoGenerationsTable = pgTable("video_generations", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  engine: text("engine").notNull(),
  status: text("status").notNull().default("queued"),
  /** The user's brief (text_to_video / image_to_video motion hint). */
  prompt: text("prompt"),
  /** Ordered /objects/... source images (image_to_video uses the first). */
  sourceImagePaths: jsonb("source_image_paths").$type<string[]>(),
  options: jsonb("options").$type<VideoJobOptions>(),
  /** Provider/model that produced the video (null for the slideshow engine). */
  provider: text("provider"),
  model: text("model"),
  /** Set on success: /objects/<tenantId>/uploads/<uuid> of the mp4. */
  videoPath: text("video_path"),
  /** Set on success: poster frame PNG for library grids and previews. */
  thumbnailPath: text("thumbnail_path"),
  /** Human-readable failure reason; null unless status is failed. */
  error: text("error"),
  /** What the pipeline is doing right now ("Writing the script", ...); only
   * meaningful while status is processing. Shown live in the studio. */
  stage: text("stage"),
  /** Wall-clock generation time, for the usage/cost meters. */
  durationMs: integer("duration_ms"),
  /** How the route paid for this job, so a sweep that settles an abandoned
   * one knows whether there are credits to give back. */
  funding: text("funding").$type<"quota" | "credit" | "wallet">(),
  /**
   * Wallet-funded jobs: the first wallet_ledger reserve row plus the TOTAL
   * paise and units reserved for this job, so the runner can settle it to the
   * real cost — and cancel/sweep can hand it back — long after the enqueueing
   * request has gone.
   *
   * The totals are aggregates, not a copy of the first reserve row: a scene
   * added during storyboard review reserves again and folds its paise/unit
   * into these columns, so every later refund covers the whole job.
   */
  /**
   * The per-unit "AI amount spent" display rate (paise, fee folded in) in
   * effect when this job was charged. Frozen at enqueue so history never
   * silently shifts when a superadmin later edits the display rates. Null on
   * legacy rows, which fall back to the CURRENT rate client-side.
   */
  chargedRatePaise: integer("charged_rate_paise"),
  /**
   * The TOTAL tenant-facing display amount (paise) snapshotted onto this
   * job's usage events when it settled (all units summed) — the job's REAL
   * "AI amount spent" in cost_plus mode. Null on legacy rows or when
   * metering failed; clients fall back to chargedRatePaise x units.
   */
  spendPaise: integer("spend_paise"),
  /**
   * Content Library draft created from this job. Once set, the Studio treats
   * the generation as saved and removes it from the unsaved timeline.
   */
  savedContentItemId: integer("saved_content_item_id"),
  walletReservationId: integer("wallet_reservation_id"),
  walletReservedPaise: integer("wallet_reserved_paise"),
  walletReservedUnits: integer("wallet_reserved_units"),
  /** The editable plan; only set while status is awaiting_review (and kept
   * afterwards as a record of what was approved). */
  storyboard: jsonb("storyboard").$type<VideoStoryboard>(),
  /** When an unreviewed storyboard is swept and the reservation refunded.
   * Null unless the job is awaiting_review. */
  storyboardExpiresAt: timestamp("storyboard_expires_at", { withTimezone: true }),
  /**
   * Snapshot of the localized_dub result (locale, voiceMode, provider/model,
   * final cues, repaired cue indices, source video path). Written atomically in
   * the same update that flips status → succeeded for localized_dub jobs.
   * Null on every other engine row and before the job succeeds.
   */
  localizedResult: jsonb("localized_result").$type<LocalizedDubResult>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type VideoGeneration = typeof videoGenerationsTable.$inferSelect;
