import {
  db,
  walletBalancesTable,
  walletLedgerTable,
  walletProviderOperationsTable,
  walletSettlementRetriesTable,
  walletSettingsTable,
  tenantsTable,
  videoGenerationsTable,
  type WalletLedgerEntry,
  type WalletProviderOperation,
  type WalletSettlementRetry,
  type VideoGeneration,
  type VideoStoryboardScene,
} from "@workspace/db";
import { and, asc, desc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { isFeatureEnabled } from "./featureFlags";
import { getAiSpendConfig, withFee } from "./aiSpend";
import {
  computeTextCostPaise,
  computeImageCostPaise,
  computeVideoCostPaise,
  findModelPrice,
  getAiCostConfig,
} from "./aiCost";
import { logger } from "./logger";
import {
  notifyWalletTrueUpFailing,
  resolveWalletTrueUpFailingNotifications,
} from "./notifications";

/**
 * Prepaid RUPEE wallet.
 *
 * Money model, in one paragraph: a tenant tops up a GST-exclusive rupee
 * amount (GST is added on top only at the Razorpay checkout step); each AI
 * generation reserves an estimate up front, then settles to the REAL provider
 * cost plus the platform fee once the provider reports back. Everything is
 * integer paise and every movement is a wallet_ledger row, so the ledger
 * always sums to the balance.
 *
 * Nothing in here runs unless BOTH the `wallet` platform kill switch is on
 * AND the tenant is on billingMode="wallet". Off means the existing plan
 * quota / unit credit path is untouched.
 */

export type WalletKind = "caption" | "image" | "video";

// ---------- settings ----------

export interface WalletConfig {
  gstPercent: number;
  minTopupPaise: number;
  lowBalanceThresholdPaise: number;
  videoCostPaise: number;
}

const DEFAULT_CONFIG: WalletConfig = {
  gstPercent: 18,
  minTopupPaise: 10_000,
  lowBalanceThresholdPaise: 0,
  videoCostPaise: 0,
};

export async function getWalletConfig(): Promise<WalletConfig> {
  const [row] = await db.select().from(walletSettingsTable).limit(1);
  if (!row) return { ...DEFAULT_CONFIG };
  return {
    gstPercent: row.gstPercent,
    minTopupPaise: row.minTopupPaise,
    lowBalanceThresholdPaise: row.lowBalanceThresholdPaise,
    videoCostPaise: row.videoCostPaise,
  };
}

export async function setWalletConfig(config: WalletConfig): Promise<WalletConfig> {
  const [existing] = await db.select().from(walletSettingsTable).limit(1);
  if (existing) {
    await db
      .update(walletSettingsTable)
      .set({ ...config, updatedAt: new Date() })
      .where(eq(walletSettingsTable.id, existing.id));
  } else {
    // Flush any in-memory fail counts into the new row so counts accumulated
    // before the first config save are not silently discarded on the next
    // server restart.  Without this, a fresh install that fails some true-up
    // sweeps before an admin ever saves wallet settings would lose its streak
    // and never reach the alert threshold.
    const pendingFailCounts = Object.fromEntries(trueUpFailCounts);
    await db.insert(walletSettingsTable).values({
      ...config,
      ...(Object.keys(pendingFailCounts).length > 0
        ? { trueUpFailCounts: pendingFailCounts }
        : {}),
    });
  }
  return getWalletConfig();
}

// ---------- GST ----------

/** GST payable on a base amount, rounded to whole paise. */
export function gstOn(basePaise: number, gstPercent: number): number {
  if (!Number.isFinite(basePaise) || basePaise <= 0) return 0;
  if (!Number.isFinite(gstPercent) || gstPercent <= 0) return 0;
  return Math.round((basePaise * gstPercent) / 100);
}

/** What the tenant actually pays at checkout: base + GST. */
export function withGst(basePaise: number, gstPercent: number): number {
  return basePaise + gstOn(basePaise, gstPercent);
}

// ---------- mode ----------

/**
 * True when this workspace's generations should be funded from the wallet.
 * Requires the platform switch AND the per-tenant mode; either one off means
 * the caller keeps its existing quota-then-credits behaviour.
 *
 * Fails CLOSED to "quota" on any error: a wallet lookup blowing up must never
 * charge someone twice or lock them out of a rail that was working.
 */
export async function isWalletFunded(tenantId: number): Promise<boolean> {
  try {
    if (!(await isFeatureEnabled("wallet"))) return false;
    const [tenant] = await db
      .select({ billingMode: tenantsTable.billingMode })
      .from(tenantsTable)
      .where(eq(tenantsTable.id, tenantId))
      .limit(1);
    return tenant?.billingMode === "wallet";
  } catch {
    return false;
  }
}

// ---------- pricing ----------

/**
 * The up-front estimate for one generation: the admin-set display rate with
 * the platform fee folded in. This is also the fallback when a model has no
 * row in the price catalog, so a generation is never silently free.
 */
export async function estimateChargePaise(kind: WalletKind): Promise<number> {
  const [spend, config] = await Promise.all([getAiSpendConfig(), getWalletConfig()]);
  const base =
    kind === "caption"
      ? spend.captionCostPaise
      : kind === "image"
        ? spend.imageCostPaise
        : config.videoCostPaise;
  return withFee(base, spend.feePercent);
}

/**
 * What a finished generation should actually cost the tenant.
 *
 * `costPaise` is the real provider cost the caller already computed with the
 * same cost engine that powers the superadmin Actual Cost Report. When it is
 * unknown (model missing from the price catalog, or no USD→INR rate set) the
 * charge falls back to the admin display rate and is flagged `estimated`, so
 * a true-up can collect the difference once the admin fills the price in.
 */
export async function actualChargePaise(args: {
  kind: WalletKind;
  costPaise?: number | null;
  /** How many generations the charge covers (a campaign settles as one). */
  units?: number;
}): Promise<{ paise: number; estimated: boolean }> {
  // A cost of exactly zero is treated as UNKNOWN, not as free. It is what a
  // provider that reports nothing, a `:free` model, and a sub-half-paise
  // rounding all produce, and charging zero for a real generation is the one
  // outcome this whole engine exists to prevent.
  if (
    typeof args.costPaise === "number" &&
    Number.isFinite(args.costPaise) &&
    args.costPaise > 0
  ) {
    const { feePercent } = await getAiSpendConfig();
    return { paise: withFee(args.costPaise, feePercent), estimated: false };
  }
  const unit = await estimateChargePaise(args.kind);
  return { paise: unit * Math.max(1, args.units ?? 1), estimated: true };
}

/**
 * Exact provider-cost settlement. Unlike actualChargePaise this never falls
 * back to a display estimate: completed multi-operation video work must either
 * have every provider event priced or remain unsettled for reconciliation.
 */
export async function exactChargePaise(costPaise: number | null | undefined): Promise<number> {
  if (
    typeof costPaise !== "number" ||
    !Number.isFinite(costPaise) ||
    costPaise < 0
  ) {
    throw new Error("Exact provider cost is unavailable");
  }
  const { feePercent } = await getAiSpendConfig();
  return withFee(costPaise, feePercent);
}

// ---------- balance ----------

export async function getWalletBalancePaise(tenantId: number): Promise<number> {
  const [row] = await db
    .select()
    .from(walletBalancesTable)
    .where(eq(walletBalancesTable.tenantId, tenantId))
    .limit(1);
  return row?.balancePaise ?? 0;
}

/** The transaction handle drizzle passes to `db.transaction` callbacks. */
type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

type LedgerFields = Omit<
  typeof walletLedgerTable.$inferInsert,
  "tenantId" | "amountPaise" | "id" | "createdAt"
>;

/**
 * Apply a signed delta to the balance and append the matching ledger row,
 * inside one transaction holding a row lock.
 *
 * The balance never goes below zero, and the ledger records the delta that
 * was ACTUALLY applied (not the requested one), so ledger totals always
 * reconcile with the stored balance — same discipline as the credit ledger.
 */
async function applyDelta(
  tx: DbTransaction,
  tenantId: number,
  requestedDelta: number,
  fields: LedgerFields,
): Promise<{ applied: number; balancePaise: number; entryId: number }> {
  const old = await lockBalance(tx, tenantId);
  const next = Math.max(0, old + requestedDelta);
  const applied = next - old;

  const [entry] = await tx
    .insert(walletLedgerTable)
    .values({ tenantId, amountPaise: applied, ...fields })
    .returning({ id: walletLedgerTable.id });

  await tx
    .update(walletBalancesTable)
    .set({ balancePaise: next, updatedAt: new Date() })
    .where(eq(walletBalancesTable.tenantId, tenantId));
  return { applied, balancePaise: next, entryId: entry.id };
}

/**
 * Take the row lock, creating the balance row first if this tenant has never
 * had one. Locking a row that does not exist locks nothing, so without the
 * upsert two concurrent first movements would both fall through to an INSERT
 * and one would die on the primary key — losing a paid top-up.
 */
async function lockBalance(tx: DbTransaction, tenantId: number): Promise<number> {
  await tx
    .insert(walletBalancesTable)
    .values({ tenantId, balancePaise: 0 })
    .onConflictDoNothing({ target: walletBalancesTable.tenantId });
  const [row] = await tx
    .select()
    .from(walletBalancesTable)
    .where(eq(walletBalancesTable.tenantId, tenantId))
    .for("update");
  return row?.balancePaise ?? 0;
}

// ---------- reserve / settle / refund ----------

export interface WalletReservation {
  /** The wallet_ledger row id of the reserve entry. */
  id: number;
  /** How much was debited up front, in paise. */
  amountPaise: number;
  /** How many generations it covers (a campaign reserves one per platform). */
  units: number;
}

export interface WalletSettlementMeta {
  kind: WalletKind;
  costPaise?: number | null;
  provider?: string | null;
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  providerCredits?: string | null;
  providerRequestId?: string | null;
  /** Link back to what was produced: content | imageJob | videoJob | campaign. */
  refKind?: string | null;
  refId?: string | null;
}

/**
 * Atomically debit the estimated cost of one generation BEFORE the provider
 * call, all-or-nothing. Returns null when the balance cannot cover it — the
 * caller answers 402 with a "recharge to continue" message.
 *
 * Reserving up front is what stops two concurrent generations from both
 * spending the last rupee.
 */
export async function reserveWallet(
  tenantId: number,
  kind: WalletKind,
  meta: { model?: string | null; provider?: string | null } = {},
  units = 1,
  /** Known actual provider cost, computed before the paid call. */
  knownActualCostPaise?: number | null,
  outerTx?: DbTransaction,
): Promise<WalletReservation | null> {
  const count = Math.max(1, Math.floor(units));
  const knownTarget =
    knownActualCostPaise !== undefined
      ? await actualChargePaise({ kind, costPaise: knownActualCostPaise, units: count })
      : null;
  const estimate = knownTarget?.paise ?? (await estimateChargePaise(kind)) * count;
  const reserve = async (tx: DbTransaction) => {
    const balance = await lockBalance(tx, tenantId);
    // A zero estimate means the admin has not set display rates yet. Still
    // reserve (so the lifecycle is uniform) but never block on it.
    if (balance < estimate) return null;

    const [entry] = await tx
      .insert(walletLedgerTable)
      .values({
        tenantId,
        kind: "reserve",
        amountPaise: -estimate,
        usageKind: kind,
        model: meta.model ?? null,
        provider: meta.provider ?? null,
      })
      .returning({ id: walletLedgerTable.id });

    await tx
      .update(walletBalancesTable)
      .set({ balancePaise: balance - estimate, updatedAt: new Date() })
      .where(eq(walletBalancesTable.tenantId, tenantId));
    return { id: entry.id, amountPaise: estimate, units: count };
  };
  return outerTx ? reserve(outerTx) : db.transaction(reserve);
}

const VIDEO_JOB_TOP_UP_NOTE = "video-job-funding:v1";
const VIDEO_JOB_SCENE_NOTE = "video-job-scene:v1";

function videoJobTopUpUnits(note: string | null): number {
  const match = note?.match(/^video-job-funding:v1:required=\d+:units=(\d+)$/);
  return match ? Math.max(0, Number(match[1])) : 0;
}

function videoJobLinkedUnits(note: string | null): number {
  const match = note?.match(/^(?:video-job-funding:v1:required=\d+|video-job-scene:v1:scene=[^:]+):units=(\d+)$/);
  return match ? Math.max(0, Number(match[1])) : 0;
}

export async function insertWalletFundedStoryboardScene(args: {
  tenantId: number;
  jobId: number;
  scene: Omit<VideoStoryboardScene, "id">;
  afterSceneId?: string | null;
  units: number;
  maxScenes: number;
}): Promise<{
  status: "inserted" | "insufficient" | "rejected" | "at_cap" | "invalid_anchor";
  job?: VideoGeneration;
  scene?: VideoStoryboardScene;
}> {
  return db.transaction(async (tx) => {
    const [job] = await tx.select().from(videoGenerationsTable).where(and(
      eq(videoGenerationsTable.id, args.jobId),
      eq(videoGenerationsTable.tenantId, args.tenantId),
    )).for("update").limit(1);
    if (!job || job.status !== "awaiting_review" || job.funding !== "wallet" || !job.storyboard) {
      return { status: "rejected" };
    }
    if (job.storyboard.scenes.length >= args.maxScenes) return { status: "at_cap" };
    if (
      args.afterSceneId != null &&
      !job.storyboard.scenes.some((scene) => scene.id === args.afterSceneId)
    ) {
      return { status: "invalid_anchor" };
    }
    const nextNumber = job.storyboard.scenes.reduce((max, scene) => {
      const match = /^s(\d+)$/.exec(scene.id);
      return match ? Math.max(max, Number(match[1])) : max;
    }, 0) + 1;
    const averageDuration =
      job.storyboard.scenes.reduce((sum, item) => sum + item.durationSec, 0) /
      job.storyboard.scenes.length;
    const scene: VideoStoryboardScene = {
      ...args.scene,
      id: `s${nextNumber}`,
      durationSec: Math.round(averageDuration * 10) / 10,
    };
    const units = Math.max(1, Math.trunc(args.units));
    const estimate = (await estimateChargePaise("video")) * units;
    const balance = await lockBalance(tx, args.tenantId);
    if (balance < estimate) return { status: "insufficient" };
    await tx.insert(walletLedgerTable).values({
      tenantId: args.tenantId,
      kind: "reserve",
      amountPaise: -estimate,
      usageKind: "video",
      refKind: "videoJob",
      refId: String(args.jobId),
      note: `${VIDEO_JOB_SCENE_NOTE}:scene=${encodeURIComponent(scene.id)}:units=${units}`,
    });
    const scenes = [...job.storyboard.scenes];
    const at = args.afterSceneId === null
      ? 0
      : args.afterSceneId === undefined
        ? scenes.length
        : Math.max(0, scenes.findIndex((scene) => scene.id === args.afterSceneId) + 1);
    scenes.splice(at, 0, scene);
    const options = job.options ?? { aspectRatio: "9:16" as const };
    const funding = options.storyboardFunding;
    const [updated] = await tx.update(videoGenerationsTable).set({
      storyboard: { ...job.storyboard, scenes },
      options: {
        ...options,
        addedScenes: (options.addedScenes ?? 0) + 1,
        ...(funding ? {
          storyboardFunding: {
            ...funding,
            sceneCount: scenes.length,
            requiredUnits: (funding.requiredUnits ?? funding.fundedUnits) + units,
            fundedUnits: funding.fundedUnits + units,
          },
        } : {}),
      },
      walletReservedPaise: sql`coalesce(${videoGenerationsTable.walletReservedPaise}, 0) + ${estimate}`,
      walletReservedUnits: sql`coalesce(${videoGenerationsTable.walletReservedUnits}, 0) + ${units}`,
      updatedAt: new Date(),
    }).where(eq(videoGenerationsTable.id, args.jobId)).returning();
    await tx.update(walletBalancesTable).set({
      balancePaise: balance - estimate,
      updatedAt: new Date(),
    }).where(eq(walletBalancesTable.tenantId, args.tenantId));
    return { status: "inserted", job: updated, scene };
  });
}

/** Undo an inserted scene when its immediate preview generation fails. */
export async function rollbackWalletFundedStoryboardScene(args: {
  tenantId: number;
  jobId: number;
  sceneId: string;
  units: number;
  note: string;
}): Promise<void> {
  await db.transaction(async (tx) => {
    const [job] = await tx.select().from(videoGenerationsTable).where(and(
      eq(videoGenerationsTable.id, args.jobId),
      eq(videoGenerationsTable.tenantId, args.tenantId),
    )).for("update").limit(1);
    if (!job?.storyboard?.scenes.some((scene) => scene.id === args.sceneId)) return;
    const expectedNote =
      `${VIDEO_JOB_SCENE_NOTE}:scene=${encodeURIComponent(args.sceneId)}:units=${args.units}`;
    const [reserve] = await tx.select().from(walletLedgerTable).where(and(
      eq(walletLedgerTable.tenantId, args.tenantId),
      eq(walletLedgerTable.kind, "reserve"),
      eq(walletLedgerTable.refKind, "videoJob"),
      eq(walletLedgerTable.refId, String(args.jobId)),
      eq(walletLedgerTable.note, expectedNote),
    )).for("update").limit(1);
    if (!reserve) throw new Error(`Wallet scene reservation for ${args.sceneId} is missing`);
    const scenes = job.storyboard.scenes.filter((scene) => scene.id !== args.sceneId);
    const options = job.options ?? { aspectRatio: "9:16" as const };
    const funding = options.storyboardFunding;
    await tx.update(videoGenerationsTable).set({
      storyboard: { ...job.storyboard, scenes },
      options: {
        ...options,
        addedScenes: Math.max(0, (options.addedScenes ?? 1) - 1) || undefined,
        ...(funding ? {
          storyboardFunding: {
            ...funding,
            sceneCount: scenes.length,
            requiredUnits: Math.max(
              funding.planningUnits,
              (funding.requiredUnits ?? funding.fundedUnits) - args.units,
            ),
            fundedUnits: Math.max(funding.planningUnits, funding.fundedUnits - args.units),
          },
        } : {}),
      },
      walletReservedPaise: sql`greatest(0, coalesce(${videoGenerationsTable.walletReservedPaise}, 0) - ${-reserve.amountPaise})`,
      walletReservedUnits: sql`greatest(1, coalesce(${videoGenerationsTable.walletReservedUnits}, 1) - ${args.units})`,
      updatedAt: new Date(),
    }).where(eq(videoGenerationsTable.id, args.jobId));
    await applyDelta(tx, args.tenantId, -reserve.amountPaise, {
      kind: "refund",
      reservationId: reserve.id,
      usageKind: "video",
      refKind: "videoJob",
      refId: String(args.jobId),
      note: args.note,
    });
  });
}

/**
 * Atomically reserve the missing deferred-template units. The job row is the
 * serialization lock and the reserve itself carries ownership plus its unit
 * revision, so a committed reserve remains discoverable even if an older
 * caller crashed before updating the job's aggregate snapshot.
 */
export async function reserveVideoJobWalletTopUp(
  jobId: number,
  requiredUnits: number,
): Promise<{
  funded: boolean;
  heldUnits: number;
  requiredPaise: number;
  balancePaise: number;
}> {
  return db.transaction(async (tx) => {
    const [job] = await tx.select().from(videoGenerationsTable)
      .where(eq(videoGenerationsTable.id, jobId)).for("update").limit(1);
    if (!job || job.funding !== "wallet") {
      return { funded: false, heldUnits: 0, requiredPaise: 0, balancePaise: 0 };
    }
    const planningUnits = Math.max(1, job.options?.storyboardFunding?.planningUnits ?? 1);
    const reserves = await tx.select({
      id: walletLedgerTable.id,
      amountPaise: walletLedgerTable.amountPaise,
      note: walletLedgerTable.note,
    }).from(walletLedgerTable).where(and(
      eq(walletLedgerTable.tenantId, job.tenantId),
      eq(walletLedgerTable.kind, "reserve"),
      eq(walletLedgerTable.refKind, "videoJob"),
      eq(walletLedgerTable.refId, String(jobId)),
    ));
    const resolutions = reserves.length
      ? await tx.select({ reservationId: walletLedgerTable.reservationId })
          .from(walletLedgerTable).where(and(
            inArray(walletLedgerTable.reservationId, reserves.map((row) => row.id)),
            inArray(walletLedgerTable.kind, ["settle", "refund"]),
          ))
      : [];
    const resolved = new Set(resolutions.map((row) => row.reservationId));
    const unresolved = reserves.filter((row) => !resolved.has(row.id));
    const heldUnits = planningUnits + unresolved.reduce(
      (sum, row) => sum + videoJobLinkedUnits(row.note),
      0,
    );
    const target = Math.max(planningUnits, Math.trunc(requiredUnits));
    const missing = Math.max(0, target - heldUnits);
    if (!missing) {
      return { funded: true, heldUnits, requiredPaise: 0, balancePaise: 0 };
    }

    const estimate = (await estimateChargePaise("video")) * missing;
    const balance = await lockBalance(tx, job.tenantId);
    if (balance < estimate) {
      return {
        funded: false,
        heldUnits,
        requiredPaise: estimate,
        balancePaise: balance,
      };
    }
    const [entry] = await tx.insert(walletLedgerTable).values({
      tenantId: job.tenantId,
      kind: "reserve",
      amountPaise: -estimate,
      usageKind: "video",
      refKind: "videoJob",
      refId: String(jobId),
      note: `${VIDEO_JOB_TOP_UP_NOTE}:required=${target}:units=${missing}`,
    }).returning({ id: walletLedgerTable.id });
    await tx.update(walletBalancesTable).set({
      balancePaise: balance - estimate,
      updatedAt: new Date(),
    }).where(eq(walletBalancesTable.tenantId, job.tenantId));
    await tx.update(videoGenerationsTable).set({
      walletReservedPaise: sql`coalesce(${videoGenerationsTable.walletReservedPaise}, 0) + ${estimate}`,
      walletReservedUnits: target,
      updatedAt: new Date(),
    }).where(eq(videoGenerationsTable.id, jobId));
    void entry;
    return {
      funded: true,
      heldUnits: target,
      requiredPaise: estimate,
      balancePaise: balance,
    };
  });
}

/** Every unresolved reservation currently owned by a video job. */
export async function videoJobWalletReservations(
  job: Pick<VideoGeneration, "id" | "tenantId" | "walletReservationId" | "walletReservedUnits">,
): Promise<WalletReservation[]> {
  const rows = await db.select({
    id: walletLedgerTable.id,
    amountPaise: walletLedgerTable.amountPaise,
    note: walletLedgerTable.note,
  }).from(walletLedgerTable).where(and(
    eq(walletLedgerTable.tenantId, job.tenantId),
    eq(walletLedgerTable.kind, "reserve"),
      sql`(${walletLedgerTable.id} = ${job.walletReservationId ?? -1} or (${walletLedgerTable.refKind} = 'videoJob' and ${walletLedgerTable.refId} = ${String(job.id)}))`,
  ));
  if (!rows.length) return [];
  const resolutions = await db.select({ reservationId: walletLedgerTable.reservationId })
    .from(walletLedgerTable).where(and(
      inArray(walletLedgerTable.reservationId, rows.map((row) => row.id)),
      inArray(walletLedgerTable.kind, ["settle", "refund"]),
    ));
  const resolved = new Set(resolutions.map((row) => row.reservationId));
  return rows.filter((row) => !resolved.has(row.id)).map((row) => ({
    id: row.id,
    amountPaise: -row.amountPaise,
    units: row.id === job.walletReservationId
      ? Math.max(1, (job.walletReservedUnits ?? 1) - rows.reduce((sum, item) => sum + videoJobLinkedUnits(item.note), 0))
      : videoJobLinkedUnits(row.note),
  }));
}

/**
 * True the reservation up to the real cost once the generation has finished.
 * Writes a settle row carrying the signed difference (which may be zero), so
 * the reserve/settle pair is fully auditable and the estimate never silently
 * becomes the charge.
 */
export async function settleWallet(
  tenantId: number,
  reservation: WalletReservation,
  meta: WalletSettlementMeta,
): Promise<{ chargedPaise: number; estimated: boolean; balancePaise: number }> {
  const target = await actualChargePaise({
    kind: meta.kind,
    costPaise: meta.costPaise,
    units: reservation.units,
  });
  return settleWalletToTarget(tenantId, reservation, meta, target);
}

/**
 * Resolve one reservation to a precomputed target charge.
 *
 * The reserve ledger row is the serialization lock. A retry that arrives after
 * the original transaction committed reads the existing settle row and returns
 * it instead of applying the balance delta again.
 */
async function settleWalletToTarget(
  tenantId: number,
  reservation: WalletReservation,
  meta: WalletSettlementMeta,
  target: { paise: number; estimated: boolean },
): Promise<{ chargedPaise: number; estimated: boolean; balancePaise: number }> {
  return db.transaction(async (tx) => {
    const [reserve] = await tx
      .select({
        id: walletLedgerTable.id,
        tenantId: walletLedgerTable.tenantId,
        kind: walletLedgerTable.kind,
        amountPaise: walletLedgerTable.amountPaise,
      })
      .from(walletLedgerTable)
      .where(
        and(
          eq(walletLedgerTable.id, reservation.id),
          eq(walletLedgerTable.tenantId, tenantId),
        ),
      )
      .for("update");
    if (
      !reserve ||
      reserve.kind !== "reserve" ||
      reserve.amountPaise !== -reservation.amountPaise
    ) {
      throw new Error(`Wallet reservation ${reservation.id} is missing or does not match`);
    }

    const [resolved] = await tx
      .select({
        kind: walletLedgerTable.kind,
        amountPaise: walletLedgerTable.amountPaise,
        estimated: walletLedgerTable.estimated,
      })
      .from(walletLedgerTable)
      .where(
        and(
          eq(walletLedgerTable.reservationId, reservation.id),
          inArray(walletLedgerTable.kind, ["settle", "refund"]),
        ),
      )
      .orderBy(asc(walletLedgerTable.id))
      .limit(1);
    if (resolved?.kind === "refund") {
      throw new Error(`Wallet reservation ${reservation.id} was already refunded`);
    }
    if (resolved?.kind === "settle") {
      const [balance] = await tx
        .select({ balancePaise: walletBalancesTable.balancePaise })
        .from(walletBalancesTable)
        .where(eq(walletBalancesTable.tenantId, tenantId))
        .limit(1);
      return {
        chargedPaise: reservation.amountPaise - resolved.amountPaise,
        estimated: resolved.estimated,
        balancePaise: balance?.balancePaise ?? 0,
      };
    }

    const delta = reservation.amountPaise - target.paise;
    const result = await applyDelta(tx, tenantId, delta, {
      kind: "settle",
      reservationId: reservation.id,
      usageKind: meta.kind,
      provider: meta.provider ?? null,
      model: meta.model ?? null,
      providerCostPaise:
        typeof meta.costPaise === "number" && Number.isSafeInteger(meta.costPaise)
          ? meta.costPaise
          : null,
      inputTokens: meta.inputTokens ?? null,
      outputTokens: meta.outputTokens ?? null,
      providerCredits: meta.providerCredits ?? null,
      providerRequestId: meta.providerRequestId ?? null,
      refKind: meta.refKind ?? null,
      refId: meta.refId ?? null,
      estimated: target.estimated,
      note: target.estimated
        ? `No catalog price for ${meta.model ?? "this model"}; charged the display rate`
        : null,
    });
    return {
      chargedPaise: reservation.amountPaise - result.applied,
      estimated: target.estimated,
      balancePaise: result.balancePaise,
    };
  });
}

/**
 * Rebuild a reservation from the columns a background job persisted, so a
 * runner (or the stuck-job sweep) can settle or refund work that outlived the
 * request that reserved it. Null when the row was not wallet-funded.
 */
export function reservationFromRow(row: {
  walletReservationId: number | null;
  walletReservedPaise: number | null;
  /** Absent on single-unit work (image jobs); a video job carries its own. */
  walletReservedUnits?: number | null;
}): WalletReservation | null {
  if (row.walletReservationId === null || row.walletReservedPaise === null) return null;
  return {
    id: row.walletReservationId,
    amountPaise: row.walletReservedPaise,
    // Units drive the display-rate fallback, so a 12-scene video that reserved
    // 12 units must not settle as if it were one.
    units: Math.max(1, row.walletReservedUnits ?? 1),
  };
}

/** Give the whole reservation back when the generation failed. */
export async function refundWallet(
  tenantId: number,
  reservation: WalletReservation,
  note?: string,
): Promise<void> {
  if (reservation.amountPaise <= 0) return;
  await db.transaction(async (tx) => {
    const [reserve] = await tx
      .select({
        kind: walletLedgerTable.kind,
        amountPaise: walletLedgerTable.amountPaise,
      })
      .from(walletLedgerTable)
      .where(
        and(
          eq(walletLedgerTable.id, reservation.id),
          eq(walletLedgerTable.tenantId, tenantId),
        ),
      )
      .for("update");
    if (
      !reserve ||
      reserve.kind !== "reserve" ||
      reserve.amountPaise !== -reservation.amountPaise
    ) {
      throw new Error(`Wallet reservation ${reservation.id} is missing or does not match`);
    }
    const [providerOperation] = await tx
      .select({ status: walletProviderOperationsTable.status })
      .from(walletProviderOperationsTable)
      .where(
        and(
          eq(walletProviderOperationsTable.reservationId, reservation.id),
          eq(walletProviderOperationsTable.tenantId, tenantId),
        ),
      )
      .limit(1)
      .for("update");
    // A registered provider call is refundable only after its outcome was
    // durably confirmed as failed. Pending is intentionally protected because
    // it may represent an in-flight call or an ambiguous response-loss crash.
    if (
      providerOperation &&
      providerOperation.status !== "failed" &&
      providerOperation.status !== "refunded"
    ) {
      return;
    }
    const [queuedSettlement] = await tx
      .select({ id: walletSettlementRetriesTable.id })
      .from(walletSettlementRetriesTable)
      .where(eq(walletSettlementRetriesTable.reservationId, reservation.id))
      .limit(1);
    // Once successful work has queued its final charge, no later route error
    // may turn that provider success into a refund. Settlement retry owns the
    // reservation lifecycle from this point onward.
    if (queuedSettlement) return;
    const [resolved] = await tx
      .select({ kind: walletLedgerTable.kind })
      .from(walletLedgerTable)
      .where(
        and(
          eq(walletLedgerTable.reservationId, reservation.id),
          inArray(walletLedgerTable.kind, ["settle", "refund"]),
        ),
      )
      .limit(1);
    // A lifecycle has one terminal resolution. Duplicate refunds are harmless,
    // and a late error handler can never refund work that already settled.
    if (resolved) return;
    await applyDelta(tx, tenantId, reservation.amountPaise, {
      kind: "refund",
      reservationId: reservation.id,
      note: note ?? null,
    });
  });
}

/**
 * Resolve every wallet reservation owned by a terminally failed video job to
 * zero charge. Unlike the ordinary pre-provider refund, this deliberately
 * supersedes confirmed intermediate work and durable settlement handoffs: the
 * customer bought a delivered video, not its provider checkpoints.
 *
 * The failed job row is locked first and every reservation is then locked in
 * id order. This makes the operation idempotent and serializes it with both
 * immediate settlement and the retry/provider-operation sweep.
 */
export async function refundFailedVideoJobWallet(
  jobId: number,
  note = "terminal video generation failed",
): Promise<void> {
  await db.transaction(async (tx) => {
    const [job] = await tx
      .select()
      .from(videoGenerationsTable)
      .where(eq(videoGenerationsTable.id, jobId))
      .for("update")
      .limit(1);
    if (!job || job.status !== "failed" || job.funding !== "wallet") return;
    const preserveProvenStudioReceipts =
      (job.options?.studioLipSync?.checkpoint?.scenes ?? []).some(
        (scene) => scene.event,
      ) || Boolean(job.options?.studioLipSync?.checkpoint?.event);

    const ownsRef = (refKind: string | null, refId: string | null): boolean =>
      refKind === "videoJob" &&
      (refId === String(jobId) || refId?.startsWith(`${jobId}:`) === true);
    // A transaction uses one pg client. Keep these reads sequential: pg 9
    // removes support for client.query() calls while another query is active.
    const retryRows = await tx
      .select()
      .from(walletSettlementRetriesTable)
      .where(eq(walletSettlementRetriesTable.tenantId, job.tenantId));
    const operationRows = await tx
      .select()
      .from(walletProviderOperationsTable)
      .where(eq(walletProviderOperationsTable.tenantId, job.tenantId));
    const settlementRows = await tx
      .select({
        reservationId: walletLedgerTable.reservationId,
        refKind: walletLedgerTable.refKind,
        refId: walletLedgerTable.refId,
      })
      .from(walletLedgerTable)
      .where(
        and(
          eq(walletLedgerTable.tenantId, job.tenantId),
          eq(walletLedgerTable.kind, "settle"),
        ),
      );
    const linkedReserveRows = await tx
      .select({ id: walletLedgerTable.id })
      .from(walletLedgerTable)
      .where(and(
        eq(walletLedgerTable.tenantId, job.tenantId),
        eq(walletLedgerTable.kind, "reserve"),
        eq(walletLedgerTable.refKind, "videoJob"),
        eq(walletLedgerTable.refId, String(jobId)),
      ));
    const reservationIds = [
      ...new Set(
        [
          job.walletReservationId,
          ...linkedReserveRows.map((row) => row.id),
          ...retryRows
            .filter((row) => ownsRef(row.refKind, row.refId))
            .map((row) => row.reservationId),
          ...operationRows
            .filter((row) => ownsRef(row.refKind, row.refId))
            .map((row) => row.reservationId),
          ...settlementRows
            .filter((row) => ownsRef(row.refKind, row.refId))
            .map((row) => row.reservationId),
        ].filter((id): id is number => id !== null),
      ),
    ].sort((a, b) => a - b);

    for (const reservationId of reservationIds) {
      const [reserve] = await tx
        .select({
          amountPaise: walletLedgerTable.amountPaise,
          kind: walletLedgerTable.kind,
        })
        .from(walletLedgerTable)
        .where(
          and(
            eq(walletLedgerTable.id, reservationId),
            eq(walletLedgerTable.tenantId, job.tenantId),
          ),
        )
        .for("update")
        .limit(1);
      if (!reserve || reserve.kind !== "reserve") continue;

      await tx
        .update(walletSettlementRetriesTable)
        .set({
          status: "failed",
          claimedAt: null,
          nextAttemptAt: new Date(),
          lastError: note,
          updatedAt: new Date(),
        })
        .where(eq(walletSettlementRetriesTable.reservationId, reservationId));

      // An estimated settlement belonging to failed work is resolved at zero,
      // not a candidate for a later catalog-price true-up.
      await tx
        .update(walletLedgerTable)
        .set({ trueUpAt: new Date() })
        .where(
          and(
            eq(walletLedgerTable.tenantId, job.tenantId),
            eq(walletLedgerTable.reservationId, reservationId),
            eq(walletLedgerTable.kind, "settle"),
            eq(walletLedgerTable.estimated, true),
            isNull(walletLedgerTable.trueUpAt),
          ),
        );

      const lifecycle = await tx
        .select({
          kind: walletLedgerTable.kind,
          amountPaise: walletLedgerTable.amountPaise,
        })
        .from(walletLedgerTable)
        .where(
          and(
            eq(walletLedgerTable.tenantId, job.tenantId),
            eq(walletLedgerTable.reservationId, reservationId),
            inArray(walletLedgerTable.kind, ["settle", "refund", "true_up"]),
          ),
        );
      if (
        !lifecycle.some((row) => row.kind === "refund") &&
        !(preserveProvenStudioReceipts && lifecycle.some((row) => row.kind === "settle"))
      ) {
        const netDelta =
          reserve.amountPaise +
          lifecycle.reduce((sum, row) => sum + row.amountPaise, 0);
        const chargedPaise = Math.max(0, -netDelta);
        await applyDelta(tx, job.tenantId, chargedPaise, {
          kind: "refund",
          reservationId,
          usageKind: "video",
          refKind: "videoJob",
          refId: String(jobId),
          note,
        });
      }

      await tx
        .update(walletProviderOperationsTable)
        .set({
          status: "refunded",
          resolvedAt: new Date(),
          recoverAfter: new Date(),
          lastError: note,
          updatedAt: new Date(),
        })
        .where(eq(walletProviderOperationsTable.reservationId, reservationId));
    }

    await tx
      .update(videoGenerationsTable)
      .set({ spendPaise: 0, updatedAt: new Date() })
      .where(
        and(
          eq(videoGenerationsTable.id, jobId),
          eq(videoGenerationsTable.status, "failed"),
        ),
      );
  });
}

// ---------- durable provider-operation recovery ----------

export type WalletProviderOperationKind =
  | "character_reference"
  | "character_outfit"
  | "video_style_analysis"
  | "video_script_intake"
  | "video_script_draft"
  | "guided_line_translation"
  | "guided_scene_correction"
  | "brand_voice_clone"
  | "brand_voice_tts";

export async function validateGuidedCastWalletCheckpoint(args: {
  tenantId: number;
  draftId: number;
  revision: number;
  roleId: string;
  status: "provider_succeeded" | "upload_succeeded" | "uploaded";
  operationId: number;
  reservation: WalletReservation;
  provider: string;
  model: string;
}): Promise<{ valid: true } | { valid: false; reason: string }> {
  return db.transaction(async (tx) => {
    const [operation] = await tx
      .select()
      .from(walletProviderOperationsTable)
      .where(eq(walletProviderOperationsTable.id, args.operationId))
      .for("update")
      .limit(1);
    if (!operation) return { valid: false, reason: "wallet provider operation is missing" };

    const [reserve] = await tx
      .select()
      .from(walletLedgerTable)
      .where(eq(walletLedgerTable.id, operation.reservationId))
      .for("update")
      .limit(1);
    const resolutions = await tx
      .select()
      .from(walletLedgerTable)
      .where(eq(walletLedgerTable.reservationId, operation.reservationId))
      .for("update");
    const [retry] = await tx
      .select()
      .from(walletSettlementRetriesTable)
      .where(eq(walletSettlementRetriesTable.reservationId, operation.reservationId))
      .for("update")
      .limit(1);

    const operationKey =
      `guided-story-cast:${args.draftId}:${args.revision}:${args.roleId}`;
    const refId = `${args.draftId}:${args.revision}:${args.roleId}`;
    if (
      operation.tenantId !== args.tenantId ||
      operation.reservationId !== args.reservation.id ||
      operation.reservedPaise !== args.reservation.amountPaise ||
      operation.reservedUnits !== args.reservation.units ||
      operation.reservedUnits !== 1 ||
      operation.usageKind !== "image" ||
      operation.operationKind !== "character_reference" ||
      operation.operationKey !== operationKey ||
      operation.refKind !== "guidedStoryCast" ||
      operation.refId !== refId
    ) {
      return { valid: false, reason: "wallet provider operation identity does not match" };
    }
    if (
      !reserve ||
      reserve.tenantId !== args.tenantId ||
      reserve.kind !== "reserve" ||
      reserve.usageKind !== "image" ||
      reserve.amountPaise !== -args.reservation.amountPaise
    ) {
      return { valid: false, reason: "wallet reservation does not match" };
    }
    if (
      (operation.provider !== null && operation.provider !== args.provider) ||
      (operation.model !== null && operation.model !== args.model) ||
      (reserve.provider !== null && reserve.provider !== args.provider) ||
      (reserve.model !== null && reserve.model !== args.model)
    ) {
      return { valid: false, reason: "wallet provider receipt does not match" };
    }

    const allowed =
      args.status === "provider_succeeded"
        ? ["succeeded", "settlement_queued", "settled"].includes(operation.status)
        : args.status === "upload_succeeded"
          ? ["succeeded", "settlement_queued", "settled"].includes(operation.status)
          : operation.status === "settled";
    if (!allowed || resolutions.some((row) => row.kind === "refund")) {
      return { valid: false, reason: "wallet provider operation is not in an allowed durable state" };
    }

    if (operation.status === "settlement_queued" || operation.status === "settled") {
      if (
        !retry ||
        retry.tenantId !== args.tenantId ||
        retry.reservationId !== args.reservation.id ||
        retry.reservedPaise !== args.reservation.amountPaise ||
        retry.reservedUnits !== args.reservation.units ||
        retry.usageKind !== "image" ||
        retry.targetChargePaise !== operation.targetChargePaise ||
        retry.estimated !== operation.estimated ||
        retry.refKind !== "guidedStoryCast" ||
        retry.refId !== refId ||
        (retry.provider !== null && retry.provider !== args.provider) ||
        (retry.model !== null && retry.model !== args.model) ||
        (operation.status === "settled" && retry.status !== "settled") ||
        (operation.status === "settlement_queued" &&
          !["pending", "processing", "failed", "settled"].includes(retry.status))
      ) {
        return { valid: false, reason: "wallet durable settlement metadata does not match" };
      }
    } else if (retry) {
      return { valid: false, reason: "wallet settlement exists before its durable handoff" };
    }

    const settle = resolutions.find((row) => row.kind === "settle");
    if (operation.status === "settled" || settle) {
      if (
        !settle ||
        settle.tenantId !== args.tenantId ||
        settle.usageKind !== "image" ||
        settle.refKind !== "guidedStoryCast" ||
        settle.refId !== refId ||
        (settle.provider !== null && settle.provider !== args.provider) ||
        (settle.model !== null && settle.model !== args.model)
      ) {
        return { valid: false, reason: "wallet settlement ledger does not match" };
      }
    } else if (
      operation.status !== "settlement_queued" &&
      resolutions.some((row) => row.kind === "settle")
    ) {
      return { valid: false, reason: "wallet ledger settled before provider operation" };
    }
    return { valid: true };
  });
}

/**
 * Final wallet debits attributable to completed video jobs.
 *
 * A job can own several reservations: one main video reservation plus one
 * narration reservation per scene. The settle rows carry the videoJob ref,
 * while their reserve rows carry the original up-front debit. Sum the complete
 * reserve + settle/true_up chain so the displayed amount exactly matches the
 * balance movement and never re-prices historical work.
 */
function canonicalVideoBillingChainId(
  job: Pick<VideoGeneration, "id" | "options">,
  jobsById: Map<number, Pick<VideoGeneration, "id" | "options">>,
): number {
  let current = job;
  const seen = new Set<number>([job.id]);
  while (true) {
    const recovery = current.options?.recovery;
    if (recovery?.chainId != null) return recovery.chainId;
    const parentId = recovery?.sourceJobId ?? current.options?.characterDialogue?.retry?.sourceJobId;
    if (parentId === undefined) return current.id;
    if (seen.has(parentId)) {
      throw new Error(`Cycle detected in video billing retry chain at job ${parentId}`);
    }
    seen.add(parentId);
    const parent = jobsById.get(parentId);
    if (!parent) return parentId;
    current = parent;
  }
}

export async function getVideoJobWalletChargesPaise(
  tenantId: number,
  jobIds: number[],
): Promise<Map<number, number>> {
  const ids = [...new Set(jobIds.filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (ids.length === 0) return new Map();
  const tenantJobs = await db
    .select({
      id: videoGenerationsTable.id,
      options: videoGenerationsTable.options,
      status: videoGenerationsTable.status,
    })
    .from(videoGenerationsTable)
    .where(eq(videoGenerationsTable.tenantId, tenantId));
  const requested = new Map(
    tenantJobs.filter((job) => ids.includes(job.id)).map((job) => [job.id, job]),
  );
  const tenantJobsById = new Map(tenantJobs.map((job) => [job.id, job]));
  const chainIdFor = (job: (typeof tenantJobs)[number]): number =>
    canonicalVideoBillingChainId(job, tenantJobsById);
  const memberIdsByChain = new Map<number, number[]>();
  for (const job of tenantJobs) {
    const chainId = chainIdFor(job);
    const members = memberIdsByChain.get(chainId) ?? [];
    members.push(job.id);
    memberIdsByChain.set(chainId, members);
  }
   const expandedIds = [
    ...new Set(
      ids.flatMap((id) => {
        const job = requested.get(id);
         return job
           ? (memberIdsByChain.get(chainIdFor(job)) ?? [id]).filter(
               (memberId) => tenantJobsById.get(memberId)?.status === "succeeded",
             )
           : [id];
      }),
    ),
  ];

  const jobIdExpr = sql<number>`split_part(${walletLedgerTable.refId}, ':', 1)::int`;
  const anchors = await db
    .select({
      reservationId: walletLedgerTable.reservationId,
      refId: walletLedgerTable.refId,
    })
    .from(walletLedgerTable)
    // Ledger history is intentionally retained after test/user tenant cleanup.
    // Deleted workspaces cannot be reconciled, so do not surface their orphaned
    // rows as actionable pricing problems in the admin UI.
    .innerJoin(tenantsTable, eq(tenantsTable.id, walletLedgerTable.tenantId))
    .where(
      and(
        eq(walletLedgerTable.tenantId, tenantId),
        eq(walletLedgerTable.refKind, "videoJob"),
        eq(walletLedgerTable.kind, "settle"),
        inArray(jobIdExpr, expandedIds),
      ),
    );
  const reservationIds = [
    ...new Set(
      anchors
        .map((row) => row.reservationId)
        .filter((id): id is number => id !== null),
    ),
  ];
  if (reservationIds.length === 0) return new Map();

  const [reserves, resolutions] = await Promise.all([
    db
    .select({
      id: walletLedgerTable.id,
      amountPaise: walletLedgerTable.amountPaise,
    })
    .from(walletLedgerTable)
    .where(
      and(
        eq(walletLedgerTable.tenantId, tenantId),
        eq(walletLedgerTable.kind, "reserve"),
        inArray(walletLedgerTable.id, reservationIds),
      ),
    ),
    db
      .select({
        reservationId: walletLedgerTable.reservationId,
        amountPaise: walletLedgerTable.amountPaise,
      })
      .from(walletLedgerTable)
      .where(
        and(
          eq(walletLedgerTable.tenantId, tenantId),
          inArray(walletLedgerTable.kind, ["settle", "true_up"]),
          inArray(walletLedgerTable.reservationId, reservationIds),
        ),
      ),
  ]);
  const reserveAmounts = new Map(reserves.map((row) => [row.id, row.amountPaise]));
  const jobByReservation = new Map<number, number>();
  for (const row of anchors) {
    if (row.reservationId === null || row.refId === null) continue;
    const jobId = Number(row.refId.split(":", 1)[0]);
    if (Number.isSafeInteger(jobId) && expandedIds.includes(jobId)) {
      jobByReservation.set(row.reservationId, jobId);
    }
  }
  const byReservation = new Map<number, { jobId: number; resolutionPaise: number }>();
  for (const row of resolutions) {
    if (row.reservationId === null) continue;
    const jobId = jobByReservation.get(row.reservationId);
    if (jobId === undefined) continue;
    const current = byReservation.get(row.reservationId);
    byReservation.set(row.reservationId, {
      jobId,
      resolutionPaise: (current?.resolutionPaise ?? 0) + row.amountPaise,
    });
  }

  const totalsByJob = new Map<number, number>();
  for (const [reservationId, resolution] of byReservation) {
    const reservePaise = reserveAmounts.get(reservationId);
    if (reservePaise === undefined) continue;
    const chargedPaise = -(reservePaise + resolution.resolutionPaise);
    totalsByJob.set(
      resolution.jobId,
      (totalsByJob.get(resolution.jobId) ?? 0) + chargedPaise,
    );
  }
  const totals = new Map<number, number>();
  for (const id of ids) {
    const job = requested.get(id);
    const members = job ? memberIdsByChain.get(chainIdFor(job)) ?? [id] : [id];
    const total = members.reduce((sum, memberId) => sum + (totalsByJob.get(memberId) ?? 0), 0);
    if (members.some((memberId) => totalsByJob.has(memberId))) totals.set(id, total);
  }
  return totals;
}

interface DurableVideoProviderEvent {
  eventId?: string;
  provider: string;
  model: string;
  durationSec: number | null;
  requestBytes: number;
  label: string;
  costPaise: number | null;
  accounted?: boolean;
}

export interface VideoWalletReconciliationReportRow {
  chainId: number;
  completedJobId: number;
  jobIds: number[];
  reservationIds: number[];
  eventCount: number;
  rawProviderCostPaise: number | null;
  targetChargePaise: number | null;
  chargedPaise: number;
  discrepancyPaise: number | null;
  status:
    | "balanced"
    | "undercharged"
    | "overcharged"
    | "pending_cost"
    | "pending_settlement";
  pendingEventIds: string[];
}

interface VideoBillingChainAnalysis extends VideoWalletReconciliationReportRow {
  tenantId: number;
  correctionReservationId: number | null;
  providers: string[];
  models: string[];
  eventSummaries: string[];
}

function videoEventIdentity(chainId: number, event: DurableVideoProviderEvent): string {
  return event.eventId?.trim() || `video-chain:${chainId}:${event.label}`;
}

function videoEventConflict(
  current: DurableVideoProviderEvent,
  incoming: DurableVideoProviderEvent,
): boolean {
  return (
    current.provider !== incoming.provider ||
    current.model !== incoming.model ||
    current.label !== incoming.label ||
    (current.durationSec !== null &&
      incoming.durationSec !== null &&
      current.durationSec !== incoming.durationSec) ||
    (current.costPaise !== null &&
      incoming.costPaise !== null &&
      current.costPaise !== incoming.costPaise)
  );
}

/** Storyboard and presenter stills share the video billing chain but are image
 * provider calls. Historical receipts predate an explicit event-kind field,
 * so their stable labels are the compatibility discriminator. */
function isImageEvent(event: DurableVideoProviderEvent): boolean {
  return (
    event.label.startsWith("storyboard_preview:") ||
    event.label.startsWith("presenter_broll_")
  );
}

async function loadVideoBillingChain(
  completedJobId: number,
): Promise<{ completed: VideoGeneration; chainId: number; jobs: VideoGeneration[] }> {
  const [completed] = await db
    .select()
    .from(videoGenerationsTable)
    .where(eq(videoGenerationsTable.id, completedJobId))
    .limit(1);
  if (!completed || completed.status !== "succeeded") {
    throw new Error(`Successful video job ${completedJobId} was not found`);
  }
  const tenantJobs = await db
    .select()
    .from(videoGenerationsTable)
    .where(eq(videoGenerationsTable.tenantId, completed.tenantId));
  const tenantJobsById = new Map(tenantJobs.map((job) => [job.id, job]));
  const chainId = canonicalVideoBillingChainId(completed, tenantJobsById);
  const jobs = tenantJobs
    .filter((job) => canonicalVideoBillingChainId(job, tenantJobsById) === chainId)
    .sort((a, b) => a.id - b.id);
  return { completed, chainId, jobs };
}

async function analyzeVideoBillingChain(
  completedJobId: number,
): Promise<VideoBillingChainAnalysis> {
  const { completed, chainId, jobs } = await loadVideoBillingChain(completedJobId);
  if (!jobs.some((job) => job.funding === "wallet")) {
    throw new Error(`Video billing chain ${chainId} is not wallet funded`);
  }

  const events = new Map<string, DurableVideoProviderEvent>();
  // The completed snapshot is the delivered-membership manifest. Retry jobs
  // clone checkpoints they actually reuse and replace checkpoints they
  // regenerate, so unioning ancestors would charge discarded provider work.
  const dialogue = completed.options?.characterDialogue;
  const deliveredEvents: DurableVideoProviderEvent[] = [
    ...(dialogue?.scenes ?? []).flatMap((scene) => {
      const checkpoint = scene.checkpoint;
      return [checkpoint?.visualEvent, checkpoint?.lipSyncEvent].filter(
        (event): event is NonNullable<typeof event> => event != null,
      );
    }),
    ...(dialogue?.musicCheckpoint?.event ? [dialogue.musicCheckpoint.event] : []),
    ...(completed.options?.presenterBroll?.providerEvents ?? []),
    ...(completed.options?.presenterMusicCheckpoint?.event
      ? [completed.options.presenterMusicCheckpoint.event]
      : []),
    ...(completed.options?.renderCheckpoint?.providerEvents ?? []),
    ...(completed.options?.recovery?.rendered?.providerEvents ?? []),
    ...(completed.options?.musicCheckpoint?.event ? [completed.options.musicCheckpoint.event] : []),
    ...(completed.storyboard?.scenes.flatMap((scene) =>
      scene.providerCheckpoint?.event ? [scene.providerCheckpoint.event] : [],
    ) ?? []),
  ];
  for (const event of deliveredEvents) {
    const identity = videoEventIdentity(chainId, event);
    const current = events.get(identity);
    if (!current) {
      events.set(identity, event);
      continue;
    }
    if (videoEventConflict(current, event)) {
      throw new Error(`Conflicting durable video event identity ${identity}`);
    }
    events.set(identity, {
      ...current,
      durationSec: current.durationSec ?? event.durationSec,
      costPaise: current.costPaise ?? event.costPaise,
    });
  }
  if (events.size === 0) {
    throw new Error(`Video billing chain ${chainId} has no durable provider events`);
  }

  const jobIds = jobs.map((job) => job.id);
  const billableJobs = jobs.filter((job) => job.status === "succeeded");
  const billableJobIds = billableJobs.map((job) => job.id);
  const jobIdSet = new Set(jobIds);
  const billableJobIdSet = new Set(billableJobIds);
  const settlementAnchors = (
    await db
      .select({
        reservationId: walletLedgerTable.reservationId,
        usageKind: walletLedgerTable.usageKind,
        provider: walletLedgerTable.provider,
        model: walletLedgerTable.model,
        providerCostPaise: walletLedgerTable.providerCostPaise,
        refId: walletLedgerTable.refId,
      })
      .from(walletLedgerTable)
      .where(
        and(
          eq(walletLedgerTable.tenantId, completed.tenantId),
          eq(walletLedgerTable.kind, "settle"),
          eq(walletLedgerTable.refKind, "videoJob"),
        ),
      )
  ).filter((row) => {
    const refJobId = Number(row.refId?.split(":", 1)[0]);
    return Number.isSafeInteger(refJobId) && jobIdSet.has(refJobId);
  });
  const billableSettlementAnchors = settlementAnchors.filter((row) => {
    const refJobId = Number(row.refId?.split(":", 1)[0]);
    return Number.isSafeInteger(refJobId) && billableJobIdSet.has(refJobId);
  });
  const refundedAnchors = (
    await db
      .select({
        reservationId: walletLedgerTable.reservationId,
        refId: walletLedgerTable.refId,
      })
      .from(walletLedgerTable)
      .where(
        and(
          eq(walletLedgerTable.tenantId, completed.tenantId),
          eq(walletLedgerTable.kind, "refund"),
          eq(walletLedgerTable.refKind, "videoJob"),
        ),
      )
  ).filter((row) => {
    const refJobId = Number(row.refId?.split(":", 1)[0]);
    return Number.isSafeInteger(refJobId) && jobIdSet.has(refJobId);
  });
  const chainRetryRows = (
    await db
      .select({
        reservationId: walletSettlementRetriesTable.reservationId,
        status: walletSettlementRetriesTable.status,
        refId: walletSettlementRetriesTable.refId,
      })
      .from(walletSettlementRetriesTable)
      .where(
        and(
          eq(walletSettlementRetriesTable.tenantId, completed.tenantId),
          eq(walletSettlementRetriesTable.refKind, "videoJob"),
        ),
      )
  ).filter((row) => {
    const refJobId = Number(row.refId?.split(":", 1)[0]);
    return Number.isSafeInteger(refJobId) && billableJobIdSet.has(refJobId);
  });
  const settledVideoReservationIds = new Set(
    billableSettlementAnchors
      .filter((anchor) => anchor.usageKind === "video")
      .map((anchor) => anchor.reservationId)
      .filter((id): id is number => id !== null),
  );
  const refundedReservationIds = new Set(
    refundedAnchors
      .map((anchor) => anchor.reservationId)
      .filter((id): id is number => id !== null),
  );
  const correctionReservationId =
    [...jobs]
      .reverse()
      .map((job) => job.walletReservationId)
      .find(
        (id): id is number =>
          id !== null &&
          (settledVideoReservationIds.has(id) || refundedReservationIds.has(id)),
      ) ?? null;
  const reservationIds = [
    ...new Set(
      [
        ...billableJobs.map((job) => job.walletReservationId),
        ...billableSettlementAnchors.map((row) => row.reservationId),
        ...chainRetryRows.map((row) => row.reservationId),
        correctionReservationId,
      ].filter((id): id is number => id !== null),
    ),
  ];
  for (const anchor of settlementAnchors) {
    if (anchor.usageKind === "video" || anchor.reservationId === null) continue;
    const [anchorJobText, cueText] = anchor.refId?.split(":") ?? [];
    const anchorJobId = Number(anchorJobText);
    const cueIndex = Number(cueText);
    const belongsToCompleted = anchorJobId === completed.id;
    const ancestorNarrationPath = jobs
      .find((job) => job.id === anchorJobId)
      ?.options?.characterDialogue?.scenes[cueIndex]?.checkpoint?.narrationPath;
    const deliveredNarrationPath =
      dialogue?.scenes[cueIndex]?.checkpoint?.narrationPath;
    const inheritedDialogueNarration =
      anchorJobId !== completed.id &&
      Number.isSafeInteger(cueIndex) &&
      cueIndex >= 0 &&
      Boolean(
        ancestorNarrationPath &&
        deliveredNarrationPath &&
        ancestorNarrationPath === deliveredNarrationPath,
      );
    if (!belongsToCompleted && !inheritedDialogueNarration) continue;
    events.set(`wallet-reservation:${anchor.reservationId}`, {
      eventId: `wallet-reservation:${anchor.reservationId}`,
      provider: anchor.provider ?? "unknown",
      model: anchor.model ?? "unknown",
      durationSec: null,
      requestBytes: 0,
      label: `narration:${anchor.reservationId}`,
      costPaise: anchor.providerCostPaise,
    });
  }

  const hasPendingSettlement = chainRetryRows.some((row) => row.status !== "settled");

  const pricedEvents = await Promise.all(
    [...events.entries()].map(async ([identity, event]) => {
      const cost =
        event.costPaise ??
        (isImageEvent(event)
          ? await computeImageCostPaise({
              provider: event.provider,
              model: event.model,
            }).catch(() => null)
          : event.durationSec !== null || event.label.startsWith("narration:") === false
            ? await computeVideoCostPaise({
                provider: event.provider,
                model: event.model,
                durationSec: event.durationSec,
              }).catch(() => null)
            : null);
      return { identity, event, cost };
    }),
  );
  const pendingEventIds = pricedEvents
    .filter((entry) => entry.cost === null)
    .map((entry) => entry.identity);
  const rawProviderCostPaise =
    pendingEventIds.length === 0
      ? pricedEvents.reduce((sum, entry) => sum + entry.cost!, 0)
      : null;
  const targetChargePaise =
    rawProviderCostPaise === null ? null : await exactChargePaise(rawProviderCostPaise);
  const reconciliationRef = String(chainId);
  const reconciliationAdjustments = await db
    .select({ amountPaise: walletLedgerTable.amountPaise })
    .from(walletLedgerTable)
    .where(
      and(
        eq(walletLedgerTable.tenantId, completed.tenantId),
        eq(walletLedgerTable.kind, "true_up"),
        eq(walletLedgerTable.refKind, "videoJobReconciliation"),
        eq(walletLedgerTable.refId, reconciliationRef),
      ),
    );
  const settledChargePaise =
    (await getVideoJobWalletChargesPaise(completed.tenantId, [completed.id])).get(
      completed.id,
    ) ?? 0;
  // Normal successful jobs already fold reconciliation true-ups into their
  // settled reservation total. A zero-operation recovery anchored only to a
  // refunded ancestor has no settle row for that helper to discover, so add
  // the reconciliation movement explicitly only in that case.
  const refundedAnchorAdjustment =
    correctionReservationId !== null &&
    !settledVideoReservationIds.has(correctionReservationId)
      ? reconciliationAdjustments.reduce((sum, row) => sum - row.amountPaise, 0)
      : 0;
  const chargedPaise = settledChargePaise + refundedAnchorAdjustment;
  const discrepancyPaise =
    targetChargePaise === null ? null : targetChargePaise - chargedPaise;
  const status: VideoWalletReconciliationReportRow["status"] = hasPendingSettlement
    ? "pending_settlement"
    : targetChargePaise === null
      ? "pending_cost"
      : discrepancyPaise === 0
        ? "balanced"
        : discrepancyPaise! > 0
          ? "undercharged"
          : "overcharged";
  return {
    chainId,
    completedJobId: completed.id,
    jobIds,
    reservationIds,
    eventCount: pricedEvents.length,
    rawProviderCostPaise,
    targetChargePaise,
    chargedPaise,
    discrepancyPaise,
    status,
    pendingEventIds,
    tenantId: completed.tenantId,
    correctionReservationId,
    providers: [...new Set(pricedEvents.map(({ event }) => event.provider))],
    models: [...new Set(pricedEvents.map(({ event }) => event.model))],
    eventSummaries: pricedEvents.map(
      ({ identity, cost }) => `${identity}=${cost === null ? "unknown" : `${cost}p`}`,
    ),
  };
}

/**
 * Read-only historical discrepancy report. It never changes wallet balances;
 * explicit reconciliation is a separate operation.
 */
export async function listVideoWalletReconciliationReport(): Promise<
  VideoWalletReconciliationReportRow[]
> {
  const allJobs = await db.select().from(videoGenerationsTable);
  const completedByChain = new Map<number, VideoGeneration>();
  const allJobsById = new Map(allJobs.map((job) => [job.id, job]));
  for (const job of allJobs) {
    if (job.status !== "succeeded") continue;
    if (!job.options?.characterDialogue && !job.options?.recovery) continue;
    const chainId = canonicalVideoBillingChainId(job, allJobsById);
    const current = completedByChain.get(chainId);
    if (!current || current.id < job.id) completedByChain.set(chainId, job);
  }
  const report: VideoWalletReconciliationReportRow[] = [];
  for (const job of completedByChain.values()) {
    try {
      const {
        tenantId: _tenantId,
        correctionReservationId: _correctionReservationId,
        providers: _providers,
        models: _models,
        eventSummaries: _eventSummaries,
        ...row
      } = await analyzeVideoBillingChain(job.id);
      report.push(row);
    } catch {
      // Non-wallet chains and malformed legacy rows are not actionable wallet
      // discrepancies; unknown priced wallet rows are represented by analysis.
    }
  }
  return report.sort((a, b) => b.completedJobId - a.completedJobId);
}

export interface VideoJobWalletReconciliationResult {
  jobId: number;
  chainId: number;
  jobIds: number[];
  rawProviderCostPaise: number;
  targetChargePaise: number;
  previouslyChargedPaise: number;
  appliedPaise: number;
  finalJobSpendPaise: number;
  eventCount: number;
}

/**
 * Reconcile one completed wallet-funded Character Dialogue job from its
 * durable per-scene provider receipts.
 *
 * This is intentionally narrower than the legacy model-level true-up: every
 * visual/lip-sync event is priced independently from its actual provider,
 * model and measured duration, the platform fee is applied once to their sum,
 * and one reservation-scoped row records only the remaining difference.
 * Locking the reservation serializes retries/concurrent operators; the
 * reconciliation ref makes a completed correction a permanent no-op.
 */
export async function reconcileVideoJobWalletCost(
  jobId: number,
): Promise<VideoJobWalletReconciliationResult> {
  const analysis = await analyzeVideoBillingChain(jobId);
  if (analysis.status === "pending_settlement") {
    throw new Error(`Video billing chain ${analysis.chainId} still has a pending settlement retry`);
  }
  if (
    analysis.rawProviderCostPaise === null ||
    analysis.targetChargePaise === null
  ) {
    throw new Error(
      `Video billing chain ${analysis.chainId} has unknown provider costs: ${analysis.pendingEventIds.join(", ")}`,
    );
  }
  if (analysis.correctionReservationId === null) {
    throw new Error(
      `Video billing chain ${analysis.chainId} has no settled video reservation or refunded recovery anchor`,
    );
  }
  const rawProviderCostPaise = analysis.rawProviderCostPaise;
  const targetChargePaise = analysis.targetChargePaise;
  const reservationId = analysis.correctionReservationId;
  const reconciliationRef = String(analysis.chainId);

  const correction = await db.transaction(async (tx) => {
    const [reserve] = await tx
      .select()
      .from(walletLedgerTable)
      .where(
        and(
          eq(walletLedgerTable.id, reservationId),
          eq(walletLedgerTable.tenantId, analysis.tenantId),
          eq(walletLedgerTable.kind, "reserve"),
        ),
      )
      .for("update");
    if (!reserve) {
      throw new Error(`Wallet reservation ${reservationId} is missing or does not match`);
    }
    const pendingSettlements = await tx
      .select({ status: walletSettlementRetriesTable.status })
      .from(walletSettlementRetriesTable)
      .where(inArray(walletSettlementRetriesTable.reservationId, analysis.reservationIds));
    if (pendingSettlements.some((row) => row.status !== "settled")) {
      throw new Error(
        `Video billing chain ${analysis.chainId} still has a pending settlement retry`,
      );
    }

    const [already] = await tx
      .select({ id: walletLedgerTable.id })
      .from(walletLedgerTable)
      .where(
        and(
          eq(walletLedgerTable.kind, "true_up"),
          eq(walletLedgerTable.refKind, "videoJobReconciliation"),
          eq(walletLedgerTable.refId, reconciliationRef),
          eq(walletLedgerTable.tenantId, analysis.tenantId),
        ),
      )
      .limit(1);

    const [reserves, resolutions] = await Promise.all([
      tx
        .select({
          id: walletLedgerTable.id,
          amountPaise: walletLedgerTable.amountPaise,
        })
        .from(walletLedgerTable)
        .where(
          and(
            eq(walletLedgerTable.tenantId, analysis.tenantId),
            eq(walletLedgerTable.kind, "reserve"),
            inArray(walletLedgerTable.id, analysis.reservationIds),
          ),
        ),
      tx
        .select({
          reservationId: walletLedgerTable.reservationId,
          kind: walletLedgerTable.kind,
          amountPaise: walletLedgerTable.amountPaise,
        })
        .from(walletLedgerTable)
        .where(
          and(
            eq(walletLedgerTable.tenantId, analysis.tenantId),
            inArray(walletLedgerTable.kind, ["settle", "true_up"]),
            inArray(walletLedgerTable.reservationId, analysis.reservationIds),
          ),
        ),
    ]);
    const reserveAmounts = new Map(reserves.map((row) => [row.id, row.amountPaise]));
    const resolutionByReservation = new Map<number, number>();
    const settledReservations = new Set<number>();
    for (const row of resolutions) {
      if (row.reservationId === null) continue;
      if (row.kind === "settle") settledReservations.add(row.reservationId);
      resolutionByReservation.set(
        row.reservationId,
        (resolutionByReservation.get(row.reservationId) ?? 0) + row.amountPaise,
      );
    }
    const previouslyChargedPaise = [...settledReservations].reduce(
      (sum, id) =>
        sum -
        ((reserveAmounts.get(id) ?? 0) + (resolutionByReservation.get(id) ?? 0)),
      0,
    );
    if (already) {
      return { previouslyChargedPaise, appliedPaise: 0 };
    }

    const delta = previouslyChargedPaise - targetChargePaise;
    if (delta < 0) {
      const balance = await lockBalance(tx, analysis.tenantId);
      if (balance < -delta) {
        throw new Error(
          `Wallet balance cannot cover the exact ${-delta} paise video reconciliation`,
        );
      }
    }
    let appliedPaise = 0;
    if (delta !== 0) {
      const applied = await applyDelta(tx, analysis.tenantId, delta, {
        kind: "true_up",
        reservationId,
        usageKind: "video",
        provider: analysis.providers.length === 1 ? analysis.providers[0] : "multiple",
        model: analysis.models.length === 1 ? analysis.models[0] : "multiple",
        providerCostPaise: rawProviderCostPaise,
        refKind: "videoJobReconciliation",
        refId: reconciliationRef,
        estimated: false,
        note:
          `Reconciled ${analysis.eventCount} retry-chain provider events ` +
          `(${analysis.eventSummaries.join(", ")}); raw=${analysis.rawProviderCostPaise}p, ` +
          `fee-inclusive target=${targetChargePaise}p`,
      });
      if (applied.applied !== delta) {
        throw new Error(`Exact video reconciliation applied ${applied.applied}, expected ${delta}`);
      }
      appliedPaise = applied.applied;
    }
    return { previouslyChargedPaise, appliedPaise };
  });

  const finalJobSpendPaise =
    correction.previouslyChargedPaise - correction.appliedPaise;
  await db
    .update(videoGenerationsTable)
    .set({ spendPaise: finalJobSpendPaise, updatedAt: new Date() })
    .where(eq(videoGenerationsTable.id, jobId));
  return {
    jobId,
    chainId: analysis.chainId,
    jobIds: analysis.jobIds,
    rawProviderCostPaise,
    targetChargePaise,
    previouslyChargedPaise: correction.previouslyChargedPaise,
    appliedPaise: correction.appliedPaise,
    finalJobSpendPaise,
    eventCount: analysis.eventCount,
  };
}

export const WALLET_PROVIDER_HANDOFF_GRACE_MS = Number(
  process.env.WALLET_PROVIDER_HANDOFF_GRACE_MS ?? 30_000,
);

export interface WalletProviderOperationSuccessMeta {
  provider?: string | null;
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  /** Exact provider cost before KOKAO's fee; enables receipt-time repricing. */
  costPaise?: number | null;
  providerCredits?: string | null;
  providerRequestId?: string | null;
  providerResultId?: string | null;
}

export class WalletProviderSuccessPersistenceError extends Error {
  constructor(
    message: string,
    public readonly operationId: number,
  ) {
    super(message);
    this.name = "WalletProviderSuccessPersistenceError";
  }
}

/**
 * The provider acknowledged success and the durable receipt was written, but
 * local parsing/persistence after that acknowledgement failed. Callers must
 * settle the operation and may report the original application error, but may
 * never refund or invoke the provider again.
 */
export class WalletProviderPostSuccessError extends Error {
  constructor(
    public readonly operationId: number,
    public readonly originalError: unknown,
  ) {
    super(
      `Provider operation ${operationId} succeeded before a later step failed: ${settlementError(originalError)}`,
    );
    this.name = "WalletProviderPostSuccessError";
  }
}

export type WalletProviderSuccessConfirmer = (
  meta?: WalletProviderOperationSuccessMeta,
) => Promise<void>;
export type WalletProviderReceiptRecorder = (
  meta: Omit<WalletProviderOperationSuccessMeta, "costPaise">,
) => Promise<void>;

/** Persist provider receipt telemetry without claiming a billable outcome. */
export async function recordWalletProviderOperationReceipt(
  operationId: number,
  meta: Omit<WalletProviderOperationSuccessMeta, "costPaise">,
): Promise<void> {
  await db
    .update(walletProviderOperationsTable)
    .set({
      provider: meta.provider,
      model: meta.model,
      inputTokens: meta.inputTokens,
      outputTokens: meta.outputTokens,
      providerCredits: meta.providerCredits,
      providerRequestId: meta.providerRequestId,
      providerResultId: meta.providerResultId,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(walletProviderOperationsTable.id, operationId),
        eq(walletProviderOperationsTable.status, "pending"),
      ),
    );
}

/**
 * Register the provider intent before any paid external work starts and freeze
 * the exact target charge at that point. Reusing the reservation is
 * idempotent, which also makes a request retry unable to create two receipts.
 */
export async function beginWalletProviderOperation(params: {
  tenantId: number;
  reservation: WalletReservation;
  operationKind: WalletProviderOperationKind;
  operationKey?: string | null;
  settlement: WalletSettlementMeta;
}): Promise<WalletProviderOperation> {
  const target = await actualChargePaise({
    kind: params.settlement.kind,
    costPaise: params.settlement.costPaise,
    units: params.reservation.units,
  });
  return db.transaction(async (tx) => {
    const [reserve] = await tx
      .select({
        kind: walletLedgerTable.kind,
        amountPaise: walletLedgerTable.amountPaise,
      })
      .from(walletLedgerTable)
      .where(
        and(
          eq(walletLedgerTable.id, params.reservation.id),
          eq(walletLedgerTable.tenantId, params.tenantId),
        ),
      )
      .for("update");
    if (
      !reserve ||
      reserve.kind !== "reserve" ||
      reserve.amountPaise !== -params.reservation.amountPaise
    ) {
      throw new Error(
        `Wallet reservation ${params.reservation.id} is missing or does not match`,
      );
    }

    const [existing] = await tx
      .select()
      .from(walletProviderOperationsTable)
      .where(
        and(
          eq(walletProviderOperationsTable.reservationId, params.reservation.id),
          eq(walletProviderOperationsTable.tenantId, params.tenantId),
        ),
      )
      .limit(1)
      .for("update");
    if (existing) return existing;

    const [resolved] = await tx
      .select({ kind: walletLedgerTable.kind })
      .from(walletLedgerTable)
      .where(
        and(
          eq(walletLedgerTable.reservationId, params.reservation.id),
          inArray(walletLedgerTable.kind, ["settle", "refund"]),
        ),
      )
      .limit(1);
    if (resolved) {
      throw new Error(
        `Wallet reservation ${params.reservation.id} was already ${resolved.kind === "refund" ? "refunded" : "settled"}`,
      );
    }

    const [inserted] = await tx
      .insert(walletProviderOperationsTable)
      .values({
        tenantId: params.tenantId,
        reservationId: params.reservation.id,
        reservedPaise: params.reservation.amountPaise,
        reservedUnits: params.reservation.units,
        usageKind: params.settlement.kind,
        operationKind: params.operationKind,
        operationKey: params.operationKey ?? null,
        targetChargePaise: target.paise,
        estimated: target.estimated,
        provider: params.settlement.provider ?? null,
        model: params.settlement.model ?? null,
        inputTokens: params.settlement.inputTokens ?? null,
        outputTokens: params.settlement.outputTokens ?? null,
        refKind: params.settlement.refKind ?? null,
        refId: params.settlement.refId ?? null,
        status: "pending",
        recoverAfter: new Date(),
      })
      .returning();
    return inserted!;
  });
}

/**
 * Persist the provider's positive acknowledgement before control returns to the
 * route. Settlement is deliberately a separate handoff: if the process exits
 * between these two steps, the recovery sweep uses this receipt.
 */
export async function confirmWalletProviderOperationSucceeded(
  operationId: number,
  meta: WalletProviderOperationSuccessMeta = {},
): Promise<WalletProviderOperation> {
  return db.transaction(async (tx) => {
    const [operation] = await tx
      .select()
      .from(walletProviderOperationsTable)
      .where(eq(walletProviderOperationsTable.id, operationId))
      .limit(1);
    if (!operation) {
      throw new Error(`Wallet provider operation ${operationId} is missing`);
    }

    const [reserve] = await tx
      .select({
        kind: walletLedgerTable.kind,
        amountPaise: walletLedgerTable.amountPaise,
      })
      .from(walletLedgerTable)
      .where(
        and(
          eq(walletLedgerTable.id, operation.reservationId),
          eq(walletLedgerTable.tenantId, operation.tenantId),
        ),
      )
      .for("update");
    if (
      !reserve ||
      reserve.kind !== "reserve" ||
      reserve.amountPaise !== -operation.reservedPaise
    ) {
      throw new Error(
        `Wallet reservation ${operation.reservationId} is missing or does not match`,
      );
    }

    const [locked] = await tx
      .select()
      .from(walletProviderOperationsTable)
      .where(eq(walletProviderOperationsTable.id, operationId))
      .for("update");
    if (!locked) {
      throw new Error(`Wallet provider operation ${operationId} is missing`);
    }
    if (
      locked.status === "succeeded" ||
      locked.status === "settlement_queued" ||
      locked.status === "settled"
    ) {
      return locked;
    }
    if (locked.status !== "pending") {
      throw new Error(
        `Wallet provider operation ${operationId} cannot succeed from ${locked.status}`,
      );
    }
    const [resolved] = await tx
      .select({ kind: walletLedgerTable.kind })
      .from(walletLedgerTable)
      .where(
        and(
          eq(walletLedgerTable.reservationId, locked.reservationId),
          inArray(walletLedgerTable.kind, ["settle", "refund"]),
        ),
      )
      .limit(1);
    if (resolved) {
      throw new Error(
        `Wallet provider operation ${operationId} cannot succeed after reservation ${resolved.kind}`,
      );
    }
    let exactTarget: { paise: number; estimated: boolean } | null = null;
    if (meta.costPaise !== undefined) {
      if (
        meta.costPaise === null ||
        !Number.isSafeInteger(meta.costPaise) ||
        meta.costPaise < 0
      ) {
        throw new Error(
          `Wallet provider operation ${operationId} received no usable exact provider cost`,
        );
      }
      exactTarget =
        meta.costPaise === 0
          ? { paise: 0, estimated: false }
          : await actualChargePaise({
              kind: locked.usageKind as WalletKind,
              costPaise: meta.costPaise,
              units: locked.reservedUnits,
            });
      if (exactTarget.estimated) {
        throw new Error(
          `Wallet provider operation ${operationId} could not derive an exact target charge`,
        );
      }
      if (exactTarget.paise > locked.reservedPaise) {
        throw new Error(
          `Wallet provider operation ${operationId} exact charge exceeds its durable reservation`,
        );
      }
    }
    const now = new Date();
    const [updated] = await tx
      .update(walletProviderOperationsTable)
      .set({
        status: "succeeded",
        provider: meta.provider ?? locked.provider,
        model: meta.model ?? locked.model,
        providerCostPaise:
          meta.costPaise !== undefined ? meta.costPaise : locked.providerCostPaise,
        inputTokens: meta.inputTokens ?? locked.inputTokens,
        outputTokens: meta.outputTokens ?? locked.outputTokens,
        providerCredits: meta.providerCredits ?? locked.providerCredits,
        providerRequestId: meta.providerRequestId ?? locked.providerRequestId,
        providerResultId: meta.providerResultId ?? locked.providerResultId,
        targetChargePaise: exactTarget?.paise ?? locked.targetChargePaise,
        estimated: exactTarget?.estimated ?? locked.estimated,
        providerFinishedAt: now,
        recoverAfter: new Date(now.getTime() + WALLET_PROVIDER_HANDOFF_GRACE_MS),
        lastError: null,
        updatedAt: now,
      })
      .where(eq(walletProviderOperationsTable.id, operationId))
      .returning();
    return updated!;
  });
}

/**
 * Persist a confirmed provider failure. This serializes against the successful
 * settlement handoff on the reserve row, so a late error can never overwrite a
 * charge that has already been queued.
 */
export async function markWalletProviderOperationFailed(
  operationId: number,
  error: unknown,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [operation] = await tx
      .select()
      .from(walletProviderOperationsTable)
      .where(eq(walletProviderOperationsTable.id, operationId))
      .limit(1);
    if (!operation) return false;

    await tx
      .select({ id: walletLedgerTable.id })
      .from(walletLedgerTable)
      .where(
        and(
          eq(walletLedgerTable.id, operation.reservationId),
          eq(walletLedgerTable.tenantId, operation.tenantId),
        ),
      )
      .for("update");

    const [locked] = await tx
      .select()
      .from(walletProviderOperationsTable)
      .where(eq(walletProviderOperationsTable.id, operationId))
      .for("update");
    if (!locked) return false;
    if (locked.status === "failed") return true;
    if (locked.status !== "pending") return false;

    const [queued] = await tx
      .select({ id: walletSettlementRetriesTable.id })
      .from(walletSettlementRetriesTable)
      .where(eq(walletSettlementRetriesTable.reservationId, locked.reservationId))
      .limit(1);
    if (queued) return false;
    await tx
      .update(walletProviderOperationsTable)
      .set({
        status: "failed",
        providerFinishedAt: locked.providerFinishedAt ?? new Date(),
        recoverAfter: new Date(),
        lastError: settlementError(error),
        updatedAt: new Date(),
      })
      .where(eq(walletProviderOperationsTable.id, operationId));
    return true;
  });
}

/**
 * Execute a paid provider call behind a durable receipt. A provider success is
 * recorded before this function resolves, so callers can safely treat the
 * returned value as confirmed work. Recovery never invokes `perform` again.
 */
export async function executeWalletProviderOperation<T>(
  params: {
    tenantId: number;
    reservation: WalletReservation;
    operationKind: WalletProviderOperationKind;
    operationKey?: string | null;
    settlement: WalletSettlementMeta;
  },
  perform: (
    confirmSuccess: WalletProviderSuccessConfirmer,
    recordReceipt: WalletProviderReceiptRecorder,
  ) => Promise<T>,
  successMeta: (value: T) => WalletProviderOperationSuccessMeta = () => ({}),
  options: {
    isFailureConfirmed?: (error: unknown) => boolean;
    /**
     * Paid work may return successfully without a usable meter receipt. Keep
     * its reservation pending instead of converting the ceiling into a charge.
     */
    requireExplicitSuccessConfirmation?: boolean;
  } = {},
): Promise<{ value: T; operationId: number; confirmed: boolean }> {
  const operation = await beginWalletProviderOperation(params);
  let providerSucceeded = false;
  const confirmSuccess: WalletProviderSuccessConfirmer = async (meta = {}) => {
    if (providerSucceeded) return;
    // Set this before the database write. If that write fails, the provider has
    // still positively acknowledged the work and refunding would be unsafe.
    providerSucceeded = true;
    try {
      await confirmWalletProviderOperationSucceeded(operation.id, meta);
    } catch (error) {
      throw new WalletProviderSuccessPersistenceError(
        `Provider work succeeded but operation ${operation.id} could not be recorded: ${settlementError(error)}`,
        operation.id,
      );
    }
  };
  const recordReceipt: WalletProviderReceiptRecorder = async (meta) => {
    await recordWalletProviderOperationReceipt(operation.id, meta);
  };
  try {
    const value = await perform(confirmSuccess, recordReceipt);
    if (!providerSucceeded && !options.requireExplicitSuccessConfirmation) {
      // Evaluate metadata only after classifying the provider call as a
      // success. A buggy metadata extractor cannot turn completed work into a
      // refundable provider failure.
      providerSucceeded = true;
      let meta: WalletProviderOperationSuccessMeta;
      try {
        meta = successMeta(value);
      } catch (error) {
        try {
          await confirmWalletProviderOperationSucceeded(operation.id);
        } catch (persistError) {
          throw new WalletProviderSuccessPersistenceError(
            `Provider work succeeded but operation ${operation.id} could not be recorded: ${settlementError(persistError)}`,
            operation.id,
          );
        }
        throw new WalletProviderPostSuccessError(operation.id, error);
      }
      try {
        await confirmWalletProviderOperationSucceeded(operation.id, meta);
      } catch (error) {
        throw new WalletProviderSuccessPersistenceError(
          `Provider work succeeded but operation ${operation.id} could not be recorded: ${settlementError(error)}`,
          operation.id,
        );
      }
    }
    return { value, operationId: operation.id, confirmed: providerSucceeded };
  } catch (error) {
    if (!providerSucceeded && (options.isFailureConfirmed?.(error) ?? true)) {
      await markWalletProviderOperationFailed(operation.id, error).catch((recordError) => {
        logger.error(
          { err: recordError, operationId: operation.id },
          "Failed to record provider-operation failure",
        );
      });
    }
    if (
      providerSucceeded &&
      !(error instanceof WalletProviderSuccessPersistenceError) &&
      !(error instanceof WalletProviderPostSuccessError)
    ) {
      throw new WalletProviderPostSuccessError(operation.id, error);
    }
    throw error;
  }
}

/**
 * Move one confirmed provider success into the existing settlement outbox
 * using the target frozen before the provider call, then try it immediately.
 */
export async function settleWalletProviderOperationDurably(
  operationId: number,
): Promise<{ chargedPaise: number; estimated: boolean }> {
  const operation = await db.transaction(async (tx) => {
    const [candidate] = await tx
      .select()
      .from(walletProviderOperationsTable)
      .where(eq(walletProviderOperationsTable.id, operationId))
      .limit(1);
    if (!candidate) {
      throw new Error(`Wallet provider operation ${operationId} is missing`);
    }

    const [reserve] = await tx
      .select({
        kind: walletLedgerTable.kind,
        amountPaise: walletLedgerTable.amountPaise,
      })
      .from(walletLedgerTable)
      .where(
        and(
          eq(walletLedgerTable.id, candidate.reservationId),
          eq(walletLedgerTable.tenantId, candidate.tenantId),
        ),
      )
      .for("update");
    if (
      !reserve ||
      reserve.kind !== "reserve" ||
      reserve.amountPaise !== -candidate.reservedPaise
    ) {
      throw new Error(
        `Wallet reservation ${candidate.reservationId} is missing or does not match`,
      );
    }

    const [locked] = await tx
      .select()
      .from(walletProviderOperationsTable)
      .where(eq(walletProviderOperationsTable.id, operationId))
      .for("update");
    if (!locked) {
      throw new Error(`Wallet provider operation ${operationId} disappeared`);
    }
    if (locked.status === "pending") {
      throw new Error(`Wallet provider operation ${operationId} has no confirmed outcome`);
    }
    if (locked.status === "failed" || locked.status === "refunded") {
      throw new Error(`Wallet provider operation ${operationId} failed`);
    }
    if (
      (locked.operationKind === "brand_voice_tts" ||
        locked.operationKind === "brand_voice_clone") &&
      !locked.providerCredits
    ) {
      throw new Error(
        `Wallet provider operation ${operationId} has no authoritative provider-credit receipt`,
      );
    }

    const [refunded] = await tx
      .select({ id: walletLedgerTable.id })
      .from(walletLedgerTable)
      .where(
        and(
          eq(walletLedgerTable.reservationId, locked.reservationId),
          eq(walletLedgerTable.kind, "refund"),
        ),
      )
      .limit(1);
    if (refunded) {
      throw new Error(`Wallet reservation ${locked.reservationId} was already refunded`);
    }

    await tx
      .insert(walletSettlementRetriesTable)
      .values({
        tenantId: locked.tenantId,
        reservationId: locked.reservationId,
        reservedPaise: locked.reservedPaise,
        reservedUnits: locked.reservedUnits,
        usageKind: locked.usageKind,
        targetChargePaise: locked.targetChargePaise,
        estimated: locked.estimated,
        provider: locked.provider,
        model: locked.model,
        providerCostPaise: locked.providerCostPaise,
        inputTokens: locked.inputTokens,
        outputTokens: locked.outputTokens,
        providerCredits: locked.providerCredits,
        providerRequestId: locked.providerRequestId,
        refKind: locked.refKind,
        refId: locked.refId,
        status: "pending",
        nextAttemptAt: new Date(),
      })
      .onConflictDoNothing({ target: walletSettlementRetriesTable.reservationId });
    if (locked.status !== "settled") {
      await tx
        .update(walletProviderOperationsTable)
        .set({ status: "settlement_queued", updatedAt: new Date() })
        .where(eq(walletProviderOperationsTable.id, operationId));
    }
    return locked;
  });

  const result = await retryWalletSettlement(operation.reservationId);
  if (!result) {
    throw new Error(
      `Wallet settlement retry for reservation ${operation.reservationId} disappeared`,
    );
  }
  if (result.status !== "settled") {
    throw new Error(
      result.error ??
        `Wallet settlement for reservation ${operation.reservationId} is ${result.status}`,
    );
  }
  await db
    .update(walletProviderOperationsTable)
    .set({ status: "settled", resolvedAt: new Date(), lastError: null, updatedAt: new Date() })
    .where(eq(walletProviderOperationsTable.id, operationId));
  return {
    chargedPaise: operation.targetChargePaise,
    estimated: operation.estimated,
  };
}

export async function refundWalletProviderOperation(
  operationId: number,
  error: unknown = "provider operation failed",
): Promise<boolean> {
  const canRefund = await markWalletProviderOperationFailed(operationId, error);
  if (!canRefund) return false;
  const [operation] = await db
    .select()
    .from(walletProviderOperationsTable)
    .where(eq(walletProviderOperationsTable.id, operationId))
    .limit(1);
  if (!operation || operation.status === "refunded") return false;
  await refundWallet(
    operation.tenantId,
    {
      id: operation.reservationId,
      amountPaise: operation.reservedPaise,
      units: operation.reservedUnits,
    },
    operation.lastError ?? "provider operation failed",
  );
  await db
    .update(walletProviderOperationsTable)
    .set({ status: "refunded", resolvedAt: new Date(), updatedAt: new Date() })
    .where(eq(walletProviderOperationsTable.id, operationId));
  return true;
}

/**
 * A caller may decide that successfully completed provider work can no longer
 * be used (for example, its optimistic draft revision became stale) before it
 * hands the operation to settlement. Preserve the provider receipt for audit
 * and recovery, but return the unconsumed reservation to the customer.
 *
 * This deliberately accepts only the durably-confirmed, not-yet-queued success
 * state. It can therefore never turn success-persistence uncertainty or an
 * already queued/settled charge into a refund.
 */
export async function refundSucceededWalletProviderOperation(
  operationId: number,
  note = "completed provider work was discarded before settlement",
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [operation] = await tx
      .select()
      .from(walletProviderOperationsTable)
      .where(eq(walletProviderOperationsTable.id, operationId))
      .for("update")
      .limit(1);
    if (!operation || operation.status !== "succeeded") return false;
    const [reserve] = await tx
      .select({ id: walletLedgerTable.id })
      .from(walletLedgerTable)
      .where(
        and(
          eq(walletLedgerTable.id, operation.reservationId),
          eq(walletLedgerTable.tenantId, operation.tenantId),
        ),
      )
      .for("update");
    if (!reserve) return false;
    const [queued] = await tx
      .select({ id: walletSettlementRetriesTable.id })
      .from(walletSettlementRetriesTable)
      .where(eq(walletSettlementRetriesTable.reservationId, operation.reservationId))
      .limit(1);
    if (queued) return false;
    const [resolved] = await tx
      .select({ kind: walletLedgerTable.kind })
      .from(walletLedgerTable)
      .where(
        and(
          eq(walletLedgerTable.reservationId, operation.reservationId),
          inArray(walletLedgerTable.kind, ["settle", "refund"]),
        ),
      )
      .limit(1);
    if (resolved) return false;
    await applyDelta(tx, operation.tenantId, operation.reservedPaise, {
      kind: "refund",
      reservationId: operation.reservationId,
      note,
    });
    await tx
      .update(walletProviderOperationsTable)
      .set({
        status: "refunded",
        lastError: note,
        resolvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(walletProviderOperationsTable.id, operationId),
          eq(walletProviderOperationsTable.status, "succeeded"),
        ),
      );
    return true;
  });
}

