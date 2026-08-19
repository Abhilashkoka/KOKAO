import {
  and,
  asc,
  eq,
  gte,
  isNull,
  lt,
  lte,
  or,
} from "drizzle-orm";
import {
  brandVoiceExtractedSamplesTable,
  db,
} from "@workspace/db";
import { logger } from "./logger";
import { ObjectStorageService } from "./objectStorage";
import { loadActivePayload } from "./brandKit/service";

export const BRAND_VOICE_EXTRACT_TTL_MS = 2 * 60 * 60 * 1000;
const CLAIM_STALE_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;
const SWEEP_INITIAL_DELAY_MS = 60 * 1000;
const SWEEP_BATCH_SIZE = 100;

const objectStorage = new ObjectStorageService();

export function isBrandVoiceExtractedSamplePath(
  path: string,
  tenantId: number,
  brandKitId: number,
): boolean {
  return path.startsWith(
    `/objects/${tenantId}/voice-extracts/${brandKitId}/`,
  );
}

export async function registerBrandVoiceExtractedSample(input: {
  tenantId: number;
  brandKitId: number;
  objectPath: string;
}): Promise<void> {
  await db.insert(brandVoiceExtractedSamplesTable).values({
    ...input,
    expiresAt: new Date(Date.now() + BRAND_VOICE_EXTRACT_TTL_MS),
  });
}

/**
 * Claim a temporary sample for cloning. A voice-extract path without an
 * available tracking row is expired, already being cloned, or forged.
 */
export async function claimBrandVoiceExtractedSample(input: {
  tenantId: number;
  brandKitId: number;
  objectPath: string;
}): Promise<boolean> {
  const [row] = await db
    .update(brandVoiceExtractedSamplesTable)
    .set({ claimedAt: new Date() })
    .where(
      and(
        eq(brandVoiceExtractedSamplesTable.tenantId, input.tenantId),
        eq(brandVoiceExtractedSamplesTable.brandKitId, input.brandKitId),
        eq(brandVoiceExtractedSamplesTable.objectPath, input.objectPath),
        isNull(brandVoiceExtractedSamplesTable.claimedAt),
        gte(brandVoiceExtractedSamplesTable.expiresAt, new Date()),
      ),
    )
    .returning({ id: brandVoiceExtractedSamplesTable.id });
  return Boolean(row);
}

export async function releaseBrandVoiceExtractedSampleClaim(input: {
  tenantId: number;
  brandKitId: number;
  objectPath: string;
}): Promise<void> {
  await db
    .update(brandVoiceExtractedSamplesTable)
    .set({ claimedAt: null })
    .where(
      and(
        eq(brandVoiceExtractedSamplesTable.tenantId, input.tenantId),
        eq(brandVoiceExtractedSamplesTable.brandKitId, input.brandKitId),
        eq(brandVoiceExtractedSamplesTable.objectPath, input.objectPath),
      ),
    );
}

/** The successful clone adopted the object; only its temporary tracker goes. */
export async function adoptBrandVoiceExtractedSample(input: {
  tenantId: number;
  brandKitId: number;
  objectPath: string;
}): Promise<void> {
  await db
    .delete(brandVoiceExtractedSamplesTable)
    .where(
      and(
        eq(brandVoiceExtractedSamplesTable.tenantId, input.tenantId),
        eq(brandVoiceExtractedSamplesTable.brandKitId, input.brandKitId),
        eq(brandVoiceExtractedSamplesTable.objectPath, input.objectPath),
      ),
    );
}

/** Delete an already-claimed temporary sample and then its durable tracker. */
export async function discardClaimedBrandVoiceExtractedSample(input: {
  tenantId: number;
  brandKitId: number;
  objectPath: string;
}): Promise<void> {
  await objectStorage.deleteObjectEntity(input.objectPath, input.tenantId);
  await adoptBrandVoiceExtractedSample(input);
}

export type ExtractedSampleDeleteResult = "deleted" | "missing" | "busy";

/**
 * Atomically claim an abandoned sample before deleting it. Clone and cleanup
 * therefore cannot both own the same object.
 */
