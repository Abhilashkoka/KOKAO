import { db, tenantsTable, usageEventsTable } from "@workspace/db";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { computeDisplayPaise, getAiSpendConfig } from "./aiSpend";
import { logger } from "./logger";

export type UsageKind = "caption" | "image" | "video";

const QUOTA_RESERVATION_MODEL = "__quota_reservation__";
const QUOTA_RESERVATION_STALE_MS = 2 * 60 * 60 * 1000;
const QUOTA_RESERVATION_RENEW_MS = 10 * 60 * 1000;

export function currentPeriodStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export async function getUsage(tenantId: number): Promise<{
  captions: number;
  images: number;
  videos: number;
  periodStart: Date;
}> {
  const periodStart = currentPeriodStart();
  const rows = await db
    .select({
      kind: usageEventsTable.kind,
      count: sql<number>`count(*)::int`,
    })
    .from(usageEventsTable)
    .where(
      and(
        eq(usageEventsTable.tenantId, tenantId),
        gte(usageEventsTable.createdAt, periodStart),
        // Credit-, wallet-, and explicitly unmetered rows exist only for
        // data-consumption/cost telemetry and must never count against the
        // monthly plan quota.
        sql`(${usageEventsTable.funding} IS DISTINCT FROM 'credit' AND ${usageEventsTable.funding} IS DISTINCT FROM 'wallet' AND ${usageEventsTable.funding} IS DISTINCT FROM 'unmetered')`,
      ),
    )
    .groupBy(usageEventsTable.kind);

  const captions = rows.find((r) => r.kind === "caption")?.count ?? 0;
  const images = rows.find((r) => r.kind === "image")?.count ?? 0;
  const videos = rows.find((r) => r.kind === "video")?.count ?? 0;
  return { captions, images, videos, periodStart };
}

/** Optional AI data-consumption metrics attached to a usage row. */
export interface UsageMeta {
  requestBytes?: number;
  responseBytes?: number;
  durationMs?: number;
  model?: string;
  campaignId?: string;
  platform?: string;
  funding?: "quota" | "credit" | "wallet" | "unmetered";
  // Actual-cost tracking (superadmin-only reporting; best-effort).
  provider?: string;
  inputTokens?: number;
  outputTokens?: number;
  inputCharacters?: number;
  sampleDurationMs?: number;
  costPaise?: number;
  // Richer telemetry (best-effort; omitted rather than zeroed when unknown).
  // cachedInputTokens/reasoningTokens are SUBSETS of inputTokens/outputTokens.
  cachedInputTokens?: number;
  reasoningTokens?: number;
  /** Time to first token, streaming text only. */
  ttftMs?: number;
  /** 0 = the first provider tried, 1 = the first fallback, and so on. */
  fallbackStep?: number;
  /** Human-readable "why this provider"; for debugging, never parsed. */
  routingReason?: string;
  /**
   * Precomputed display snapshot (paise). Job runners that must persist the
   * spend on the job row BEFORE flipping it to a terminal status pass the
   * value they already computed here, so the usage event and the job row can
   * never disagree. Undefined = compute from the current config as usual.
   */
  displayPaiseOverride?: number | null;
}

async function displayPaiseFor(
  kind: UsageKind,
  meta: UsageMeta,
): Promise<number | null> {
  if (meta.displayPaiseOverride !== undefined) return meta.displayPaiseOverride;
  try {
    const config = await getAiSpendConfig();
    return computeDisplayPaise(kind, meta.costPaise ?? null, config);
  } catch {
    return null;
  }
}

export interface QuotaUsageReservation {
  usageEventId: number;
}

/**
 * Keep a live quota hold younger than the stale-reclamation window.
 *
 * The interval is unref'd so it never keeps the process alive. A failed renewal
 * is logged and retried on the next tick; settlement still refuses to create an
 * extra quota event if the hold is ultimately lost.
 */
