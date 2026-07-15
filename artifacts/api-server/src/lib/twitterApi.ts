import { db, appCredentialsTable, connectedAccountsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { createHash, randomBytes } from "crypto";
import type { TwitterAppCredentials } from "@workspace/db";
import { TWEET_MAX_LENGTH } from "@workspace/social-limits";
import { decryptJson, encryptJson } from "./secretCrypto";

// Re-export the shared tweet-length limit so callers can source it from a single
// place and stay aligned with @workspace/social-limits (no 280-char drift).
export { TWEET_MAX_LENGTH };

/** v2 API base for tweet creation and the authenticated-user lookup. */
export const TWITTER_API_BASE = "https://api.x.com";
/** OAuth 2.0 authorization endpoint (PKCE authorization-code flow). */
export const TWITTER_AUTH_URL = "https://twitter.com/i/oauth2/authorize";
/** OAuth 2.0 token endpoint (code exchange + refresh). */
export const TWITTER_TOKEN_URL = "https://api.x.com/2/oauth2/token";
/**
 * v2 media upload endpoint. The legacy v1.1 endpoint
 * (`upload.twitter.com/1.1/media/upload.json`) was permanently sunset by X on
 * 2025-06-09. Uploads use a command-based INIT -> APPEND -> FINALIZE flow on
 * this single endpoint (see `uploadTwitterMedia`), authorized with an OAuth 2.0
 * bearer token that carries the `media.write` scope.
 */
export const TWITTER_MEDIA_UPLOAD_URL = "https://api.x.com/2/media/upload";
/**
 * Scopes requested when a tenant connects their account. `media.write` is
 * required for the v2 media-upload flow, `offline.access` yields a refresh
 * token so publishing keeps working after the short-lived access token expires.
 */
export const TWITTER_OAUTH_SCOPES =
  "tweet.read tweet.write users.read media.write offline.access";

/**
 * Per-tenant X user tokens obtained via OAuth 2.0. Stored encrypted at rest.
 * The refresh token is the long-lived secret; the access token is short-lived
 * and refreshed on demand. Neither ever appears in a URL.
 */
export interface TwitterOAuth2Credentials {
  accessToken: string;
  refreshToken: string | null;
}

/**
 * Shape of a legacy OAuth 1.0a credential blob left over from before this
 * migration. Detected by the presence of `accessTokenSecret`; such connections
 * can no longer publish and must be reconnected via the OAuth 2.0 flow.
 */
interface LegacyTwitterOAuth1Credentials {
  accessToken: string;
  accessTokenSecret: string;
}

type StoredTwitterCredentials =
  | TwitterOAuth2Credentials
  | LegacyTwitterOAuth1Credentials;

function isLegacyOAuth1(
  creds: StoredTwitterCredentials,
): creds is LegacyTwitterOAuth1Credentials {
  return (
    typeof (creds as LegacyTwitterOAuth1Credentials).accessTokenSecret ===
    "string"
  );
}

// Re-exported from the shared lib so existing imports keep working; the
// implementation lives in @workspace/social-limits alongside the Library
// preview's copy to prevent client/server drift.
export { splitIntoTweets } from "@workspace/social-limits";

export interface TestResult {
  ok: boolean;
  /** Human-friendly account name resolved from X on success. */
  accountName?: string;
  /** Error message on failure (safe to show; never contains secrets). */
  error?: string;
}

/** Normalized OAuth 2.0 token set returned by the token endpoint. */
export interface TwitterTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
}

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------

/**
 * Generate a PKCE verifier + S256 challenge pair. The verifier is a
 * high-entropy random string; the challenge is BASE64URL(SHA256(verifier)).
 */
