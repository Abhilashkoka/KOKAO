import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  tenantsTable,
  contentItemsTable,
  videoGenerationsTable,
  storyboardPreviewsAreGenerated,
} from "@workspace/db";
import { and, eq, desc, isNotNull, sql } from "drizzle-orm";
import {
  GenerateVideoBody,
  ImportLibraryMusicBody,
  SaveVideoToLibraryBody,
  UpdateVideoStoryboardBody,
  InsertVideoStoryboardSceneBody,
} from "@workspace/api-zod";
import {
  searchLibraryMusic,
  downloadLibraryTrack,
  MusicLibraryError,
} from "../lib/musicLibrary";
import { ObjectStorageService } from "../lib/objectStorage";
import { getPlanLimits } from "../lib/plans";
import { getUsage } from "../lib/usage";
import { spendCredit, refundCredits } from "../lib/credits";
import {
  isWalletFunded,
  reserveWallet,
  refundWallet,
  reservationFromRow,
  type WalletReservation,
} from "../lib/wallet";
import { enqueueBackgroundJob } from "../lib/backgroundJobs";
import {
  runVideoGenerationJob,
  resumeVideoGenerationJob,
  refreshStoryboardScenePreview,
  STORYBOARD_REGENERATIONS_PER_SCENE,
} from "../lib/videoGen/jobRunner";
import { VideoGenProviderError, compiledClipPrompt } from "../lib/videoGen";
import { MAX_SLIDESHOW_IMAGES } from "../lib/videoGen/slideshow";
import { clampSceneDuration, clipShotCount } from "../lib/videoGen/clipStoryboard";
import { videoJobUnits } from "../lib/videoGen/units";
import { preflightVideoJob } from "../lib/videoGen/preflight";
import { getCharacterDetail, resolveOutfit } from "../lib/characters";
import { isFeatureEnabled } from "../lib/featureFlags";
import { serializeContent } from "../lib/serializers";
import type { VideoGeneration } from "@workspace/db";

const router: IRouter = Router();

/**
 * Adjust a wallet-funded job's reserved TOTALS in place.
 *
 * The job row holds the aggregate of every reserve made for it (the enqueue
 * reservation plus any scene added during storyboard review), because the
 * refund and settle paths rebuild exactly one reservation from those columns.
 * Deltas are applied in SQL so two concurrent scene inserts cannot clobber
 * each other's increment.
 */
async function addToJobReservation(
  jobId: number,
  paiseDelta: number,
  unitsDelta: number,
): Promise<void> {
  await db
    .update(videoGenerationsTable)
    .set({
      walletReservedPaise: sql`coalesce(${videoGenerationsTable.walletReservedPaise}, 0) + ${paiseDelta}`,
      walletReservedUnits: sql`greatest(coalesce(${videoGenerationsTable.walletReservedUnits}, 1) + ${unitsDelta}, 1)`,
      updatedAt: new Date(),
    })
    .where(eq(videoGenerationsTable.id, jobId));
}

/**
 * Video generation endpoints. Generation is long-running, so POST
 * /ai/generate-video only validates + reserves funding + creates a
 * video_generations row, then hands the heavy work to an in-process
 * background job. Clients poll GET /ai/video-jobs/{id} until the job settles.
 */

/** The exact clip prompt an animate-photo render sends (see serializeVideoJob). */
function animatePhotoAiPrompt(job: VideoGeneration): string {
  const scene = job.storyboard?.scenes[0];
  if (job.storyboard && scene) {
    return compiledClipPrompt(
      scene.visual,
      clampSceneDuration(job.storyboard, scene.durationSec),
    );
  }
  return compiledClipPrompt(job.prompt ?? "", job.options?.durationSec ?? 5);
}

