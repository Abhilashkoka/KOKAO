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
