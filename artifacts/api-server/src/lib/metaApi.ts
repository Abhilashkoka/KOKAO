import { db, appCredentialsTable, connectedAccountsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import type { MetaAppCredentials } from "@workspace/db";
import { decryptJson } from "./secretCrypto";
import { platformFetch } from "./platformFetch";

export const GRAPH_VERSION = "v21.0";
export const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;
export const GRAPH_ROOT = "https://graph.facebook.com";

/** Per-tenant Facebook Page credentials. */
export interface FacebookCredentials {
  pageId: string;
  pageAccessToken: string;
}

/** Per-tenant Instagram credentials. Publishing uses the Facebook Page token. */
export interface InstagramCredentials {
  igUserId: string;
}

export interface TestResult {
  ok: boolean;
  /** Human-friendly account name resolved from the platform on success. */
  accountName?: string;
  /** Error message on failure (safe to show; never contains secrets). */
  error?: string;
  /**
   * True when the failure was a transient/network problem (we could not reach
   * Meta) rather than a definitive rejection of the credentials. Callers doing
   * automatic re-verification use this to avoid flipping a still-valid
   * connection to "failed" on a momentary network blip.
   */
  transient?: boolean;
  /**
   * Set when verification succeeded but the credentials should be stored in a
   * corrected form (e.g. a pasted USER token was exchanged for the actual Page
   * access token). Callers that persist credentials should save these instead.
   */
  correctedCredentials?: FacebookCredentials;
}

interface GraphError {
  error?: { message?: string };
}

function graphErrorMessage(json: GraphError, status: number): string {
  return json.error?.message || `Meta API error (${status})`;
}

/** Load the app-level Meta credentials, or null if not configured. */
export async function getMetaAppCredentials(): Promise<MetaAppCredentials | null> {
  const row = (
    await db
      .select()
      .from(appCredentialsTable)
      .where(eq(appCredentialsTable.provider, "meta"))
      .limit(1)
  )[0];
  if (!row) return null;
  try {
    return decryptJson<MetaAppCredentials>(row.encryptedCredentials);
  } catch {
    return null;
  }
}

/** Whether admin-configured Meta app keys exist and passed their last test. */
export async function isMetaAppConfigured(): Promise<boolean> {
  const row = (
    await db
      .select()
      .from(appCredentialsTable)
      .where(eq(appCredentialsTable.provider, "meta"))
      .limit(1)
  )[0];
  return !!row && row.lastTestStatus === "verified";
}

/**
 * Validate the Meta App ID + App Secret by requesting an app access token via
 * the client_credentials grant. A valid pair returns a token.
 */
export async function testMetaAppCredentials(
  appId: string,
  appSecret: string,
): Promise<TestResult> {
  try {
    // Send the secret in the POST body (never the URL) so it can't leak into
    // upstream/proxy access logs.
    const body = new URLSearchParams({
      client_id: appId,
      client_secret: appSecret,
      grant_type: "client_credentials",
    });
    const res = await platformFetch(`${GRAPH_ROOT}/oauth/access_token`, {
      method: "POST",
      body,
    });
    const json = (await res.json()) as { access_token?: string } & GraphError;
    if (!res.ok || !json.access_token) {
      return { ok: false, error: graphErrorMessage(json, res.status) };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not reach Meta.",
      transient: true,
    };
  }
}

/** Permissions a Page token must carry to publish posts. */
const REQUIRED_PAGE_PUBLISH_SCOPES = [
  "pages_read_engagement",
  "pages_manage_posts",
] as const;

interface TokenInspection {
  /** "PAGE", "USER", etc. Null when the debug call could not be made. */
  type: string | null;
  /** Publish-required permissions the token is missing. */
  missing: string[];
}

/**
 * Inspect a token via /debug_token (using the app access token) and return
 * its type plus which publish-required permissions it is missing. Best-effort:
 * if the app credentials are absent or the debug call fails, returns
 * { type: null, missing: [] } so a momentary hiccup never blocks saving
 * otherwise-working credentials.
 */
async function inspectToken(token: string): Promise<TokenInspection> {
  const none: TokenInspection = { type: null, missing: [] };
  try {
    const app = await getMetaAppCredentials();
    if (!app) return none;
    // POST with the token in the body (never the URL) so it can't leak into
    // upstream/proxy access logs; `method=get` tells Graph to treat it as a read.
    const body = new URLSearchParams({ input_token: token, method: "get" });
    const res = await platformFetch(`${GRAPH_BASE}/debug_token`, {
      method: "POST",
      body,
      headers: { Authorization: `Bearer ${app.appId}|${app.appSecret}` },
    });
    const json = (await res.json()) as {
      data?: { scopes?: string[]; type?: string };
    } & GraphError;
    const scopes = json.data?.scopes;
    if (!res.ok || !Array.isArray(scopes)) return none;
    return {
      type: json.data?.type ?? null,
      missing: REQUIRED_PAGE_PUBLISH_SCOPES.filter((s) => !scopes.includes(s)),
    };
  } catch {
    return none;
  }
}

/**
 * Exchange a short-lived token for a long-lived one via
 * grant_type=fb_exchange_token (requires the app credentials). Long-lived
 * Page tokens generally never expire; long-lived user tokens last ~60 days.
 * Best-effort: returns null when the exchange is not possible so callers can
 * keep using the original (still valid) token.
 */
async function exchangeForLongLivedToken(token: string): Promise<string | null> {
  try {
    const app = await getMetaAppCredentials();
    if (!app) return null;
    // Secrets go in the POST body (never the URL) so they can't leak into
    // upstream/proxy access logs.
    const body = new URLSearchParams({
      grant_type: "fb_exchange_token",
      client_id: app.appId,
      client_secret: app.appSecret,
      fb_exchange_token: token,
    });
    const res = await platformFetch(`${GRAPH_ROOT}/oauth/access_token`, {
      method: "POST",
      body,
    });
    const json = (await res.json()) as { access_token?: string } & GraphError;
    if (!res.ok || !json.access_token) return null;
    return json.access_token;
  } catch {
    return null;
  }
}

/**
 * Exchange a USER access token for the Page's own access token via
 * GET /<pageId>?fields=access_token (works when the user is a Page admin with
 * pages_show_list). Returns null when the exchange is not possible.
 */
async function exchangeForPageToken(
  pageId: string,
  userToken: string,
): Promise<string | null> {
  try {
    const res = await platformFetch(
      `${GRAPH_BASE}/${encodeURIComponent(pageId)}?fields=access_token`,
      { headers: { Authorization: `Bearer ${userToken}` } },
    );
    const json = (await res.json()) as { access_token?: string } & GraphError;
    if (!res.ok || !json.access_token) return null;
    return json.access_token;
  } catch {
    return null;
  }
}

/**
 * Validate a tenant's Facebook Page token + Page ID by reading the Page. The
 * token must resolve to the same Page ID the tenant entered.
 */
export async function testFacebookCredentials(
  creds: FacebookCredentials,
): Promise<TestResult> {
  try {
    // Pass the token via the Authorization header (not the URL) so it can't
    // leak into upstream/proxy access logs.
    const res = await platformFetch(
      `${GRAPH_BASE}/${encodeURIComponent(creds.pageId)}?fields=id,name`,
      { headers: { Authorization: `Bearer ${creds.pageAccessToken}` } },
    );
    const json = (await res.json()) as { id?: string; name?: string } & GraphError;
    if (!res.ok || json.error || !json.id) {
      return { ok: false, error: graphErrorMessage(json, res.status) };
    }
    if (json.id !== creds.pageId) {
      return {
        ok: false,
        error: "The access token does not belong to the entered Page ID.",
      };
    }
    const inspection = await inspectToken(creds.pageAccessToken);
    if (inspection.missing.length > 0) {
      const missing = inspection.missing;
      return {
        ok: false,
        error:
          `The token works for reading, but is missing the permission${missing.length === 1 ? "" : "s"} ` +
          `${missing.join(" and ")} required to publish posts. Generate a new Page access token ` +
          "with pages_read_engagement and pages_manage_posts granted (as a Page admin) and save it again.",
      };
    }
    if (inspection.type && inspection.type !== "PAGE") {
      // A USER token can read the Page but can NOT publish to it; Facebook
      // requires the Page's own token. First upgrade the user token to a
      // long-lived one (so the derived Page token never expires), then
      // exchange it for the Page token automatically.
      const longLivedUserToken = await exchangeForLongLivedToken(
        creds.pageAccessToken,
      );
      const pageToken = await exchangeForPageToken(
        creds.pageId,
        longLivedUserToken ?? creds.pageAccessToken,
      );
      if (!pageToken) {
        return {
          ok: false,
          error:
            "This is a User access token, but publishing requires the Page's own access token. " +
            "In Graph API Explorer, open the token dropdown and pick your Page (or call /me/accounts) " +
            "to get the Page access token, then save that instead.",
        };
      }
      return {
        ok: true,
        accountName: json.name || "Facebook Page",
        correctedCredentials: { pageId: creds.pageId, pageAccessToken: pageToken },
      };
    }
    // A confirmed Page token: still try to upgrade it to a long-lived token
    // so it doesn't expire after a couple of hours. When the token type is
    // unknown (debug call unavailable), leave the stored credentials as-is —
    // never rewrite under uncertainty.
    if (inspection.type === "PAGE") {
      const longLived = await exchangeForLongLivedToken(creds.pageAccessToken);
      if (longLived && longLived !== creds.pageAccessToken) {
        return {
          ok: true,
          accountName: json.name || "Facebook Page",
          correctedCredentials: { pageId: creds.pageId, pageAccessToken: longLived },
        };
      }
    }
    return { ok: true, accountName: json.name || "Facebook Page" };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not reach Meta.",
      transient: true,
    };
  }
}