function serializeVideoJob(job: VideoGeneration) {
  return {
    id: job.id,
    engine: job.engine,
    status: job.status,
    prompt: job.prompt ?? null,
    // Transparency: the exact prompt the video model receives. Storyboard
    // engines show their per-scene prompts in the storyboard instead. When an
    // animate-photo job HAS a storyboard, the render uses the (editable) scene
    // prompt and its clamped length — so derive from those, never job.prompt,
    // or the shown text could diverge from what was actually sent.
    aiPrompt: job.engine === "image_to_video" ? animatePhotoAiPrompt(job) : null,
    sourceImagePaths: job.sourceImagePaths ?? [],
    aspectRatio: job.options?.aspectRatio ?? "9:16",
    videoPath: job.videoPath ?? null,
    thumbnailPath: job.thumbnailPath ?? null,
    provider: job.provider ?? null,
    model: job.model ?? null,
    error: job.error ?? null,
    stage: job.stage ?? null,
    durationMs: job.durationMs ?? null,
    // How many video units this job actually charges (multi-shot clips,
    // character/AI-visual scene groups, review-added scenes, AI music bed).
    // Prefer the persisted wallet reservation when present (it tracks
    // review-time additions transactionally); otherwise recompute from the
    // options, which videoJobUnits keeps in sync with every funding path.
    units: Math.max(1, job.walletReservedUnits ?? videoJobUnits(job.engine, job.options)),
    storyboard: job.storyboard ?? null,
    storyboardExpiresAt: job.storyboardExpiresAt?.toISOString() ?? null,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}

const musicStorage = new ObjectStorageService();

/** Built-in background-music library: search commercially-usable CC tracks. */
router.get("/ai/music/search", async (req: Request, res: Response) => {
  const q = String(req.query.q ?? "").trim();
  if (q.length < 2 || q.length > 80) {
    res.status(400).json({ error: "Search for 2-80 characters." });
    return;
  }
  try {
    res.json({ tracks: await searchLibraryMusic(q) });
  } catch (error) {
    req.log.warn({ err: error }, "Music library search failed");
    const message =
      error instanceof MusicLibraryError ? error.message : "Music search failed. Please try again.";
    res.status(502).json({ error: message });
  }
});

/** Import a chosen library track into tenant storage → musicPath. */
router.post("/ai/music/import", async (req: Request, res: Response) => {
  const parsed = ImportLibraryMusicBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  try {
    const bytes = await downloadLibraryTrack(parsed.data.audioUrl);
    const uploadURL = await musicStorage.getObjectEntityUploadURL(req.tenantId);
    const putRes = await fetch(uploadURL, {
      method: "PUT",
      headers: { "Content-Type": "audio/mpeg" },
      body: new Uint8Array(bytes),
      signal: AbortSignal.timeout(60_000),
    });
    if (!putRes.ok) {
      res.status(502).json({ error: "Saving the track to storage failed." });
      return;
    }
    res.json({
      musicPath: musicStorage.normalizeObjectEntityPath(uploadURL),
      title: parsed.data.title,
    });
  } catch (error) {
    req.log.warn({ err: error }, "Music library import failed");
    const message =
      error instanceof MusicLibraryError
        ? error.message
        : "Importing the track failed. Please try again.";
    res.status(400).json({ error: message });
  }
});

router.post("/ai/generate-video", async (req: Request, res: Response) => {
  const parsed = GenerateVideoBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const body = parsed.data;

  // Engine-specific input requirements, checked BEFORE any funding is
  // reserved so a bad request never burns quota.
  const sourceImagePaths = body.sourceImagePaths ?? [];
  if (body.engine === "text_to_video" && !body.prompt?.trim()) {
    res.status(400).json({ error: "A prompt is required for text-to-video." });
    return;
  }
  if (body.engine === "topic_to_video" && !body.prompt?.trim()) {
    res.status(400).json({ error: "A topic is required for topic-to-video." });
    return;
  }
  if (body.engine === "image_to_video" && sourceImagePaths.length === 0) {
    res.status(400).json({ error: "A source image is required for image-to-video." });
    return;
  }
  if (body.engine === "slideshow") {
    if (sourceImagePaths.length === 0) {
      res.status(400).json({ error: "At least one photo is required for a slideshow." });
      return;
    }
    if (sourceImagePaths.length > MAX_SLIDESHOW_IMAGES) {
      res.status(400).json({
        error: `A slideshow supports at most ${MAX_SLIDESHOW_IMAGES} photos.`,
      });
      return;
    }
  }
  // The tenant-scope prefix is asserted again at read time in the job runner;
  // rejecting early here gives a clear message instead of a failed job.
  for (const path of sourceImagePaths) {
    if (!path.startsWith(`/objects/${req.tenantId}/`)) {
      res.status(400).json({ error: "Invalid source image path." });
      return;
    }
  }
  if (body.musicPath && !body.musicPath.startsWith(`/objects/${req.tenantId}/`)) {
    res.status(400).json({ error: "Invalid music path." });
    return;
  }

  // Character lock: validate the character (and outfit) belong to the caller
  // BEFORE funding, and resolve the effective outfit so the job is
  // self-describing even if the default outfit changes later.
  const visualsSource =
    body.engine === "topic_to_video" &&
    (body.visualsSource === "character" || body.visualsSource === "ai")
      ? body.visualsSource
      : "stock";
  const wantsCharacter =
    visualsSource === "character" ||
    (body.engine === "text_to_video" && body.characterId != null);
  let characterId: number | null = null;
  let outfitId: number | null = null;
  if (wantsCharacter) {
    if (body.characterId == null) {
      res.status(400).json({ error: "Pick a character for a character video." });
      return;
    }
    const detail = await getCharacterDetail(req.tenantId, body.characterId);
    if (!detail) {
      res.status(400).json({ error: "That character does not exist." });
      return;
    }
    const outfit = resolveOutfit(detail, body.outfitId ?? null);
    if (!outfit) {
      res.status(400).json({ error: "That outfit does not exist." });
      return;
    }
    characterId = detail.character.id;
    outfitId = outfit.id;
  }

  const tenant = (
    await db.select().from(tenantsTable).where(eq(tenantsTable.id, req.tenantId)).limit(1)
  )[0];
  if (!tenant) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const options = {
    aspectRatio: body.aspectRatio ?? "9:16",
    durationSec: body.durationSec ?? 5,
    // Prices the job (one unit per shot), so it is pinned here and the
    // storyboard editor cannot move it.
    shotCount: body.engine === "text_to_video" ? clipShotCount(body.shotCount) : 1,
    slideDurationSec: body.slideDurationSec ?? 3,
    overlayText: body.overlayText ?? null,
    musicPath: body.musicPath ?? null,
    musicPrompt: body.musicPath ? null : (body.musicPrompt?.trim() || null),
    voice: body.voice ?? "alloy",
    stockSource: body.stockSource ?? "auto",
    subtitles: body.subtitles ?? true,
    captionStyle: body.captionStyle ?? "classic",
    paragraphCount: body.paragraphCount ?? 1,
    visualsSource,
    characterId,
    outfitId,
    wardrobeNotes: body.wardrobeNotes?.trim() || null,
    // Defaults to true in the request schema, so an older client that has never
    // heard of storyboards still gets one.
    reviewStoryboard: body.reviewStoryboard,
    // Brand kit is tenant-scoped at load time in the job runner; storing a
    // foreign id just renders unbranded. Dropped entirely when the Brand
    // Video kill switch is off.
    brandKitId:
      body.engine === "topic_to_video" && (await isFeatureEnabled("brandVideo"))
        ? (body.brandKitId ?? null)
        : null,
    // Same story for the style profile: tenant-scoped at load time, so a
    // foreign or deleted id just renders without reference styling. Dropped
    // entirely when the Reference Styles kill switch is off.
    styleProfileId:
      body.engine === "topic_to_video" && (await isFeatureEnabled("referenceStyles"))
        ? (body.styleProfileId ?? null)
        : null,
  };

  // Dependency preflight BEFORE funding: a job that will die four minutes in
  // on a missing key or a provider that is already failing should never take
  // the tenant's quota in the first place. Refunds return credits, not time.
  // Platform kill switch (fail-open): when off, jobs fund and run exactly as
  // they did before preflight existed.
  const preflightEnabled = await isFeatureEnabled("providerResilience").catch(() => true);
  if (preflightEnabled) {
    const preflight = await preflightVideoJob(body.engine, options);
    if (preflight) {
      res.status(preflight.status).json({ error: preflight.message });
      return;
    }
  }

  // Fund like every metered generation: monthly plan quota first, then
  // atomically reserved credits (refunded by the job runner on failure).
  // Character story videos cost one unit PER SCENE — every scene is a real
  // keyframe + image-to-video generation.
  const units = videoJobUnits(body.engine, options);
  const limits = await getPlanLimits(tenant.plan);
  const usage = await getUsage(req.tenantId);
  // Wallet workspaces reserve one estimate per unit in a single
  // all-or-nothing debit, persisted on the job row so the runner can settle
  // it to the real cost minutes later.
  let funding: "quota" | "credit" | "wallet";
  let reservation: WalletReservation | null = null;
  if (await isWalletFunded(req.tenantId)) {
    reservation = await reserveWallet(req.tenantId, "video", {}, units);
    if (!reservation) {
      res.status(402).json({
        error:
          units > 1
            ? `This video needs ${units} generations (one per scene) and your wallet balance can't cover it. Recharge to continue.`
            : "Your wallet balance can't cover this video. Recharge to continue.",
      });
      return;
    }
    funding = "wallet";
  } else if (limits.videos === -1 || usage.videos + units <= limits.videos) {
    funding = "quota";
  } else if (await spendCredit(req.tenantId, "video", units)) {
    funding = "credit";
  } else {
    res.status(402).json({
      error:
        units > 1
          ? `This video needs ${units} video units (one per generated scene) and your plan does not have enough left. Upgrade your plan or buy a credit pack.`
          : "Monthly video quota reached and no video credits left. Upgrade your plan or buy a credit pack.",
    });
    return;
  }

  const job = (
    await db
      .insert(videoGenerationsTable)
      .values({
        tenantId: req.tenantId,
        engine: body.engine,
        status: "queued",
        prompt: body.prompt?.trim() || null,
        sourceImagePaths,
        options,
        // Persisted at creation, not at the runner's claim: if the process
        // restarts before the runner claims this row, the stuck-job sweep can
        // only refund a reservation it knows about.
        funding,
        walletReservationId: reservation?.id ?? null,
        walletReservedPaise: reservation?.amountPaise ?? null,
        walletReservedUnits: reservation?.units ?? null,
      })
      .returning()
  )[0]!;

  const accepted = enqueueBackgroundJob(() => runVideoGenerationJob(job.id, funding));
  if (!accepted) {
    // Shutdown in progress: undo everything and ask the client to retry.
    await db
      .update(videoGenerationsTable)
      .set({ status: "failed", error: "Server restarting; please retry." })
      .where(eq(videoGenerationsTable.id, job.id));
    if (reservation) {
      await refundWallet(req.tenantId, reservation, "video enqueue rejected");
    } else if (funding === "credit") {
      await refundCredits(req.tenantId, "video", units, "video enqueue rejected");
    }
    res.status(503).json({ error: "Server is restarting. Please retry in a moment." });
    return;
  }

  res.status(201).json(serializeVideoJob(job));
});

router.get("/ai/video-jobs", async (req: Request, res: Response) => {
  const rows = await db
    .select()
    .from(videoGenerationsTable)
    .where(eq(videoGenerationsTable.tenantId, req.tenantId))
    .orderBy(desc(videoGenerationsTable.createdAt), desc(videoGenerationsTable.id))
    .limit(30);
  res.json(rows.map(serializeVideoJob));
});

router.param("jobId", (req, res, next, value) => {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  next();
});

async function loadJob(req: Request): Promise<VideoGeneration | undefined> {
  return (
    await db
      .select()
      .from(videoGenerationsTable)
      .where(
        and(
          eq(videoGenerationsTable.id, Number(req.params.jobId)),
          eq(videoGenerationsTable.tenantId, req.tenantId),
        ),
      )
      .limit(1)
  )[0];
}

router.get("/ai/video-jobs/:jobId", async (req: Request, res: Response) => {
  const job = await loadJob(req);
  if (!job) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(serializeVideoJob(job));
});

/**
 * Cancel a still-queued job. The conditional queued->cancelled UPDATE is the
 * same atomic guard the runner uses for its queued->processing claim, so a
 * job can never be both cancelled and executed: whichever flip lands first
 * wins. Refunds the reserved credits when the job was credit-funded (quota
 * funding is only metered on success, so there is nothing to refund). The
 * refund amount is recomputed from the stored engine/options — the exact
 * inputs the route priced the job with at enqueue.
 */
router.post("/ai/video-jobs/:jobId/cancel", async (req: Request, res: Response) => {
  const id = Number(req.params.jobId);
  // The status flip and the credit refund share one transaction so a job can
  // never end up cancelled without its refund (or vice versa).
  let cancelledReservation: WalletReservation | null = null;
  const cancelled = await db.transaction(async (tx) => {
    const row = (
      await tx
        .update(videoGenerationsTable)
        .set({ status: "cancelled", error: null })
        .where(
          and(
            eq(videoGenerationsTable.id, id),
            eq(videoGenerationsTable.tenantId, req.tenantId),
            eq(videoGenerationsTable.status, "queued"),
          ),
        )
        .returning()
    )[0];
    if (row) {
      const held = reservationFromRow(row);
      if (held) {
        // Issued after the cancel commits, on its own connection.
        cancelledReservation = held;
      } else if (row.funding === "credit") {
        const units = videoJobUnits(row.engine, row.options);
        await refundCredits(req.tenantId, "video", units, "video job cancelled", tx);
      }
    }
    return row;
  });
  if (cancelled) {
    if (cancelledReservation) {
      await refundWallet(
        req.tenantId,
        cancelledReservation,
        "video job cancelled",
      ).catch((error) =>
        req.log.error({ err: error, jobId: id }, "Failed to refund cancelled video job"),
      );
    }
    res.json(serializeVideoJob(cancelled));
    return;
  }
  const existing = await loadJob(req);
  if (!existing) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.status(409).json({
    error:
      existing.status === "processing"
        ? "This video has already started and can no longer be cancelled."
        : existing.status === "awaiting_review"
          ? "This video is waiting on storyboard review — discard the storyboard instead."
          : "This video has already finished.",
  });
});

/**
 * Storyboard review. A job created with reviewStoryboard pauses after the cheap
 * half (script → narration → one still per scene) and waits here in
 * awaiting_review. The stills on the plan ARE the frames the render animates, so
 * approving costs no image generation twice, and editing is free.
 *
 * Funding was reserved when the job was created; approve spends nothing extra
 * and discard gives it back.
 */

/** Load a job that must be paused for review, answering the request when it is
 * not. Returns the job and its plan together so callers get both non-null. */
async function loadPausedJob(
  req: Request,
  res: Response,
): Promise<{ job: VideoGeneration; storyboard: NonNullable<VideoGeneration["storyboard"]> } | null> {
  const job = await loadJob(req);
  if (!job) {
    res.status(404).json({ error: "Not found" });
    return null;
  }
  if (job.status !== "awaiting_review" || !job.storyboard) {
    res.status(400).json({ error: "This video is not waiting for storyboard review." });
    return null;
  }
  return { job, storyboard: job.storyboard };
}

/** Edit scene prompts (and, when the timeline is unlocked, scene lengths). */
router.patch("/ai/video-jobs/:jobId/storyboard", async (req: Request, res: Response) => {
  const parsed = UpdateVideoStoryboardBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const loaded = await loadPausedJob(req, res);
  if (!loaded) return;
  const { storyboard } = loaded;

  const edits = new Map(parsed.data.scenes.map((scene) => [scene.id, scene]));
  for (const id of edits.keys()) {
    if (!storyboard.scenes.some((scene) => scene.id === id)) {
      res.status(400).json({ error: "That scene is not in this storyboard." });
      return;
    }
  }
  // Topic storyboards are cut against already-recorded narration, so a length
  // edit would either desync every later scene from the audio or silently
  // change the total. Reject it rather than accept-and-ignore.
  if (storyboard.timelineLocked && parsed.data.scenes.some((s) => s.durationSec != null)) {
    res.status(400).json({
      error: "Scene lengths are set by the narration timing and cannot be changed.",
    });
    return;
  }
  // Narration text is only editable where narration exists to re-record: the
  // narrated (topic) plans. Everywhere else `text` is empty by construction,
  // so accepting an edit would invent a script no engine will voice.
  if (!storyboard.narration && parsed.data.scenes.some((s) => s.text?.trim())) {
    res.status(400).json({
      error: "This video has no narration, so there is no scene text to edit.",
    });
    return;
  }

  // On a slideshow plan, `visual` is the burned-in caption, so clearing it is a
  // real edit. Everywhere else it is the generation prompt, and an empty prompt
  // has nothing to generate — there, blank means "leave it alone".
  const blankClearsVisual = storyboard.visualsSource === "slide";
  const updated = {
    ...storyboard,
    scenes: storyboard.scenes.map((scene) => {
      const edit = edits.get(scene.id);
      if (!edit) return scene;
      const visual = edit.visual?.trim();
      // Blank never clears narration: a narrated scene with no words has no
      // length. The voiceover re-records to match edited text on approve.
      const text = edit.text?.trim();
      return {
        ...scene,
        text: text || scene.text,
        visual: visual || (blankClearsVisual && visual === "" ? "" : scene.visual),
        // Clamped rather than rejected: the bounds are what the renderer can
        // actually deliver, and a client that asks for 30s meant "the longest
        // you can do".
        durationSec:
          edit.durationSec == null
            ? scene.durationSec
            : clampSceneDuration(storyboard, edit.durationSec),
      };
    }),
  };
  const saved = (
    await db
      .update(videoGenerationsTable)
      .set({ storyboard: updated, updatedAt: new Date() })
      .where(
        and(
          eq(videoGenerationsTable.id, Number(req.params.jobId)),
          eq(videoGenerationsTable.tenantId, req.tenantId),
          eq(videoGenerationsTable.status, "awaiting_review"),
        ),
      )
      .returning()
  )[0];
  if (!saved) {
    res.status(400).json({ error: "This video is not waiting for storyboard review." });
    return;
  }
  res.json(serializeVideoJob(saved));
});

/** Hard ceiling on scenes per narrated storyboard: the largest planned board
 * (character, 3 paragraphs) is 12 scenes, and each added scene lengthens the
 * recording and the render, so growth past this needs a new video instead. */
const MAX_NARRATED_STORYBOARD_SCENES = 16;

/** Add a scene to a paused narrated storyboard. Costs one extra video unit,
 * funded the same way as the job so every refund path stays consistent. */
router.post("/ai/video-jobs/:jobId/storyboard/scenes", async (req: Request, res: Response) => {
  const parsed = InsertVideoStoryboardSceneBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const loaded = await loadPausedJob(req, res);
  if (!loaded) return;
  const { job, storyboard } = loaded;

  // Phase 1: narrated topic boards only. Their scenes are generated stills, so
  // a new one can be drawn from a prompt; the voiceover re-records on approve.
  if (!storyboard.narration || !storyboardPreviewsAreGenerated(storyboard.visualsSource)) {
    res.status(400).json({
      error: "Scenes can only be added to narrated topic storyboards.",
    });
    return;
  }
  if (storyboard.scenes.length >= MAX_NARRATED_STORYBOARD_SCENES) {
    res.status(400).json({
      error: `This storyboard is at its maximum of ${MAX_NARRATED_STORYBOARD_SCENES} scenes.`,
    });
    return;
  }
  const afterSceneId = parsed.data.afterSceneId;
  if (afterSceneId != null && !storyboard.scenes.some((s) => s.id === afterSceneId)) {
    res.status(400).json({ error: "That scene is not in this storyboard." });
    return;
  }
  const text = parsed.data.text.trim();
  if (!text) {
    res.status(400).json({ error: "The new scene needs narration text." });
    return;
  }

  // Fund the extra unit the same way the job was funded — mixed funding would
  // break the refund paths, which give back videoJobUnits(engine, options)
  // only when funding is "credit". The unit is recorded in options.addedScenes
  // so success metering, discard and failure refunds all price it in.
  const options = job.options ?? { aspectRatio: "9:16" as const };
  const optionsAfter = { ...options, addedScenes: (options.addedScenes ?? 0) + 1 };
  let sceneReservation: WalletReservation | null = null;
  if (job.funding === "wallet") {
    sceneReservation = await reserveWallet(req.tenantId, "video");
    if (!sceneReservation) {
      res.status(402).json({
        error: "Adding a scene needs another generation and your wallet can't cover it.",
      });
      return;
    }
    // Fold it into the job's reserved totals. The refund paths (render
    // failure, storyboard discard, sweep) rebuild ONE reservation from these
    // columns, so an extra reserve that is not folded in here is money the
    // tenant can never get back.
    await addToJobReservation(job.id, sceneReservation.amountPaise, 1);
  } else if (job.funding === "credit") {
    if (!(await spendCredit(req.tenantId, "video", 1))) {
      res.status(402).json({
        error: "Adding a scene needs one video credit and you have none left.",
      });
      return;
    }
  } else {
    const tenant = (
      await db.select().from(tenantsTable).where(eq(tenantsTable.id, req.tenantId))
    )[0];
    const limits = await getPlanLimits(tenant?.plan ?? "free");
    const usage = await getUsage(req.tenantId);
    const unitsAfter = videoJobUnits(job.engine, optionsAfter);
    if (limits.videos !== -1 && usage.videos + unitsAfter > limits.videos) {
      res.status(402).json({
        error:
          "Adding a scene needs one more video unit than your monthly quota has left. Upgrade your plan or start a smaller video.",
      });
      return;
    }
  }
  const refundInsert = async (reason: string): Promise<void> => {
    if (sceneReservation) {
      // Unfold first, so the job's totals stop claiming a scene that never
      // landed and a later refund cannot hand the same paise back twice.
      await addToJobReservation(job.id, -sceneReservation.amountPaise, -1).catch(
        (err) =>
          req.log.error(
            { err, jobId: job.id },
            "Failed to unfold a scene reservation from the job totals",
          ),
      );
      await refundWallet(req.tenantId, sceneReservation, reason).catch((err) => {
        req.log.error(
          { err, jobId: job.id, tenantId: req.tenantId, reason },
          "Storyboard scene insert wallet refund FAILED — tenant may be owed a refund",
        );
      });
      return;
    }
    if (job.funding === "credit") {
      await refundCredits(req.tenantId, "video", 1, reason).catch((err) => {
        // A failed refund leaves the tenant charged for a scene that never
        // landed — surface it loudly so it can be reconciled by hand.
        req.log.error(
          { err, jobId: job.id, tenantId: req.tenantId, reason },
          "Storyboard scene insert refund FAILED — tenant may be owed 1 video credit",
        );
      });
    }
  };

  // Give back the funding if anything below fails; quota jobs only meter on
  // success, so there the checks above were the whole reservation.
  const nextId = `s${storyboard.scenes.reduce((max, s) => {
    const m = /^s(\d+)$/.exec(s.id);
    return m ? Math.max(max, Number(m[1])) : max;
  }, 0) + 1}`;
  // Length placeholder only: the re-recorded narration dictates the real
  // duration when the storyboard is approved.
  const durationSec =
    storyboard.scenes.reduce((sum, s) => sum + s.durationSec, 0) / storyboard.scenes.length;
  const newScene = {
    id: nextId,
    text,
    visual: parsed.data.visual?.trim() || text,
    durationSec: Math.round(durationSec * 10) / 10,
    previewPath: null as string | null,
    outfitId: null as number | null,
  };

  // Generate the preview still BEFORE persisting anything, so a provider
  // failure charges nothing and leaves the board exactly as it was.
  let previewBoard;
  try {
    previewBoard = await refreshStoryboardScenePreview(
      job,
      { ...storyboard, scenes: [...storyboard.scenes, newScene] },
      newScene,
    );
  } catch (error) {
    req.log.warn({ err: error, jobId: job.id }, "Storyboard scene insert preview failed");
    await refundInsert("storyboard scene insert failed");
    const message =
      error instanceof VideoGenProviderError
        ? error.message
        : "Generating the new scene's image failed. Please try again.";
    res.status(502).json({ error: message });
    return;
  }
  const generated = previewBoard.scenes.find((s) => s.id === nextId) ?? newScene;

  // Re-read under lock and splice into the CURRENT board, so edits made while
  // the image generated are kept and two parallel inserts cannot lose one.
  let saved;
  try {
    saved = await db.transaction(async (tx) => {
    const fresh = (
      await tx
        .select()
        .from(videoGenerationsTable)
        .where(
          and(
            eq(videoGenerationsTable.id, job.id),
            eq(videoGenerationsTable.tenantId, req.tenantId),
          ),
        )
        .for("update")
    )[0];
    if (
      !fresh ||
      fresh.status !== "awaiting_review" ||
      !fresh.storyboard ||
      fresh.storyboard.scenes.length >= MAX_NARRATED_STORYBOARD_SCENES ||
      fresh.storyboard.scenes.some((s) => s.id === nextId)
    ) {
      return null;
    }
    const scenes = [...fresh.storyboard.scenes];
    const at =
      afterSceneId === null
        ? 0
        : afterSceneId === undefined
          ? scenes.length
          : scenes.findIndex((s) => s.id === afterSceneId) + 1 || scenes.length;
    scenes.splice(at, 0, generated);
    const freshOptions = fresh.options ?? options;
    return (
      await tx
        .update(videoGenerationsTable)
        .set({
          storyboard: { ...fresh.storyboard, scenes },
          options: { ...freshOptions, addedScenes: (freshOptions.addedScenes ?? 0) + 1 },
          updatedAt: new Date(),
        })
        .where(eq(videoGenerationsTable.id, job.id))
        .returning()
    )[0];
    });
  } catch (error) {
    // The DB write failed after funding was taken — give it back before 500ing.
    req.log.error({ err: error, jobId: job.id }, "Storyboard scene insert persist failed");
    await refundInsert("storyboard scene insert failed");
    res.status(500).json({ error: "Saving the new scene failed. You were not charged." });
    return;
  }
  if (!saved) {
    await refundInsert("storyboard scene insert rejected");
    res.status(400).json({ error: "This video is not waiting for storyboard review." });
    return;
  }
  res.json(serializeVideoJob(saved));
});

/** Re-roll one scene's preview still from its current prompt. */
router.post(
  "/ai/video-jobs/:jobId/storyboard/scenes/:sceneId/preview",
  async (req: Request, res: Response) => {
    const loaded = await loadPausedJob(req, res);
    if (!loaded) return;
    const { job, storyboard } = loaded;

    // "photo" and "slide" plans preview the user's OWN uploaded photos, and a
    // "prompt" plan has no still at all — there is nothing here to re-roll, and
    // generating one would replace a photo they chose with one they did not.
    if (!storyboardPreviewsAreGenerated(storyboard.visualsSource)) {
      res.status(400).json({
        error: "This storyboard's images are your own photos, so there is nothing to redraw.",
      });
      return;
    }
    const scene = storyboard.scenes.find((s) => s.id === req.params.sceneId);
    if (!scene) {
      res.status(400).json({ error: "That scene is not in this storyboard." });
      return;
    }
    const cap = STORYBOARD_REGENERATIONS_PER_SCENE * storyboard.scenes.length;

    // Spend one re-roll atomically BEFORE the expensive generation: the
    // conditional UPDATE both checks the cap and increments the counter in one
    // statement, so concurrent requests each need their own winning claim and
    // can never overshoot the cap by racing a read-then-write.
    const claimed = (
      await db
        .update(videoGenerationsTable)
        .set({
          storyboard: sql`jsonb_set(${videoGenerationsTable.storyboard}, '{regenerations}', to_jsonb(COALESCE((${videoGenerationsTable.storyboard}->>'regenerations')::int, 0) + 1))`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(videoGenerationsTable.id, job.id),
            eq(videoGenerationsTable.tenantId, req.tenantId),
            eq(videoGenerationsTable.status, "awaiting_review"),
            sql`COALESCE((${videoGenerationsTable.storyboard}->>'regenerations')::int, 0) < ${cap}`,
          ),
        )
        .returning()
    )[0];
    if (!claimed || !claimed.storyboard) {
      res.status(400).json({
        error: `You have used all ${cap} free preview re-rolls for this storyboard. Approve it, or start a new video.`,
      });
      return;
    }

    // Best-effort: a provider failure should not eat a re-roll. Guarded the
    // same way as the claim; if the plan moved on meanwhile, leave it alone.
    const releaseClaim = async (): Promise<void> => {
      await db
        .update(videoGenerationsTable)
        .set({
          storyboard: sql`jsonb_set(${videoGenerationsTable.storyboard}, '{regenerations}', to_jsonb(GREATEST(COALESCE((${videoGenerationsTable.storyboard}->>'regenerations')::int, 0) - 1, 0)))`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(videoGenerationsTable.id, job.id),
            eq(videoGenerationsTable.tenantId, req.tenantId),
            eq(videoGenerationsTable.status, "awaiting_review"),
          ),
        );
    };

    const fresh = claimed.storyboard;
    const freshScene = fresh.scenes.find((s) => s.id === scene.id) ?? scene;
    let updated;
    try {
      updated = await refreshStoryboardScenePreview(job, fresh, freshScene);
    } catch (error) {
      req.log.warn({ err: error, jobId: job.id }, "Storyboard preview regeneration failed");
      await releaseClaim().catch(() => {});
      const message =
        error instanceof VideoGenProviderError
          ? error.message
          : "Generating that preview failed. Please try again.";
      res.status(502).json({ error: message });
      return;
    }
    // Persist only the scenes; the regenerations counter was already spent by
    // the atomic claim above, and writing the whole object back would let a
    // slow request overwrite a counter a concurrent request has since moved.
    // Guarded on status so a preview cannot land on a plan that was approved
    // or discarded while the image was generating.
    const saved = (
      await db
        .update(videoGenerationsTable)
        .set({
          storyboard: sql`jsonb_set(${videoGenerationsTable.storyboard}, '{scenes}', ${JSON.stringify(updated.scenes)}::jsonb)`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(videoGenerationsTable.id, job.id),
            eq(videoGenerationsTable.tenantId, req.tenantId),
            eq(videoGenerationsTable.status, "awaiting_review"),
          ),
        )
        .returning()
    )[0];
    if (!saved) {
      res.status(400).json({ error: "This video is not waiting for storyboard review." });
      return;
    }
    res.json(serializeVideoJob(saved));
  },
);

/** Approve the plan and run the expensive half. */
router.post(
  "/ai/video-jobs/:jobId/storyboard/approve",
  async (req: Request, res: Response) => {
    const loaded = await loadPausedJob(req, res);
    if (!loaded) return;

    // Claim atomically here rather than in the runner, so two approve requests
    // cannot both start a render (the second finds nothing to claim).
    const claimed = (
      await db
        .update(videoGenerationsTable)
        .set({
          status: "processing",
          stage: "Getting started",
          storyboardExpiresAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(videoGenerationsTable.id, loaded.job.id),
            eq(videoGenerationsTable.tenantId, req.tenantId),
            eq(videoGenerationsTable.status, "awaiting_review"),
            isNotNull(videoGenerationsTable.storyboard),
          ),
        )
        .returning()
    )[0];
    if (!claimed) {
      res.status(400).json({ error: "This video is not waiting for storyboard review." });
      return;
    }

    const accepted = enqueueBackgroundJob(() => resumeVideoGenerationJob(claimed));
    if (!accepted) {
      // Shutdown in progress: put the plan back so the user can approve again.
      // Nothing was charged, so there is nothing to refund.
      await db
        .update(videoGenerationsTable)
        .set({
          status: "awaiting_review",
          stage: null,
          storyboardExpiresAt: loaded.job.storyboardExpiresAt,
        })
        .where(eq(videoGenerationsTable.id, claimed.id));
      res.status(503).json({ error: "Server is restarting. Please retry in a moment." });
      return;
    }
    res.status(202).json(serializeVideoJob(claimed));
  },
);

/** Abandon the plan now instead of waiting for it to expire, and refund. */
router.post(
  "/ai/video-jobs/:jobId/storyboard/discard",
  async (req: Request, res: Response) => {
    const loaded = await loadPausedJob(req, res);
    if (!loaded) return;

    const discarded = (
      await db
        .update(videoGenerationsTable)
        .set({
          status: "failed",
          error: "You discarded this storyboard. Nothing was charged.",
          stage: null,
          storyboardExpiresAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(videoGenerationsTable.id, loaded.job.id),
            eq(videoGenerationsTable.tenantId, req.tenantId),
            eq(videoGenerationsTable.status, "awaiting_review"),
          ),
        )
        .returning()
    )[0];
    // Conditional on status, so only the request that actually flipped the row
    // issues the refund — a double discard cannot refund twice.
    if (!discarded) {
      res.status(400).json({ error: "This video is not waiting for storyboard review." });
      return;
    }
    const discardedReservation = reservationFromRow(discarded);
    if (discardedReservation) {
      await refundWallet(
        req.tenantId,
        discardedReservation,
        "storyboard discarded",
      ).catch((err) =>
        req.log.error({ err, jobId: discarded.id }, "Failed to refund discarded storyboard"),
      );
    } else if (discarded.funding === "credit") {
      await refundCredits(
        req.tenantId,
        "video",
        videoJobUnits(discarded.engine, discarded.options),
        "storyboard discarded",
      ).catch((err) =>
        req.log.error({ err, jobId: discarded.id }, "Failed to refund discarded storyboard"),
      );
    }
    res.json(serializeVideoJob(discarded));
  },
);

/** Save a finished video into the content library as a draft item. */
router.post(
  "/ai/video-jobs/:jobId/save-to-library",
  async (req: Request, res: Response) => {
    const parsed = SaveVideoToLibraryBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    const job = await loadJob(req);
    if (!job) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (job.status !== "succeeded" || !job.videoPath) {
      res.status(400).json({ error: "This video is not ready yet." });
      return;
    }
    const created = (
      await db
        .insert(contentItemsTable)
        .values({
          tenantId: req.tenantId,
          title: parsed.data.title,
          caption: parsed.data.caption ?? "",
          videoPath: job.videoPath,
          videoThumbnailPath: job.thumbnailPath,
          platform: parsed.data.platform ?? "instagram",
          contentType: "reel",
          status: "draft",
          brandKitId: parsed.data.brandKitId ?? null,
        })
        .returning()
    )[0]!;
    res.status(201).json(serializeContent(created));
  },
);

export default router;
