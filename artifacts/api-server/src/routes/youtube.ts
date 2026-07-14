import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  connectedAccountsTable,
  appCredentialsTable,
  type YoutubeAppCredentials,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { decryptJson, encryptJson } from "../lib/secretCrypto";
import {
  signOAuthState,
  verifySignedOAuthState,
  randomNonce,
} from "../lib/oauthState";
import { notifySocialConnectionFailed } from "../lib/notifications";

const router: IRouter = Router();

const OAUTH_SCOPE = "https://www.googleapis.com/auth/youtube.readonly";
const AUTH_BASE = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CHANNELS_URL =
  "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true";

/**
 * App-level Google OAuth credentials for the YouTube connect flow. The
 * superadmin-managed database row (saved from the admin page, encrypted at
 * rest) wins; the GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET env vars remain a
 * fallback for env-based setups. Returns null when neither source is usable.
 */
async function getCredentials(): Promise<{
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

function redirectUri(req: Request): string {
  const proto =
    (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0] ||
    req.protocol ||
    "https";
  const host =
    (req.headers["x-forwarded-host"] as string | undefined) || req.headers.host;
  return `${proto}://${host}/api/youtube/auth/callback`;
}

async function isConfigured(): Promise<boolean> {
  return !!(await getCredentials()) && !!process.env.SESSION_SECRET;
}

async function getYoutubeAccount(tenantId: number) {
  return (
    await db
      .select()
      .from(connectedAccountsTable)
      .where(
        and(
          eq(connectedAccountsTable.tenantId, tenantId),
          eq(connectedAccountsTable.platform, "youtube"),
        ),
      )
      .limit(1)
  )[0];
}

type YoutubeAccount = NonNullable<Awaited<ReturnType<typeof getYoutubeAccount>>>;

/** Encrypted per-tenant blob kept alongside the connection row. */
type YoutubeStoredCreds = { refreshToken: string };

function readStoredRefreshToken(account: YoutubeAccount): string | null {
  if (!account.encryptedCredentials) return null;
  try {
    const creds = decryptJson<YoutubeStoredCreds>(account.encryptedCredentials);
    return creds.refreshToken || null;
  } catch {
    return null;
  }
}

/**
 * Google access tokens expire after ~1 hour, so a connection is only truly
 * alive while we hold a refresh token. Refresh the short-lived access token
 * when it is missing or near expiry. Returns the fresh access token, or null
 * when Google definitively rejects the refresh token (revoked), in which case
 * the row is flipped to failed so the UI prompts a reconnect. Transient errors
 * throw instead so callers don't mistake an outage for a revocation.
 */
async function ensureFreshAccessToken(
  tenantId: number,
  account: YoutubeAccount,
  creds: { clientId: string; clientSecret: string },
): Promise<string | null> {
  const skewMs = 60 * 1000;
  if (
    account.accessToken &&
    account.tokenExpiresAt !== null &&
    account.tokenExpiresAt.getTime() > Date.now() + skewMs
  ) {
    return account.accessToken;
  }

  const refreshToken = readStoredRefreshToken(account);
  if (!refreshToken) return null;

  const res = await fetch(TOKEN_URL, {
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
    const expiresAt = json.expires_in
      ? new Date(Date.now() + json.expires_in * 1000)
      : null;
    await db
      .update(connectedAccountsTable)
      .set({
        accessToken: json.access_token,
        tokenExpiresAt: expiresAt,
        status: "connected",
        verifyStatus: "verified",
        verifyError: null,
        verifiedAt: new Date(),
      })
      .where(eq(connectedAccountsTable.id, account.id));
    return json.access_token;
  }

  if (json.error === "invalid_grant" || res.status === 400 || res.status === 401) {
    // The refresh token was revoked or expired — the connection is dead.
    await db
      .update(connectedAccountsTable)
      .set({
        status: "error",
        verifyStatus: "failed",
        verifyError:
          "Your YouTube access is no longer valid. Reconnect YouTube to restore the connection.",
        verifiedAt: new Date(),
      })
      .where(eq(connectedAccountsTable.id, account.id));
    if (account.verifyStatus === "verified") {
      await notifySocialConnectionFailed(
        tenantId,
        "youtube",
        "Your YouTube access is no longer valid. Reconnect YouTube to restore the connection.",
      );
    }
    return null;
  }

  throw new Error(`Google token refresh failed (${res.status})`);
}

router.get("/youtube/auth/url", async (req: Request, res: Response) => {
  const creds = await getCredentials();
  if (!creds || !process.env.SESSION_SECRET) {
    res.status(503).json({
      error:
        "YouTube is not configured. Ask an administrator to save the Google Client ID and Client Secret on the Admin page.",
    });
    return;
  }
  const params = new URLSearchParams({
    response_type: "code",
    client_id: creds.clientId,
    redirect_uri: redirectUri(req),
    state: signOAuthState(req.tenantId, randomNonce()),
    scope: OAUTH_SCOPE,
    // Required to receive a refresh token so the connection outlives the
    // one-hour Google access token.
    access_type: "offline",
    prompt: "consent",
  });
  res.json({ url: `${AUTH_BASE}?${params.toString()}` });
});

/**
 * The OAuth callback lives on a separate PUBLIC router (mounted before the
 * session gate in routes/index.ts): it arrives as a top-level browser
 * navigation from google.com that may not carry the app's session token.
 * The HMAC-signed, TTL'd `state` minted by /youtube/auth/url is what
 * authenticates the request and identifies the initiating tenant.
 */
export const youtubeCallbackRouter: IRouter = Router();

youtubeCallbackRouter.get(
  "/youtube/auth/callback",
  async (req: Request, res: Response) => {
    const webBase = "/accounts";
    const fail = (reason: string) =>
      res.redirect(`${webBase}?youtube=error&reason=${encodeURIComponent(reason)}`);

    const creds = await getCredentials();
    if (!creds || !process.env.SESSION_SECRET) {
      fail("not_configured");
      return;
    }

    const { code, state, error: oauthError } = req.query as {
      code?: string;
      state?: string;
      error?: string;
    };
    if (oauthError) {
      fail(oauthError);
      return;
    }
    const verified = state ? verifySignedOAuthState(state) : null;
    if (!code || !verified) {
      fail("invalid_state");
      return;
    }
    const tenantId = verified.tenantId;

    try {
      const tokenRes = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri(req),
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
        }).toString(),
      });
      const tokenJson = (await tokenRes.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        error?: string;
      };
      if (!tokenRes.ok || !tokenJson.access_token) {
        req.log.error(
          { status: tokenRes.status, error: tokenJson.error },
          "Google token exchange failed",
        );
        fail("token_exchange");
        return;
      }

      const accessToken = tokenJson.access_token;
      const expiresAt = tokenJson.expires_in
        ? new Date(Date.now() + tokenJson.expires_in * 1000)
        : null;

      const channelRes = await fetch(CHANNELS_URL, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const channelJson = (await channelRes.json()) as {
        items?: Array<{
          id?: string;
          snippet?: { title?: string; customUrl?: string };
        }>;
      };
      if (!channelRes.ok) {
        req.log.error({ status: channelRes.status }, "YouTube channels lookup failed");
        fail("channel_lookup");
        return;
      }
      const channel = channelJson.items?.[0];
      if (!channel?.id) {
        // The Google account has no YouTube channel to connect.
        fail("no_channel");
        return;
      }

      const accountName =
        channel.snippet?.title || channel.snippet?.customUrl || "YouTube";

      const existing = await getYoutubeAccount(tenantId);
      // Google only returns refresh_token on a fresh consent; keep the prior
      // one if this reconnect didn't mint a new one.
      const priorRefresh = existing ? readStoredRefreshToken(existing) : null;
      const refreshToken = tokenJson.refresh_token || priorRefresh;
      if (!refreshToken) {
        fail("no_refresh_token");
        return;
      }
      const encryptedCredentials = encryptJson({ refreshToken });

      const now = new Date();
      if (existing) {
        await db
          .update(connectedAccountsTable)
          .set({
            accountName,
            status: "connected",
            accessToken,
            tokenExpiresAt: expiresAt,
            providerUserId: channel.id,
            encryptedCredentials,
            verifyStatus: "verified",
            verifyError: null,
            verifiedAt: now,
          })
          .where(eq(connectedAccountsTable.id, existing.id));
      } else {
        await db.insert(connectedAccountsTable).values({
          tenantId,
          platform: "youtube",
          accountName,
          status: "connected",
          accessToken,
          tokenExpiresAt: expiresAt,
          providerUserId: channel.id,
          encryptedCredentials,
          verifyStatus: "verified",
          verifyError: null,
          verifiedAt: now,
        });
      }

      res.redirect(`${webBase}?youtube=connected`);
    } catch (error) {
      req.log.error({ err: error }, "YouTube OAuth callback failed");
      fail("server_error");
    }
  },
);

