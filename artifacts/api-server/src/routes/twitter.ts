import { Router, type IRouter, type Request, type Response } from "express";
import { db, connectedAccountsTable, contentItemsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
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
  splitIntoTweets,
  type TwitterOAuth2Credentials,
} from "../lib/twitterApi";
import { encryptJson } from "../lib/secretCrypto";
import { signOAuthState, verifySignedOAuthState } from "../lib/oauthState";
import { reverifyTwitter } from "../lib/socialReverify";

const router: IRouter = Router();

const objectStorageService = new ObjectStorageService();

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

// ---------------------------------------------------------------------------
// OAuth 2.0 PKCE connect flow
//
// PKCE requires the code_verifier generated at authorize time to be recovered
// at callback time. We embed it as the opaque `data` field of the shared,
// HMAC-signed, short-lived, tenant-bound OAuth state (see lib/oauthState). A
// verifier that leaks in the redirect URL is not enough to complete a flow,
// since the confidential-client token exchange also demands the client secret.
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
    state: signOAuthState(req.tenantId, verifier),
    challenge,
  });
  res.json({ url });
});

/**
 * The OAuth callback lives on a separate PUBLIC router (mounted before the
 * session gate in routes/index.ts): it arrives as a top-level browser
 * navigation from x.com that may not carry the app's session token. The
 * HMAC-signed, TTL'd `state` minted by /twitter/auth/url is what authenticates
 * the request and identifies the initiating tenant.
 */
export const twitterCallbackRouter: IRouter = Router();

twitterCallbackRouter.get(
  "/twitter/auth/callback",
  async (req: Request, res: Response) => {
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
  const verified = verifySignedOAuthState(state);
  if (!verified || !verified.data) {
    fail("invalid_state");
    return;
  }
  const tenantId = verified.tenantId;

  try {
    const tokens = await exchangeCodeForTokens({
      app,
      code,
      redirectUri: redirectUri(req),
      verifier: verified.data,
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
    const existing = await getTwitterAccount(tenantId);
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
        tenantId,
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
  },
);

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
  const app = await getTwitterAppCredentials();
  let account = await getTwitterAccount(req.tenantId);
  // Proactively re-check a stored token so an expired/revoked one flips to
  // "failed" the moment the page loads, without waiting for a publish to fail.
  if (
    isConfigured(app) &&
    account?.encryptedCredentials &&
    account.status !== "disconnected"
  ) {
    try {
      account = (await reverifyTwitter(req.tenantId)) ?? account;
    } catch (err) {
      req.log.error({ err }, "X auto re-verify failed");
    }
  }
  res.json(serializeStatus(req, isConfigured(app), account));
});

/**
 * POST /twitter/retest
 * Force a live re-verification of the tenant's stored X connection without
 * reconnecting or re-entering anything. Refreshes the access token if needed and
 * confirms it still works, persisting the fresh status. Returns the same shape
 * as GET /twitter/status.
 */
router.post("/twitter/retest", async (req: Request, res: Response) => {
  const app = await getTwitterAppCredentials();
  if (!isConfigured(app)) {
    res.status(400).json({
      error:
        "X app credentials have not been configured by an administrator yet.",
    });
    return;
  }
  const existing = await getTwitterAccount(req.tenantId);
  if (!existing?.encryptedCredentials || existing.status === "disconnected") {
    res.status(400).json({ error: "No connected X account to re-test." });
    return;
  }
  try {
    await reverifyTwitter(req.tenantId, { force: true });
  } catch (err) {
    req.log.error({ err }, "X manual re-verify failed");
  }
  const account = await getTwitterAccount(req.tenantId);
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

/**
 * Post a single tweet (optionally with media and/or chained as a reply) and
 * return its id. Authorizes with the tenant's OAuth 2.0 bearer token — no
 * OAuth 1.0a signing. Throws with a safe, human-friendly message on failure.
 */
async function postTweet(opts: {
  text: string;
  mediaId: string | null;
  replyToId: string | null;
  accessToken: string;
}): Promise<string> {
  const { text, mediaId, replyToId, accessToken } = opts;
  const tweetUrl = `${TWITTER_API_BASE}/2/tweets`;
  const tweetBody: Record<string, unknown> = { text };
  if (mediaId) {
    tweetBody.media = { media_ids: [mediaId] };
  }
  if (replyToId) {
    tweetBody.reply = { in_reply_to_tweet_id: replyToId };
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
  return tweetJson.data.id;
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

    const text = (item.caption?.trim() || item.title).trim();
    // Long captions are posted as a reply-chained thread instead of being
    // truncated, so the full message survives.
    const tweets = splitIntoTweets(text);

    try {
      let mediaId: string | null = null;

      if (item.imagePath) {
        const file = await objectStorageService.getObjectEntityFile(
          item.imagePath,
          req.tenantId,
        );
        const [buffer] = await file.download();
        mediaId = await uploadTwitterMedia({
          buffer,
          contentType: "image/png",
          accessToken,
        });
      }

      let firstPostId: string | null = null;
      let replyToId: string | null = null;

      for (let i = 0; i < tweets.length; i++) {
        // The attached image goes on the first tweet only.
        const attachMedia = i === 0 ? mediaId : null;
        const postId = await postTweet({
          text: tweets[i],
          mediaId: attachMedia,
          replyToId,
          accessToken,
        });
        if (i === 0) {
          firstPostId = postId;
        }
        replyToId = postId;
      }

      const handle = accountName.startsWith("@")
        ? accountName.slice(1)
        : accountName;
      const permalink = firstPostId
        ? `https://x.com/${encodeURIComponent(handle)}/status/${firstPostId}`
        : null;
      await markPublished(id, req.tenantId, { postId: firstPostId, permalink });
      res.json({ postId: firstPostId, permalink, tweetCount: tweets.length });
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
