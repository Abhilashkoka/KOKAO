/**
 * Proactive re-verification of ad account connections (Meta + TikTok), so a
 * lost/revoked ads grant surfaces a Reconnect prompt on the Ads page (and a
 * tenant notification) BEFORE an owner tries to approve a scheduled change
 * and has it fail at apply time.
 *
 * Mirrors the social reverify contract used by the connection sweep:
 * - staleness-gated (force=false respects the shared REVERIFY_STALE_MS clock,
 *   so the sweep never hammers the ads APIs every cycle);
 * - flips a connection to failed only on a DEFINITIVE rejection (expired or
 *   revoked token, permissions gone, advertiser no longer granted) and fires
 *   a deduped tenant notification on a fresh verified -> failed transition;
 * - a transient/network failure only touches the "last checked" clock (so an
 *   API outage doesn't retry on every request) and rethrows for sweep
 *   error bookkeeping — the stored status is never falsely flipped.
 */
import { db, adAccountConnectionsTable, type AdAccountConnection } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { decryptJson } from "./secretCrypto";
import {
  MetaAdsApiError,
  readAdAccount,
  type MetaAdsCredentials,
} from "./metaAdsApi";
import { TiktokAdsApiError, readAdvertiser } from "./tiktokAdsApi";
import {
  notifyAdsConnectionFailed,
  resolveAdsConnectionNotifications,
} from "./notifications";
import { REVERIFY_STALE_MS } from "./socialReverify";

/** Ad platforms the background sweep re-verifies. */
export const AD_SWEEP_PLATFORMS = ["meta", "tiktok"] as const;
export type AdSweepPlatform = (typeof AD_SWEEP_PLATFORMS)[number];

export const ADS_CREDENTIALS_UNREADABLE_MESSAGE =
  "Stored ad account credentials could not be read. Reconnect the ad account.";

function isStale(verifiedAt: Date | null): boolean {
  if (!verifiedAt) return true;
  return Date.now() - verifiedAt.getTime() > REVERIFY_STALE_MS;
}

/**
 * A definitive rejection means the grant itself is dead: an auth failure
 * (expired/revoked token, permissions removed) on either platform, or TikTok
 * no longer returning the selected advertiser for this grant (the
 * advertiser-level access was revoked even though the token still works).
 */
function isDefinitiveRejection(err: unknown): boolean {
  if (err instanceof MetaAdsApiError) return err.authFailed;
  if (err instanceof TiktokAdsApiError) {
    return err.authFailed || err.status === 404;
  }
  return false;
}

async function loadConnection(
  tenantId: number,
  platform: AdSweepPlatform,
): Promise<AdAccountConnection | undefined> {
  return (
    await db
      .select()
      .from(adAccountConnectionsTable)
      .where(
        and(
          eq(adAccountConnectionsTable.tenantId, tenantId),
          eq(adAccountConnectionsTable.platform, platform),
        ),
      )
      .limit(1)
  )[0];
}

/** Persist the outcome of a live re-test onto the stored connection row. */
async function writeStatus(
  conn: AdAccountConnection,
  values: {
    verifyStatus: "verified" | "failed";
    verifyError: string | null;
    adAccountName?: string;
    currency?: string;
  },
): Promise<void> {
  await db
    .update(adAccountConnectionsTable)
    .set({
      verifyStatus: values.verifyStatus,
      verifyError: values.verifyError,
      verifiedAt: new Date(),
      ...(values.adAccountName ? { adAccountName: values.adAccountName } : {}),
      ...(values.currency ? { currency: values.currency } : {}),
    })
    .where(eq(adAccountConnectionsTable.id, conn.id));

  // Proactively notify the tenant the first time a previously-working ads
  // grant breaks, so the owner learns before a scheduled change fails.
  if (conn.verifyStatus !== "failed" && values.verifyStatus === "failed") {
    await notifyAdsConnectionFailed(
      conn.tenantId,
      conn.platform,
      values.verifyError ?? undefined,
    );
  }

  // The moment the grant verifies again, auto-dismiss any lingering
  // "ad account disconnected" banner for this platform.
  if (values.verifyStatus === "verified") {
    await resolveAdsConnectionNotifications(conn.tenantId, conn.platform);
  }
}

/**
 * Reset only the "last checked" clock after a transient failure, so an ads
 * API outage doesn't re-test every cycle yet never falsely flips a valid
 * grant to failed.
 */
async function touchChecked(conn: AdAccountConnection): Promise<void> {
  await db
    .update(adAccountConnectionsTable)
    .set({ verifiedAt: new Date() })
    .where(eq(adAccountConnectionsTable.id, conn.id));
}

export type AdReverifyOutcome =
  | { checked: false; reason: string }
  | { checked: true; verifyStatus: "verified" | "failed" };

/**
 * Re-verify one tenant's ad connection on one platform with a cheap
 * advertiser/ad-account read. Only fully connected rows (an ad account has
 * been selected and credentials are stored) are checked — a pending
 * selection has nothing meaningful to verify. Transient failures rethrow
 * after touching the staleness clock so the sweep can count them.
 */
export async function reverifyAdConnection(
  tenantId: number,
  platform: AdSweepPlatform,
  opts: { force?: boolean } = {},
): Promise<AdReverifyOutcome> {
  const conn = await loadConnection(tenantId, platform);
  if (!conn) return { checked: false, reason: "not_connected" };
  if (conn.status !== "connected" || !conn.adAccountId) {
    return { checked: false, reason: "pending_selection" };
  }
  if (!conn.encryptedCredentials) {
    return { checked: false, reason: "no_credentials" };
  }
  if (!opts.force && !isStale(conn.verifiedAt)) {
    return { checked: false, reason: "fresh" };
  }

  let token: string | null = null;
  try {
    token =
      decryptJson<MetaAdsCredentials>(conn.encryptedCredentials).accessToken ??
      null;
  } catch {
    token = null;
  }
  if (!token) {
    // Unreadable credentials are a definitive breakage: nothing this
    // connection does can succeed until the tenant reconnects.
    await writeStatus(conn, {
      verifyStatus: "failed",
      verifyError: ADS_CREDENTIALS_UNREADABLE_MESSAGE,
    });
    return { checked: true, verifyStatus: "failed" };
  }

  let info: { name?: string | null; currency?: string | null };
  try {
    info =
      platform === "meta"
        ? await readAdAccount(token, conn.adAccountId)
        : await readAdvertiser(token, conn.adAccountId);
  } catch (err) {
    if (isDefinitiveRejection(err)) {
      await writeStatus(conn, {
        verifyStatus: "failed",
        verifyError:
          err instanceof Error && err.message
            ? err.message
            : "The ad account connection is no longer valid.",
      });
      return { checked: true, verifyStatus: "failed" };
    }
    // Transient (network blip, 5xx, rate limit): don't touch the stored
    // status, just reset the staleness clock and let the sweep record it.
    await touchChecked(conn);
    throw err;
  }

  // Refresh the display name/currency alongside the verified flip so the
  // Ads page always shows current account metadata.
  await writeStatus(conn, {
    verifyStatus: "verified",
    verifyError: null,
    adAccountName: info.name ?? undefined,
    currency: info.currency ?? undefined,
  });
  return { checked: true, verifyStatus: "verified" };
}

/** Convenience helper for the Meta-specific connection check used by routes. */
export async function reverifyMetaAds(tenantId: number): Promise<void> {
  await reverifyAdConnection(tenantId, "meta");
}
