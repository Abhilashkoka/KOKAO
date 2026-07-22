import { Router, type IRouter, type Request, type Response } from "express";
import { db, connectedAccountsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { decryptJson, encryptJson } from "../lib/secretCrypto";
import { signOAuthState, verifySignedOAuthState, randomNonce } from "../lib/oauthState";
import { getYoutubeAppCredentials } from "../lib/socialReverify";
import { platformFetch } from "../lib/platformFetch";
import { ObjectStorageService } from "../lib/objectStorage";
import { ImportGoogleDriveFilesBody } from "@workspace/api-zod";

const router: IRouter = Router();

/**
 * Google Drive photo import for the Video Studio. Tenants connect their
 * Google account (drive.readonly scope), browse folders, and import selected
 * photos into workspace object storage — from where the slideshow and
 * image-to-video engines (and everything else in the app) can use them.
 *
 * Reuses the app-level Google OAuth client already configured for YouTube
 * (admin dashboard "youtube" credentials or GOOGLE_CLIENT_ID/SECRET), with
 * its own consent + token row (platform "google_drive") because the scope
 * differs. The Google Cloud client must list
 * /api/google-drive/auth/callback as an authorized redirect URI.
 */

const OAUTH_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const AUTH_BASE = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";
const DRIVE_ABOUT_URL =
  "https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress)";

const MAX_IMPORT_FILES = 20;
const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

const objectStorageService = new ObjectStorageService();

function redirectUri(req: Request): string {
  const proto =
    (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0] ||
    req.protocol ||
    "https";
  const host =
    (req.headers["x-forwarded-host"] as string | undefined) || req.headers.host;
  return `${proto}://${host}/api/google-drive/auth/callback`;
}

async function isConfigured(): Promise<boolean> {
  return !!(await getYoutubeAppCredentials()) && !!process.env.SESSION_SECRET;
}

async function getDriveAccount(tenantId: number) {
  return (
    await db
      .select()
      .from(connectedAccountsTable)
      .where(
        and(
          eq(connectedAccountsTable.tenantId, tenantId),
          eq(connectedAccountsTable.platform, "google_drive"),
        ),
      )
      .limit(1)
  )[0];
}

type DriveAccount = NonNullable<Awaited<ReturnType<typeof getDriveAccount>>>;

/** Encrypted per-tenant blob kept alongside the connection row. */
type DriveStoredCreds = { refreshToken: string };

function readStoredRefreshToken(account: DriveAccount): string | null {
  if (!account.encryptedCredentials) return null;
  try {
    return decryptJson<DriveStoredCreds>(account.encryptedCredentials).refreshToken || null;
  } catch {
    return null;
  }
}

/**
 * Return a working access token for Drive calls, refreshing via the stored
 * refresh token when the cached one is missing/near expiry. A definitive
 * invalid_grant flips the row to failed (UI prompts a reconnect) and returns
 * null; transient errors throw.
 */
async function ensureFreshAccessToken(account: DriveAccount): Promise<string | null> {
  const skewMs = 60 * 1000;
  if (
    account.accessToken &&
    account.tokenExpiresAt !== null &&
    account.tokenExpiresAt.getTime() > Date.now() + skewMs
  ) {
    return account.accessToken;
  }
  const creds = await getYoutubeAppCredentials();
  const refreshToken = readStoredRefreshToken(account);
  if (!creds || !refreshToken) return null;

  const res = await platformFetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
    }).toString(),
  });
  const json = (await res.json().catch(() => ({}))) as {
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
        verifyStatus: "verified",
        verifyError: null,
        verifiedAt: new Date(),
      })
      .where(eq(connectedAccountsTable.id, account.id));
    return json.access_token;
  }
  if (json.error === "invalid_grant" || res.status === 400 || res.status === 401) {
    await db
      .update(connectedAccountsTable)
      .set({
        status: "error",
        verifyStatus: "failed",
        verifyError:
          "Google rejected the stored access. Reconnect Google Drive to restore the connection.",
        verifiedAt: new Date(),
      })
      .where(eq(connectedAccountsTable.id, account.id));
    return null;
  }
  throw new Error(`Google token refresh failed (${res.status})`);
}

function serializeStatus(
  req: Request,
  account: Awaited<ReturnType<typeof getDriveAccount>> | undefined,
  configured: boolean,
) {
  const hasCreds = !!account && !!account.encryptedCredentials;
  const connected = hasCreds && account!.verifyStatus !== "failed";
  return {
    connected,
    accountName: connected ? account!.accountName : null,
    configured,
    redirectUri: redirectUri(req),
    expired: hasCreds && !connected,
  };
}

