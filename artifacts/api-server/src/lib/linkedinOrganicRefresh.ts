import { db, connectedAccountsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { decryptJson, encryptJson } from "./secretCrypto";
import { getLinkedinAppCredentials, linkedinTokenUrl } from "./linkedinApp";
import { platformFetch } from "./platformFetch";
import { logger } from "./logger";
import {
  notifySocialConnectionFailed,
  resolveSocialConnectionNotifications,
} from "./notifications";

/**
 * Silent ORGANIC LinkedIn token refresh (mirrors lib/linkedinAdsRefresh.ts,
 * which does the same for LinkedIn ADS connections).
 *
 * LinkedIn member access tokens expire after ~60 days, but the OAuth callback
 * also stores the programmatic refresh token (valid up to ~1 year) encrypted
 * on the connectedAccounts row. This module renews the access token BEFORE it
 * expires — proactively from the connection sweep and on-demand whenever the
 * connection is re-verified (Accounts page load / pre-publish) — so tenants
 * only ever see a reconnect prompt when the refresh token itself is dead
 * (expired, revoked, or LinkedIn definitively rejects it). Transient refresh
 * failures (network, 5xx) leave the connection untouched; the still-valid
 * access token keeps working and the next sweep retries.
 */

type AccountRow = typeof connectedAccountsTable.$inferSelect;

/** Shape of the encrypted credentials blob stored on the organic LinkedIn
 * connectedAccounts row. The access token itself lives in the row's
 * `accessToken`/`tokenExpiresAt` columns (pre-existing layout); only the
 * refresh token and its expiry live here. */
export interface LinkedinOrganicStoredCredentials {
  refreshToken?: string;
  /** Epoch ms when the refresh token itself expires (LinkedIn: ~1 year). */
  refreshTokenExpiresAt?: number;
}

/** Refresh when the access token expires within this window (7 days). The
 * sweep runs every 15 minutes, so this leaves ample retry room for transient
 * failures before the token actually lapses. */
export const LINKEDIN_ORGANIC_REFRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export const LINKEDIN_ORGANIC_RECONNECT_MESSAGE =
  "Your LinkedIn access token is no longer valid. Reconnect LinkedIn to keep publishing.";

function decryptStored(row: AccountRow): LinkedinOrganicStoredCredentials | null {
  if (!row.encryptedCredentials) return null;
  try {
    return decryptJson<LinkedinOrganicStoredCredentials>(
      row.encryptedCredentials,
    );
  } catch {
    return null;
  }
}

/**
 * Whether this connection's access token is due for a refresh: LinkedIn
 * platform, still holds an access token, has a stored refresh token, and the
 * access token expires within the refresh window (or its expiry is unknown
 * but the row was flagged failed — a refresh attempt might silently revive
 * it).
 */
export function linkedinOrganicRefreshDue(
  row: AccountRow,
  now = Date.now(),
): boolean {
  if (row.platform !== "linkedin") return false;
  if (!row.accessToken || row.status === "disconnected") return false;
  const stored = decryptStored(row);
  if (!stored?.refreshToken) return false;
  if (row.tokenExpiresAt === null) {
    // No recorded expiry — only refresh when the row already failed, where a
    // silent revive is worth attempting.
    return row.verifyStatus === "failed";
  }
  return row.tokenExpiresAt.getTime() - now <= LINKEDIN_ORGANIC_REFRESH_WINDOW_MS;
}

/** True when the stored refresh token is itself past its recorded expiry. */
function refreshTokenExpired(
  stored: LinkedinOrganicStoredCredentials,
  now = Date.now(),
): boolean {
  return (
    stored.refreshTokenExpiresAt != null && stored.refreshTokenExpiresAt <= now
  );
}

export type LinkedinOrganicRefreshOutcome =
  | "not_due"
  | "refreshed"
  | "invalid"
  | "transient";

/**
 * Refresh the connection's LinkedIn access token if it is due. Never throws.
 *
 * Outcomes:
 * - "not_due": not LinkedIn / no refresh token / not yet due — untouched.
 * - "refreshed": new access token persisted to the row's token columns (and
 *   rotated refresh token re-encrypted when LinkedIn returns one); a
 *   previously failed row is restored to verified/connected and any lingering
 *   breakage notification is cleared.
 * - "invalid": the refresh token is definitively dead (HTTP 400/401, or past
 *   its own expiry with a lapsed access token) — the row is flipped to failed
 *   so the UI shows the reconnect prompt (deduped breakage notification on a
 *   fresh verified -> failed transition).
 * - "transient": network/5xx/unconfigured — nothing was changed; retried by
 *   the next sweep while the current access token is still valid.
 */
export async function maybeRefreshLinkedinOrganicToken(
  row: AccountRow,
): Promise<LinkedinOrganicRefreshOutcome> {
  if (!linkedinOrganicRefreshDue(row)) return "not_due";
  const stored = decryptStored(row);
  if (!stored?.refreshToken) return "not_due";

  const now = Date.now();
  if (refreshTokenExpired(stored, now)) {
    // The refresh token is dead. Only surface a reconnect prompt once the
    // access token has actually lapsed (or was already flagged failed) —
    // until then the connection still works.
    if (
      row.verifyStatus !== "failed" &&
      row.tokenExpiresAt !== null &&
      row.tokenExpiresAt.getTime() <= now
    ) {
      await markFailed(row, LINKEDIN_ORGANIC_RECONNECT_MESSAGE);
      return "invalid";
    }
    return "transient";
  }

  const attempt = await attemptRefresh(row, stored.refreshToken, stored);
  if (attempt === "dead") {
    await markFailed(row, LINKEDIN_ORGANIC_RECONNECT_MESSAGE);
    return "invalid";
  }
  return attempt === "renewed" ? "refreshed" : "transient";
}

/**
 * One token-exchange attempt against LinkedIn. Never throws.
 * - "renewed": the row's token columns were updated (and a previously failed
 *   row restored to verified).
 * - "dead": LinkedIn definitively rejected the refresh token (400/401).
 * - "transient": network/5xx/unconfigured — nothing was changed.
 */
async function attemptRefresh(
  row: AccountRow,
  refreshToken: string,
  stored: LinkedinOrganicStoredCredentials,
): Promise<"renewed" | "dead" | "transient"> {
  const now = Date.now();
  const app = await getLinkedinAppCredentials();
  if (!app) return "transient"; // App creds unconfigured.

  let res: Response;
  try {
    res = await platformFetch(linkedinTokenUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: app.clientId,
        client_secret: app.clientSecret,
      }).toString(),
    });
  } catch (err) {
    logger.warn(
      { err, accountId: row.id, tenantId: row.tenantId },
      "LinkedIn organic token refresh failed (transient); will retry",
    );
    return "transient";
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
    const updated: LinkedinOrganicStoredCredentials = {
      // LinkedIn may rotate the refresh token; keep the old one otherwise.
      refreshToken: json.refresh_token ?? refreshToken,
      refreshTokenExpiresAt:
        json.refresh_token != null && json.refresh_token_expires_in != null
          ? now + json.refresh_token_expires_in * 1000
          : stored.refreshTokenExpiresAt,
    };
    await db
      .update(connectedAccountsTable)
      .set({
        accessToken: json.access_token,
        tokenExpiresAt:
          json.expires_in != null
            ? new Date(now + json.expires_in * 1000)
            : null,
        encryptedCredentials: encryptJson(updated),
        // A successful refresh proves the connection is alive — clear any
        // stale failed flag so the reconnect prompt goes away.
        status: "connected",
        verifyStatus: "verified",
        verifyError: null,
        verifiedAt: new Date(),
      })
      .where(eq(connectedAccountsTable.id, row.id));
    await resolveSocialConnectionNotifications(row.tenantId, "linkedin");
    logger.info(
      { accountId: row.id, tenantId: row.tenantId },
      "LinkedIn organic access token refreshed",
    );
    return "renewed";
  }

  if (res.status === 400 || res.status === 401) {
    // Definitive rejection (invalid_grant / revoked) — the refresh token is
    // dead, so the tenant genuinely has to reconnect.
    logger.warn(
      {
        accountId: row.id,
        tenantId: row.tenantId,
        status: res.status,
        error: json.error,
      },
      "LinkedIn organic refresh token rejected",
    );
    return "dead";
  }

  // 5xx / rate limit / anything else: transient, retry next sweep.
  logger.warn(
    { accountId: row.id, tenantId: row.tenantId, status: res.status },
    "LinkedIn organic token refresh failed (transient); will retry",
  );
  return "transient";
}