export async function listPendingWalletProviderOperations(
  operationKind?: WalletProviderOperationKind,
): Promise<WalletProviderOperation[]> {
  return db
    .select()
    .from(walletProviderOperationsTable)
    .where(
      operationKind
        ? and(
            eq(walletProviderOperationsTable.status, "pending"),
            eq(walletProviderOperationsTable.operationKind, operationKind),
          )
        : eq(walletProviderOperationsTable.status, "pending"),
    )
    .orderBy(asc(walletProviderOperationsTable.createdAt));
}

/**
 * Recover confirmed outcomes only. A still-pending operation is intentionally
 * untouched unless a provider-specific reconciler first proves its outcome.
 */
export async function sweepWalletProviderOperations(
  now = new Date(),
): Promise<{ settled: number; refunded: number; failed: number }> {
  const rows = await db
    .select()
    .from(walletProviderOperationsTable)
    .where(
      and(
        inArray(walletProviderOperationsTable.status, ["succeeded", "failed"]),
        lte(walletProviderOperationsTable.recoverAfter, now),
      ),
    )
    .orderBy(asc(walletProviderOperationsTable.id));
  let settled = 0;
  let refunded = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      if (row.status === "succeeded") {
        await settleWalletProviderOperationDurably(row.id);
        settled += 1;
      } else if (await refundWalletProviderOperation(row.id, row.lastError ?? "provider failed")) {
        refunded += 1;
      }
    } catch (error) {
      failed += 1;
      await db
        .update(walletProviderOperationsTable)
        .set({
          lastError: settlementError(error),
          recoverAfter: new Date(now.getTime() + retryDelayMs(1)),
          updatedAt: new Date(),
        })
        .where(eq(walletProviderOperationsTable.id, row.id));
      logger.error(
        { err: error, operationId: row.id, operationKind: row.operationKind },
        "Wallet provider-operation recovery failed",
      );
    }
  }
  return { settled, refunded, failed };
}