export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** Build the OAuth 2.0 authorization URL the browser is redirected to. */
export function buildTwitterAuthUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
}): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    scope: TWITTER_OAUTH_SCOPES,
    state: opts.state,
    code_challenge: opts.challenge,
    code_challenge_method: "S256",
  });
  return `${TWITTER_AUTH_URL}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Token endpoint (confidential client: HTTP Basic client authentication)
// ---------------------------------------------------------------------------

interface TwitterTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

function basicAuth(app: TwitterAppCredentials): string {
  return Buffer.from(`${app.clientId}:${app.clientSecret}`).toString("base64");
}

function normalizeTokens(
  json: TwitterTokenResponse,
  fallbackRefresh: string | null,
): TwitterTokens {
  return {
    accessToken: json.access_token!,
    // A refresh may or may not return a new refresh token; keep the old one if
    // X does not rotate it.
    refreshToken: json.refresh_token ?? fallbackRefresh,
    expiresAt: json.expires_in
      ? new Date(Date.now() + json.expires_in * 1000)
      : null,
  };
}

/**
 * Exchange an authorization code for tokens. The confidential client
 * authenticates with HTTP Basic (client id/secret) — the secret rides in the
 * Authorization header, never a URL or the redirect. Throws on failure.
 */
export async function exchangeCodeForTokens(opts: {
  app: TwitterAppCredentials;
  code: string;
  redirectUri: string;
  verifier: string;
}): Promise<TwitterTokens> {
  const res = await fetch(TWITTER_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth(opts.app)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: opts.code,
      redirect_uri: opts.redirectUri,
      code_verifier: opts.verifier,
      client_id: opts.app.clientId,
    }).toString(),
  });
  const json = (await res.json()) as TwitterTokenResponse;
  if (!res.ok || !json.access_token) {
    throw new Error(
      json.error_description || json.error || `X token exchange failed (${res.status})`,
    );
  }
  return normalizeTokens(json, null);
}

/** Refresh an access token using a refresh token. Throws on failure. */
export async function refreshTwitterTokens(opts: {
  app: TwitterAppCredentials;
  refreshToken: string;
}): Promise<TwitterTokens> {
  const res = await fetch(TWITTER_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth(opts.app)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: opts.refreshToken,
      client_id: opts.app.clientId,
    }).toString(),
  });
  const json = (await res.json()) as TwitterTokenResponse;
  if (!res.ok || !json.access_token) {
    throw new Error(
      json.error_description ||
        json.error ||
        `X token refresh failed (${res.status})`,
    );
  }
  return normalizeTokens(json, opts.refreshToken);
}

/**
 * Read the authenticated X user with an OAuth 2.0 bearer token. Returns the
 * user's id and a display handle, or null on any failure.
 */
export async function fetchTwitterUser(
  accessToken: string,
): Promise<{ id: string; accountName: string } | null> {
  try {
    const res = await fetch(`${TWITTER_API_BASE}/2/users/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const json = (await res.json()) as {
      data?: { id?: string; name?: string; username?: string };
    };
    if (!res.ok || !json.data?.id) return null;
    return {
      id: json.data.id,
      accountName: json.data.username ? `@${json.data.username}` : "X account",
    };
  } catch {
    return null;
  }
}

/** Outcome of a live re-check of a stored X access token. */
export type TwitterTestResult =
  | { ok: true; accountName: string }
  | { ok: false; transient: boolean; error: string };

/**
 * Live-test an OAuth 2.0 access token by reading the authenticated user. A 401/
 * 403 (or a 200 with no user) means the token is dead and the tenant must
 * reconnect. A 429 / 5xx / network error is transient and must NOT flip a valid
 * connection to "failed" — the caller only resets its staleness clock instead.
 */
