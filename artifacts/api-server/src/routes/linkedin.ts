import { Router, type IRouter, type Request, type Response } from "express";
import { db, connectedAccountsTable, contentItemsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { ObjectStorageService } from "../lib/objectStorage";
import { notifySocialConnectionFailed } from "../lib/notifications";

const router: IRouter = Router();

const objectStorageService = new ObjectStorageService();

const LINKEDIN_VERSION = "202405";
const OAUTH_SCOPE = "openid profile w_member_social";
const AUTH_BASE = "https://www.linkedin.com/oauth/v2/authorization";
const TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
const USERINFO_URL = "https://api.linkedin.com/v2/userinfo";
const REST_BASE = "https://api.linkedin.com/rest";
const STATE_TTL_MS = 10 * 60 * 1000;

function getCredentials(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.LINKEDIN_CLIENT_ID;
  const clientSecret = process.env.LINKEDIN_CLIENT_SECRET;
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
  return `${proto}://${host}/api/linkedin/auth/callback`;
}

function isConfigured(): boolean {
  return !!getCredentials() && !!process.env.SESSION_SECRET;
}

function signState(tenantId: number): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is required for OAuth state");
  const payload = `${tenantId}.${Date.now()}.${randomBytes(8).toString("hex")}`;
  const sig = createHmac("sha256", secret).update(payload).digest("hex");
  return Buffer.from(`${payload}.${sig}`, "utf8").toString("base64url");
}