// ---------- durable post-success settlement retry ----------

export const WALLET_SETTLEMENT_MAX_ATTEMPTS = 8;
export const WALLET_SETTLEMENT_RETRY_INTERVAL_MS = Number(
  process.env.WALLET_SETTLEMENT_RETRY_INTERVAL_MS ?? 60_000,
);
export const WALLET_SETTLEMENT_CLAIM_STALE_MS = Number(
  process.env.WALLET_SETTLEMENT_CLAIM_STALE_MS ?? 5 * 60_000,
);
const WALLET_SETTLEMENT_BATCH_LIMIT = 100;

export type WalletSettlementRetryState = "pending" | "processing" | "settled" | "failed";

export interface WalletSettlementAttemptResult {
  status: WalletSettlementRetryState;
  retryId: number;
  error?: string;
}

function settlementError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 2_000);
}

function retryDelayMs(attempts: number): number {
  return Math.min(60 * 60_000, 60_000 * 2 ** Math.max(0, attempts - 1));
}

async function processClaimedSettlement(
  row: WalletSettlementRetry,
): Promise<WalletSettlementAttemptResult> {
  try {
    await settleWalletToTarget(
      row.tenantId,
      {
        id: row.reservationId,
        amountPaise: row.reservedPaise,
        units: row.reservedUnits,
      },
      {
        kind: row.usageKind as WalletKind,
        provider: row.provider,
        model: row.model,
        costPaise: row.providerCostPaise,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        providerCredits: row.providerCredits,
        providerRequestId: row.providerRequestId,
        refKind: row.refKind,
        refId: row.refId,
      },
      { paise: row.targetChargePaise, estimated: row.estimated },
    );
    const now = new Date();
    await db
      .update(walletSettlementRetriesTable)
      .set({
        status: "settled",
        claimedAt: null,
        nextAttemptAt: now,
        lastError: null,
        settledAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(walletSettlementRetriesTable.id, row.id),
          eq(walletSettlementRetriesTable.status, "processing"),
        ),
      );
    await db
      .update(walletProviderOperationsTable)
      .set({
        status: "settled",
        resolvedAt: now,
        lastError: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(walletProviderOperationsTable.reservationId, row.reservationId),
          sql`${walletProviderOperationsTable.status} <> 'refunded'`,
        ),
      );
    return { status: "settled", retryId: row.id };
  } catch (error) {
    const message = settlementError(error);
    const terminal = row.attempts >= WALLET_SETTLEMENT_MAX_ATTEMPTS;
    const now = new Date();
    await db
      .update(walletSettlementRetriesTable)
      .set({
        status: terminal ? "failed" : "pending",
        claimedAt: null,
        nextAttemptAt: terminal
          ? now
          : new Date(now.getTime() + retryDelayMs(row.attempts)),
        lastError: message,
        updatedAt: now,
      })
      .where(
        and(
          eq(walletSettlementRetriesTable.id, row.id),
          eq(walletSettlementRetriesTable.status, "processing"),
        ),
      );
    logger.error(
      {
        err: error,
        retryId: row.id,
        reservationId: row.reservationId,
        attempts: row.attempts,
        terminal,
      },
      terminal
        ? "Wallet settlement retry failed permanently"
        : "Wallet settlement queued for retry",
    );
    return {
      status: terminal ? "failed" : "pending",
      retryId: row.id,
      error: message,
    };
  }
}