export async function deleteBrandVoiceExtractedSample(input: {
  tenantId: number;
  brandKitId: number;
  objectPath: string;
}): Promise<ExtractedSampleDeleteResult> {
  const claimed = await claimBrandVoiceExtractedSample(input);
  if (!claimed) {
    const [existing] = await db
      .select({ claimedAt: brandVoiceExtractedSamplesTable.claimedAt })
      .from(brandVoiceExtractedSamplesTable)
      .where(
        and(
          eq(brandVoiceExtractedSamplesTable.tenantId, input.tenantId),
          eq(brandVoiceExtractedSamplesTable.brandKitId, input.brandKitId),
          eq(brandVoiceExtractedSamplesTable.objectPath, input.objectPath),
        ),
      )
      .limit(1);
    return existing?.claimedAt ? "busy" : "missing";
  }
  try {
    await discardClaimedBrandVoiceExtractedSample(input);
    return "deleted";
  } catch (error) {
    await releaseBrandVoiceExtractedSampleClaim(input).catch(() => {});
    throw error;
  }
}

export async function sweepExpiredBrandVoiceExtractedSamples(
  now = new Date(),
): Promise<number> {
  const rows = await db
    .select()
    .from(brandVoiceExtractedSamplesTable)
    .where(lte(brandVoiceExtractedSamplesTable.expiresAt, now))
    .orderBy(asc(brandVoiceExtractedSamplesTable.expiresAt))
    .limit(SWEEP_BATCH_SIZE);
  let deleted = 0;
  for (const row of rows) {
    const activePayload = await loadActivePayload(row.tenantId, row.brandKitId);
    const voice = activePayload?.payload.brand_voice;
    if (
      voice?.sample_asset_path === row.objectPath ||
      voice?.voices?.some(
        (entry) => entry.sample_asset_path === row.objectPath,
      )
    ) {
      // A clone committed but its best-effort tracker deletion failed. The
      // object is retained by the Brand Kit, so only discard the stale tracker.
      await db
        .delete(brandVoiceExtractedSamplesTable)
        .where(eq(brandVoiceExtractedSamplesTable.id, row.id));
      continue;
    }
    const [claimed] = await db
      .update(brandVoiceExtractedSamplesTable)
      .set({ claimedAt: now })
      .where(
        and(
          eq(brandVoiceExtractedSamplesTable.id, row.id),
          or(
            isNull(brandVoiceExtractedSamplesTable.claimedAt),
            lt(
              brandVoiceExtractedSamplesTable.claimedAt,
              new Date(now.getTime() - CLAIM_STALE_MS),
            ),
          ),
        ),
      )
      .returning({ id: brandVoiceExtractedSamplesTable.id });
    if (!claimed) continue;
    try {
      await objectStorage.deleteObjectEntity(row.objectPath, row.tenantId);
      await db
        .delete(brandVoiceExtractedSamplesTable)
        .where(eq(brandVoiceExtractedSamplesTable.id, row.id));
      deleted += 1;
    } catch (error) {
      await db
        .update(brandVoiceExtractedSamplesTable)
        .set({ claimedAt: null })
        .where(eq(brandVoiceExtractedSamplesTable.id, row.id))
        .catch(() => {});
      logger.warn(
        { err: error, extractedSampleId: row.id },
        "Expired Brand Voice sample cleanup failed",
      );
    }
  }
  return deleted;
}

let sweepTimer: NodeJS.Timeout | null = null;
let initialTimer: NodeJS.Timeout | null = null;

export function startBrandVoiceExtractedSampleSweep(): void {
  if (sweepTimer || initialTimer) return;
  initialTimer = setTimeout(() => {
    initialTimer = null;
    void sweepExpiredBrandVoiceExtractedSamples();
    sweepTimer = setInterval(() => {
      void sweepExpiredBrandVoiceExtractedSamples();
    }, SWEEP_INTERVAL_MS);
    sweepTimer.unref();
  }, SWEEP_INITIAL_DELAY_MS);
  initialTimer.unref();
}

export function stopBrandVoiceExtractedSampleSweep(): void {
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}