router.get("/google-drive/status", async (req: Request, res: Response) => {
  res.json(serializeStatus(req, await getDriveAccount(req.tenantId), await isConfigured()));
});

router.get("/google-drive/auth/url", async (req: Request, res: Response) => {
  const creds = await getYoutubeAppCredentials();
  if (!creds || !process.env.SESSION_SECRET) {
    res.status(503).json({
      error:
        "Google Drive is not configured. Ask an administrator to save the Google Client ID and Client Secret on the Admin page.",
    });
    return;
  }
  const params = new URLSearchParams({
    response_type: "code",
    client_id: creds.clientId,
    redirect_uri: redirectUri(req),
    state: signOAuthState(req.tenantId, randomNonce()),
    scope: OAUTH_SCOPE,
    access_type: "offline",
    prompt: "consent",
  });
  res.json({ url: `${AUTH_BASE}?${params.toString()}` });
});

/**
 * PUBLIC callback router (mounted before the session gate): the redirect from
 * google.com may not carry the app session; the HMAC-signed `state` is what
 * authenticates the request and identifies the tenant.
 */
export const googleDriveCallbackRouter: IRouter = Router();

googleDriveCallbackRouter.get(
  "/google-drive/auth/callback",
  async (req: Request, res: Response) => {
    const webBase = "/studio";
    const fail = (reason: string) =>
      res.redirect(`${webBase}?drive=error&reason=${encodeURIComponent(reason)}`);

    const creds = await getYoutubeAppCredentials();
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
      const tokenRes = await platformFetch(TOKEN_URL, {
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
          "Google Drive token exchange failed",
        );
        fail("token_exchange");
        return;
      }

      const aboutRes = await platformFetch(DRIVE_ABOUT_URL, {
        headers: { Authorization: `Bearer ${tokenJson.access_token}` },
      });
      const aboutJson = (await aboutRes.json().catch(() => ({}))) as {
        user?: { displayName?: string; emailAddress?: string };
      };
      const accountName =
        aboutJson.user?.emailAddress || aboutJson.user?.displayName || "Google Drive";

      const existing = await getDriveAccount(tenantId);
      // Google only returns refresh_token on a fresh consent; keep the prior
      // one if this reconnect didn't mint a new one.
      const priorRefresh = existing ? readStoredRefreshToken(existing) : null;
      const refreshToken = tokenJson.refresh_token || priorRefresh;
      if (!refreshToken) {
        fail("no_refresh_token");
        return;
      }
      const values = {
        accountName,
        status: "connected",
        accessToken: tokenJson.access_token,
        tokenExpiresAt: tokenJson.expires_in
          ? new Date(Date.now() + tokenJson.expires_in * 1000)
          : null,
        encryptedCredentials: encryptJson({ refreshToken } satisfies DriveStoredCreds),
        verifyStatus: "verified",
        verifyError: null,
        verifiedAt: new Date(),
      };
      if (existing) {
        await db
          .update(connectedAccountsTable)
          .set(values)
          .where(eq(connectedAccountsTable.id, existing.id));
      } else {
        await db
          .insert(connectedAccountsTable)
          .values({ tenantId, platform: "google_drive", ...values });
      }
      res.redirect(`${webBase}?drive=connected`);
    } catch (error) {
      req.log.error({ err: error }, "Google Drive OAuth callback failed");
      fail("server_error");
    }
  },
);

router.delete("/google-drive", async (req: Request, res: Response) => {
  const existing = await getDriveAccount(req.tenantId);
  if (existing) {
    await db
      .update(connectedAccountsTable)
      .set({
        status: "disconnected",
        accessToken: null,
        tokenExpiresAt: null,
        encryptedCredentials: null,
      })
      .where(eq(connectedAccountsTable.id, existing.id));
  }
  res.json(serializeStatus(req, undefined, await isConfigured()));
});

/** Resolve a working access token or answer the request with the right error. */
async function getAccessTokenOrRespond(req: Request, res: Response): Promise<string | null> {
  const account = await getDriveAccount(req.tenantId);
  if (!account?.encryptedCredentials) {
    res.status(400).json({ error: "Google Drive is not connected." });
    return null;
  }
  try {
    const token = await ensureFreshAccessToken(account);
    if (!token) {
      res.status(401).json({
        error: "Google Drive access expired. Please reconnect your Google account.",
      });
      return null;
    }
    return token;
  } catch (error) {
    req.log.error({ err: error }, "Google Drive token refresh failed");
    res.status(502).json({ error: "Could not reach Google Drive. Please try again." });
    return null;
  }
}

interface DriveFile {
  id?: string;
  name?: string;
  mimeType?: string;
  size?: string;
  thumbnailLink?: string;
}

