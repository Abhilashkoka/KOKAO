import {
  db,
  adAccountConnectionsTable,
  type AdAccountConnection,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { decryptJson, encryptJson } from "./secretCrypto";
import { getLinkedinAppCredentials, LINKEDIN_TOKEN_URL } from "./linkedinApp";
import { platformFetch } from "./platformFetch";
import type { LinkedinAdsCredentials } from "./linkedinAdsApi";
import {
  notifyAdsConnectionFailed,
  resolveAdsConnectionNotifications,
} from "./notifications";
import { logger } from "./logger";

/**
 * Silent LinkedIn ads token refresh.
 *
 * LinkedIn member access tokens expire after ~60 days, but the OAuth callback
 * also stores the programmatic refresh token (valid up to ~1 year). This
 * module renews the access token BEFORE it expires — proactively from the
 * connection sweep and on-demand whenever a connection row is loaded for an
 * API call — so tenants only ever see a reconnect prompt when the refresh
 * token itself is dead (expired, revoked, or LinkedIn definitively rejects
 * it). Transient refresh failures (network, 5xx) leave the connection
 * untouched; the still-valid access token keeps working and the next sweep
 * retries.
 */

/** Refresh when the access token expires within this window (7 days). The
 * sweep runs every 15 minutes, so this leaves ample retry room for transient
 * failures before the token actually lapses. */
export const LINKEDIN_ADS_REFRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function decryptCreds(conn: AdAccountConnection): LinkedinAdsCredentials | null {
  if (!conn.encryptedCredentials) return null;
  try {
    return decryptJson<LinkedinAdsCredentials>(conn.encryptedCredentials);
  } catch {
    return null;
  }
}

/**
 * Whether this connection's access token is due for a refresh: LinkedIn
 * platform, has a refresh token, and the access token expires within the
 * refresh window (or its expiry is unknown but the row was flagged failed —
 * a refresh attempt might silently revive it).
 */
export function linkedinAdsRefreshDue(
  conn: AdAccountConnection,
  now = Date.now(),
): boolean {
  if (conn.platform !== "linkedin") return false;
  const creds = decryptCreds(conn);
  if (!creds?.refreshToken) return false;
  if (creds.expiresAt == null) {
    // No recorded expiry — only refresh when the row already failed, where a
    // silent revive is worth attempting.
    return conn.verifyStatus === "failed";
  }
  return creds.expiresAt - now <= LINKEDIN_ADS_REFRESH_WINDOW_MS;
}

/** True when the stored refresh token is itself past its recorded expiry. */
function refreshTokenExpired(
  creds: LinkedinAdsCredentials,
  now = Date.now(),
): boolean {
  return (
    creds.refreshTokenExpiresAt != null && creds.refreshTokenExpiresAt <= now
  );
}

/**
 * In-process serialization of refresh attempts per connection id. LinkedIn
 * may ROTATE the refresh token on each exchange; if two refreshes race (e.g.
 * sweep + a user request), the loser could persist the stale pre-rotation
 * token and later force an unnecessary reconnect. The API server runs as a
 * single process (same assumption as resendLock), so concurrent callers for
 * the same connection share one in-flight promise: exactly one token
 * exchange runs and every caller gets its result. The winner also re-reads
 * the row from the DB before exchanging, so a caller holding a stale
 * snapshot (taken before another refresh landed) sees the fresh credentials
 * and skips the exchange entirely.
 */
const inflightRefreshes = new Map<number, Promise<AdAccountConnection>>();

/**
 * Refresh the connection's LinkedIn access token if it is due. Returns the
 * (possibly updated) connection row. Never throws.
 *
 * Concurrent calls for the same connection are coalesced into a single token
 * exchange (see inflightRefreshes above).
 *
 * Outcomes:
 * - Not LinkedIn / no refresh token / not yet due → row returned unchanged.
 * - Refresh succeeds → credentials re-encrypted with the new access token
 *   (and rotated refresh token when LinkedIn returns one); a previously
 *   failed row is restored to verified since the connection is alive again.
 * - Refresh token definitively rejected (HTTP 400/401, e.g. invalid_grant)
 *   or already past its own expiry with a lapsed access token → the row is
 *   marked failed so the UI shows the reconnect prompt.
 * - Transient failure (network, 5xx) → row returned unchanged; retried by
 *   the next sweep while the current access token is still valid.
 */
export async function maybeRefreshLinkedinAdsToken(
  conn: AdAccountConnection,
): Promise<AdAccountConnection> {
  if (!linkedinAdsRefreshDue(conn)) return conn;

  const existing = inflightRefreshes.get(conn.id);
  if (existing) return existing;

  const run = (async () => {
    try {
      return await refreshSerialized(conn);
    } finally {
      inflightRefreshes.delete(conn.id);
    }
  })();
  inflightRefreshes.set(conn.id, run);
  return run;
}

/** The serialized body of maybeRefreshLinkedinAdsToken; runs at most once
 * concurrently per connection id. Re-reads the row first so a stale caller
 * snapshot never triggers a duplicate token exchange. */
async function refreshSerialized(
  snapshot: AdAccountConnection,
): Promise<AdAccountConnection> {
  let conn = snapshot;
  try {
    const fresh = (
      await db
        .select()
        .from(adAccountConnectionsTable)
        .where(
          and(
            eq(adAccountConnectionsTable.id, snapshot.id),
            eq(adAccountConnectionsTable.tenantId, snapshot.tenantId),
          ),
        )
        .limit(1)
    )[0];
    if (!fresh) return snapshot; // Row deleted meanwhile.
    conn = fresh;
  } catch (err) {
    logger.warn(
      { err, connectionId: snapshot.id, tenantId: snapshot.tenantId },
      "LinkedIn ads refresh pre-read failed; using caller snapshot",
    );
  }

  if (!linkedinAdsRefreshDue(conn)) return conn; // Another refresh already landed.
  const creds = decryptCreds(conn);
  if (!creds?.refreshToken) return conn;

  const now = Date.now();
  if (refreshTokenExpired(creds, now)) {
    // The refresh token is dead. Only surface a reconnect prompt once the
    // access token has actually lapsed (or was already flagged failed) —
    // until then the connection still works.
    if (
      conn.verifyStatus !== "failed" &&
      creds.expiresAt != null &&
      creds.expiresAt <= now
    ) {
      return await markFailed(
        conn,
        "LinkedIn sign-in expired. Reconnect LinkedIn Ads to continue.",
      );
    }
    return conn;
  }

  const attempt = await attemptRefresh(
    conn,
    creds as LinkedinAdsCredentials & { refreshToken: string },
  );
  if (attempt.outcome === "dead") {
    return await markFailed(
      conn,
      "LinkedIn sign-in expired. Reconnect LinkedIn Ads to continue.",
    );
  }
  return attempt.row;
}

/**
 * One token-exchange attempt against LinkedIn. Never throws.
 * - "renewed": credentials were re-encrypted and persisted (a previously
 *   failed row is restored to verified); `row` is the updated connection.
 * - "dead": LinkedIn definitively rejected the refresh token (400/401).
 * - "transient": network/5xx/unconfigured — nothing was changed.
 */
async function attemptRefresh(
  conn: AdAccountConnection,
  creds: LinkedinAdsCredentials & { refreshToken: string },
): Promise<{ outcome: "renewed" | "dead" | "transient"; row: AdAccountConnection }> {
  const now = Date.now();
  const app = await getLinkedinAppCredentials();
  if (!app) return { outcome: "transient", row: conn }; // App creds unconfigured.

  let res: Response;
  try {
    res = await platformFetch(LINKEDIN_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: creds.refreshToken,
        client_id: app.clientId,
        client_secret: app.clientSecret,
      }).toString(),
    });
  } catch (err) {
    logger.warn(
      { err, connectionId: conn.id, tenantId: conn.tenantId },
      "LinkedIn ads token refresh failed (transient); will retry",
    );
    return { outcome: "transient", row: conn };
  }

  let json: {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
    refresh_token_expires_in?: number;
    error?: string;
    error_description?: string;
  } = {};
  try {
    json = (await res.json()) as typeof json;
  } catch {
    // Non-JSON body; fall through on status alone.
  }

  if (res.ok && json.access_token) {
    const updated: LinkedinAdsCredentials = {
      accessToken: json.access_token,
      expiresAt:
        json.expires_in != null ? now + json.expires_in * 1000 : undefined,
      // LinkedIn may rotate the refresh token; keep the old one otherwise.
      refreshToken: json.refresh_token ?? creds.refreshToken,
      refreshTokenExpiresAt:
        json.refresh_token != null && json.refresh_token_expires_in != null
          ? now + json.refresh_token_expires_in * 1000
          : creds.refreshTokenExpiresAt,
    };
    const row = (
      await db
        .update(adAccountConnectionsTable)
        .set({
          encryptedCredentials: encryptJson(updated),
          // A successful refresh proves the connection is alive — clear any
          // stale failed flag so the reconnect prompt goes away.
          ...(conn.verifyStatus === "failed"
            ? { verifyStatus: "verified", verifyError: null }
            : {}),
          verifiedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(adAccountConnectionsTable.id, conn.id),
            eq(adAccountConnectionsTable.tenantId, conn.tenantId),
          ),
        )
        .returning()
    )[0];
    logger.info(
      { connectionId: conn.id, tenantId: conn.tenantId },
      "LinkedIn ads access token refreshed",
    );
    // A successful refresh proves the grant is alive again — auto-dismiss any
    // lingering "ad account disconnected" banner for this platform.
    if (conn.verifyStatus === "failed") {
      await resolveAdsConnectionNotifications(conn.tenantId, conn.platform);
    }
    return { outcome: "renewed", row: row ?? conn };
  }

  if (res.status === 400 || res.status === 401) {
    // Definitive rejection (invalid_grant / revoked) — the refresh token is
    // dead, so the tenant genuinely has to reconnect.
    logger.warn(
      {
        connectionId: conn.id,
        tenantId: conn.tenantId,
        status: res.status,
        error: json.error,
      },
      "LinkedIn ads refresh token rejected",
    );
    return { outcome: "dead", row: conn };
  }

  // 5xx / rate limit / anything else: transient, retry next sweep.
  logger.warn(
    { connectionId: conn.id, tenantId: conn.tenantId, status: res.status },
    "LinkedIn ads token refresh failed (transient); will retry",
  );
  return { outcome: "transient", row: conn };
}

