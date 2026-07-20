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
  GoogleAdsApiError,
  getGoogleAdsAuth,
  readCustomer,
} from "./googleAdsApi";
import {
  LinkedinAdsApiError,
  readLinkedinAdAccount,
  type LinkedinAdsCredentials,
} from "./linkedinAdsApi";
import { maybeRefreshLinkedinAdsToken, handleLinkedinAdsAuthFailure } from "./linkedinAdsRefresh";
import {
  notifyAdsConnectionFailed,
  resolveAdsConnectionNotifications,
} from "./notifications";
import { REVERIFY_STALE_MS } from "./socialReverify";

/** Ad platforms the background sweep re-verifies. */
export const AD_SWEEP_PLATFORMS = ["meta", "tiktok", "google", "linkedin"] as const;
export type AdSweepPlatform = (typeof AD_SWEEP_PLATFORMS)[number];

export const ADS_CREDENTIALS_UNREADABLE_MESSAGE =
  "Stored ad account credentials could not be read. Reconnect the ad account.";

export const LINKEDIN_ADS_TOKEN_EXPIRED_MESSAGE =
  "LinkedIn sign-in expired. Reconnect LinkedIn Ads to continue.";

function isStale(verifiedAt: Date | null): boolean {
  if (!verifiedAt) return true;
  return Date.now() - verifiedAt.getTime() > REVERIFY_STALE_MS;
}

/**
 * A definitive rejection means the grant itself is dead: an auth failure
 * (expired/revoked token, permissions removed) on either platform, or TikTok
 * no longer returning the selected advertiser for this grant (the
 * advertiser-level access was revoked even though the token still works).
 * For Google, authFailed covers a revoked refresh token (invalid_grant on
 * the token exchange), unreadable stored credentials, and lost account
 * access (401/403/UNAUTHENTICATED/PERMISSION_DENIED).
 */
function isDefinitiveRejection(err: unknown): boolean {
  if (err instanceof MetaAdsApiError) return err.authFailed;
  if (err instanceof TiktokAdsApiError) {
    return err.authFailed || err.status === 404;
  }
  if (err instanceof GoogleAdsApiError) return err.authFailed;
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

  // LinkedIn tokens are timestamp-expiring and silently refreshable, so the
  // LinkedIn check has its own flow (refresh-then-probe) instead of the
  // shared bearer-token path below.
  if (platform === "linkedin") {
    return await reverifyLinkedinAdsConnection(conn);
  }

  // Google credentials store a refresh token, not a bearer access token —
  // getGoogleAdsAuth handles decryption + token refresh itself and throws a
  // GoogleAdsApiError with authFailed on unreadable creds or a revoked
  // grant, which the shared catch below classifies as definitive.
  let token: string | null = null;
  if (platform !== "google") {
    try {
      token =
        decryptJson<MetaAdsCredentials>(conn.encryptedCredentials)
          .accessToken ?? null;
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
  }

  let info: { name?: string | null; currency?: string | null };
  try {
    if (platform === "google") {
      // Aliveness probe = refresh-token exchange (invalid_grant = revoked)
      // + a cheap customer read (the grant can still see the account).
      const auth = await getGoogleAdsAuth(conn);
      info = await readCustomer(auth);
    } else {
      info =
        platform === "meta"
          ? await readAdAccount(token!, conn.adAccountId)
          : await readAdvertiser(token!, conn.adAccountId);
    }
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

/**
 * LinkedIn-specific check. LinkedIn access tokens are timestamp-expiring
 * (~60 days) with a silent programmatic refresh, so the flow is:
 * 1. Give the silent refresher a chance first (it may renew the token, or
 *    definitively mark the row failed when the refresh token is dead).
 * 2. A stored expiry in the past after that chance is a definitive failure
 *    with no live call needed (mirrors the organic LinkedIn reverify).
 * 3. Otherwise probe with a cheap ad-account read. An auth failure on the
 *    probe goes through the shared refresh gate (never flips the row on a
 *    401 alone) — only a dead refresh token demotes the connection.
 */
async function reverifyLinkedinAdsConnection(
  conn: AdAccountConnection,
): Promise<AdReverifyOutcome> {
  // Silent refresh first; never throws. It may renew the credentials, or
  // mark the row failed when the refresh token is definitively dead.
  conn = await maybeRefreshLinkedinAdsToken(conn);

  let creds: LinkedinAdsCredentials | null = null;
  try {
    creds = conn.encryptedCredentials
      ? decryptJson<LinkedinAdsCredentials>(conn.encryptedCredentials)
      : null;
  } catch {
    creds = null;
  }
  if (!creds?.accessToken) {
    await writeStatus(conn, {
      verifyStatus: "failed",
      verifyError: ADS_CREDENTIALS_UNREADABLE_MESSAGE,
    });
    return { checked: true, verifyStatus: "failed" };
  }

  // Timestamp-expired token that the refresher couldn't (or had no refresh
  // token to) renew: definitive, no live call needed.
  if (creds.expiresAt != null && creds.expiresAt <= Date.now()) {
    await writeStatus(conn, {
      verifyStatus: "failed",
      verifyError: LINKEDIN_ADS_TOKEN_EXPIRED_MESSAGE,
    });
    return { checked: true, verifyStatus: "failed" };
  }

  let info: { name?: string | null; currency?: string | null };
  try {
    info = await readLinkedinAdAccount(creds.accessToken, conn.adAccountId!);
  } catch (err) {
    if (err instanceof LinkedinAdsApiError && err.authFailed) {
      // A 401/403 alone must never demote the row — force one refresh
      // attempt and only mark failed on definitive refresh-token death.
      await handleLinkedinAdsAuthFailure(conn, err.message);
      const after = await loadConnection(conn.tenantId, "linkedin");
      if (after?.verifyStatus === "failed") {
        return { checked: true, verifyStatus: "failed" };
      }
      if (
        after &&
        after.verifyStatus === "verified" &&
        after.encryptedCredentials !== conn.encryptedCredentials
      ) {
        // The gate renewed the token — the grant is alive; the probe merely
        // raced a stale access token.
        return { checked: true, verifyStatus: "verified" };
      }
      // Transient refresh failure: reset the clock and let the sweep count it.
      await touchChecked(conn);
      throw err;
    }
    // Transient (network blip, 5xx, rate limit): same contract as the
    // shared path — touch the clock, rethrow for sweep bookkeeping.
    await touchChecked(conn);
    throw err;
  }

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
