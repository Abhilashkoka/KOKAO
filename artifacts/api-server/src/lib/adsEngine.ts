import {
  db,
  adsSettingsTable,
  adAccountConnectionsTable,
  adChangeRequestsTable,
  adsChangeLogsTable,
  type AdAccountConnection,
  type AdChangeRequest,
  type AdChangeField,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { decryptJson } from "./secretCrypto";
import { isMetaAppConfigured } from "./metaApi";
import {
  MetaAdsApiError,
  createCampaign,
  getCampaign,
  readObjectState,
  updateObject,
  type MetaAdsCredentials,
} from "./metaAdsApi";
import { tryAcquireResendLock } from "./resendLock";
import { notifyAdsChangeApplied, notifyAdsChangeFailed } from "./notifications";
import { logger } from "./logger";

/**
 * Shared draft-and-approve pipeline for the paid-media module.
 *
 * Safety model:
 * - Every write is first captured as a DRAFT with a human-readable
 *   before/after diff and a snapshot of the remote object's current state.
 * - Nothing touches the ad platform until the workspace OWNER approves.
 * - Apply is idempotent: the draft row's status is claimed atomically
 *   (draft → approved via a status-guarded UPDATE), an in-process lock stops
 *   truly simultaneous requests, and a unique idempotency key blocks
 *   duplicate drafts from retried creations.
 * - At apply time the remote state is re-read and compared with the draft's
 *   snapshot; if the object changed since the draft was made, the draft
 *   EXPIRES instead of applying a stale change.
 * - After the platform write, remote state is read back and verified to
 *   match; every outcome lands in the append-only change log.
 */

// ---------------------------------------------------------------------------
// Module settings (global switch) and platform availability
// ---------------------------------------------------------------------------

export async function getAdsModuleEnabled(): Promise<boolean> {
  const row = (await db.select().from(adsSettingsTable).limit(1))[0];
  return row ? row.enabled : true;
}

export async function setAdsModuleEnabled(enabled: boolean): Promise<void> {
  const row = (await db.select().from(adsSettingsTable).limit(1))[0];
  if (row) {
    await db
      .update(adsSettingsTable)
      .set({ enabled, updatedAt: new Date() })
      .where(eq(adsSettingsTable.id, row.id));
  } else {
    await db.insert(adsSettingsTable).values({ enabled });
  }
}

export interface AdsPlatformAvailability {
  platform: string;
  available: boolean;
  reason: string | null;
}

/** Platforms the ads module knows about; only Meta is live so far. */
export async function getAdsPlatformAvailability(): Promise<AdsPlatformAvailability[]> {
  const metaConfigured = await isMetaAppConfigured();
  return [
    {
      platform: "meta",
      available: metaConfigured,
      reason: metaConfigured
        ? null
        : "Meta Ads is not yet available. The platform's Meta app credentials have not been configured.",
    },
    { platform: "google", available: false, reason: "Google Ads is not yet available." },
    { platform: "linkedin", available: false, reason: "LinkedIn Ads is not yet available." },
    { platform: "tiktok", available: false, reason: "TikTok Ads is not yet available." },
  ];
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

export async function getAdConnection(
  tenantId: number,
  connectionId: number,
): Promise<AdAccountConnection | null> {
  const row = (
    await db
      .select()
      .from(adAccountConnectionsTable)
      .where(
        and(
          eq(adAccountConnectionsTable.id, connectionId),
          eq(adAccountConnectionsTable.tenantId, tenantId),
        ),
      )
      .limit(1)
  )[0];
  return row ?? null;
}

export function getConnectionToken(conn: AdAccountConnection): string | null {
  if (!conn.encryptedCredentials) return null;
  try {
    return decryptJson<MetaAdsCredentials>(conn.encryptedCredentials).accessToken ?? null;
  } catch {
    return null;
  }
}

/** Flip a connection to failed so the UI shows a reconnect prompt. */
export async function markAdConnectionFailed(
  connectionId: number,
  error: string,
): Promise<void> {
  await db
    .update(adAccountConnectionsTable)
    .set({ verifyStatus: "failed", verifyError: error, verifiedAt: new Date() })
    .where(eq(adAccountConnectionsTable.id, connectionId));
}

// ---------------------------------------------------------------------------
// Diff helpers
// ---------------------------------------------------------------------------

export interface RemoteSnapshot {
  name: string;
  status: string;
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  startTime: string | null;
  stopTime: string | null;
}

function fmtBudget(minor: number | null): string | null {
  return minor == null ? null : String(minor);
}

/** Build the human-readable before/after diff for an update draft. */
export function buildUpdateDiff(
  before: RemoteSnapshot,
  proposed: {
    name?: string;
    status?: string;
    dailyBudget?: number | null;
    lifetimeBudget?: number | null;
    startTime?: string | null;
    stopTime?: string | null;
  },
): AdChangeField[] {
  const fields: AdChangeField[] = [];
  if (proposed.name != null && proposed.name !== before.name) {
    fields.push({ field: "Name", before: before.name, after: proposed.name });
  }
  if (proposed.status != null && proposed.status !== before.status) {
    fields.push({ field: "Status", before: before.status, after: proposed.status });
  }
  if (proposed.dailyBudget != null && proposed.dailyBudget !== before.dailyBudget) {
    fields.push({
      field: "Daily budget (minor units)",
      before: fmtBudget(before.dailyBudget),
      after: fmtBudget(proposed.dailyBudget),
    });
  }
  if (proposed.lifetimeBudget != null && proposed.lifetimeBudget !== before.lifetimeBudget) {
    fields.push({
      field: "Lifetime budget (minor units)",
      before: fmtBudget(before.lifetimeBudget),
      after: fmtBudget(proposed.lifetimeBudget),
    });
  }
  if (proposed.startTime != null && proposed.startTime !== before.startTime) {
    fields.push({ field: "Start time", before: before.startTime, after: proposed.startTime });
  }
  if (proposed.stopTime != null && proposed.stopTime !== before.stopTime) {
    fields.push({ field: "End time", before: before.stopTime, after: proposed.stopTime });
  }
  return fields;
}

export function buildCreateDiff(proposed: {
  name: string;
  objective?: string | null;
  status: string;
  dailyBudget?: number | null;
  lifetimeBudget?: number | null;
  startTime?: string | null;
  stopTime?: string | null;
}): AdChangeField[] {
  const fields: AdChangeField[] = [
    { field: "Name", before: null, after: proposed.name },
    { field: "Status", before: null, after: proposed.status },
  ];
  if (proposed.objective) {
    fields.push({ field: "Objective", before: null, after: proposed.objective });
  }
  if (proposed.dailyBudget != null) {
    fields.push({ field: "Daily budget (minor units)", before: null, after: String(proposed.dailyBudget) });
  }
  if (proposed.lifetimeBudget != null) {
    fields.push({ field: "Lifetime budget (minor units)", before: null, after: String(proposed.lifetimeBudget) });
  }
  if (proposed.startTime) fields.push({ field: "Start time", before: null, after: proposed.startTime });
  if (proposed.stopTime) fields.push({ field: "End time", before: null, after: proposed.stopTime });
  return fields;
}

/** The snapshot fields a draft compares at apply time (drift detection). */
export function snapshotForCompare(s: RemoteSnapshot): Record<string, unknown> {
  return {
    name: s.name,
    status: s.status,
    dailyBudget: s.dailyBudget,
    lifetimeBudget: s.lifetimeBudget,
    startTime: s.startTime,
    stopTime: s.stopTime,
  };
}

function snapshotsMatch(
  a: Record<string, unknown> | null | undefined,
  b: Record<string, unknown>,
): boolean {
  if (!a) return true;
  for (const key of Object.keys(b)) {
    if (key in a && JSON.stringify(a[key]) !== JSON.stringify(b[key])) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Apply pipeline
// ---------------------------------------------------------------------------

export const ADS_APPLY_IN_PROGRESS_MESSAGE =
  "This change is already being applied. Wait a moment for it to finish, then check the result.";

interface ApplyPayload {
  name?: string;
  objective?: string;
  status?: "ACTIVE" | "PAUSED";
  dailyBudget?: number | null;
  lifetimeBudget?: number | null;
  startTime?: string | null;
  stopTime?: string | null;
}

async function loadDraft(tenantId: number, draftId: number): Promise<AdChangeRequest | null> {
  const row = (
    await db
      .select()
      .from(adChangeRequestsTable)
      .where(
        and(
          eq(adChangeRequestsTable.id, draftId),
          eq(adChangeRequestsTable.tenantId, tenantId),
        ),
      )
      .limit(1)
  )[0];
  return row ?? null;
}

async function recordChangeLog(
  draft: AdChangeRequest,
  outcome: "applied" | "failed",
  opts: {
    verifyStatus: string | null;
    failureReason: string | null;
    targetId: string | null;
    approvedByClerkUserId: string | null;
    approvedByEmail: string | null;
  },
): Promise<void> {
  try {
    await db.insert(adsChangeLogsTable).values({
      tenantId: draft.tenantId,
      changeRequestId: draft.id,
      platform: draft.platform,
      targetType: draft.targetType,
      targetId: opts.targetId,
      targetName: draft.targetName,
      action: draft.action,
      changes: draft.changes,
      outcome,
      verifyStatus: opts.verifyStatus,
      failureReason: opts.failureReason,
      approvedByClerkUserId: opts.approvedByClerkUserId,
      approvedByEmail: opts.approvedByEmail,
    });
  } catch (err) {
    // Append-only audit is best-effort; never fail the primary action.
    logger.error({ err, draftId: draft.id }, "Failed to write ads change log");
  }
}

export type ApplyResult =
  | { kind: "applied"; draft: AdChangeRequest }
  | { kind: "failed"; draft: AdChangeRequest }
  | { kind: "expired"; draft: AdChangeRequest }
  | { kind: "conflict" }
  | { kind: "not_found" }
  | { kind: "bad_status"; status: string };

/**
 * Approve and apply a draft. Owner-only enforcement happens at the route.
 * Idempotent: a draft already applied returns "bad_status" with its final
 * state; simultaneous applies are rejected by the lock + status claim.
 */
export async function approveAndApplyDraft(
  tenantId: number,
  draftId: number,
  approver: { clerkUserId: string; email: string | null },
): Promise<ApplyResult> {
  const release = tryAcquireResendLock("ads-apply", draftId);
  if (!release) return { kind: "conflict" };
  try {
    const draft = await loadDraft(tenantId, draftId);
    if (!draft) return { kind: "not_found" };
    if (draft.status !== "draft") return { kind: "bad_status", status: draft.status };

    // Atomic claim: only one request can flip draft → approved.
    const claimed = (
      await db
        .update(adChangeRequestsTable)
        .set({
          status: "approved",
          approvedByClerkUserId: approver.clerkUserId,
          approvedByEmail: approver.email,
          approvedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(adChangeRequestsTable.id, draft.id),
            eq(adChangeRequestsTable.status, "draft"),
          ),
        )
        .returning()
    )[0];
    if (!claimed) return { kind: "conflict" };

    const conn = await getAdConnection(tenantId, draft.connectionId);
    const token = conn ? getConnectionToken(conn) : null;
    if (!conn || !token || conn.status !== "connected") {
      return await finishFailed(claimed, "The ad account connection is missing or needs reconnecting.", approver);
    }

    const payload = (claimed.payload ?? {}) as ApplyPayload;

    try {
      if (claimed.action === "update") {
        if (!claimed.targetId) {
          return await finishFailed(claimed, "The draft has no target to update.", approver);
        }
        // Drift check: the remote object must still look like it did when the
        // draft was created, or the before/after preview the owner approved
        // is no longer truthful.
        const current = await readObjectState(token, claimed.targetId);
        if (!snapshotsMatch(claimed.beforeSnapshot, snapshotForCompare(current))) {
          const expired = (
            await db
              .update(adChangeRequestsTable)
              .set({
                status: "expired",
                failureReason:
                  "The campaign changed on the ad platform after this draft was created. Review the current state and create a fresh draft.",
                updatedAt: new Date(),
              })
              .where(eq(adChangeRequestsTable.id, claimed.id))
              .returning()
          )[0]!;
          return { kind: "expired", draft: expired };
        }

        await updateObject(token, claimed.targetId, {
          name: payload.name,
          status: payload.status,
          dailyBudget: payload.dailyBudget ?? undefined,
          lifetimeBudget: payload.lifetimeBudget ?? undefined,
          startTime: payload.startTime ?? undefined,
          stopTime: payload.stopTime ?? undefined,
        });

        // Post-apply verification: read back and confirm the fields we set.
        const verifyStatus = await verifyApplied(token, claimed.targetId, payload);
        return await finishApplied(claimed, claimed.targetId, verifyStatus, approver);
      }

      // Create (campaigns only in this phase).
      if (claimed.targetType !== "campaign") {
        return await finishFailed(claimed, "Only campaigns can be created in this phase.", approver);
      }
      const newId = await createCampaign(token, conn.adAccountId, {
        name: payload.name ?? claimed.targetName,
        objective: payload.objective ?? "OUTCOME_TRAFFIC",
        status: payload.status ?? "PAUSED",
        dailyBudget: payload.dailyBudget ?? null,
        lifetimeBudget: payload.lifetimeBudget ?? null,
        startTime: payload.startTime ?? null,
        stopTime: payload.stopTime ?? null,
      });
      const verifyStatus = await verifyApplied(token, newId, payload);
      return await finishApplied(claimed, newId, verifyStatus, approver);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "The ad platform rejected the change.";
      if (err instanceof MetaAdsApiError && err.authFailed) {
        await markAdConnectionFailed(conn.id, message);
      }
      return await finishFailed(claimed, message, approver);
    }
  } finally {
    release();
  }
}

/**
 * Compare two schedule timestamps as instants; the platform may echo a
 * different textual offset/format than the one we sent.
 */
function timesEqual(a: string | null, b: string): boolean {
  if (a == null) return false;
  if (a === b) return true;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  return Number.isFinite(ta) && Number.isFinite(tb) && ta === tb;
}

/** Best-effort read-back verification that the applied fields stuck. */
async function verifyApplied(
  token: string,
  objectId: string,
  payload: ApplyPayload,
): Promise<string> {
  try {
    const state = await readObjectState(token, objectId);
    const mismatches: string[] = [];
    if (payload.name != null && state.name !== payload.name) mismatches.push("name");
    if (payload.status != null && state.status !== payload.status) mismatches.push("status");
    if (payload.dailyBudget != null && state.dailyBudget !== payload.dailyBudget) {
      mismatches.push("dailyBudget");
    }
    if (payload.lifetimeBudget != null && state.lifetimeBudget !== payload.lifetimeBudget) {
      mismatches.push("lifetimeBudget");
    }
    if (payload.startTime != null && !timesEqual(state.startTime, payload.startTime)) {
      mismatches.push("startTime");
    }
    if (payload.stopTime != null && !timesEqual(state.stopTime, payload.stopTime)) {
      mismatches.push("stopTime");
    }
    return mismatches.length === 0 ? "verified" : "mismatch";
  } catch {
    // The write landed; only the read-back failed. Not a failure.
    return "unverified";
  }
}

async function finishApplied(
  draft: AdChangeRequest,
  targetId: string,
  verifyStatus: string,
  approver: { clerkUserId: string; email: string | null },
): Promise<ApplyResult> {
  const updated = (
    await db
      .update(adChangeRequestsTable)
      .set({
        status: "applied",
        appliedAt: new Date(),
        resultTargetId: draft.action === "create" ? targetId : null,
        targetId,
        verifyStatus,
        failureReason: null,
        updatedAt: new Date(),
      })
      .where(eq(adChangeRequestsTable.id, draft.id))
      .returning()
  )[0]!;
  await recordChangeLog(draft, "applied", {
    verifyStatus,
    failureReason: null,
    targetId,
    approvedByClerkUserId: approver.clerkUserId,
    approvedByEmail: approver.email,
  });
  await notifyAdsChangeApplied(draft.tenantId, draft.targetName, draft.platform);
  return { kind: "applied", draft: updated };
}

async function finishFailed(
  draft: AdChangeRequest,
  reason: string,
  approver: { clerkUserId: string; email: string | null },
): Promise<ApplyResult> {
  const updated = (
    await db
      .update(adChangeRequestsTable)
      .set({ status: "failed", failureReason: reason, updatedAt: new Date() })
      .where(eq(adChangeRequestsTable.id, draft.id))
      .returning()
  )[0]!;
  await recordChangeLog(draft, "failed", {
    verifyStatus: null,
    failureReason: reason,
    targetId: draft.targetId,
    approvedByClerkUserId: approver.clerkUserId,
    approvedByEmail: approver.email,
  });
  await notifyAdsChangeFailed(draft.tenantId, draft.targetName, draft.platform, reason);
  return { kind: "failed", draft: updated };
}

// Re-export for routes that need the campaign read for draft creation.
export { getCampaign };