/**
 * Gate for downstream LinkedIn API auth failures (401/403 on an ads call).
 * The reconnect prompt must only appear when the REFRESH TOKEN is dead, so
 * instead of immediately flipping the row to failed this makes one last
 * refresh attempt:
 * - Refresh succeeds → the token was merely stale; credentials are renewed
 *   and the row stays healthy (the caller's request still errors, but the
 *   retry will use the fresh token).
 * - Refresh definitively rejected, refresh token expired, or there is no
 *   refresh token at all → mark failed (genuine reconnect needed).
 * - Transient refresh failure → leave the row untouched; the sweep retries.
 * Never throws.
 */
export async function handleLinkedinAdsAuthFailure(
  conn: AdAccountConnection,
  message: string,
): Promise<void> {
  try {
    const creds = decryptCreds(conn);
    if (!creds?.refreshToken || refreshTokenExpired(creds)) {
      await markFailed(conn, message);
      return;
    }
    const attempt = await attemptRefresh(
      conn,
      creds as LinkedinAdsCredentials & { refreshToken: string },
    );
    if (attempt.outcome === "dead") {
      await markFailed(conn, message);
    } else if (attempt.outcome === "transient") {
      logger.warn(
        { connectionId: conn.id, tenantId: conn.tenantId },
        "LinkedIn ads auth failure with transient refresh failure; not marking failed",
      );
    }
    // "renewed": token refreshed successfully — connection is alive, no
    // reconnect prompt.
  } catch (err) {
    logger.error(
      { err, connectionId: conn.id, tenantId: conn.tenantId },
      "LinkedIn ads auth-failure handling crashed",
    );
  }
}

