import { db, bytePlusIdentityCleanupsTable } from "@workspace/db";
import { and, asc, eq, lte, lt, or, sql } from "drizzle-orm";
import {
  BytePlusAssetsError,
  deleteAssetGroup,
  resolveBytePlusAssetsCredentials,
  resolveLivenessAssetGroup,
} from "./byteplus/assets";
import { logger } from "./logger";
import { decryptJson } from "./secretCrypto";
import { randomUUID } from "node:crypto";

const BATCH_SIZE = 10;
const MAX_ATTEMPTS = 8;
const SWEEP_INTERVAL_MS = 60_000;
const PROCESSING_LEASE_MS = 5 * 60_000;
let sweepTimer: ReturnType<typeof setInterval> | null = null;
let sweepRunning = false;

function retryDelayMs(attempts: number): number {
  return Math.min(6 * 60 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1));
}

function errorCode(error: unknown): string {
  if (error instanceof BytePlusAssetsError) {
    return (error.code || (error.status ? `http_${error.status}` : "provider_error")).slice(0, 100);
  }
  return "unknown";
}

function isAlreadyDeleted(error: unknown): boolean {
  if (!(error instanceof BytePlusAssetsError)) return false;
  return error.status === 404 || /not.?found|does.?not.?exist/i.test(error.code ?? "");
}

function isPermanentlyUnsupported(error: unknown): boolean {
  if (!(error instanceof BytePlusAssetsError)) return false;
  return /unsupported|not.?supported|invalid.?action/i.test(error.code ?? "");
}

async function finish(
  id: number,
  leaseToken: string,
  status: "succeeded" | "unsupported" | "exhausted",
  code: string | null,
  clearRecoveryHandle = true,
) {
  await db.update(bytePlusIdentityCleanupsTable).set({
    status,
    lastErrorCode: code,
    completedAt: new Date(),
    leaseToken: null,
    ...(clearRecoveryHandle ? { verificationTokenEncrypted: null } : {}),
  }).where(and(
    eq(bytePlusIdentityCleanupsTable.id, id),
    eq(bytePlusIdentityCleanupsTable.status, "processing"),
    eq(bytePlusIdentityCleanupsTable.leaseToken, leaseToken),
  ));
}

async function retry(id: number, leaseToken: string, attempts: number, error: unknown) {
  const terminal = attempts >= MAX_ATTEMPTS;
  await db.update(bytePlusIdentityCleanupsTable).set({
    status: terminal ? "exhausted" : "pending",
    lastErrorCode: terminal ? "retry_exhausted" : errorCode(error),
    nextAttemptAt: new Date(Date.now() + retryDelayMs(attempts)),
    completedAt: terminal ? new Date() : null,
    leaseToken: null,
  }).where(and(
    eq(bytePlusIdentityCleanupsTable.id, id),
    eq(bytePlusIdentityCleanupsTable.status, "processing"),
    eq(bytePlusIdentityCleanupsTable.leaseToken, leaseToken),
  ));
}

export async function enqueueBytePlusIdentityCleanup(args: {
  tenantId: number;
  sourceIdentityId: number;
  sourceAttemptId: string;
  assetGroupId?: string | null;
  verificationTokenEncrypted?: string | null;
}): Promise<number> {
  const [row] = await db.insert(bytePlusIdentityCleanupsTable).values({
    tenantId: args.tenantId,
    sourceIdentityId: args.sourceIdentityId,
    sourceAttemptId: args.sourceAttemptId,
    assetGroupId: args.assetGroupId ?? null,
    verificationTokenEncrypted: args.verificationTokenEncrypted ?? null,
  }).onConflictDoUpdate({
    target: bytePlusIdentityCleanupsTable.sourceAttemptId,
    set: {
      status: sql`case when ${bytePlusIdentityCleanupsTable.status} = 'succeeded' then 'succeeded' else 'pending' end`,
      assetGroupId: args.assetGroupId ?? null,
      verificationTokenEncrypted: args.assetGroupId
        ? null
        : (args.verificationTokenEncrypted ?? null),
      nextAttemptAt: new Date(),
      completedAt: sql`case when ${bytePlusIdentityCleanupsTable.status} = 'succeeded' then ${bytePlusIdentityCleanupsTable.completedAt} else null end`,
    },
  }).returning({ id: bytePlusIdentityCleanupsTable.id });
  return row!.id;
}

