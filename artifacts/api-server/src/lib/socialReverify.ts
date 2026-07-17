import {
  db,
  connectedAccountsTable,
  appCredentialsTable,
  type YoutubeAppCredentials,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { decryptJson, encryptJson } from "./secretCrypto";
import { platformFetch } from "./platformFetch";
import {
  testFacebookCredentials,
  testInstagramCredentials,
  getTenantCredentials,
  type FacebookCredentials,
  type InstagramCredentials,
} from "./metaApi";
import {
  getTwitterAppCredentials,
  ensureFreshTwitterToken,
  testTwitterCredentials,
} from "./twitterApi";
import {
  notifySocialConnectionFailed,
  resolveSocialConnectionNotifications,
} from "./notifications";

/**
 * How long a stored credential's last verification stays "fresh" before an
 * automatic re-check is allowed. This is the rate limiter: the Accounts page
 * only re-tests against Meta when the previous check is older than this, so a
 * burst of page loads does not hammer the Graph API.
 */
export const REVERIFY_STALE_MS = 15 * 60 * 1000;

type AccountRow = typeof connectedAccountsTable.$inferSelect;

function isStale(verifiedAt: Date | null): boolean {
  if (!verifiedAt) return true;
  return Date.now() - verifiedAt.getTime() > REVERIFY_STALE_MS;
}

async function loadAccountRow(
  tenantId: number,
  platform: string,
): Promise<AccountRow | undefined> {
  return (
    await db
      .select()
      .from(connectedAccountsTable)
      .where(
        and(
          eq(connectedAccountsTable.tenantId, tenantId),
          eq(connectedAccountsTable.platform, platform),
        ),
      )
      .limit(1)
  )[0];
}

/** Persist the outcome of a live re-test onto the stored account row. */
async function writeStatus(
  row: AccountRow,
  values: {
    verifyStatus: "verified" | "failed";
    verifyError: string | null;
    accountName: string;
  },
): Promise<void> {
  await db
    .update(connectedAccountsTable)
    .set({
      status: values.verifyStatus === "verified" ? "connected" : "error",
      verifyStatus: values.verifyStatus,
      verifyError: values.verifyError,
      verifiedAt: new Date(),
      accountName: values.accountName,
    })
    .where(eq(connectedAccountsTable.id, row.id));

  // Proactively notify the tenant the first time a previously-good connection
  // breaks, so a user who isn't in the app learns about it before a post fails.
  if (row.verifyStatus === "verified" && values.verifyStatus === "failed") {
    await notifySocialConnectionFailed(
      row.tenantId,
      row.platform,
      values.verifyError ?? undefined,
    );
  }

  // The moment a connection verifies again, auto-dismiss any lingering
  // "connection failed" banner for this platform.
  if (values.verifyStatus === "verified") {
    await resolveSocialConnectionNotifications(row.tenantId, row.platform);
  }
}

/**
 * Reset only the "last checked" clock without touching the stored status. Used
 * after a transient/network failure so a Meta outage does not repeatedly
 * re-test on every page load, yet does not falsely flip a valid token to
 * "failed" either.
 */
async function touchChecked(row: AccountRow): Promise<void> {
  await db
    .update(connectedAccountsTable)
    .set({ verifiedAt: new Date() })
    .where(eq(connectedAccountsTable.id, row.id));
}

/**
 * Flip a tenant's stored account row to verifyStatus "failed" after a live
 * platform call rejected its token (e.g. a Graph auth error surfacing
 * mid-publish, in the window after the pre-publish re-verify passed).
 * Persists the failure and fires the breakage notification on a fresh
 * verified -> failed transition, exactly like a failed re-verify would.
 * Best-effort: no-ops when the row is missing.
 */
export async function markAccountVerifyFailed(
  tenantId: number,
  platform: string,
  message: string,
): Promise<void> {
  const row = await loadAccountRow(tenantId, platform);
  if (!row) return;
  await writeStatus(row, {
    verifyStatus: "failed",
    verifyError: message,
    accountName: row.accountName || platform,
  });
}

interface ReverifyOptions {
  /** Skip the staleness gate and always re-test (used right before publishing). */
  force?: boolean;
}

/**
 * Automatically re-verify a tenant's stored Facebook Page credentials against
 * the live Graph API when they have gone stale (or when forced). Persists the
 * fresh status so the UI immediately reflects an expired/revoked token. Never
 * throws — returns the latest row so callers can serialize it safely.
 */
export async function reverifyFacebook(
  tenantId: number,
  opts: ReverifyOptions = {},
): Promise<AccountRow | undefined> {
  const row = await loadAccountRow(tenantId, "facebook");
  if (!row?.encryptedCredentials) return row;
  if (!opts.force && !isStale(row.verifiedAt)) return row;

  let creds: FacebookCredentials;
  try {
    creds = decryptJson<FacebookCredentials>(row.encryptedCredentials);
  } catch {
    return row;
  }

  const test = await testFacebookCredentials(creds);
  if (!test.ok && test.transient) {
    await touchChecked(row);
    return loadAccountRow(tenantId, "facebook");
  }

  // The tenant stored a USER token that verification exchanged for the real
  // Page token — persist it so the very next publish uses the working token.
  if (test.ok && test.correctedCredentials) {
    await db
      .update(connectedAccountsTable)
      .set({ encryptedCredentials: encryptJson(test.correctedCredentials) })
      .where(eq(connectedAccountsTable.id, row.id));
  }

  await writeStatus(row, {
    verifyStatus: test.ok ? "verified" : "failed",
    verifyError: test.ok ? null : test.error ?? "Verification failed",
    accountName: test.accountName || row.accountName || "Facebook Page",
  });
  return loadAccountRow(tenantId, "facebook");
}

/**
 * Automatically re-verify a tenant's stored Instagram credentials. Instagram
 * publishing rides on the Facebook Page token, so this only runs when a
 * verified Facebook credential exists; otherwise the row is left untouched (the
 * UI surfaces the "connect Facebook first" state).
 */
export async function reverifyInstagram(
  tenantId: number,
  opts: ReverifyOptions = {},
): Promise<AccountRow | undefined> {
  const row = await loadAccountRow(tenantId, "instagram");
  if (!row?.encryptedCredentials) return row;
  if (!opts.force && !isStale(row.verifiedAt)) return row;

  const fb = await getTenantCredentials<FacebookCredentials>(
    tenantId,
    "facebook",
  );
  if (!fb || !fb.verified) return row;

  let creds: InstagramCredentials;
  try {
    creds = decryptJson<InstagramCredentials>(row.encryptedCredentials);
  } catch {
    return row;
  }

  const test = await testInstagramCredentials(creds, fb.creds.pageAccessToken);
  if (!test.ok && test.transient) {
    await touchChecked(row);
    return loadAccountRow(tenantId, "instagram");
  }

  await writeStatus(row, {
    verifyStatus: test.ok ? "verified" : "failed",
    verifyError: test.ok ? null : test.error ?? "Verification failed",
    accountName: test.accountName || row.accountName || "Instagram account",
  });
  return loadAccountRow(tenantId, "instagram");
}

const LINKEDIN_USERINFO_URL = "https://api.linkedin.com/v2/userinfo";

const LINKEDIN_TOKEN_INVALID_MESSAGE =
  "Your LinkedIn access token is no longer valid. Reconnect LinkedIn to keep publishing.";

/**
 * Proactively re-check a tenant's stored LinkedIn token against the live
 * userinfo endpoint when it has gone stale (or when forced). A token can be
 * revoked by the user before its stored expiry, so this catches breakage the
 * expiry timestamp alone would miss. On a definitive rejection the row flips
 * to "failed"/error so the UI prompts a reconnect and the tenant is notified
 * once; transient/network errors only reset the check clock and never flip a
 * still-valid connection. A token already expired by timestamp is flipped
 * (and notified) without spending a live call. Never throws.
 */
export async function reverifyLinkedin(
  tenantId: number,
  opts: ReverifyOptions = {},
): Promise<AccountRow | undefined> {
  const row = await loadAccountRow(tenantId, "linkedin");
  if (!row?.accessToken) return row;

  // Expired by timestamp — no live call needed to know it's dead. Flip a
  // previously-verified row to failed so the breakage notification fires even
  // for users who never load the Accounts page.
  if (row.tokenExpiresAt !== null && row.tokenExpiresAt.getTime() <= Date.now()) {
    if (row.verifyStatus === "verified") {
      await db
        .update(connectedAccountsTable)
        .set({
          status: "error",
          verifyStatus: "failed",
          verifyError: LINKEDIN_TOKEN_INVALID_MESSAGE,
          verifiedAt: new Date(),
        })
        .where(eq(connectedAccountsTable.id, row.id));
      await notifySocialConnectionFailed(
        tenantId,
        "linkedin",
        LINKEDIN_TOKEN_INVALID_MESSAGE,
      );
      return loadAccountRow(tenantId, "linkedin");
    }
    return row;
  }

  if (!opts.force && !isStale(row.verifiedAt)) return row;

  try {
    const userRes = await platformFetch(LINKEDIN_USERINFO_URL, {
      headers: { Authorization: `Bearer ${row.accessToken}` },
    });
    if (userRes.status === 401 || userRes.status === 403) {
      await db
        .update(connectedAccountsTable)
        .set({
          status: "error",
          verifyStatus: "failed",
          verifyError: LINKEDIN_TOKEN_INVALID_MESSAGE,
          verifiedAt: new Date(),
        })
        .where(eq(connectedAccountsTable.id, row.id));
      // Notify once when a previously-good connection first breaks.
      if (row.verifyStatus === "verified") {
        await notifySocialConnectionFailed(
          tenantId,
          "linkedin",
          LINKEDIN_TOKEN_INVALID_MESSAGE,
        );
      }
    } else if (userRes.ok) {
      await db
        .update(connectedAccountsTable)
        .set({
          status: "connected",
          verifyStatus: "verified",
          verifyError: null,
          verifiedAt: new Date(),
        })
        .where(eq(connectedAccountsTable.id, row.id));
      await resolveSocialConnectionNotifications(tenantId, "linkedin");
    } else {
      // Unexpected non-auth status: reset the clock, keep prior state.
      await touchChecked(row);
    }
  } catch {
    // Transient/network error: reset the clock, never flip a valid token.
    await touchChecked(row);
  }

  return loadAccountRow(tenantId, "linkedin");
}

/**
 * Automatically re-verify a tenant's stored X (Twitter) OAuth 2.0 connection.
 * Resolves a usable access token (refreshing when expired), then live-tests it
 * against the X API so a revoked/expired token flips to "failed" the moment the
 * Accounts page loads — instead of looking "Verified" until a publish fails.
 * Respects the staleness gate, treats transient X errors as non-fatal, and
 * never throws.
 */
export async function reverifyTwitter(
  tenantId: number,
  opts: ReverifyOptions = {},
): Promise<AccountRow | undefined> {
  const row = await loadAccountRow(tenantId, "twitter");
  if (!row?.encryptedCredentials || row.status === "disconnected") return row;
  if (!opts.force && !isStale(row.verifiedAt)) return row;

  const app = await getTwitterAppCredentials();
  if (!app) return row; // Cannot test without app-level client credentials.

  // Resolve a usable token (refreshing if needed). This persists a refreshed
  // token, or marks reconnect-needed on a failed refresh / expired-no-refresh.
  const tokenResult = await ensureFreshTwitterToken(tenantId, app);
  if (!tokenResult.ok) {
    if (tokenResult.reason === "not_connected") {
      return loadAccountRow(tenantId, "twitter");
    }
    // reconnect_required: the stored/refreshed token is dead. Persist a failed
    // status (idempotent) and notify on a fresh verified -> failed transition.
    await writeStatus(row, {
      verifyStatus: "failed",
      verifyError: tokenResult.message,
      accountName: row.accountName || "X account",
    });
    return loadAccountRow(tenantId, "twitter");
  }

  // Token resolved — confirm it actually works with a live identity read.
  const test = await testTwitterCredentials(tokenResult.accessToken);
  if (!test.ok && test.transient) {
    await touchChecked(row);
    return loadAccountRow(tenantId, "twitter");
  }

  await writeStatus(row, {
    verifyStatus: test.ok ? "verified" : "failed",
    verifyError: test.ok ? null : test.error ?? "Verification failed",
    accountName: test.ok ? test.accountName : row.accountName || "X account",
  });
  return loadAccountRow(tenantId, "twitter");
}

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

const THREADS_GRAPH_BASE = "https://graph.threads.net/v1.0";
const THREADS_REFRESH_URL = "https://graph.threads.net/refresh_access_token";

/** Refresh when a Threads long-lived token is within this window of expiry. */
export const THREADS_REFRESH_WHEN_REMAINING_MS = 7 * 24 * 60 * 60 * 1000;

const THREADS_TOKEN_INVALID_MESSAGE =
  "Your Threads access is no longer valid. Reconnect Threads to keep publishing.";

export type ThreadsRefreshOutcome =
  | "not_needed"
  | "refreshed"
  | "invalid"
  | "transient";

/**
 * SHARED Threads token-refresh core, used by BOTH the Accounts-page route
 * handlers (routes/threads.ts) and the background sweep (reverifyThreads) so
 * the two paths can never drift. Threads long-lived tokens last ~60 days and
 * roll on refresh; when the stored token is inside the renewal window (or
 * already expired), attempt a refresh:
 *   - success persists the rolled token as verified and clears any breakage
 *     notification ("refreshed");
 *   - a definitive refusal (already expired, or a 400/401 rejection) flips
 *     the row to failed with the deduped breakage notification ("invalid");
 *   - anything else leaves the stored state untouched ("transient") — the
 *     caller decides whether to reset the staleness clock.
 * Never throws.
 */
export async function maybeRefreshThreadsToken(
  row: AccountRow,
): Promise<ThreadsRefreshOutcome> {
  if (!row.accessToken || row.tokenExpiresAt === null) return "not_needed";
  const remaining = row.tokenExpiresAt.getTime() - Date.now();
  if (remaining > THREADS_REFRESH_WHEN_REMAINING_MS) return "not_needed";

  try {
    const params = new URLSearchParams({
      grant_type: "th_refresh_token",
      access_token: row.accessToken,
    });
    const res = await platformFetch(`${THREADS_REFRESH_URL}?${params.toString()}`);
    const json = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (res.ok && json.access_token) {
      await db
        .update(connectedAccountsTable)
        .set({
          accessToken: json.access_token,
          tokenExpiresAt: json.expires_in
            ? new Date(Date.now() + json.expires_in * 1000)
            : null,
          status: "connected",
          verifyStatus: "verified",
          verifyError: null,
          verifiedAt: new Date(),
        })
        .where(eq(connectedAccountsTable.id, row.id));
      await resolveSocialConnectionNotifications(row.tenantId, "threads");
      return "refreshed";
    }
    if (remaining <= 0 || res.status === 400 || res.status === 401) {
      // Token already dead, or Threads definitively refused to renew it.
      await markFailed(row, THREADS_TOKEN_INVALID_MESSAGE);
      return "invalid";
    }
    return "transient";
  } catch {
    // Transient/network error: keep the stored token, try again next time.
    return "transient";
  }
}

async function markFailed(
  row: AccountRow,
  message: string,
): Promise<void> {
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
    await notifySocialConnectionFailed(row.tenantId, row.platform, message);
  }
}