/**
 * Retry one reservation immediately, ignoring its normal backoff. This is used
 * right after enqueue and is also useful for an operator-triggered recovery.
 * The conditional pending -> processing update is the claim: concurrent calls
 * cannot both invoke settlement.
 */
export async function retryWalletSettlement(
  reservationId: number,
): Promise<WalletSettlementAttemptResult | null> {
  const now = new Date();
  const [claimed] = await db
    .update(walletSettlementRetriesTable)
    .set({
      status: "processing",
      attempts: sql`${walletSettlementRetriesTable.attempts} + 1`,
      claimedAt: now,
      lastAttemptAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(walletSettlementRetriesTable.reservationId, reservationId),
        eq(walletSettlementRetriesTable.status, "pending"),
      ),
    )
    .returning();
  if (claimed) return processClaimedSettlement(claimed);

  const [existing] = await db
    .select({
      id: walletSettlementRetriesTable.id,
      status: walletSettlementRetriesTable.status,
      lastError: walletSettlementRetriesTable.lastError,
    })
    .from(walletSettlementRetriesTable)
    .where(eq(walletSettlementRetriesTable.reservationId, reservationId))
    .limit(1);
  if (!existing) return null;
  return {
    retryId: existing.id,
    status: existing.status as WalletSettlementRetryState,
    ...(existing.lastError ? { error: existing.lastError } : {}),
  };
}