function verifyState(state: string, tenantId: number): boolean {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return false;
  try {
    const decoded = Buffer.from(state, "base64url").toString("utf8");
    const lastDot = decoded.lastIndexOf(".");
    if (lastDot < 0) return false;
    const payload = decoded.slice(0, lastDot);
    const sig = decoded.slice(lastDot + 1);
    const expected = createHmac("sha256", secret)
      .update(payload)
      .digest("hex");
    const sigBuf = Buffer.from(sig, "hex");
    const expBuf = Buffer.from(expected, "hex");
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
      return false;
    }
    const [tid, ts] = payload.split(".");
    if (Number(tid) !== tenantId) return false;
    if (!Number.isFinite(Number(ts)) || Date.now() - Number(ts) > STATE_TTL_MS) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * LinkedIn's Posts API commentary uses the "Little Text" format, where a set of
 * reserved characters must be escaped with a leading backslash or the request
 * is rejected. Escape the backslash first so we don't double-escape.
 */
function escapeCommentary(text: string): string {
  return text.replace(/[\\<>@~#*_(){}\[\]|]/g, (c) => `\\${c}`);
}

function imageContentType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    default:
      return "image/png";
  }
}

async function getLinkedinAccount(tenantId: number) {
  return (
    await db
      .select()
      .from(connectedAccountsTable)
      .where(
        and(
          eq(connectedAccountsTable.tenantId, tenantId),
          eq(connectedAccountsTable.platform, "linkedin"),
        ),
      )
      .limit(1)
  )[0];
}

/**
 * How long a LinkedIn live-token check stays fresh before we re-check. Acts as
 * the rate limiter so repeated Accounts-page loads don't hammer LinkedIn.
 */
const LINKEDIN_REVERIFY_STALE_MS = 15 * 60 * 1000;

type LinkedinAccount = NonNullable<Awaited<ReturnType<typeof getLinkedinAccount>>>;

/**
 * Proactively re-check a stored LinkedIn token against the live userinfo
 * endpoint when it has gone stale. A token can be revoked by the user before
 * its stored expiry, so this catches breakage the expiry timestamp alone would
 * miss. On a definitive rejection the row is flipped to "failed"/error so the
 * UI prompts a reconnect; transient/network errors only reset the check clock
 * and never flip a still-valid connection. Never throws.
 */
async function reverifyLinkedin(
  tenantId: number,
  account: LinkedinAccount,
): Promise<LinkedinAccount> {
  if (!account.accessToken) return account;
  // Expired by timestamp — no need to spend a live call to know it's dead.
  if (
    account.tokenExpiresAt !== null &&
    account.tokenExpiresAt.getTime() <= Date.now()
  ) {
    return account;
  }
  const fresh =
    account.verifiedAt !== null &&
    Date.now() - account.verifiedAt.getTime() < LINKEDIN_REVERIFY_STALE_MS;
  if (fresh) return account;

  try {
    const userRes = await fetch(USERINFO_URL, {
      headers: { Authorization: `Bearer ${account.accessToken}` },
    });
    if (userRes.status === 401 || userRes.status === 403) {
      await db
        .update(connectedAccountsTable)
        .set({
          status: "error",
          verifyStatus: "failed",
          verifyError:
            "Your LinkedIn access token is no longer valid. Reconnect LinkedIn to keep publishing.",
          verifiedAt: new Date(),
        })
        .where(eq(connectedAccountsTable.id, account.id));
      // Notify once when a previously-good connection first breaks.
      if (account.verifyStatus === "verified") {
        await notifySocialConnectionFailed(
          tenantId,
          "linkedin",
          "Your LinkedIn access token is no longer valid. Reconnect LinkedIn to keep publishing.",
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
        .where(eq(connectedAccountsTable.id, account.id));
    } else {
      // Unexpected non-auth status: reset the clock, keep prior state.
      await db
        .update(connectedAccountsTable)
        .set({ verifiedAt: new Date() })
        .where(eq(connectedAccountsTable.id, account.id));
    }
  } catch {
    // Transient/network error: reset the clock, never flip a valid token.
    await db
      .update(connectedAccountsTable)
      .set({ verifiedAt: new Date() })
      .where(eq(connectedAccountsTable.id, account.id));
  }

  return (await getLinkedinAccount(tenantId)) ?? account;
}

router.param("id", (req, res, next, value) => {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  next();
});

router.get("/linkedin/auth/url", (req: Request, res: Response) => {
  const creds = getCredentials();
  if (!creds || !isConfigured()) {
    res.status(503).json({
      error:
        "LinkedIn is not configured. Add LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET and SESSION_SECRET.",
    });
    return;
  }
  const params = new URLSearchParams({
    response_type: "code",
    client_id: creds.clientId,
    redirect_uri: redirectUri(req),
    state: signState(req.tenantId),
    scope: OAUTH_SCOPE,
  });
  res.json({ url: `${AUTH_BASE}?${params.toString()}` });
});

router.get("/linkedin/auth/callback", async (req: Request, res: Response) => {
  const webBase = "/accounts";
  const fail = (reason: string) =>
    res.redirect(`${webBase}?linkedin=error&reason=${encodeURIComponent(reason)}`);

  const creds = getCredentials();
  if (!creds || !isConfigured()) {
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
  if (!code || !state || !verifyState(state, req.tenantId)) {
    fail("invalid_state");
    return;
  }

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
      expires_in?: number;
      error?: string;
      error_description?: string;
    };
    if (!tokenRes.ok || !tokenJson.access_token) {
      req.log.error(
        { status: tokenRes.status, error: tokenJson.error },
        "LinkedIn token exchange failed",
      );
      fail("token_exchange");
      return;
    }

    const accessToken = tokenJson.access_token;
    const expiresAt = tokenJson.expires_in
      ? new Date(Date.now() + tokenJson.expires_in * 1000)
      : null;

    const userRes = await fetch(USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const userJson = (await userRes.json()) as {
      sub?: string;
      name?: string;
    };
    if (!userRes.ok || !userJson.sub) {
      req.log.error({ status: userRes.status }, "LinkedIn userinfo failed");
      fail("userinfo");
      return;
    }

    const accountName = userJson.name || "LinkedIn";
    const now = new Date();
    const existing = await getLinkedinAccount(req.tenantId);
    if (existing) {
      await db
        .update(connectedAccountsTable)
        .set({
          accountName,
          status: "connected",
          accessToken,
          tokenExpiresAt: expiresAt,
          providerUserId: userJson.sub,
          verifyStatus: "verified",
          verifyError: null,
          verifiedAt: now,
        })
        .where(eq(connectedAccountsTable.id, existing.id));
    } else {
      await db.insert(connectedAccountsTable).values({
        tenantId: req.tenantId,
        platform: "linkedin",
        accountName,
        status: "connected",
        accessToken,
        tokenExpiresAt: expiresAt,
        providerUserId: userJson.sub,
        verifyStatus: "verified",
        verifyError: null,
        verifiedAt: now,
      });
    }

    res.redirect(`${webBase}?linkedin=connected`);
  } catch (error) {
    req.log.error({ err: error }, "LinkedIn OAuth callback failed");
    fail("server_error");
  }
});

function serializeStatus(
  req: Request,
  account: Awaited<ReturnType<typeof getLinkedinAccount>> | undefined,
) {
  const connected =
    !!account?.accessToken &&
    account.verifyStatus !== "failed" &&
    (account.tokenExpiresAt === null ||
      account.tokenExpiresAt.getTime() > Date.now());
  // A stored account that is no longer usable should prompt a reconnect rather
  // than looking like it was never connected.
  const expired = !!account?.accessToken && !connected;
  return {
    connected,
    accountName: connected ? account!.accountName : null,
    configured: isConfigured(),
    redirectUri: redirectUri(req),
    expired,
  };
}

router.get("/linkedin/status", async (req: Request, res: Response) => {
  let account = await getLinkedinAccount(req.tenantId);
  // Proactively re-check the stored token so a revoked/expired one is caught on
  // page load and the UI prompts a reconnect, without a manual retest.
  if (account?.accessToken) {
    try {
      account = await reverifyLinkedin(req.tenantId, account);
    } catch (err) {
      req.log.error({ err }, "LinkedIn auto re-verify failed");
    }
  }
  res.json(serializeStatus(req, account));
});

router.delete("/linkedin", async (req: Request, res: Response) => {
  const existing = await getLinkedinAccount(req.tenantId);
  if (existing) {
    await db
      .update(connectedAccountsTable)
      .set({
        status: "disconnected",
        accessToken: null,
        tokenExpiresAt: null,
        providerUserId: null,
      })
      .where(eq(connectedAccountsTable.id, existing.id));
  }
  res.json(serializeStatus(req, undefined));
});

router.post("/linkedin/retest", async (req: Request, res: Response) => {
  const existing = await getLinkedinAccount(req.tenantId);
  if (!existing?.accessToken) {
    res.status(400).json({ error: "No stored LinkedIn connection to re-test." });
    return;
  }

  let stillValid = false;
  let accountName = existing.accountName;
  let providerUserId = existing.providerUserId;
  try {
    const userRes = await fetch(USERINFO_URL, {
      headers: { Authorization: `Bearer ${existing.accessToken}` },
    });
    const userJson = (await userRes.json()) as { sub?: string; name?: string };
    if (userRes.ok && userJson.sub) {
      stillValid = true;
      accountName = userJson.name || accountName;
      providerUserId = userJson.sub;
    }
  } catch (error) {
    req.log.error({ err: error }, "LinkedIn re-test failed");
  }

  if (stillValid) {
    await db
      .update(connectedAccountsTable)
      .set({ status: "connected", accountName, providerUserId })
      .where(eq(connectedAccountsTable.id, existing.id));
  } else {
    // The stored token no longer works; clear it so the UI reflects the break.
    await db
      .update(connectedAccountsTable)
      .set({
        status: "disconnected",
        accessToken: null,
        tokenExpiresAt: null,
        providerUserId: null,
      })
      .where(eq(connectedAccountsTable.id, existing.id));
  }

  const refreshed = await getLinkedinAccount(req.tenantId);
  res.json(serializeStatus(req, refreshed));
});

router.post(
  "/content/:id/publish-linkedin",
  async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const item = (
      await db
        .select()
        .from(contentItemsTable)
        .where(
          and(
            eq(contentItemsTable.id, id),
            eq(contentItemsTable.tenantId, req.tenantId),
          ),
        )
        .limit(1)
    )[0];
    if (!item) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    let account = await getLinkedinAccount(req.tenantId);
    // Re-check the token against LinkedIn right before publishing so a
    // revoked/expired token is caught here instead of producing a confusing raw
    // publish error. Force the check regardless of staleness.
    if (account?.accessToken) {
      try {
        account = await reverifyLinkedin(req.tenantId, {
          ...account,
          verifiedAt: null,
        });
      } catch (err) {
        req.log.error({ err }, "LinkedIn pre-publish re-verify failed");
      }
    }
    const tokenValid =
      !!account?.accessToken &&
      account.verifyStatus !== "failed" &&
      (account.tokenExpiresAt === null ||
        account.tokenExpiresAt.getTime() > Date.now());
    if (!account || !tokenValid || !account.providerUserId) {
      res.status(400).json({
        error:
          "LinkedIn is not connected or its access token is no longer valid. Reconnect your LinkedIn account on the Accounts page and try again.",
      });
      return;
    }

    const token = account.accessToken!;
    const author = `urn:li:person:${account.providerUserId}`;
    const commentary = escapeCommentary(item.caption?.trim() || item.title);

    const baseHeaders = {
      Authorization: `Bearer ${token}`,
      "LinkedIn-Version": LINKEDIN_VERSION,
      "X-Restli-Protocol-Version": "2.0.0",
    };

    try {
      let imageUrn: string | null = null;

      if (item.imagePath) {
        const file = await objectStorageService.getObjectEntityFile(
          item.imagePath,
        );
        const [buffer] = await file.download();

        const initRes = await fetch(`${REST_BASE}/images?action=initializeUpload`, {
          method: "POST",
          headers: { ...baseHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({ initializeUploadRequest: { owner: author } }),
        });
        const initJson = (await initRes.json()) as {
          value?: { uploadUrl?: string; image?: string };
        };
        if (!initRes.ok || !initJson.value?.uploadUrl || !initJson.value.image) {
          throw new Error(`Image upload could not be initialized (${initRes.status})`);
        }

        const uploadRes = await fetch(initJson.value.uploadUrl, {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": imageContentType(item.imagePath),
          },
          body: new Uint8Array(buffer),
        });
        if (!uploadRes.ok) {
          throw new Error(`Image binary upload failed (${uploadRes.status})`);
        }
        imageUrn = initJson.value.image;
      }

      const postBody: Record<string, unknown> = {
        author,
        commentary,
        visibility: "PUBLIC",
        distribution: {
          feedDistribution: "MAIN_FEED",
          targetEntities: [],
          thirdPartyDistributionChannels: [],
        },
        lifecycleState: "PUBLISHED",
        isReshareDisabledByAuthor: false,
      };
      if (imageUrn) {
        postBody.content = {
          media: { id: imageUrn, title: item.title.slice(0, 400) },
        };
      }

      const postRes = await fetch(`${REST_BASE}/posts`, {
        method: "POST",
        headers: { ...baseHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(postBody),
      });
      if (postRes.status !== 201 && !postRes.ok) {
        let detail = `LinkedIn API error (${postRes.status})`;
        try {
          const errJson = (await postRes.json()) as { message?: string };
          if (errJson.message) detail = errJson.message;
        } catch {
          /* ignore non-JSON body */
        }
        throw new Error(detail);
      }

      const postId =
        postRes.headers.get("x-restli-id") ||
        postRes.headers.get("x-linkedin-id") ||
        "";

      await db
        .update(contentItemsTable)
        .set({ status: "published", updatedAt: new Date() })
        .where(
          and(
            eq(contentItemsTable.id, id),
            eq(contentItemsTable.tenantId, req.tenantId),
          ),
        );

      const permalink = postId
        ? `https://www.linkedin.com/feed/update/${postId}`
        : null;
      res.json({ postId, permalink });
    } catch (error) {
      req.log.error({ err: error }, "LinkedIn publish failed");
      res.status(502).json({
        error:
          error instanceof Error
            ? `LinkedIn rejected the post: ${error.message}`
            : "Failed to publish to LinkedIn.",
      });
    }
  },
);

export default router;