/**
 * Proactively re-verify a tenant's stored Threads connection when stale (or
 * forced). Threads long-lived tokens last ~60 days and are refreshed on a
 * rolling basis — an inactive user's token silently lapses, so the sweep
 * refreshes it when it is inside the renewal window and otherwise live-probes
 * the /me endpoint. On a definitive rejection the row flips to failed (with
 * the deduped breakage notification on a fresh verified -> failed transition);
 * transient errors only reset the check clock. Never throws.
 */
export async function reverifyThreads(
  tenantId: number,
  opts: ReverifyOptions = {},
): Promise<AccountRow | undefined> {
  const row = await loadAccountRow(tenantId, "threads");
  if (!row?.accessToken || row.status === "disconnected") return row;

  // Expired by timestamp — Threads refuses to refresh an already-expired
  // token, so no live call is needed to know the connection is dead.
  if (row.tokenExpiresAt !== null && row.tokenExpiresAt.getTime() <= Date.now()) {
    if (row.verifyStatus === "verified") {
      await markFailed(row, THREADS_TOKEN_INVALID_MESSAGE);
      return loadAccountRow(tenantId, "threads");
    }
    return row;
  }

  if (!opts.force && !isStale(row.verifiedAt)) return row;

  // Inside the renewal window: refresh instead of probing, so the rolling
  // long-lived token never lapses for a tenant who isn't using the app.
  // Uses the same shared refresh core as the Accounts-page route handlers.
  if (
    row.tokenExpiresAt !== null &&
    row.tokenExpiresAt.getTime() - Date.now() <= THREADS_REFRESH_WHEN_REMAINING_MS
  ) {
    const outcome = await maybeRefreshThreadsToken(row);
    if (outcome === "transient") await touchChecked(row);
    return loadAccountRow(tenantId, "threads");
  }

  // Otherwise a cheap live identity probe catches early revocation.
  try {
    const res = await platformFetch(
      `${THREADS_GRAPH_BASE}/me?fields=id,username&access_token=${encodeURIComponent(row.accessToken)}`,
    );
    if (res.ok) {
      const json = (await res.json()) as { id?: string; username?: string };
      await db
        .update(connectedAccountsTable)
        .set({
          status: "connected",
          verifyStatus: "verified",
          verifyError: null,
          verifiedAt: new Date(),
          accountName: json.username ? `@${json.username}` : row.accountName,
        })
        .where(eq(connectedAccountsTable.id, row.id));
      await resolveSocialConnectionNotifications(tenantId, "threads");
    } else if (res.status === 400 || res.status === 401 || res.status === 403) {
      await markFailed(row, THREADS_TOKEN_INVALID_MESSAGE);
    } else {
      await touchChecked(row);
    }
  } catch {
    await touchChecked(row);
  }

  return loadAccountRow(tenantId, "threads");
}