/**
 * Persist a successful generation's exact target charge, then try it now.
 * Throwing after a failed attempt preserves existing route logging behavior;
 * the durable row has already been moved back to pending (or terminal failed),
 * so callers must log but never refund the successful work.
 */
export async function settleWalletDurably(
  tenantId: number,
  reservation: WalletReservation,
  meta: WalletSettlementMeta,
  options: { requireExact?: boolean; targetChargePaise?: number } = {},
): Promise<{ chargedPaise: number; estimated: boolean }> {
  const target = options.targetChargePaise !== undefined
    ? { paise: Math.max(0, Math.trunc(options.targetChargePaise)), estimated: false }
    : options.requireExact
    ? { paise: await exactChargePaise(meta.costPaise), estimated: false }
    : await actualChargePaise({
        kind: meta.kind,
        costPaise: meta.costPaise,
        units: reservation.units,
      });
  await db.transaction(async (tx) => {
    // Serialize enqueue against refundWallet on the reserve row. If enqueue
    // wins, refund sees the durable retry and no-ops; if an earlier failure
    // already refunded, successful-work settlement must not be queued.
    const [reserve] = await tx
      .select({
        kind: walletLedgerTable.kind,
        amountPaise: walletLedgerTable.amountPaise,
      })
      .from(walletLedgerTable)
      .where(
        and(
          eq(walletLedgerTable.id, reservation.id),
          eq(walletLedgerTable.tenantId, tenantId),
        ),
      )
      .for("update");
    if (
      !reserve ||
      reserve.kind !== "reserve" ||
      reserve.amountPaise !== -reservation.amountPaise
    ) {
      throw new Error(`Wallet reservation ${reservation.id} is missing or does not match`);
    }
    const [refunded] = await tx
      .select({ id: walletLedgerTable.id })
      .from(walletLedgerTable)
      .where(
        and(
          eq(walletLedgerTable.reservationId, reservation.id),
          eq(walletLedgerTable.kind, "refund"),
        ),
      )
      .limit(1);
    if (refunded) {
      throw new Error(`Wallet reservation ${reservation.id} was already refunded`);
    }
    await tx
      .insert(walletSettlementRetriesTable)
      .values({
        tenantId,
        reservationId: reservation.id,
        reservedPaise: reservation.amountPaise,
        reservedUnits: reservation.units,
        usageKind: meta.kind,
        targetChargePaise: target.paise,
        estimated: target.estimated,
        provider: meta.provider ?? null,
        model: meta.model ?? null,
        providerCostPaise:
          typeof meta.costPaise === "number" && Number.isSafeInteger(meta.costPaise)
            ? meta.costPaise
            : null,
        inputTokens: meta.inputTokens ?? null,
        outputTokens: meta.outputTokens ?? null,
        refKind: meta.refKind ?? null,
        refId: meta.refId ?? null,
        status: "pending",
        nextAttemptAt: new Date(),
      })
      .onConflictDoNothing({ target: walletSettlementRetriesTable.reservationId });
  });

  const result = await retryWalletSettlement(reservation.id);
  if (!result) {
    throw new Error(`Wallet settlement retry for reservation ${reservation.id} disappeared`);
  }
  if (result.status !== "settled") {
    throw new Error(
      result.error ??
        `Wallet settlement for reservation ${reservation.id} is ${result.status}`,
    );
  }
  return { chargedPaise: target.paise, estimated: target.estimated };
}

