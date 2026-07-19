import { db, adAccountConnectionsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { decryptJson } from "./secretCrypto";
import {
  MetaAdsApiError,
  readAdAccount,
  type MetaAdsCredentials,
} from "./metaAdsApi";
import { REVERIFY_STALE_MS } from "./socialReverify";
import {
  notifyAdsConnectionFailed,
  resolveAdsConnectionNotifications,
} from "./notifications";

/**
 * Background re-verification of a tenant's Meta Ads connection, mirroring the
 * social-connection reverify helpers so the connection sweep can keep ad
 * account tokens honest too. Long-lived Meta tokens expire (~60 days), and
 * without this a tenant only learns at approval time.
 *
 * Semantics (identical to socialReverify):
 * - Staleness-gated: skips when the last check is fresher than
 *   REVERIFY_STALE_MS unless `force` is set, so bursts never hammer Graph.
 * - Only a DEFINITIVE auth rejection (MetaAdsApiError.authFailed, or
 *   undecryptable stored credentials) flips the row to failed; transient
 *   errors (network, 5xx, rate limits) only touch the checked clock so a Meta
 *   outage never falsely kills a valid token.
 * - A fresh verified -> failed transition fires the deduped
 *   notifyAdsConnectionFailed; a successful re-check auto-resolves any
 *   lingering breakage notification.
 */
export interface AdsReverifyOutcome {
  checked: boolean;
  verifyStatus: "verified" | "failed" | null;
}

type AdConnectionRow = typeof adAccountConnectionsTable.$inferSelect;

function isStale(verifiedAt: Date | null): boolean {
  if (!verifiedAt) return true;
  return Date.now() - verifiedAt.getTime() > REVERIFY_STALE_MS;
}

export async function reverifyMetaAds(
  tenantId: number,
  force = false,
): Promise<AdsReverifyOutcome> {
  const row: AdConnectionRow | undefined = (
    await db
      .select()
      .from(adAccountConnectionsTable)
      .where(
        and(
          eq(adAccountConnectionsTable.tenantId, tenantId),
          eq(adAccountConnectionsTable.platform, "meta"),
        ),
      )
      .limit(1)
  )[0];

  // Nothing verifiable yet: no row, no stored token, or the tenant hasn't
  // picked an ad account (pending_selection rows have no target to read).
  if (!row || !row.encryptedCredentials || !row.adAccountId) {
    return { checked: false, verifyStatus: (row?.verifyStatus ?? null) as AdsReverifyOutcome["verifyStatus"] };
  }
  if (!force && !isStale(row.verifiedAt)) {
    return { checked: false, verifyStatus: (row.verifyStatus ?? null) as AdsReverifyOutcome["verifyStatus"] };
  }

  let token: string | null = null;
  try {
    token = decryptJson<MetaAdsCredentials>(row.encryptedCredentials).accessToken ?? null;
  } catch {
    token = null;
  }
  if (!token) {
    await writeFailed(row, "The stored Meta Ads credentials could not be read. Reconnect the account.");
    return { checked: true, verifyStatus: "failed" };
  }

  try {
    const info = await readAdAccount(token, row.adAccountId);
    await db
      .update(adAccountConnectionsTable)
      .set({
        verifyStatus: "verified",
        verifyError: null,
        verifiedAt: new Date(),
        adAccountName: info.name,
        currency: info.currency,
      })
      .where(eq(adAccountConnectionsTable.id, row.id));
    // The moment the connection verifies again, auto-dismiss any lingering
    // breakage banner (also re-arms the notification dedupe).
    await resolveAdsConnectionNotifications(row.tenantId, row.platform);
    return { checked: true, verifyStatus: "verified" };
  } catch (err) {
    if (err instanceof MetaAdsApiError && err.authFailed) {
      // Definitive rejection: the token is expired/revoked or lost its
      // permissions. Flip to failed so the UI shows the reconnect prompt.
      await writeFailed(row, err.message);
      return { checked: true, verifyStatus: "failed" };
    }
    // Transient (network, 5xx, rate limit): only reset the checked clock so
    // an outage doesn't re-test on every sweep, without falsely flipping a
    // valid token to failed.
    await db
      .update(adAccountConnectionsTable)
      .set({ verifiedAt: new Date() })
      .where(eq(adAccountConnectionsTable.id, row.id));
    throw err;
  }
}

/** Persist a definitive failure and notify on a fresh verified -> failed flip. */
async function writeFailed(row: AdConnectionRow, error: string): Promise<void> {
  await db
    .update(adAccountConnectionsTable)
    .set({ verifyStatus: "failed", verifyError: error, verifiedAt: new Date() })
    .where(eq(adAccountConnectionsTable.id, row.id));
  // Proactively notify the tenant the first time a previously-good connection
  // breaks, so they can reconnect before an approval fails.
  if (row.verifyStatus === "verified") {
    await notifyAdsConnectionFailed(row.tenantId, row.platform, error);
  }
}
