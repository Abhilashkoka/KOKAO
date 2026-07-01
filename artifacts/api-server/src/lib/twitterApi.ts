import { db, appCredentialsTable, connectedAccountsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { createHmac, randomBytes } from "crypto";
import type { TwitterAppCredentials } from "@workspace/db";
import { decryptJson } from "./secretCrypto";

export const TWITTER_API_BASE = "https://api.twitter.com";
export const TWITTER_UPLOAD_URL =
  "https://upload.twitter.com/1.1/media/upload.json";

/** Per-tenant X (Twitter) user credentials (OAuth 1.0a user context). */
export interface TwitterCredentials {
  accessToken: string;
  accessTokenSecret: string;
}

export interface TestResult {
  ok: boolean;
  /** Human-friendly account name resolved from X on success. */
  accountName?: string;
  /** Error message on failure (safe to show; never contains secrets). */
  error?: string;
}

/** RFC 3986 percent-encoding as required by OAuth 1.0a. */
function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!*'()]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Build an OAuth 1.0a "Authorization" header (HMAC-SHA1) for a request.
 *
 * `extraParams` should only contain request parameters that participate in the
 * signature — i.e. query-string params or application/x-www-form-urlencoded
 * body params. JSON and multipart bodies are NOT signed, so callers pass an
 * empty object for those.
 *
 * Secrets never appear in a URL: this produces a header, not a query string.
 */
export function buildOAuthHeader(opts: {
  method: string;
  url: string;
  consumerKey: string;
  consumerSecret: string;
  token: string;
  tokenSecret: string;
  extraParams?: Record<string, string>;
}): string {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: opts.consumerKey,
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: opts.token,
    oauth_version: "1.0",
  };

  const allParams: Record<string, string> = {
    ...oauthParams,
    ...(opts.extraParams ?? {}),
  };
  const paramString = Object.keys(allParams)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(allParams[k])}`)
    .join("&");

  const baseString = [
    opts.method.toUpperCase(),
    percentEncode(opts.url),
    percentEncode(paramString),
  ].join("&");

  const signingKey = `${percentEncode(opts.consumerSecret)}&${percentEncode(
    opts.tokenSecret,
  )}`;
  const signature = createHmac("sha1", signingKey)
    .update(baseString)
    .digest("base64");

  const headerParams: Record<string, string> = {
    ...oauthParams,
    oauth_signature: signature,
  };
  return (
    "OAuth " +
    Object.keys(headerParams)
      .sort()
      .map((k) => `${percentEncode(k)}="${percentEncode(headerParams[k])}"`)
      .join(", ")
  );
}

/** Load the app-level X credentials, or null if not configured. */
export async function getTwitterAppCredentials(): Promise<TwitterAppCredentials | null> {
  const row = (
    await db
      .select()
      .from(appCredentialsTable)
      .where(eq(appCredentialsTable.provider, "twitter"))
      .limit(1)
  )[0];
  if (!row) return null;
  try {
    return decryptJson<TwitterAppCredentials>(row.encryptedCredentials);
  } catch {
    return null;
  }
}

/** Whether admin-configured X app keys exist and passed their last test. */
export async function isTwitterAppConfigured(): Promise<boolean> {
  const row = (
    await db
      .select()
      .from(appCredentialsTable)
      .where(eq(appCredentialsTable.provider, "twitter"))
      .limit(1)
  )[0];
  return !!row && row.lastTestStatus === "verified";
}

/**
 * Validate the X API Key + API Secret by requesting an app-only bearer token
 * via the OAuth2 client_credentials grant. A valid pair returns a token. The
 * credentials go in the Authorization header (Basic), never a URL.
 */
export async function testTwitterAppCredentials(
  apiKey: string,
  apiSecret: string,
): Promise<TestResult> {
  try {
    const basic = Buffer.from(
      `${percentEncode(apiKey)}:${percentEncode(apiSecret)}`,
    ).toString("base64");
    const res = await fetch(`${TWITTER_API_BASE}/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      },
      body: "grant_type=client_credentials",
    });
    const json = (await res.json()) as {
      access_token?: string;
      errors?: { message?: string }[];
      error?: string;
    };
    if (!res.ok || !json.access_token) {
      return {
        ok: false,
        error:
          json.errors?.[0]?.message ||
          json.error ||
          `X API error (${res.status})`,
      };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not reach X.",
    };
  }
}

/**
 * Validate a tenant's X access token + secret by reading the authenticated
 * user. Requires the app-level consumer key/secret to sign the request.
 */
export async function testTwitterCredentials(
  creds: TwitterCredentials,
  app: TwitterAppCredentials,
): Promise<TestResult> {
  try {
    const url = `${TWITTER_API_BASE}/2/users/me`;
    const auth = buildOAuthHeader({
      method: "GET",
      url,
      consumerKey: app.apiKey,
      consumerSecret: app.apiSecret,
      token: creds.accessToken,
      tokenSecret: creds.accessTokenSecret,
    });
    const res = await fetch(url, { headers: { Authorization: auth } });
    const json = (await res.json()) as {
      data?: { id?: string; name?: string; username?: string };
      errors?: { message?: string; detail?: string }[];
      title?: string;
      detail?: string;
    };
    if (!res.ok || !json.data?.id) {
      return {
        ok: false,
        error:
          json.errors?.[0]?.detail ||
          json.errors?.[0]?.message ||
          json.detail ||
          json.title ||
          `X API error (${res.status})`,
      };
    }
    return {
      ok: true,
      accountName: json.data.username ? `@${json.data.username}` : "X account",
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Could not reach X.",
    };
  }
}

/** Load and decrypt a tenant's stored X credentials. */
export async function getTenantTwitterCredentials(
  tenantId: number,
): Promise<{
  creds: TwitterCredentials;
  accountName: string;
  verified: boolean;
} | null> {
  const row = (
    await db
      .select()
      .from(connectedAccountsTable)
      .where(
        and(
          eq(connectedAccountsTable.tenantId, tenantId),
          eq(connectedAccountsTable.platform, "twitter"),
        ),
      )
      .limit(1)
  )[0];
  if (!row || !row.encryptedCredentials) return null;
  try {
    return {
      creds: decryptJson<TwitterCredentials>(row.encryptedCredentials),
      accountName: row.accountName,
      verified: row.verifyStatus === "verified",
    };
  } catch {
    return null;
  }
}
