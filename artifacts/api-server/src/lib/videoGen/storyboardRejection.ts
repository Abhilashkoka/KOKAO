import { randomUUID } from "node:crypto";
import {
  db, charactersTable, characterOutfitsTable, guidedStoryDraftsTable,
  videoGenerationsTable, tenantsTable, type VideoJobOptions,
} from "@workspace/db";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { deleteAtlasAsset, getAtlasAsset, isAtlasPredictionTerminal, resolveAtlasAssetsKey } from "../atlascloud/assets";
import { deleteAsset, resolveBytePlusAssetsCredentials } from "../byteplus/assets";
import { logger } from "../logger";

type Rejection = NonNullable<VideoJobOptions["storyboardRejection"]>;
export class StoryboardRejectionError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
class CleanupWaitError extends Error {}

/** Read only explicit character-reference fields, never arbitrary nested numeric IDs. */
export function referencedCharacterIds(value: unknown): Set<number> {
  const result = new Set<number>();
  const visit = (item: unknown) => {
    if (!item || typeof item !== "object") return;
    if (Array.isArray(item)) { item.forEach(visit); return; }
    for (const [key, child] of Object.entries(item)) {
      if (key === "storyboardRejection") continue;
      if ((key === "characterId" || key === "selectedCharacterId") &&
          typeof child === "number" && Number.isSafeInteger(child) && child > 0) result.add(child);
      if (key === "character" && child && typeof child === "object" && "id" in child &&
          typeof child.id === "number" && Number.isSafeInteger(child.id) && child.id > 0) result.add(child.id);
      visit(child);
    }
  };
  visit(value);
  return result;
}

export function publicStoryboardRejection(rejection: VideoJobOptions["storyboardRejection"]) {
  return rejection ? {
    rejectedAt: rejection.rejectedAt,
    removedCharacterCount: rejection.removedCharacterIds.length,
    preservedCharacterCount: rejection.preservedCharacterIds.length,
    cleanupState: rejection.cleanup.state,
    cleanupMessage: rejection.cleanup.message,
  } : null;
}

/**
 * Delete local library rows and atomically retain upstream cleanup handles.
 * Provider calls never run in this transaction. Other stories/drafts keep their cast.
 * The completed video, receipt history and billing are deliberately unchanged.
 */