/**
 * Gate for a live LinkedIn auth failure (401/403 from the userinfo probe or a
 * publish call). The reconnect prompt must only appear when the REFRESH TOKEN
 * is dead, so instead of immediately flipping the row to failed this makes
 * one last refresh attempt (mirrors handleLinkedinAdsAuthFailure):
 * - "refreshed": the token was merely stale; credentials are renewed and the
 *   row stays healthy.
 * - "invalid": refresh definitively rejected, refresh token expired, or no
 *   refresh token stored at all — the row is marked failed (genuine
 *   reconnect needed) with the deduped breakage notification.
 * - "transient": refresh failed transiently — the row is left untouched so
 *   the next sweep retries.
 * Never throws.
 */
export async function handleLinkedinOrganicAuthFailure(
  row: AccountRow,
  message: string,
): Promise<Exclude<LinkedinOrganicRefreshOutcome, "not_due">> {
  try {
    const stored = decryptStored(row);
    if (!stored?.refreshToken || refreshTokenExpired(stored)) {
      await markFailed(row, message);
      return "invalid";
    }
    const attempt = await attemptRefresh(row, stored.refreshToken, stored);
    if (attempt === "dead") {
      await markFailed(row, message);
      return "invalid";
    }
    if (attempt === "transient") {
      logger.warn(
        { accountId: row.id, tenantId: row.tenantId },
        "LinkedIn organic auth failure with transient refresh failure; not marking failed",
      );
      return "transient";
    }
    return "refreshed";
  } catch (err) {
    logger.error(
      { err, accountId: row.id, tenantId: row.tenantId },
      "LinkedIn organic auth-failure handling crashed",
    );
    return "transient";
  }
}

/** Flip the row to failed and fire the deduped breakage notification on a
 * fresh verified -> failed transition (same contract as socialReverify). */
async function markFailed(row: AccountRow, message: string): Promise<void> {
  await db
    .update(connectedAccountsTable)
    .set({
      status: "error",
      verifyStatus: "failed",
      verifyError: message,
      verifiedAt: new Date(),
    })
    .where(eq(connectedAccountsTable.id, row.id));
  if (row.verifyStatus === "verified") {
    await notifySocialConnectionFailed(row.tenantId, "linkedin", message);
  }
}