export async function sweepBytePlusIdentityCleanups(options: {
  tenantId?: number;
} = {}): Promise<number> {
  if (sweepRunning) return 0;
  sweepRunning = true;
  try {
    const now = new Date();
    const stale = new Date(now.getTime() - PROCESSING_LEASE_MS);
    const due = await db.select({ id: bytePlusIdentityCleanupsTable.id })
      .from(bytePlusIdentityCleanupsTable)
      .where(and(
        options.tenantId === undefined
          ? undefined
          : eq(bytePlusIdentityCleanupsTable.tenantId, options.tenantId),
        or(
          and(
            eq(bytePlusIdentityCleanupsTable.status, "pending"),
            lte(bytePlusIdentityCleanupsTable.nextAttemptAt, now),
          ),
          and(
            eq(bytePlusIdentityCleanupsTable.status, "processing"),
            lt(bytePlusIdentityCleanupsTable.updatedAt, stale),
          ),
        ),
      ))
      .orderBy(asc(bytePlusIdentityCleanupsTable.nextAttemptAt))
      .limit(BATCH_SIZE);
    if (!due.length) return 0;

    const credentials = await resolveBytePlusAssetsCredentials();
    if (!credentials) return 0;

    let processed = 0;
    for (const candidate of due) {
      const leaseToken = randomUUID();
      const [claimed] = await db.update(bytePlusIdentityCleanupsTable).set({
        status: "processing",
        attempts: sql`${bytePlusIdentityCleanupsTable.attempts} + 1`,
        leaseToken,
      }).where(and(
        eq(bytePlusIdentityCleanupsTable.id, candidate.id),
        or(
          and(
            eq(bytePlusIdentityCleanupsTable.status, "pending"),
            lte(bytePlusIdentityCleanupsTable.nextAttemptAt, now),
          ),
          and(
            eq(bytePlusIdentityCleanupsTable.status, "processing"),
            lt(bytePlusIdentityCleanupsTable.updatedAt, stale),
          ),
        ),
      )).returning();
      if (!claimed) continue;
      processed += 1;
      let deleting = false;
      try {
        let assetGroupId = claimed.assetGroupId;
        if (!assetGroupId) {
          if (!claimed.verificationTokenEncrypted) {
            await finish(claimed.id, leaseToken, "unsupported", "missing_resolution_token");
            continue;
          }
          const { token } = decryptJson<{ token: string }>(claimed.verificationTokenEncrypted);
          assetGroupId = await resolveLivenessAssetGroup(token, credentials);
          const [persisted] = await db.update(bytePlusIdentityCleanupsTable).set({
            assetGroupId,
            verificationTokenEncrypted: null,
          }).where(and(
            eq(bytePlusIdentityCleanupsTable.id, claimed.id),
            eq(bytePlusIdentityCleanupsTable.status, "processing"),
            eq(bytePlusIdentityCleanupsTable.leaseToken, leaseToken),
          )).returning({ id: bytePlusIdentityCleanupsTable.id });
          if (!persisted) continue;
        }
        deleting = true;
        await deleteAssetGroup(assetGroupId, credentials);
        await finish(claimed.id, leaseToken, "succeeded", null);
      } catch (error) {
        if (deleting && isAlreadyDeleted(error)) {
          await finish(claimed.id, leaseToken, "succeeded", "already_deleted");
        } else if (isPermanentlyUnsupported(error)) {
          await finish(
            claimed.id,
            leaseToken,
            "unsupported",
            errorCode(error),
            deleting,
          );
        } else {
          await retry(claimed.id, leaseToken, claimed.attempts, error);
        }
      }
    }
    return processed;
  } finally {
    sweepRunning = false;
  }
}

export function startBytePlusIdentityCleanupSweep(): void {
  if (sweepTimer) return;
  void sweepBytePlusIdentityCleanups().catch((error) =>
    logger.error({ err: error }, "BytePlus identity cleanup sweep failed"));
  sweepTimer = setInterval(() => {
    void sweepBytePlusIdentityCleanups().catch((error) =>
      logger.error({ err: error }, "BytePlus identity cleanup sweep failed"));
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
}

export function stopBytePlusIdentityCleanupSweep(): void {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}