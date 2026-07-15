import { db, connectedAccountsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { decryptJson } from "./secretCrypto";
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
    const userRes = await fetch(LINKEDIN_USERINFO_URL, {
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