async function markFailed(
  conn: AdAccountConnection,
  error: string,
): Promise<AdAccountConnection> {
  const row = (
    await db
      .update(adAccountConnectionsTable)
      .set({ verifyStatus: "failed", verifyError: error, verifiedAt: new Date() })
      .where(eq(adAccountConnectionsTable.id, conn.id))
      .returning()
  )[0];
  // Proactively notify the tenant the first time a previously-working ads
  // grant breaks (deduped: repeated failures don't re-notify), mirroring the
  // shared ads reverify contract.
  if (conn.verifyStatus !== "failed") {
    await notifyAdsConnectionFailed(conn.tenantId, conn.platform, error);
  }
  return row ?? conn;
}

/**
 * Sweep hook: refresh every LinkedIn ads connection that is due. Each row is
 * handled independently; failures are logged and never abort the batch.
 * Returns how many rows were checked and how many refresh attempts errored
 * unexpectedly (bookkeeping errors — API rejections are handled inside
 * maybeRefreshLinkedinAdsToken and do not count here).
 */
export async function refreshDueLinkedinAdsTokens(): Promise<{
  checked: number;
  errors: number;
}> {
  let rows: AdAccountConnection[];
  try {
    rows = await db
      .select()
      .from(adAccountConnectionsTable)
      .where(eq(adAccountConnectionsTable.platform, "linkedin"));
  } catch (err) {
    logger.error({ err }, "Failed to list LinkedIn ads connections for refresh");
    return { checked: 0, errors: 1 };
  }
  let checked = 0;
  let errors = 0;
  for (const row of rows) {
    if (!linkedinAdsRefreshDue(row)) continue;
    checked += 1;
    try {
      await maybeRefreshLinkedinAdsToken(row);
    } catch (err) {
      errors += 1;
      logger.error(
        { err, connectionId: row.id, tenantId: row.tenantId },
        "LinkedIn ads token refresh crashed",
      );
    }
  }
  return { checked, errors };
}