export function startQuotaUsageLease(
  tenantId: number,
  reservation: QuotaUsageReservation,
): () => void {
  const timer = setInterval(() => {
    void db
      .update(usageEventsTable)
      .set({ createdAt: new Date() })
      .where(
        and(
          eq(usageEventsTable.id, reservation.usageEventId),
          eq(usageEventsTable.tenantId, tenantId),
          eq(usageEventsTable.model, QUOTA_RESERVATION_MODEL),
        ),
      )
      .catch((error) => {
        logger.warn(
          { err: error, tenantId, usageEventId: reservation.usageEventId },
          "Failed to renew quota reservation lease",
        );
      });
  }, QUOTA_RESERVATION_RENEW_MS);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * Atomically hold one finite monthly quota unit.
 *
 * The tenant row is the lock shared by every caller, while the placeholder
 * usage row makes the hold visible to later requests after the transaction
 * commits. A crashed request is reclaimed after two hours the next time that
 * kind is reserved; normal failures delete the row immediately.
 */
export async function reserveQuotaUsage(
  tenantId: number,
  kind: UsageKind,
  limit: number,
): Promise<QuotaUsageReservation | null> {
  if (limit < 0) return null;
  const periodStart = currentPeriodStart();
  const staleBefore = new Date(Date.now() - QUOTA_RESERVATION_STALE_MS);

  return db.transaction(async (tx) => {
    const tenant = (
      await tx
        .select({ id: tenantsTable.id })
        .from(tenantsTable)
        .where(eq(tenantsTable.id, tenantId))
        .for("update")
        .limit(1)
    )[0];
    if (!tenant) return null;

    await tx
      .delete(usageEventsTable)
      .where(
        and(
          eq(usageEventsTable.tenantId, tenantId),
          eq(usageEventsTable.kind, kind),
          eq(usageEventsTable.model, QUOTA_RESERVATION_MODEL),
          lt(usageEventsTable.createdAt, staleBefore),
        ),
      );

    const used =
      (
        await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(usageEventsTable)
          .where(
            and(
              eq(usageEventsTable.tenantId, tenantId),
              eq(usageEventsTable.kind, kind),
              gte(usageEventsTable.createdAt, periodStart),
              sql`(${usageEventsTable.funding} IS DISTINCT FROM 'credit' AND ${usageEventsTable.funding} IS DISTINCT FROM 'wallet' AND ${usageEventsTable.funding} IS DISTINCT FROM 'unmetered')`,
            ),
          )
      )[0]?.count ?? 0;
    if (used >= limit) return null;

    const row = (
      await tx
        .insert(usageEventsTable)
        .values({
          tenantId,
          kind,
          funding: "quota",
          model: QUOTA_RESERVATION_MODEL,
        })
        .returning({ id: usageEventsTable.id })
    )[0];
    return row ? { usageEventId: row.id } : null;
  });
}

/** Convert a pending quota hold into the final metered usage event. */
export async function settleQuotaUsage(
  tenantId: number,
  reservation: QuotaUsageReservation,
  kind: UsageKind,
  meta: UsageMeta = {},
): Promise<number | null> {
  const displayPaise = await displayPaiseFor(kind, meta);
  const updated = await db
    .update(usageEventsTable)
    .set({
      kind,
      requestBytes: meta.requestBytes ?? null,
      responseBytes: meta.responseBytes ?? null,
      durationMs: meta.durationMs ?? null,
      model: meta.model ?? null,
      campaignId: meta.campaignId ?? null,
      platform: meta.platform ?? null,
      funding: "quota",
      provider: meta.provider ?? null,
      inputTokens: meta.inputTokens ?? null,
      outputTokens: meta.outputTokens ?? null,
      inputCharacters: meta.inputCharacters ?? null,
      sampleDurationMs: meta.sampleDurationMs ?? null,
      costPaise: meta.costPaise ?? null,
      cachedInputTokens: meta.cachedInputTokens ?? null,
      reasoningTokens: meta.reasoningTokens ?? null,
      ttftMs: meta.ttftMs ?? null,
      fallbackStep: meta.fallbackStep ?? null,
      routingReason: meta.routingReason ?? null,
      displayPaise,
    })
    .where(
      and(
        eq(usageEventsTable.id, reservation.usageEventId),
        eq(usageEventsTable.tenantId, tenantId),
        eq(usageEventsTable.model, QUOTA_RESERVATION_MODEL),
      ),
    )
    .returning({ id: usageEventsTable.id });

  // A lease that was genuinely lost must never recreate quota after that slot
  // has been reassigned. Preserve telemetry explicitly as unmetered instead;
  // the live lease makes this a crash/pause recovery path, not normal billing.
  if (updated.length === 0) {
    logger.error(
      { tenantId, usageEventId: reservation.usageEventId, kind },
      "Quota reservation was lost before settlement",
    );
    const reconciliationReason = [meta.routingReason, "quota_reservation_lost"]
      .filter(Boolean)
      .join("; ");
    return recordUsage(tenantId, kind, {
      ...meta,
      funding: "unmetered",
      routingReason: reconciliationReason,
    });
  }
  return displayPaise;
}

/** Release a quota hold when its generation produced no billable result. */
export async function releaseQuotaUsage(
  tenantId: number,
  reservation: QuotaUsageReservation,
): Promise<void> {
  await db
    .delete(usageEventsTable)
    .where(
      and(
        eq(usageEventsTable.id, reservation.usageEventId),
        eq(usageEventsTable.tenantId, tenantId),
        eq(usageEventsTable.model, QUOTA_RESERVATION_MODEL),
      ),
    );
}

/**
 * Insert one usage event and return the snapshotted tenant-facing display
 * amount (paise) it recorded, so callers can surface the REAL per-event
 * spend to the client instead of re-deriving it from the flat rates.
 * Returns null when no snapshot could be computed.
 */
export async function recordUsage(
  tenantId: number,
  kind: UsageKind,
  meta: UsageMeta = {},
): Promise<number | null> {
  // Snapshot the tenant-facing display amount at the settings in effect
  // RIGHT NOW, so later rate/margin changes never rewrite historical spend
  // figures. In flat mode this is the per-kind rate; in cost_plus mode it is
  // actual cost x (1 + margin%), falling back to the flat rate when the cost
  // is unknown. Best-effort: a failed lookup stores NULL (reports fall back
  // to current rates for such rows) and must never block the metered action.
  const displayPaise = await displayPaiseFor(kind, meta);
  await db.insert(usageEventsTable).values({
    tenantId,
    kind,
    requestBytes: meta.requestBytes ?? null,
    responseBytes: meta.responseBytes ?? null,
    durationMs: meta.durationMs ?? null,
    model: meta.model ?? null,
    campaignId: meta.campaignId ?? null,
    platform: meta.platform ?? null,
    funding: meta.funding ?? null,
    provider: meta.provider ?? null,
    inputTokens: meta.inputTokens ?? null,
    outputTokens: meta.outputTokens ?? null,
    inputCharacters: meta.inputCharacters ?? null,
    sampleDurationMs: meta.sampleDurationMs ?? null,
    costPaise: meta.costPaise ?? null,
    cachedInputTokens: meta.cachedInputTokens ?? null,
    reasoningTokens: meta.reasoningTokens ?? null,
    ttftMs: meta.ttftMs ?? null,
    fallbackStep: meta.fallbackStep ?? null,
    routingReason: meta.routingReason ?? null,
    displayPaise,
  });
  return displayPaise;
}