// ---------------------------------------------------------------------------
// YouTube
// ---------------------------------------------------------------------------

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

const YOUTUBE_TOKEN_INVALID_MESSAGE =
  "Your YouTube access is no longer valid. Reconnect YouTube to restore the connection.";

/**
 * SHARED app-level Google OAuth credential resolution, used by BOTH the
 * Accounts-page routes (routes/youtube.ts) and the background sweep so the
 * two paths can never drift: the superadmin-managed database row wins, with
 * the GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET env vars as a fallback for
 * env-based setups. Returns null when neither source is usable.
 */
export async function getYoutubeAppCredentials(): Promise<{
  clientId: string;
  clientSecret: string;
} | null> {
  try {
    const row = (
      await db
        .select()
        .from(appCredentialsTable)
        .where(eq(appCredentialsTable.provider, "youtube"))
        .limit(1)
    )[0];
    if (row) {
      const creds = decryptJson<YoutubeAppCredentials>(row.encryptedCredentials);
      if (creds.clientId && creds.clientSecret) return creds;
    }
  } catch {
    // Fall through to the env fallback on read/decrypt failure.
  }
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export type YoutubeTokenRefreshResult =
  | { ok: true; accessToken: string }
  | { ok: false; reason: "no_refresh_token" | "invalid_grant" };

/**
 * SHARED YouTube (Google OAuth) token-refresh core, used by BOTH the
 * Accounts-page route handlers (routes/youtube.ts) and the background sweep
 * (reverifyYoutube) so the two paths can never drift. Google access tokens
 * expire after ~1 hour; a connection is only truly alive while its refresh
 * token works. Unless a still-fresh access token short-circuits the call
 * (skipped with `force`, which the sweep uses to genuinely exercise the
 * refresh token), this refreshes against Google:
 *   - success persists the fresh access token as verified and clears any
 *     breakage notification;
 *   - a definitive invalid_grant/400/401 rejection flips the row to failed
 *     with the deduped breakage notification;
 *   - transient errors THROW so callers don't mistake an outage for a
 *     revocation.
 */
export async function ensureFreshYoutubeAccessToken(
  account: AccountRow,
  creds: { clientId: string; clientSecret: string },
  opts: { force?: boolean } = {},
): Promise<YoutubeTokenRefreshResult> {
  const skewMs = 60 * 1000;
  if (
    !opts.force &&
    account.accessToken &&
    account.tokenExpiresAt !== null &&
    account.tokenExpiresAt.getTime() > Date.now() + skewMs
  ) {
    return { ok: true, accessToken: account.accessToken };
  }

  let refreshToken: string | null = null;
  if (account.encryptedCredentials) {
    try {
      const stored = decryptJson<{ refreshToken?: string }>(
        account.encryptedCredentials,
      );
      refreshToken = stored.refreshToken || null;
    } catch {
      refreshToken = null;
    }
  }
  if (!refreshToken) return { ok: false, reason: "no_refresh_token" };

  const res = await platformFetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
    }).toString(),
  });
  const json = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
  };

  if (res.ok && json.access_token) {
    await db
      .update(connectedAccountsTable)
      .set({
        accessToken: json.access_token,
        tokenExpiresAt: json.expires_in
          ? new Date(Date.now() + json.expires_in * 1000)
          : null,
        status: "connected",
        verifyStatus: "verified",
        verifyError: null,
        verifiedAt: new Date(),
      })
      .where(eq(connectedAccountsTable.id, account.id));
    await resolveSocialConnectionNotifications(account.tenantId, "youtube");
    return { ok: true, accessToken: json.access_token };
  }

  if (
    json.error === "invalid_grant" ||
    res.status === 400 ||
    res.status === 401
  ) {
    // The refresh token was revoked or expired — the connection is dead.
    await markFailed(account, YOUTUBE_TOKEN_INVALID_MESSAGE);
    return { ok: false, reason: "invalid_grant" };
  }

  throw new Error(`Google token refresh failed (${res.status})`);
}

