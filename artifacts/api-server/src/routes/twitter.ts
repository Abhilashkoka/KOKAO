import { Router, type IRouter, type Request, type Response } from "express";
import { db, connectedAccountsTable, contentItemsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { createHmac, timingSafeEqual } from "crypto";
import { ObjectStorageService } from "../lib/objectStorage";
import {
  TWITTER_API_BASE,
  buildTwitterAuthUrl,
  generatePkce,
  exchangeCodeForTokens,
  fetchTwitterUser,
  getTwitterAppCredentials,
  getTwitterAccount,
  ensureFreshTwitterToken,
  uploadTwitterMedia,
  type TwitterOAuth2Credentials,
} from "../lib/twitterApi";
import { trimToTweetLength } from "@workspace/social-limits";
import { encryptJson } from "../lib/secretCrypto";

const router: IRouter = Router();

const objectStorageService = new ObjectStorageService();

const STATE_TTL_MS = 10 * 60 * 1000;

router.param("id", (req, res, next, value) => {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  next();
});

function redirectUri(req: Request): string {
  const proto =
    (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0] ||
    req.protocol ||
    "https";
  const host =
    (req.headers["x-forwarded-host"] as string | undefined) || req.headers.host;
  return `${proto}://${host}/api/twitter/auth/callback`;
}

function isConfigured(app: unknown): boolean {
  return !!app && !!process.env.SESSION_SECRET;
}

/**
 * PKCE requires the code_verifier generated at authorize time to be recovered
 * at callback time. We embed it inside an HMAC-signed, short-lived `state`
 * value. Tampering is caught by the signature, and because we are a
 * confidential client the token exchange also demands the client secret — so a
 * verifier that leaks in the redirect URL is not enough to complete a flow.
 */
function signState(tenantId: number, verifier: string): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is required for OAuth state");
  const payload = `${tenantId}.${Date.now()}.${verifier}`;
  const sig = createHmac("sha256", secret).update(payload).digest("hex");
  return Buffer.from(`${payload}.${sig}`, "utf8").toString("base64url");
}