function serializeStatus(
  req: Request,
  account: Awaited<ReturnType<typeof getYoutubeAccount>> | undefined,
  configured: boolean,
) {
  // With a refresh token the connection survives access-token expiry, so
  // "connected" hinges on the stored credentials still being marked good.
  const hasCreds = !!account && !!account.encryptedCredentials;
  const connected = hasCreds && account!.verifyStatus !== "failed";
  const expired = hasCreds && !connected;
  return {
    connected,
    accountName: connected ? account!.accountName : null,
    configured,
    redirectUri: redirectUri(req),
    expired,
  };
}

router.get("/youtube/status", async (req: Request, res: Response) => {
  let account = await getYoutubeAccount(req.tenantId);
  // Proactively refresh a stale access token so a revoked connection is caught
  // on page load and the UI prompts a reconnect.
  if (account?.encryptedCredentials && account.verifyStatus !== "failed") {
    const creds = await getCredentials();
    if (creds) {
      try {
        await ensureFreshAccessToken(req.tenantId, account, creds);
        account = await getYoutubeAccount(req.tenantId);
      } catch (err) {
        req.log.error({ err }, "YouTube token refresh failed (transient)");
      }
    }
  }
  res.json(serializeStatus(req, account, await isConfigured()));
});

router.delete("/youtube", async (req: Request, res: Response) => {
  const existing = await getYoutubeAccount(req.tenantId);
  if (existing) {
    await db
      .update(connectedAccountsTable)
      .set({
        status: "disconnected",
        accessToken: null,
        tokenExpiresAt: null,
        providerUserId: null,
        encryptedCredentials: null,
      })
      .where(eq(connectedAccountsTable.id, existing.id));
  }
  res.json(serializeStatus(req, undefined, await isConfigured()));
});