/**
 * Proactively re-verify a tenant's stored YouTube (Google OAuth) connection
 * when stale (or forced). A YouTube connection is only truly alive while its
 * refresh token works, so the check exercises a token refresh against Google
 * via the same shared core the route handlers use: success re-verifies (and
 * persists the fresh access token), a definitive invalid_grant/4xx rejection
 * flips the row to failed with the deduped breakage notification, and
 * transient errors only reset the check clock. Never throws.
 */
export async function reverifyYoutube(
  tenantId: number,
  opts: ReverifyOptions = {},
): Promise<AccountRow | undefined> {
  const row = await loadAccountRow(tenantId, "youtube");
  if (!row?.encryptedCredentials || row.status === "disconnected") return row;
  if (!opts.force && !isStale(row.verifiedAt)) return row;

  const app = await getYoutubeAppCredentials();
  if (!app) return row; // Cannot test without app-level client credentials.

  try {
    // force: a still-fresh access token must not skip exercising the refresh
    // token — the refresh token IS the connection's liveness.
    const result = await ensureFreshYoutubeAccessToken(row, app, {
      force: true,
    });
    if (!result.ok && result.reason === "no_refresh_token") return row;
  } catch {
    // Transient/network error: reset the clock, never flip a valid token.
    await touchChecked(row);
  }

  return loadAccountRow(tenantId, "youtube");
}