function verifyState(
  state: string,
  tenantId: number,
): { verifier: string } | null {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return null;
  try {
    const decoded = Buffer.from(state, "base64url").toString("utf8");
    const lastDot = decoded.lastIndexOf(".");
    if (lastDot < 0) return null;
    const payload = decoded.slice(0, lastDot);
    const sig = decoded.slice(lastDot + 1);
    const expected = createHmac("sha256", secret).update(payload).digest("hex");
    const sigBuf = Buffer.from(sig, "hex");
    const expBuf = Buffer.from(expected, "hex");
    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
      return null;
    }
    // payload = tenantId.timestamp.verifier — the verifier may itself contain no
    // dots (base64url), so split into exactly three parts.
    const firstDot = payload.indexOf(".");
    const secondDot = payload.indexOf(".", firstDot + 1);
    if (firstDot < 0 || secondDot < 0) return null;
    const tid = payload.slice(0, firstDot);
    const ts = payload.slice(firstDot + 1, secondDot);
    const verifier = payload.slice(secondDot + 1);
    if (Number(tid) !== tenantId) return null;
    if (!Number.isFinite(Number(ts)) || Date.now() - Number(ts) > STATE_TTL_MS) {
      return null;
    }
    if (!verifier) return null;
    return { verifier };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// OAuth 2.0 PKCE connect flow
// ---------------------------------------------------------------------------

router.get("/twitter/auth/url", async (req: Request, res: Response) => {
  const app = await getTwitterAppCredentials();
  if (!app || !isConfigured(app)) {
    res.status(503).json({
      error:
        "X is not configured. An administrator must add the X OAuth 2.0 client credentials first.",
    });
    return;
  }
  const { verifier, challenge } = generatePkce();
  const url = buildTwitterAuthUrl({
    clientId: app.clientId,
    redirectUri: redirectUri(req),
    state: signState(req.tenantId, verifier),
    challenge,
  });
  res.json({ url });
});

router.get("/twitter/auth/callback", async (req: Request, res: Response) => {
  const webBase = "/accounts";
  const fail = (reason: string) =>
    res.redirect(`${webBase}?twitter=error&reason=${encodeURIComponent(reason)}`);

  const app = await getTwitterAppCredentials();
  if (!app || !isConfigured(app)) {
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
  if (!code || !state) {
    fail("invalid_state");
    return;
  }
  const verified = verifyState(state, req.tenantId);
  if (!verified) {
    fail("invalid_state");
    return;
  }

  try {
    const tokens = await exchangeCodeForTokens({
      app,
      code,
      redirectUri: redirectUri(req),
      verifier: verified.verifier,
    });

    const user = await fetchTwitterUser(tokens.accessToken);
    if (!user) {
      fail("userinfo");
      return;
    }

    const encryptedCredentials = encryptJson({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    } satisfies TwitterOAuth2Credentials);
    const now = new Date();
    const existing = await getTwitterAccount(req.tenantId);
    if (existing) {
      await db
        .update(connectedAccountsTable)
        .set({
          accountName: user.accountName,
          status: "connected",
          encryptedCredentials,
          tokenExpiresAt: tokens.expiresAt,
          providerUserId: user.id,
          accessToken: null,
          verifyStatus: "verified",
          verifyError: null,
          verifiedAt: now,
        })
        .where(eq(connectedAccountsTable.id, existing.id));
    } else {
      await db.insert(connectedAccountsTable).values({
        tenantId: req.tenantId,
        platform: "twitter",
        accountName: user.accountName,
        status: "connected",
        encryptedCredentials,
        tokenExpiresAt: tokens.expiresAt,
        providerUserId: user.id,
        verifyStatus: "verified",
        verifyError: null,
        verifiedAt: now,
      });
    }

    res.redirect(`${webBase}?twitter=connected`);
  } catch (error) {
    req.log.error({ err: error }, "X OAuth callback failed");
    fail("token_exchange");
  }
});

function serializeStatus(
  req: Request,
  configured: boolean,
  account: Awaited<ReturnType<typeof getTwitterAccount>> | undefined,
) {
  const usable =
    !!account &&
    !!account.encryptedCredentials &&
    account.status !== "disconnected" &&
    account.verifyStatus !== "failed";
  // A stored-but-unusable connection (revoked/expired/legacy OAuth 1.0a) should
  // prompt a reconnect rather than look like it was never connected.
  const expired =
    !!account &&
    !!account.encryptedCredentials &&
    account.status !== "disconnected" &&
    !usable;
  return {
    connected: usable,
    accountName: usable ? account!.accountName : null,
    configured,
    redirectUri: redirectUri(req),
    expired,
  };
}

router.get("/twitter/status", async (req: Request, res: Response) => {
  const [app, account] = await Promise.all([
    getTwitterAppCredentials(),
    getTwitterAccount(req.tenantId),
  ]);
  res.json(serializeStatus(req, isConfigured(app), account));
});

router.delete("/twitter", async (req: Request, res: Response) => {
  const existing = await getTwitterAccount(req.tenantId);
  if (existing) {
    await db
      .update(connectedAccountsTable)
      .set({
        status: "disconnected",
        encryptedCredentials: null,
        accessToken: null,
        tokenExpiresAt: null,
        providerUserId: null,
        verifyStatus: null,
        verifyError: null,
      })
      .where(eq(connectedAccountsTable.id, existing.id));
  }
  const app = await getTwitterAppCredentials();
  res.json(serializeStatus(req, isConfigured(app), undefined));
});

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

async function loadContentItem(id: number, tenantId: number) {
  return (
    await db
      .select()
      .from(contentItemsTable)
      .where(
        and(
          eq(contentItemsTable.id, id),
          eq(contentItemsTable.tenantId, tenantId),
        ),
      )
      .limit(1)
  )[0];
}

async function markPublished(
  id: number,
  tenantId: number,
  meta?: { postId?: string | null; permalink?: string | null },
) {
  await db
    .update(contentItemsTable)
    .set({
      status: "published",
      postId: meta?.postId || null,
      permalink: meta?.permalink || null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(contentItemsTable.id, id),
        eq(contentItemsTable.tenantId, tenantId),
      ),
    );
}

/**
 * POST /content/:id/publish-twitter
 * Publish a content item to the tenant's connected X account using their stored
 * OAuth 2.0 access token (refreshed on demand). Image uploads and tweet
 * creation both authorize with the bearer token — no OAuth 1.0a signing.
 */
router.post(
  "/content/:id/publish-twitter",
  async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const item = await loadContentItem(id, req.tenantId);
    if (!item) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const app = await getTwitterAppCredentials();
    if (!app) {
      res.status(400).json({
        error:
          "X app credentials have not been configured by an administrator yet.",
      });
      return;
    }

    const tokenResult = await ensureFreshTwitterToken(req.tenantId, app);
    if (!tokenResult.ok) {
      res.status(400).json({ error: tokenResult.message });
      return;
    }
    const { accessToken, accountName } = tokenResult;

    const text = trimToTweetLength((item.caption?.trim() || item.title).trim());

    try {
      let mediaId: string | null = null;

      if (item.imagePath) {
        const file = await objectStorageService.getObjectEntityFile(
          item.imagePath,
        );
        const [buffer] = await file.download();
        mediaId = await uploadTwitterMedia({
          buffer,
          contentType: "image/png",
          accessToken,
        });
      }

      const tweetUrl = `${TWITTER_API_BASE}/2/tweets`;
      const tweetBody: Record<string, unknown> = { text };
      if (mediaId) {
        tweetBody.media = { media_ids: [mediaId] };
      }
      const tweetRes = await fetch(tweetUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(tweetBody),
      });
      const tweetJson = (await tweetRes.json()) as {
        data?: { id?: string };
        errors?: { message?: string; detail?: string }[];
        title?: string;
        detail?: string;
      };
      if (!tweetRes.ok || !tweetJson.data?.id) {
        throw new Error(
          tweetJson.errors?.[0]?.detail ||
            tweetJson.errors?.[0]?.message ||
            tweetJson.detail ||
            tweetJson.title ||
            `X API error (${tweetRes.status})`,
        );
      }

      const postId = tweetJson.data.id;
      const handle = accountName.startsWith("@")
        ? accountName.slice(1)
        : accountName;
      const permalink = postId
        ? `https://x.com/${encodeURIComponent(handle)}/status/${postId}`
        : null;
      await markPublished(id, req.tenantId, { postId, permalink });
      res.json({ postId, permalink });
    } catch (error) {
      req.log.error({ err: error }, "X publish failed");
      res.status(502).json({
        error:
          error instanceof Error
            ? `X rejected the post: ${error.message}`
            : "Failed to publish to X.",
      });
    }
  },
);

export default router;