/** Pending/processing and terminally failed rows for superadmin operations. */
export async function listWalletSettlementRetries(): Promise<WalletSettlementRetry[]> {
  return db
    .select()
    .from(walletSettlementRetriesTable)
    .where(
      inArray(walletSettlementRetriesTable.status, ["pending", "processing", "failed"]),
    )
    .orderBy(asc(walletSettlementRetriesTable.createdAt));
}

export async function sweepWalletSettlementRetries(
  now = new Date(),
): Promise<{ claimed: number; settled: number; failed: number }> {
  const staleBefore = new Date(now.getTime() - WALLET_SETTLEMENT_CLAIM_STALE_MS);
  const claimed = await db
    .update(walletSettlementRetriesTable)
    .set({
      status: "processing",
      attempts: sql`${walletSettlementRetriesTable.attempts} + 1`,
      claimedAt: now,
      lastAttemptAt: now,
      updatedAt: now,
    })
    .where(
      sql`${walletSettlementRetriesTable.id} IN (
        SELECT id FROM wallet_settlement_retries
        WHERE (
          (status = 'pending' AND next_attempt_at <= ${now})
          OR (status = 'processing' AND claimed_at <= ${staleBefore})
        )
        ORDER BY next_attempt_at, id
        LIMIT ${WALLET_SETTLEMENT_BATCH_LIMIT}
        FOR UPDATE SKIP LOCKED
      )`,
    )
    .returning();

  let settled = 0;
  let failed = 0;
  for (const row of claimed) {
    const result = await processClaimedSettlement(row);
    if (result.status === "settled") settled += 1;
    if (result.status === "failed") failed += 1;
  }
  return { claimed: claimed.length, settled, failed };
}