router.post("/youtube/retest", async (req: Request, res: Response) => {
  const existing = await getYoutubeAccount(req.tenantId);
  if (!existing?.encryptedCredentials) {
    res.status(400).json({ error: "No stored YouTube connection to re-test." });
    return;
  }
  const creds = await getCredentials();
  if (!creds) {
    res.status(503).json({
      error:
        "YouTube is not configured. Ask an administrator to save the Google Client ID and Client Secret on the Admin page.",
    });
    return;
  }

  try {
    const accessToken = await ensureFreshAccessToken(req.tenantId, existing, creds);
    if (accessToken) {
      const channelRes = await fetch(CHANNELS_URL, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const channelJson = (await channelRes.json()) as {
        items?: Array<{ id?: string; snippet?: { title?: string } }>;
      };
      const channel = channelJson.items?.[0];
      if (channelRes.ok && channel?.id) {
        await db
          .update(connectedAccountsTable)
          .set({
            status: "connected",
            accountName: channel.snippet?.title || existing.accountName,
            providerUserId: channel.id,
            verifyStatus: "verified",
            verifyError: null,
            verifiedAt: new Date(),
          })
          .where(eq(connectedAccountsTable.id, existing.id));
      } else if (channelRes.status === 401 || channelRes.status === 403) {
        await db
          .update(connectedAccountsTable)
          .set({
            status: "error",
            verifyStatus: "failed",
            verifyError:
              "YouTube rejected the stored access. Reconnect YouTube to restore the connection.",
            verifiedAt: new Date(),
          })
          .where(eq(connectedAccountsTable.id, existing.id));
      }
    }
  } catch (err) {
    req.log.error({ err }, "YouTube re-test failed");
  }

  const refreshed = await getYoutubeAccount(req.tenantId);
  res.json(serializeStatus(req, refreshed, await isConfigured()));
});

export default router;