export async function rejectStoryboard(tenantId: number, jobId: number) {
  return db.transaction(async (tx) => {
    await tx.select({ id: tenantsTable.id }).from(tenantsTable)
      .where(eq(tenantsTable.id, tenantId)).for("update");
    // Same draft-before-job order as Guided approval/recovery.
    const drafts = await tx.select().from(guidedStoryDraftsTable)
      .where(eq(guidedStoryDraftsTable.tenantId, tenantId)).orderBy(asc(guidedStoryDraftsTable.id)).for("update");
    const jobs = await tx.select().from(videoGenerationsTable)
      .where(eq(videoGenerationsTable.tenantId, tenantId)).orderBy(asc(videoGenerationsTable.id)).for("update");
    const job = jobs.find((row) => row.id === jobId);
    if (!job) throw new StoryboardRejectionError("Video not found.", 404);
    if (job.options?.storyboardRejection) return job;
    if (!["failed", "succeeded"].includes(job.status)) {
      throw new StoryboardRejectionError("Only failed or completed videos can be rejected. Wait for active work to finish.", 409);
    }
    const ownDraft = drafts.find((draft) =>
      draft.id === job.options?.guidedStory?.draftId && draft.state.storyboardJobId === job.id);
    if (ownDraft && (
      Object.values(ownDraft.state.castOperations).some((operation) =>
        operation.revision === ownDraft.revision && operation.status !== "uploaded") ||
      Object.values(ownDraft.state.referenceOperations ?? {}).some((operation) =>
        ["queued", "running", "provider_running", "provider_succeeded", "outcome_unknown"].includes(operation.status))
    )) throw new StoryboardRejectionError("Wait for this story's active character work to finish before rejecting it.", 409);
    const candidateIds = referencedCharacterIds([job.options, job.storyboard, ownDraft?.state.cast]);
    const used = referencedCharacterIds([
      ...jobs.filter((row) => row.id !== job.id && !row.options?.storyboardRejection)
        .map((row) => [row.options, row.storyboard]),
      ...drafts.filter((draft) => draft.id !== ownDraft?.id).map((draft) => draft.state),
    ]);
    const characters = candidateIds.size ? await tx.select().from(charactersTable).where(and(
      eq(charactersTable.tenantId, tenantId), inArray(charactersTable.id, [...candidateIds]),
    )).orderBy(asc(charactersTable.id)).for("update") : [];
    // Live registration must keep its owner row until the finalizer persists its handles.
    const removable = characters.filter((character) => !used.has(character.id) &&
      !character.atlasAssetLeaseOwner && !character.bytePlusAssetGroupClaimedAt);
    const outfits = removable.length ? await tx.select().from(characterOutfitsTable).where(and(
      eq(characterOutfitsTable.tenantId, tenantId), inArray(characterOutfitsTable.characterId, removable.map((c) => c.id)),
    )).orderBy(asc(characterOutfitsTable.id)).for("update") : [];
    const liveOutfitParents = new Set(outfits.filter((o) => o.atlasAssetLeaseOwner || o.bytePlusAssetClaimedAt).map((o) => o.characterId));
    const removedIds = removable.filter((c) => !liveOutfitParents.has(c.id)).map((c) => c.id);
    const removed = new Set(removedIds);
    const assets: Rejection["cleanup"]["assets"] = [];
    for (const c of characters.filter((c) => removed.has(c.id))) {
      if (c.atlasAssetLibraryId || c.atlasAssetId || c.atlasAssetSubmitFencedAt) {
        assets.push({ provider: "atlascloud", characterId: c.id, libraryRecordId: c.atlasAssetLibraryId,
          assetId: c.atlasAssetId, submitFencedAt: c.atlasAssetSubmitFencedAt?.toISOString() });
      }
    }
    for (const outfit of outfits.filter((o) => removed.has(o.characterId))) {
      if (outfit.atlasAssetLibraryId || outfit.atlasAssetId || outfit.atlasAssetSubmitFencedAt) {
        assets.push({ provider: "atlascloud", characterId: outfit.characterId, outfitId: outfit.id,
          libraryRecordId: outfit.atlasAssetLibraryId, assetId: outfit.atlasAssetId,
          submitFencedAt: outfit.atlasAssetSubmitFencedAt?.toISOString() });
      }
      if (outfit.bytePlusAssetId) assets.push({
        provider: "byteplus", characterId: outfit.characterId, outfitId: outfit.id, assetId: outfit.bytePlusAssetId,
      });
    }
    const now = new Date().toISOString();
    // A reused provider handle must not be deleted with only one of its owners.
    const remainingCharacters = await tx.select().from(charactersTable).where(eq(charactersTable.tenantId, tenantId));
    const remainingOutfits = await tx.select().from(characterOutfitsTable).where(eq(characterOutfitsTable.tenantId, tenantId));
    const retainedAtlasIds = new Set([
      ...remainingCharacters.filter((c) => !removed.has(c.id)).map((c) => c.atlasAssetLibraryId),
      ...remainingOutfits.filter((o) => !removed.has(o.characterId)).map((o) => o.atlasAssetLibraryId),
    ].filter((id): id is number => id != null));
    const retainedBytePlusIds = new Set(remainingOutfits.filter((o) => !removed.has(o.characterId)).map((o) => o.bytePlusAssetId));
    const ownedAssets = assets.filter((a) => a.provider === "atlascloud"
      ? !a.libraryRecordId || !retainedAtlasIds.has(a.libraryRecordId)
      : !retainedBytePlusIds.has(a.assetId ?? null));
    const rejection: Rejection = {
      version: 1, rejectedAt: now, removedCharacterIds: removedIds,
      preservedCharacterIds: characters.filter((c) => !removed.has(c.id)).map((c) => c.id),
      cleanup: { state: ownedAssets.length ? "pending" : "complete", assets: ownedAssets, attempts: 0, nextAttemptAt: now,
        message: ownedAssets.length ? "Provider cleanup is queued. No Atlas console action is needed to remove these characters from KOKAO." : null },
    };
    if (ownDraft) {
      // Keep the script, but invalidate the rejected cast and execution approval.
      await tx.update(guidedStoryDraftsTable).set({
        revision: ownDraft.revision + 1,
        state: { ...ownDraft.state, cast: [], castApprovals: null, storyboardJobId: null },
        updatedAt: new Date(),
      }).where(eq(guidedStoryDraftsTable.id, ownDraft.id));
    }
    const [saved] = await tx.update(videoGenerationsTable).set({
      options: sql`jsonb_set(COALESCE(${videoGenerationsTable.options}, '{}'::jsonb), '{storyboardRejection}', ${JSON.stringify(rejection)}::jsonb)`,
      guidedStoryRecoveryDismissedAt: new Date(), updatedAt: new Date(),
    }).where(and(eq(videoGenerationsTable.id, job.id), eq(videoGenerationsTable.tenantId, tenantId))).returning();
    if (removedIds.length) {
      await tx.delete(characterOutfitsTable).where(and(
        eq(characterOutfitsTable.tenantId, tenantId), inArray(characterOutfitsTable.characterId, removedIds),
      ));
      await tx.delete(charactersTable).where(and(
        eq(charactersTable.tenantId, tenantId), inArray(charactersTable.id, removedIds),
      ));
    }
    return saved!;
  });
}