let settlementRetryTimer: NodeJS.Timeout | null = null;
let settlementRetryRunning = false;

export function startWalletSettlementRetrySweep(
  intervalMs = WALLET_SETTLEMENT_RETRY_INTERVAL_MS,
): void {
  if (settlementRetryTimer) return;
  settlementRetryTimer = setInterval(() => {
    if (settlementRetryRunning) return;
    settlementRetryRunning = true;
    void sweepWalletSettlementRetries()
      .catch((error) => {
        logger.error({ err: error }, "Wallet settlement retry sweep failed");
      })
      .finally(() => {
        settlementRetryRunning = false;
      });
  }, intervalMs);
  settlementRetryTimer.unref?.();
}

export function stopWalletSettlementRetrySweep(): void {
  if (!settlementRetryTimer) return;
  clearInterval(settlementRetryTimer);
  settlementRetryTimer = null;
}

// ---------- top-ups and admin adjustments ----------

/**
 * Credit a paid recharge. `basePaise` is the GST-exclusive amount that lands
 * in the wallet; the GST figures are recorded alongside for reconciliation but
 * are never credited. Idempotent per Razorpay order via the ledger's unique
 * index, so a verification racing the webhook backstop credits exactly once.
 */
export async function creditWalletTopup(params: {
  tenantId: number;
  basePaise: number;
  gstPaise: number;
  gstPercent: number;
  /** Exactly one order id must be set; the matching unique index dedupes. */
  razorpayOrderId?: string;
  cashfreeOrderId?: string;
  note?: string | null;
}): Promise<boolean> {
  if (!params.razorpayOrderId && !params.cashfreeOrderId) {
    throw new Error("creditWalletTopup requires a razorpayOrderId or cashfreeOrderId");
  }
  try {
    await db.transaction(async (tx) =>
      applyDelta(tx, params.tenantId, params.basePaise, {
        kind: "topup",
        baseAmountPaise: params.basePaise,
        gstAmountPaise: params.gstPaise,
        gstPercent: params.gstPercent,
        razorpayOrderId: params.razorpayOrderId ?? null,
        cashfreeOrderId: params.cashfreeOrderId ?? null,
        note: params.note ?? null,
      }),
    );
  } catch (error) {
    // Unique violation on the order id = already credited. Not an error.
    if (isOrderUniqueViolation(error)) return false;
    throw error;
  }
  // The wallet just gained funds: collect any true-up remainder that a
  // previous attempt could only partially debit. Best-effort — a failure
  // here must never make a paid top-up look uncredited.
  try {
    await collectPendingTrueUpsForTenant(params.tenantId);
  } catch (error) {
    logger.error(
      { err: error, tenantId: params.tenantId },
      "Post-top-up true-up collection failed",
    );
  }
  return true;
}

function isOrderUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    const e = current as {
      code?: string;
      constraint?: string;
      message?: string;
      cause?: unknown;
    };
    // Deliberately NOT a bare code 23505 check: any other unique violation
    // means the top-up was LOST, and reporting that as "already credited"
    // would swallow a payment the tenant actually made.
    if (
      e.constraint === "wallet_ledger_order_unique" ||
      e.constraint === "wallet_ledger_cf_order_unique" ||
      (typeof e.message === "string" &&
        /wallet_ledger_(cf_)?order_unique/i.test(e.message))
    ) {
      return true;
    }
    current = e.cause;
  }
  return false;
}

/**
 * Superadmin manual top-up or deduction, in paise. Positive credits, negative
 * debits. No GST is involved — an admin grant is not a sale.
 */
export async function adminAdjustWallet(params: {
  tenantId: number;
  amountPaise: number;
  note?: string | null;
}): Promise<{ appliedPaise: number; balancePaise: number }> {
  const result = await db.transaction(async (tx) =>
    applyDelta(tx, params.tenantId, params.amountPaise, {
      kind: params.amountPaise >= 0 ? "admin_credit" : "admin_debit",
      note: params.note ?? null,
    }),
  );
  return { appliedPaise: result.applied, balancePaise: result.balancePaise };
}

// ---------- history and pending prices ----------

export async function listWalletHistory(
  tenantId: number,
  limit = 50,
): Promise<WalletLedgerEntry[]> {
  return db
    .select()
    .from(walletLedgerTable)
    .where(eq(walletLedgerTable.tenantId, tenantId))
    .orderBy(desc(walletLedgerTable.createdAt), desc(walletLedgerTable.id))
    .limit(limit);
}

/**
 * Why a group of estimated wallet charges is still awaiting reconciliation.
 * - `no_price`        — the price catalog has no row for the model at all.
 * - `price_incomplete`— a catalog row exists but lacks the price fields this
 *                       usage kind needs (e.g. a text row without token rates).
 * - `no_fx_rate`      — a usable price exists but the USD→INR rate is unset,
 *                       so no USD price can become a paise charge.
 * - `missing_usage`   — a usable price exists but the charges never recorded
 *                       the token usage a token-based price needs.
 * - `not_reconciled`  — everything needed appears to be in place; the true-up
 *                       simply has not run (or could not finish, e.g. an empty
 *                       wallet at collection time). Reconcile now / retry.
 */
export type PendingPriceReason =
  | "no_price"
  | "price_incomplete"
  | "no_fx_rate"
  | "missing_usage"
  | "not_reconciled";

export interface PendingPricedModel {
  usageKind: string;
  provider: string | null;
  model: string | null;
  chargeCount: number;
  chargedPaise: number;
  /** Why the rows are still pending — drives the admin banner copy. */
  reason: PendingPriceReason;
  /** Human-readable specifics (which input is missing, mismatches, etc.). */
  detail: string;
  /** Provider string on the catalog row that matched (null = no row). */
  priceProvider: string | null;
  /** Charges in the group that never recorded token usage. */
  missingUsageCount: number;
}

const usageKindToPriceKind = (
  usageKind: string | null,
): "text" | "image" | "video" | null =>
  usageKind === "caption"
    ? "text"
    : usageKind === "image"
      ? "image"
      : usageKind === "video"
        ? "video"
        : null;

/**
 * Models whose wallet charges are still at the display-rate fallback, each
 * diagnosed against the CURRENT price catalog (same matching rules as the
 * cost calculators, including the model-only provider fallback) so the admin
 * banner can say WHY a group is stuck instead of blaming the catalog for
 * everything.
 */
export async function listPendingPricedModels(): Promise<PendingPricedModel[]> {
  const rows = await db
    .select({
      usageKind: walletLedgerTable.usageKind,
      provider: walletLedgerTable.provider,
      model: walletLedgerTable.model,
      chargeCount: sql<number>`count(*)::int`,
      chargedPaise: sql<number>`coalesce(sum(-${walletLedgerTable.amountPaise}), 0)::int`,
      missingUsageCount: sql<number>`count(*) filter (where ${walletLedgerTable.inputTokens} is null or ${walletLedgerTable.outputTokens} is null)::int`,
    })
    .from(walletLedgerTable)
    .where(
      and(
        eq(walletLedgerTable.estimated, true),
        isNull(walletLedgerTable.trueUpAt),
      ),
    )
    .groupBy(
      walletLedgerTable.usageKind,
      walletLedgerTable.provider,
      walletLedgerTable.model,
    );

  const { usdToInrPaise } = await getAiCostConfig();
  const out: PendingPricedModel[] = [];
  for (const r of rows) {
    const base = {
      usageKind: r.usageKind ?? "unknown",
      provider: r.provider,
      model: r.model,
      chargeCount: r.chargeCount,
      // A settle row's amount is the reserve/actual DIFFERENCE, so this sum is
      // indicative only; the per-tenant ledger stays the exact record.
      chargedPaise: r.chargedPaise,
      missingUsageCount: r.missingUsageCount,
    };
    out.push({
      ...base,
      ...(await classifyPendingGroup({
        usageKind: r.usageKind,
        provider: r.provider,
        model: r.model,
        chargeCount: r.chargeCount,
        missingUsageCount: r.missingUsageCount,
        usdToInrPaise,
      })),
    });
  }
  return out;
}

/** Diagnose one pending group against the price catalog. */
async function classifyPendingGroup(group: {
  usageKind: string | null;
  provider: string | null;
  model: string | null;
  chargeCount: number;
  missingUsageCount: number;
  usdToInrPaise: number;
}): Promise<{ reason: PendingPriceReason; detail: string; priceProvider: string | null }> {
  const kind = usageKindToPriceKind(group.usageKind);
  if (!group.model || !kind) {
    return {
      reason: "no_price",
      detail: !group.model
        ? "The charge recorded no model name, so no catalog price can ever match it."
        : `Unrecognized usage kind "${group.usageKind ?? "unknown"}".`,
      priceProvider: null,
    };
  }
  const price = await findModelPrice(kind, group.provider ?? "", group.model);
  if (!price) {
    if (
      kind === "text" &&
      group.chargeCount > 0 &&
      group.missingUsageCount === group.chargeCount
    ) {
      return {
        reason: "missing_usage",
        detail:
          "These legacy text charges recorded no input/output token counts, so no catalog price can accurately reconcile them.",
        priceProvider: null,
      };
    }
    return {
      reason: "no_price",
      detail: `No row in the price catalog matches ${kind}:${group.model} under any provider.`,
      priceProvider: null,
    };
  }
  const providerNote =
    group.provider &&
    price.provider.trim().toLowerCase() !== group.provider.trim().toLowerCase()
      ? ` (matched the catalog row for provider "${price.provider}" via the model-only fallback)`
      : "";

  const hasTokenPair = price.inputUsdPerMtok !== null && price.outputUsdPerMtok !== null;
  if (kind === "text" && !hasTokenPair) {
    return {
      reason: "price_incomplete",
      detail: `The catalog row is missing the input/output USD-per-1M-token rates a text price needs${providerNote}.`,
      priceProvider: price.provider,
    };
  }
  if (kind === "image" && price.usdPerImage === null && !hasTokenPair) {
    return {
      reason: "price_incomplete",
      detail: `The catalog row has neither a per-image price nor both token rates${providerNote}.`,
      priceProvider: price.provider,
    };
  }
  if (kind === "video" && price.usdPerSecond === null && price.usdPerVideo === null) {
    return {
      reason: "price_incomplete",
      detail: `The catalog row has neither a per-second nor a per-video price${providerNote}.`,
      priceProvider: price.provider,
    };
  }
  if (group.usdToInrPaise <= 0) {
    return {
      reason: "no_fx_rate",
      detail: `A price exists but the USD→INR rate is unset, so no charge can be computed${providerNote}.`,
      priceProvider: price.provider,
    };
  }
  // Token-based pricing with no recorded usage can never reconcile. Images
  // with a flat per-image price don't need usage; text always does.
  const needsUsage = kind === "text" || (kind === "image" && price.usdPerImage === null);
  if (needsUsage && group.missingUsageCount >= group.chargeCount) {
    return {
      reason: "missing_usage",
      detail: `A usable price exists but ${group.missingUsageCount === 1 ? "the charge" : `all ${group.missingUsageCount} charges`} recorded no token usage, so the real cost cannot be computed${providerNote}.`,
      priceProvider: price.provider,
    };
  }
  const partialUsage =
    needsUsage && group.missingUsageCount > 0
      ? ` ${group.missingUsageCount} of ${group.chargeCount} charges lack token usage and will stay pending.`
      : "";
  const videoNote =
    kind === "video" && price.usdPerVideo === null
      ? " Per-second pricing needs each charge's stored clip length; charges without one stay pending."
      : "";
  return {
    reason: "not_reconciled",
    detail: `A usable price exists; these charges have not been reconciled yet (or the wallet could not cover the shortfall). Use Reconcile now${providerNote}.${partialUsage}${videoNote}`,
    priceProvider: price.provider,
  };
}

export interface ReconcileResult {
  /** Rows fully trued-up (stamped trueUpAt) by this run. */
  settledRows: number;
  /** Net paise applied across wallets (negative = collected, positive = refunded). */
  netPaise: number;
  /** Shortfall that wallets could not cover; stays pending for later. */
  uncollectedPaise: number;
  /** The group after the run, with a fresh diagnosis; null when fully cleared. */
  remaining: PendingPricedModel | null;
}

/**
 * Admin "reconcile now" for one pending group: run the existing true-up for
 * the model, then re-diagnose what (if anything) is still pending so the
 * caller can report settled vs remaining with reasons.
 */
export async function reconcilePendingModel(args: {
  usageKind: string;
  provider: string | null;
  model: string;
}): Promise<ReconcileResult> {
  const kind = usageKindToPriceKind(args.usageKind);
  if (!kind) {
    throw new Error(`Unrecognized usage kind "${args.usageKind}"`);
  }
  const price = await findModelPrice(kind, args.provider ?? "", args.model);
  const result = price
    ? await trueUpModel({
        kind,
        provider: args.provider ?? price.provider,
        model: args.model,
      })
    : { rowsTruedUp: 0, netPaise: 0, uncollectedPaise: 0 };

  const pendingAfter = await listPendingPricedModels();
  const norm = (s: string | null) => (s ?? "").trim().toLowerCase();
  const remaining =
    pendingAfter.find(
      (p) =>
        p.usageKind === args.usageKind &&
        norm(p.provider) === norm(args.provider) &&
        norm(p.model) === norm(args.model),
    ) ?? null;
  return {
    settledRows: result.rowsTruedUp,
    netPaise: result.netPaise,
    uncollectedPaise: result.uncollectedPaise,
    remaining,
  };
}

/**
 * Collect the difference on generations that were charged the display rate
 * because their model had no price. Called after a superadmin saves a model
 * price: every estimated row for that model is recomputed against the real
 * price and the shortfall is debited (or the overcharge refunded) as a
 * `true_up` row.
 *
 * Rows are marked `trueUpAt` once their shortfall (or refund) has been FULLY
 * applied, so a model is only ever trued up once per price save. When the
 * wallet cannot cover the whole shortfall, the balance is drained to zero,
 * the partial collection is recorded, and the row stays PENDING (no
 * `trueUpAt`) so the remainder is collected on a later attempt — e.g. the
 * boot sweep or the tenant's next top-up — instead of being silently
 * forgiven. Prior partial `true_up` rows are counted as already-charged, so
 * retries never double-collect.
 */