export async function testTwitterCredentials(
  accessToken: string,
): Promise<TwitterTestResult> {
  let res: Response;
  try {
    res = await fetch(`${TWITTER_API_BASE}/2/users/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    return { ok: false, transient: true, error: "Could not reach X to verify the connection." };
  }

  if (res.status === 429 || res.status >= 500) {
    return { ok: false, transient: true, error: `X API is unavailable (${res.status}).` };
  }

  let json: { data?: { id?: string; username?: string } } = {};
  try {
    json = (await res.json()) as { data?: { id?: string; username?: string } };
  } catch {
    // Fall through to the status-based decision below.
  }

  if (res.ok && json.data?.id) {
    return {
      ok: true,
      accountName: json.data.username ? `@${json.data.username}` : "X account",
    };
  }

  return {
    ok: false,
    transient: false,
    error:
      "Your X access token is no longer valid. Reconnect X to keep publishing.",
  };
}

interface MediaUploadResponse {
  data?: { id?: string };
  id?: string;
  media_id_string?: string;
  errors?: { message?: string }[];
  title?: string;
  detail?: string;
}

function mediaUploadError(json: MediaUploadResponse, status: number): string {
  return (
    json.errors?.[0]?.message ||
    json.detail ||
    json.title ||
    `X media upload failed (${status})`
  );
}

/**
 * Upload a single image to X via the v2 command-based flow and return its
 * media_id. Authorized with an OAuth 2.0 bearer token (media.write scope) — no
 * request signing. The legacy v1.1 endpoint was sunset 2025-06-09.
 */
export async function uploadTwitterMedia(opts: {
  buffer: Buffer;
  contentType: string;
  accessToken: string;
}): Promise<string> {
  const { buffer, contentType, accessToken } = opts;
  const authHeader = `Bearer ${accessToken}`;

  // INIT: open an upload session.
  const initParams: Record<string, string> = {
    command: "INIT",
    total_bytes: String(buffer.byteLength),
    media_type: contentType,
    media_category: "tweet_image",
  };
  const initRes = await fetch(TWITTER_MEDIA_UPLOAD_URL, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(initParams).toString(),
  });
  const initJson = (await initRes.json()) as MediaUploadResponse;
  const mediaId = initJson.data?.id ?? initJson.id ?? initJson.media_id_string;
  if (!initRes.ok || !mediaId) {
    throw new Error(mediaUploadError(initJson, initRes.status));
  }

  // APPEND: upload the bytes as a single chunk (multipart).
  const form = new FormData();
  form.append("command", "APPEND");
  form.append("media_id", mediaId);
  form.append("segment_index", "0");
  form.append(
    "media",
    new Blob([new Uint8Array(buffer)], { type: contentType }),
    "media",
  );
  const appendRes = await fetch(TWITTER_MEDIA_UPLOAD_URL, {
    method: "POST",
    headers: { Authorization: authHeader },
    body: form,
  });
  if (!appendRes.ok) {
    let json: MediaUploadResponse = {};
    try {
      json = (await appendRes.json()) as MediaUploadResponse;
    } catch {
      // APPEND can succeed with an empty body; only parse on the error path.
    }
    throw new Error(mediaUploadError(json, appendRes.status));
  }

  // FINALIZE: close the session; the media is now attachable to a post.
  const finalizeParams: Record<string, string> = {
    command: "FINALIZE",
    media_id: mediaId,
  };
  const finalizeRes = await fetch(TWITTER_MEDIA_UPLOAD_URL, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(finalizeParams).toString(),
  });
  const finalizeJson = (await finalizeRes.json()) as MediaUploadResponse;
  if (!finalizeRes.ok) {
    throw new Error(mediaUploadError(finalizeJson, finalizeRes.status));
  }
  return (
    finalizeJson.data?.id ??
    finalizeJson.id ??
    finalizeJson.media_id_string ??
    mediaId
  );
}

/** Load the app-level X OAuth 2.0 client credentials, or null if not set. */
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

/**
 * Whether admin-configured X OAuth 2.0 client credentials exist. Confidential
 * client credentials cannot be validated without a full user authorization, so
 * there is no live pre-test — presence of the row is the configured signal.
 */
export async function isTwitterAppConfigured(): Promise<boolean> {
  return (await getTwitterAppCredentials()) !== null;
}

// ---------------------------------------------------------------------------
// Per-tenant connected account
// ---------------------------------------------------------------------------

/** Load a tenant's stored X connected-account row, or undefined. */
export async function getTwitterAccount(tenantId: number) {
  return (
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
}

/** Refresh a couple of minutes early so a token never expires mid-request. */
const TWITTER_TOKEN_REFRESH_BUFFER_MS = 60 * 1000;

export type TwitterTokenResult =
  | { ok: true; accessToken: string; accountName: string }
  | {
      ok: false;
      reason: "not_connected" | "reconnect_required";
      message: string;
    };

const RECONNECT_MESSAGE =
  "X is not connected or not verified. Reconnect your X account on the Accounts page and try again.";

/**
 * Resolve a usable OAuth 2.0 access token for a tenant, refreshing it when it
 * has expired. Legacy OAuth 1.0a connections (which can no longer publish) and
 * failed refreshes surface as `reconnect_required` so the caller can prompt the
 * user to reconnect. Persists any refreshed token. Never throws.
 */
export async function ensureFreshTwitterToken(
  tenantId: number,
  app: TwitterAppCredentials,
): Promise<TwitterTokenResult> {
  const row = await getTwitterAccount(tenantId);
  if (!row || !row.encryptedCredentials || row.status === "disconnected") {
    return {
      ok: false,
      reason: "not_connected",
      message:
        "X is not connected or not verified. Connect your X account on the Accounts page first.",
    };
  }

  let stored: StoredTwitterCredentials;
  try {
    stored = decryptJson<StoredTwitterCredentials>(row.encryptedCredentials);
  } catch {
    return { ok: false, reason: "reconnect_required", message: RECONNECT_MESSAGE };
  }

  // Legacy OAuth 1.0a token: publishing moved to OAuth 2.0, so prompt reconnect.
  if (isLegacyOAuth1(stored)) {
    return { ok: false, reason: "reconnect_required", message: RECONNECT_MESSAGE };
  }

  if (row.verifyStatus === "failed") {
    return { ok: false, reason: "reconnect_required", message: RECONNECT_MESSAGE };
  }

  let accessToken = stored.accessToken;
  const expired =
    row.tokenExpiresAt !== null &&
    row.tokenExpiresAt.getTime() - TWITTER_TOKEN_REFRESH_BUFFER_MS <= Date.now();

  if (expired) {
    if (!stored.refreshToken) {
      await markTwitterReconnectNeeded(row.id);
      return {
        ok: false,
        reason: "reconnect_required",
        message: RECONNECT_MESSAGE,
      };
    }
    try {
      const tokens = await refreshTwitterTokens({
        app,
        refreshToken: stored.refreshToken,
      });
      accessToken = tokens.accessToken;
      await db
        .update(connectedAccountsTable)
        .set({
          encryptedCredentials: encryptJson({
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
          } satisfies TwitterOAuth2Credentials),
          tokenExpiresAt: tokens.expiresAt,
          status: "connected",
          verifyStatus: "verified",
          verifyError: null,
          verifiedAt: new Date(),
        })
        .where(eq(connectedAccountsTable.id, row.id));
    } catch {
      await markTwitterReconnectNeeded(row.id);
      return {
        ok: false,
        reason: "reconnect_required",
        message: RECONNECT_MESSAGE,
      };
    }
  }

  return { ok: true, accessToken, accountName: row.accountName };
}

async function markTwitterReconnectNeeded(rowId: number): Promise<void> {
  await db
    .update(connectedAccountsTable)
    .set({
      status: "error",
      verifyStatus: "failed",
      verifyError:
        "Your X access token is no longer valid. Reconnect X to keep publishing.",
      verifiedAt: new Date(),
    })
    .where(eq(connectedAccountsTable.id, rowId));
}