router.get("/google-drive/files", async (req: Request, res: Response) => {
  const token = await getAccessTokenOrRespond(req, res);
  if (!token) return;

  const folderId =
    typeof req.query.folderId === "string" && /^[\w-]{1,128}$/.test(req.query.folderId)
      ? req.query.folderId
      : "root";
  const pageToken = typeof req.query.pageToken === "string" ? req.query.pageToken : "";

  const params = new URLSearchParams({
    q: `'${folderId}' in parents and (mimeType contains 'image/' or mimeType = 'application/vnd.google-apps.folder') and trashed = false`,
    fields: "nextPageToken, files(id, name, mimeType, size, thumbnailLink)",
    orderBy: "folder, name",
    pageSize: "60",
  });
  if (pageToken) params.set("pageToken", pageToken);

  const listRes = await platformFetch(`${DRIVE_FILES_URL}?${params.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const listJson = (await listRes.json().catch(() => ({}))) as {
    files?: DriveFile[];
    nextPageToken?: string;
    error?: { message?: string };
  };
  if (!listRes.ok) {
    req.log.error({ status: listRes.status }, "Google Drive file list failed");
    res.status(502).json({ error: "Google Drive listing failed. Please try again." });
    return;
  }
  res.json({
    files: (listJson.files ?? [])
      .filter((f) => f.id && f.name)
      .map((f) => ({
        id: f.id!,
        name: f.name!,
        mimeType: f.mimeType ?? "application/octet-stream",
        isFolder: f.mimeType === "application/vnd.google-apps.folder",
        sizeBytes: f.size ? Number(f.size) : null,
        thumbnailUrl: f.thumbnailLink ?? null,
      })),
    nextPageToken: listJson.nextPageToken ?? null,
  });
});

/** Import selected Drive photos into workspace object storage. */
router.post("/google-drive/import", async (req: Request, res: Response) => {
  const parsed = ImportGoogleDriveFilesBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const fileIds = parsed.data.fileIds.slice(0, MAX_IMPORT_FILES);
  const token = await getAccessTokenOrRespond(req, res);
  if (!token) return;

  const imported: { fileId: string; name: string; objectPath: string }[] = [];
  const failed: { fileId: string; reason: string }[] = [];

  for (const fileId of fileIds) {
    if (!/^[\w-]{1,128}$/.test(fileId)) {
      failed.push({ fileId, reason: "Invalid file id." });
      continue;
    }
    try {
      const metaRes = await platformFetch(
        `${DRIVE_FILES_URL}/${fileId}?fields=id,name,mimeType,size`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const meta = (await metaRes.json().catch(() => ({}))) as DriveFile;
      if (!metaRes.ok || !meta.id) {
        failed.push({ fileId, reason: "File not found in Google Drive." });
        continue;
      }
      const mimeType = (meta.mimeType ?? "").toLowerCase();
      const normalized = mimeType === "image/jpg" ? "image/jpeg" : mimeType;
      if (!ALLOWED_IMAGE_TYPES.has(normalized)) {
        failed.push({ fileId, reason: "Only PNG, JPEG, and WebP photos can be imported." });
        continue;
      }
      if (meta.size && Number(meta.size) > MAX_IMPORT_BYTES) {
        failed.push({ fileId, reason: "Photo is larger than 10 MB." });
        continue;
      }

      const downloadRes = await platformFetch(`${DRIVE_FILES_URL}/${fileId}?alt=media`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!downloadRes.ok) {
        failed.push({ fileId, reason: "Download from Google Drive failed." });
        continue;
      }
      const bytes = Buffer.from(await downloadRes.arrayBuffer());
      if (bytes.length === 0 || bytes.length > MAX_IMPORT_BYTES) {
        failed.push({ fileId, reason: "Photo is empty or larger than 10 MB." });
        continue;
      }

      const uploadURL = await objectStorageService.getObjectEntityUploadURL(req.tenantId);
      const putRes = await fetch(uploadURL, {
        method: "PUT",
        headers: { "Content-Type": normalized },
        body: new Uint8Array(bytes),
        signal: AbortSignal.timeout(60_000),
      });
      if (!putRes.ok) {
        failed.push({ fileId, reason: "Saving the photo to storage failed." });
        continue;
      }
      imported.push({
        fileId,
        name: meta.name ?? fileId,
        objectPath: objectStorageService.normalizeObjectEntityPath(uploadURL),
      });
    } catch (error) {
      req.log.error({ err: error, fileId }, "Google Drive import failed for file");
      failed.push({ fileId, reason: "Import failed. Please try again." });
    }
  }

  res.json({ imported, failed });
});

export default router;