export async function trueUpModel(args: {
  kind: "text" | "image" | "video";
  provider: string;
  model: string;
  /**
   * Restrict the true-up to one tenant's rows. Set by the post-top-up retry
   * so tenant A's payment can never trigger a debit against tenant B; a
   * price save leaves it unset and trues up everyone, as before.
   */
  tenantId?: number;
}): Promise<{ rowsTruedUp: number; netPaise: number; uncollectedPaise: number }> {
  const usageKind: WalletKind =
    args.kind === "text" ? "caption" : args.kind === "image" ? "image" : "video";
  const pending = await db
    .select()
    .from(walletLedgerTable)
    .where(
      and(
        eq(walletLedgerTable.estimated, true),
        isNull(walletLedgerTable.trueUpAt),
        eq(walletLedgerTable.usageKind, usageKind),
        // Same normalization as the price-catalog lookup (findPrice): trimmed,
        // case-insensitive. An exact string match here left rows permanently
        // "pending" whenever the admin's catalog entry differed from the
        // ledger's model string only by case or whitespace.
        sql`lower(trim(${walletLedgerTable.model})) = lower(${args.model.trim()})`,
        ...(args.tenantId !== undefined
          ? [eq(walletLedgerTable.tenantId, args.tenantId)]
          : []),
      ),
    )
    .limit(1000);
  if (pending.length === 0) return { rowsTruedUp: 0, netPaise: 0, uncollectedPaise: 0 };

  const { feePercent } = await getAiSpendConfig();
  let rowsTruedUp = 0;
  let netPaise = 0;
  let uncollectedPaise = 0;

  // Per-second video prices need the clip length, which the ledger does not
  // store. A video settle row links back to its video_generations job
  // (refKind "videoJob"), whose options carry the REQUESTED clip length —
  // the same figure the reservation priced. Null when there is no job link
  // or the job stored no duration; computeVideoCostPaise then falls back to
  // the flat per-video price, or stays unknown (row remains pending).
  const storedVideoCost = async (
    row: (typeof pending)[number],
  ): Promise<number | null> => {
    const legacyFallback = () =>
      computeVideoCostPaise({
        provider: row.provider ?? args.provider,
        model: args.model,
        durationSec: null,
        variantCriteria: {},
      });
    if (row.refKind !== "videoJob" || !row.refId) return legacyFallback();
    const jobId = Number(row.refId);
    if (!Number.isInteger(jobId) || jobId <= 0) return legacyFallback();
    const [job] = await db
      .select({
        options: videoGenerationsTable.options,
        storyboard: videoGenerationsTable.storyboard,
      })
      .from(videoGenerationsTable)
      .where(eq(videoGenerationsTable.id, jobId))
      .limit(1);
    if (!job) return legacyFallback();
    const options = job.options;
    const events = [
      ...(options?.renderCheckpoint?.providerEvents ?? []),
      ...(options?.recovery?.rendered?.providerEvents ?? []),
      ...(options?.musicCheckpoint?.event ? [options.musicCheckpoint.event] : []),
      ...(options?.presenterMusicCheckpoint?.event
        ? [options.presenterMusicCheckpoint.event]
        : []),
      ...(options?.presenterBroll?.providerEvents ?? []),
      ...(options?.characterDialogue?.scenes.flatMap((scene) => [
        ...(scene.checkpoint?.visualEvent ? [scene.checkpoint.visualEvent] : []),
        ...(scene.checkpoint?.lipSyncEvent ? [scene.checkpoint.lipSyncEvent] : []),
      ]) ?? []),
      ...(job.storyboard?.scenes.flatMap((scene) =>
        scene.providerCheckpoint?.event ? [scene.providerCheckpoint.event] : [],
      ) ?? []),
    ];
    if (events.length === 0) {
      // Legacy jobs have no immutable receipts. Empty criteria deliberately
      // match only legacy model-level prices, never a conditional catalog.
      return computeVideoCostPaise({
        provider: row.provider ?? args.provider,
        model: args.model,
        durationSec: options?.durationSec ?? null,
        variantCriteria: {},
      });
    }
    const costs = await Promise.all(
      events.map((event) =>
        computeVideoCostPaise({
          provider: event.provider,
          model: event.model,
          durationSec: event.durationSec,
          variantCriteria: event.criteria ?? {},
        }),
      ),
    );
    return costs.every((cost): cost is number => cost !== null && cost > 0)
      ? costs.reduce((sum, cost) => sum + cost, 0)
      : null;
  };

  // What the tenant was ACTUALLY charged for a settled generation is the
  // reserved estimate minus the settle row's delta — not today's display rate,
  // which may have changed, and not a per-unit figure, which would be wrong
  // for a multi-platform campaign that settled as one row. Prior partial
  // `true_up` collections against the same reservation count as charged too,
  // so a retry after a top-up collects only what is still owed.
  //
  // Runs INSIDE the debit transaction, after the settle row has been locked,
  // so two concurrent true-up triggers (price save, boot sweep, top-up) can
  // never both read the same prior total and each collect the full shortfall.
  const chargedFor = async (
    tx: DbTransaction,
    row: { reservationId: number | null; amountPaise: number },
  ): Promise<number | null> => {
    if (row.reservationId === null) return null;
    const [reserve] = await tx
      .select({ amountPaise: walletLedgerTable.amountPaise })
      .from(walletLedgerTable)
      .where(eq(walletLedgerTable.id, row.reservationId))
      .limit(1);
    if (!reserve) return null;
    const [priorTrueUps] = await tx
      .select({
        total: sql<number>`coalesce(sum(${walletLedgerTable.amountPaise}), 0)::int`,
      })
      .from(walletLedgerTable)
      .where(
        and(
          eq(walletLedgerTable.reservationId, row.reservationId),
          eq(walletLedgerTable.kind, "true_up"),
        ),
      );
    // true_up debits are negative, so subtracting them ADDS what was already
    // collected to the charged total.
    return -reserve.amountPaise - row.amountPaise - (priorTrueUps?.total ?? 0);
  };

  for (const row of pending) {
    const provider = row.provider ?? args.provider;
    const videoCost = args.kind === "video" ? await storedVideoCost(row) : null;
    const raw =
      args.kind === "text"
        ? await computeTextCostPaise({
            provider,
            model: args.model,
            inputTokens: row.inputTokens,
            outputTokens: row.outputTokens,
          })
        : args.kind === "image"
          ? await computeImageCostPaise({
              provider,
              model: args.model,
              inputTokens: row.inputTokens,
              outputTokens: row.outputTokens,
            })
          : videoCost;
    // Still unknown (e.g. a text model whose tokens were never reported):
    // leave the row pending rather than inventing a number.
    if (raw === null) continue;
    const realCharge = withFee(Math.max(0, raw), feePercent);

    const fullyApplied = await db.transaction(async (tx) => {
      // Serialize on the settle row itself: lock it, and re-check that no
      // concurrent trigger already trued it up while we were computing.
      const [fresh] = await tx
        .select()
        .from(walletLedgerTable)
        .where(eq(walletLedgerTable.id, row.id))
        .for("update");
      if (!fresh || fresh.trueUpAt !== null) return false;

      const charged = await chargedFor(tx, fresh);
      if (charged === null) return false;
      const delta = charged - realCharge; // positive = refund the overcharge

      let complete = true;
      if (delta !== 0) {
        const applied = await applyDelta(tx, row.tenantId, delta, {
          kind: "true_up",
          reservationId: row.reservationId,
          usageKind: row.usageKind,
          provider,
          model: args.model,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          note: `Priced ${args.model} after the fact`,
        });
        netPaise += applied.applied;
        // Both sides negative on a shortfall; > 0 means part went uncollected.
        const remainder = applied.applied - delta;
        if (remainder > 0 && delta < 0) {
          // The wallet could not cover the whole shortfall. Record exactly
          // how much is still owed on the true_up row and leave the settle
          // row PENDING so a later attempt (boot sweep, next top-up, next
          // price save) collects the remainder instead of forgiving it.
          complete = false;
          uncollectedPaise += remainder;
          await tx
            .update(walletLedgerTable)
            .set({
              note: `Priced ${args.model} after the fact — partial: ${remainder} paise still due`,
            })
            .where(eq(walletLedgerTable.id, applied.entryId));
          logger.warn(
            {
              tenantId: row.tenantId,
              model: args.model,
              collectedPaise: -applied.applied,
              stillDuePaise: remainder,
            },
            "True-up shortfall only partially collected; row left pending",
          );
        }
      }
      if (complete) {
        await tx
          .update(walletLedgerTable)
          .set({ trueUpAt: new Date() })
          .where(eq(walletLedgerTable.id, row.id));
      }
      return complete;
    });
    if (fullyApplied) rowsTruedUp += 1;
  }
  return { rowsTruedUp, netPaise, uncollectedPaise };
}

/**
 * Retry pending true-ups for ONE tenant's estimated-but-unpriced charges,
 * used right after a top-up so a shortfall that was only partially collected
 * (wallet was empty at price-save time) gets the remainder debited from the
 * fresh balance. Only groups whose model now has a catalog price are touched;
 * everything else stays pending exactly as before.
 */
export async function collectPendingTrueUpsForTenant(tenantId: number): Promise<void> {
  const groups = await db
    .selectDistinct({
      usageKind: walletLedgerTable.usageKind,
      provider: walletLedgerTable.provider,
      model: walletLedgerTable.model,
    })
    .from(walletLedgerTable)
    .where(
      and(
        eq(walletLedgerTable.tenantId, tenantId),
        eq(walletLedgerTable.estimated, true),
        isNull(walletLedgerTable.trueUpAt),
      ),
    );
  for (const group of groups) {
    if (!group.model) continue;
    const kind =
      group.usageKind === "caption"
        ? ("text" as const)
        : group.usageKind === "image"
          ? ("image" as const)
          : group.usageKind === "video"
            ? ("video" as const)
            : null;
    if (!kind) continue;
    const price = await findModelPrice(kind, group.provider ?? "", group.model);
    if (!price) continue;
    await trueUpModel({
      kind,
      provider: group.provider ?? price.provider,
      model: group.model,
      // Scope strictly to the tenant whose top-up triggered this: their
      // payment must never cause a debit against another tenant's wallet.
      tenantId,
    });
  }
}
/**
 * How many consecutive per-group sweep failures must occur before a superadmin
 * alert is raised. Overridable for tests via WALLET_TRUEUP_FAIL_ALERT_THRESHOLD.
 */
export const WALLET_TRUEUP_FAIL_ALERT_THRESHOLD = Number(
  process.env.WALLET_TRUEUP_FAIL_ALERT_THRESHOLD ?? 3,
);

/**
 * Per-group consecutive-failure state, keyed by `${usageKind}:${model}`.
 * Counts how many successive sweeps threw an error for that group; resets to
 * zero when the group settles or disappears from the pending list. Exposed for
 * testing via `resetTrueUpFailCounts`.
 */
const trueUpFailCounts = new Map<string, { count: number; lastError: string | null }>();

/** Reset all consecutive-failure counters (tests only). */
export function resetTrueUpFailCounts(): void {
  trueUpFailCounts.clear();
}

/** Inject a failure count for one model group (tests only). */
export function setTrueUpFailCountForTest(
  usageKind: string,
  model: string,
  count: number,
  lastError: string | null = null,
): void {
  const key = `${usageKind}:${model}`;
  if (count <= 0) {
    trueUpFailCounts.delete(key);
  } else {
    trueUpFailCounts.set(key, { count, lastError });
  }
}

/**
 * Load persisted fail counts from the DB into the in-memory map on server
 * boot, so consecutive-failure streaks survive restarts. Merges DB entries
 * into the map without overwriting any values already present (safe to call
 * before the first sweep tick). Best-effort — a failure is logged and the
 * sweep continues with whatever the in-memory map already holds.
 */
export async function initTrueUpFailCounts(): Promise<void> {
  try {
    const [row] = await db.select().from(walletSettingsTable).limit(1);
    if (!row?.trueUpFailCounts) return;
    for (const [key, val] of Object.entries(row.trueUpFailCounts)) {
      if (
        typeof val?.count === "number" &&
        val.count > 0 &&
        !trueUpFailCounts.has(key)
      ) {
        trueUpFailCounts.set(key, {
          count: val.count,
          lastError: val.lastError ?? null,
        });
      }
    }
  } catch (error) {
    logger.error({ err: error }, "Failed to load persisted true-up fail counts from DB");
  }
}

/**
 * Persist the current in-memory fail counts to the DB so they survive the
 * next server restart. Best-effort — a failure is logged and never throws.
 * Only writes when a wallet_settings row already exists; a missing row means
 * no wallet has been configured yet and counts are reset to zero anyway.
 */
async function saveTrueUpFailCounts(): Promise<void> {
  try {
    const payload = Object.fromEntries(trueUpFailCounts);
    const [row] = await db
      .select({ id: walletSettingsTable.id })
      .from(walletSettingsTable)
      .limit(1);
    if (!row) return; // no settings row yet — will persist on the next sweep tick after config is set
    await db
      .update(walletSettingsTable)
      .set({ trueUpFailCounts: payload })
      .where(eq(walletSettingsTable.id, row.id));
  } catch (error) {
    logger.error({ err: error }, "Failed to persist true-up fail counts to DB");
  }
}

/**
 * Startup sweep clearing the "Needs pricing" backlog left by the old exact
 * string match in `trueUpModel`: rows that stayed pending even though a
 * matching (case/whitespace-insensitively) price row existed, because the
 * true-up only ran when a price was SAVED. Re-checks every pending group
 * against the current catalog and trues up the ones that now have a price.
 *
 * Safe to run every boot: `trueUpModel` only touches rows with a NULL
 * `trueUpAt` and stamps them once processed, so nothing is ever trued up
 * twice, and groups still without a price are left pending untouched.
 * Best-effort — a failure is logged and never affects startup.
 *
 * Tracks consecutive per-group errors: after WALLET_TRUEUP_FAIL_ALERT_THRESHOLD
 * consecutive failures for the same group, a deduped superadmin alert is
 * raised. The alert auto-resolves when the group settles successfully.
 */
export async function sweepStuckPendingTrueUps(): Promise<void> {
  try {
    const pending = await listPendingPricedModels();
    // Track which group keys appeared this run so we can resolve alerts for
    // groups that are no longer pending (fully settled or newly cleared).
    const seenKeys = new Set<string>();
    for (const group of pending) {
      if (!group.model) continue;
      const kind =
        group.usageKind === "caption"
          ? ("text" as const)
          : group.usageKind === "image"
            ? ("image" as const)
            : group.usageKind === "video"
              ? ("video" as const)
              : null;
      if (!kind) continue;
      const groupKey = `${group.usageKind}:${group.model}`;
      seenKeys.add(groupKey);
      try {
        // Only invoke the true-up when the catalog actually has a price now;
        // trueUpModel itself would no-op safely, but this keeps the sweep
        // from doing per-row work for models still awaiting pricing.
        const price = await findModelPrice(kind, group.provider ?? "", group.model);
        if (!price) continue;
        const result = await trueUpModel({
          kind,
          provider: group.provider ?? price.provider,
          model: group.model,
        });
        if (result.rowsTruedUp > 0) {
          logger.info(
            { model: group.model, kind, rowsTruedUp: result.rowsTruedUp, netPaise: result.netPaise },
            "Trued up stuck pending wallet charges against the price catalog",
          );
          // Group settled — reset the failure counter and auto-resolve any
          // open alert so the banner clears and the dedupe re-arms.
          if (trueUpFailCounts.has(groupKey)) {
            trueUpFailCounts.delete(groupKey);
            await resolveWalletTrueUpFailingNotifications(group.usageKind, group.model);
          }
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(
          { err: error, model: group.model, usageKind: group.usageKind },
          "Failed to true up a stuck pending model",
        );
        // Accumulate the consecutive failure count for this group.
        const prev = trueUpFailCounts.get(groupKey) ?? { count: 0, lastError: null };
        const next = { count: prev.count + 1, lastError: msg };
        trueUpFailCounts.set(groupKey, next);
        if (next.count >= WALLET_TRUEUP_FAIL_ALERT_THRESHOLD) {
          await notifyWalletTrueUpFailing({
            usageKind: group.usageKind,
            model: group.model,
            provider: group.provider ?? null,
            failCount: next.count,
            lastError: next.lastError,
          });
        }
      }
    }
    // Resolve alerts for groups that disappeared from the pending list between
    // sweeps (e.g. settled by a concurrent top-up or a price re-save).
    for (const [groupKey, state] of trueUpFailCounts) {
      if (!seenKeys.has(groupKey) && state.count > 0) {
        const [usageKind, ...modelParts] = groupKey.split(":");
        const model = modelParts.join(":");
        trueUpFailCounts.delete(groupKey);
        await resolveWalletTrueUpFailingNotifications(usageKind, model);
      }
    }
    // Persist the updated fail counts so they survive a server restart. The
    // alert threshold then measures real cumulative failures, not just those
    // since the last boot. Awaited so the write completes before the sweep
    // resolves — a restart right after a failing tick must never silently
    // lose the just-incremented count. Best-effort — already wraps errors.
    await saveTrueUpFailCounts();
  } catch (error) {
    logger.error({ err: error }, "Stuck pending true-up sweep failed");
  }
}

// ---------- periodic true-up retry ----------

/**
 * How often the background retry re-checks pending estimated charges against
 * the price catalog. Overridable for tests. The retry exists so a true-up
 * that silently failed (or a price added while the fire-and-forget hook was
 * down) does not leave rows pending until the next boot or price re-save.
 */
export const TRUE_UP_RETRY_INTERVAL_MS = Number(
  process.env.TRUE_UP_RETRY_INTERVAL_MS ?? 15 * 60_000,
);

let trueUpRetryTimer: NodeJS.Timeout | null = null;
let trueUpRetryRunning = false;

/**
 * Start the periodic true-up retry. Each tick runs the same sweep as boot:
 * only pending groups whose model NOW has a catalog price are touched, the
 * per-invocation row cap and per-row locking in `trueUpModel` apply, and
 * failures are logged, never thrown. An overlap guard skips a tick while the
 * previous one is still running.
 */
export function startTrueUpRetrySweep(intervalMs = TRUE_UP_RETRY_INTERVAL_MS): void {
  if (trueUpRetryTimer) return;
  trueUpRetryTimer = setInterval(() => {
    if (trueUpRetryRunning) return;
    trueUpRetryRunning = true;
    void sweepStuckPendingTrueUps().finally(() => {
      trueUpRetryRunning = false;
    });
  }, intervalMs);
  trueUpRetryTimer.unref?.();
}

export function stopTrueUpRetrySweep(): void {
  if (trueUpRetryTimer) {
    clearInterval(trueUpRetryTimer);
    trueUpRetryTimer = null;
  }
}