/**
 * Validate a tenant's Instagram Business account. IG publishing rides on the
 * Facebook Page token, so a verified Facebook credential must already exist.
 */
export async function testInstagramCredentials(
  creds: InstagramCredentials,
  pageToken: string,
): Promise<TestResult> {
  try {
    // Pass the token via the Authorization header (not the URL) so it can't
    // leak into upstream/proxy access logs.
    const res = await platformFetch(
      `${GRAPH_BASE}/${encodeURIComponent(creds.igUserId)}?fields=id,username`,
      { headers: { Authorization: `Bearer ${pageToken}` } },
    );
    const json = (await res.json()) as { id?: string; username?: string } & GraphError;
    if (!res.ok || json.error || !json.id) {
      return { ok: false, error: graphErrorMessage(json, res.status) };
    }
    return {
      ok: true,
      accountName: json.username ? `@${json.username}` : "Instagram account",
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not reach Meta.",
      transient: true,
    };
  }
}

/** Load and decrypt a tenant's stored credentials for a platform. */
export async function getTenantCredentials<T>(
  tenantId: number,
  platform: string,
): Promise<{ creds: T; accountName: string; verified: boolean } | null> {
  const row = (
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
  if (!row || !row.encryptedCredentials) return null;
  try {
    return {
      creds: decryptJson<T>(row.encryptedCredentials),
      accountName: row.accountName,
      verified: row.verifyStatus === "verified",
    };
  } catch {
    return null;
  }
}