/** Explicit absence only; a failed GET is never proof of successful deletion. */
async function atlasAbsent(id: number, key: string) {
  try { await getAtlasAsset(id, key); return false; }
  catch (error) {
    if (error instanceof Error && "status" in error && error.status === 404) return true;
    throw error;
  }
}

/** Restart-safe, token-fenced cleanup. Each pass is bounded to four assets. */
export async function cleanupRejectedStoryboard(jobId: number): Promise<void> {
  const token = randomUUID();
  const job = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(videoGenerationsTable).where(eq(videoGenerationsTable.id, jobId)).for("update");
    const rejection = row?.options?.storyboardRejection;
    if (!row || !rejection || rejection.cleanup.state === "complete" ||
        Date.parse(rejection.cleanup.nextAttemptAt) > Date.now() ||
        (rejection.cleanup.leaseExpiresAt && Date.parse(rejection.cleanup.leaseExpiresAt) > Date.now())) return null;
    const next = structuredClone(rejection);
    next.cleanup.leaseToken = token;
    next.cleanup.leaseExpiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const [claimed] = await tx.update(videoGenerationsTable).set({
      options: sql`jsonb_set(${videoGenerationsTable.options}, '{storyboardRejection}', ${JSON.stringify(next)}::jsonb)`,
    }).where(eq(videoGenerationsTable.id, jobId)).returning();
    return claimed!;
  });
  if (!job) return;
  const rejection = structuredClone(job.options!.storyboardRejection!);
  let message: string | null = null;
  try {
    const pending = rejection.cleanup.assets.filter((a) => !a.done);
    const atlasKey = pending.some((a) => a.provider === "atlascloud") ? await resolveAtlasAssetsKey() : null;
    if (pending.some((a) => a.provider === "atlascloud")) {
      if (!atlasKey) throw new CleanupWaitError("Provider credentials are unavailable; cleanup will retry.");
      const tasks = Object.values(job.options?.providerTasks ?? {}).filter((task) => task.provider === "atlascloud");
      if (tasks.some((task) => task.submitStartedAt && !task.taskId)) {
        throw new CleanupWaitError("Waiting for an uncertain Atlas submission to be reconciled; its assets remain protected.");
      }
      const taskIds = new Set(tasks.map((task) => task.taskId).filter(Boolean));
      if (job.provider === "atlascloud" && job.providerTaskId) taskIds.add(job.providerTaskId);
      if (job.provider === "atlascloud" && job.status === "failed" && !tasks.length && !taskIds.size) {
        throw new CleanupWaitError("This older Atlas attempt has no saved task receipt. Cleanup is retained pending reconciliation.");
      }
      for (const taskId of taskIds) {
        if (!(await isAtlasPredictionTerminal(taskId, atlasKey))) {
          throw new CleanupWaitError("Atlas is still processing this video's scenes. Cleanup will resume after they finish.");
        }
      }
    }
    for (const asset of pending.slice(0, 4)) {
      if (asset.provider === "atlascloud") {
        if (!asset.libraryRecordId) throw new CleanupWaitError("An older Atlas registration needs reconciliation. Its cleanup record has been retained.");
        if (!(await atlasAbsent(asset.libraryRecordId, atlasKey!))) {
          await deleteAtlasAsset(asset.libraryRecordId, atlasKey!);
          if (!(await atlasAbsent(asset.libraryRecordId, atlasKey!))) {
            throw new CleanupWaitError("Atlas has not yet confirmed removal. Cleanup will retry automatically.");
          }
        }
      } else {
        const credentials = await resolveBytePlusAssetsCredentials();
        if (!credentials || !asset.assetId) throw new CleanupWaitError("Character provider credentials are unavailable; cleanup will retry.");
        await deleteAsset(asset.assetId, credentials);
      }
      asset.done = true;
    }
  } catch (error) {
    // Do not expose provider response bodies, IDs or credentials in the public status.
    logger.warn({ jobId, errorType: error instanceof Error ? error.name : "unknown" }, "Rejected storyboard cleanup remains pending");
    const safe = error instanceof CleanupWaitError ? error.message : null;
    message = safe ?? "The provider could not confirm removal. KOKAO has retained the cleanup records and will retry automatically.";
  }
  rejection.cleanup.state = rejection.cleanup.assets.every((a) => a.done) ? "complete" : "pending";
  rejection.cleanup.attempts += 1;
  rejection.cleanup.message = rejection.cleanup.state === "complete" ? null : message ?? "Provider cleanup is continuing.";
  rejection.cleanup.leaseToken = null;
  rejection.cleanup.leaseExpiresAt = null;
  rejection.cleanup.nextAttemptAt = new Date(Date.now() + Math.min(60, 2 ** Math.min(rejection.cleanup.attempts, 6)) * 60_000).toISOString();
  await db.update(videoGenerationsTable).set({
    options: sql`jsonb_set(${videoGenerationsTable.options}, '{storyboardRejection}', ${JSON.stringify(rejection)}::jsonb)`,
    updatedAt: new Date(),
  }).where(and(eq(videoGenerationsTable.id, jobId),
    sql`${videoGenerationsTable.options}->'storyboardRejection'->'cleanup'->>'leaseToken' = ${token}`));
}

export async function sweepRejectedStoryboards(): Promise<void> {
  try {
    const rows = await db.select({ id: videoGenerationsTable.id }).from(videoGenerationsTable).where(
      sql`${videoGenerationsTable.options}->'storyboardRejection'->'cleanup'->>'state' = 'pending'
        AND (${videoGenerationsTable.options}->'storyboardRejection'->'cleanup'->>'nextAttemptAt')::timestamptz <= now()
        AND COALESCE((${videoGenerationsTable.options}->'storyboardRejection'->'cleanup'->>'leaseExpiresAt')::timestamptz, '-infinity'::timestamptz) <= now()`,
    ).orderBy(asc(videoGenerationsTable.id)).limit(50);
    for (const row of rows) await cleanupRejectedStoryboard(row.id);
  } catch (error) { logger.error({ error }, "Rejected storyboard cleanup sweep failed"); }
}