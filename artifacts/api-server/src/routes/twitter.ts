import { buildPostText } from "../lib/postText";
import { Router, type IRouter, type Request, type Response } from "express";
import { trackSyncPublish } from "../middlewares/trackSyncPublish";
import { db, connectedAccountsTable, contentItemsTable } from "@workspace/db";
import { platformFetch } from "../lib/platformFetch";
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
import { resolveSocialConnectionNotifications } from "../lib/notifications";

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

    // Reconnecting clears any lingering "connection failed" notification.
    await resolveSocialConnectionNotifications(tenantId, "twitter");

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
 * How far back a previous publish attempt's posts still count as "this
 * content already landed". A retried publish (the user re-clicking after a
 * transient-looking failure, or any future auto-retry) happens within
 * minutes; older identical posts are treated as intentional re-posts.
 */
const PUBLISH_DEDUPE_WINDOW_MS = 10 * 60 * 1000;

type RecentTweet = { id: string; text: string; createdAtMs: number };

/**
 * Pagination bounds for the duplicate-post probe. The probe filters
 * server-side with the X API's `start_time` param, so on a quiet account one
 * page is plenty — but a busy account (or one posting from several tools at
 * once) can push a just-landed tweet past a single page, so the probe follows
 * `meta.next_token` up to `maxPages`. Exported (and mutable) so tests can
 * exercise the pagination without huge fixtures.
 */
export const TWITTER_DEDUPE_PROBE = {
  pageSize: 100,
  maxPages: 5,
};

/**
 * Fetch the account's recent tweets (created at/after `sinceMs`) so a
 * (re-)publish can detect that a previous attempt actually landed despite a
 * lost/transient-looking response. The X API has no idempotency key for tweet
 * creation, so probing recent posts is the only way to avoid double-posting
 * on retry. The window is bounded server-side via `start_time` and the probe
 * paginates (see TWITTER_DEDUPE_PROBE) so a landed tweet on a busy account
 * cannot scroll past the probed window. Best-effort: any failure is treated
 * as "no recent posts" by the caller.
 */
async function fetchRecentTweets(
  userId: string,
  accessToken: string,
  sinceMs: number,
): Promise<RecentTweet[]> {
  const baseUrl =
    `${TWITTER_API_BASE}/2/users/${encodeURIComponent(userId)}/tweets` +
    `?max_results=${TWITTER_DEDUPE_PROBE.pageSize}&tweet.fields=created_at` +
    `&start_time=${encodeURIComponent(new Date(sinceMs).toISOString())}`;
  const out: RecentTweet[] = [];
  let nextToken: string | undefined;
  for (let page = 0; page < TWITTER_DEDUPE_PROBE.maxPages; page++) {
    const url = nextToken
      ? `${baseUrl}&pagination_token=${encodeURIComponent(nextToken)}`
      : baseUrl;
    const res = await platformFetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const json = (await res.json()) as {
      data?: Array<{ id?: string; text?: string; created_at?: string }>;
      meta?: { next_token?: string };
    };
    if (!res.ok || !Array.isArray(json.data)) break;
    for (const t of json.data) {
      if (!t.id || typeof t.text !== "string") continue;
      const createdAtMs = t.created_at ? Date.parse(t.created_at) : NaN;
      if (Number.isNaN(createdAtMs)) continue;
      out.push({ id: t.id, text: t.text, createdAtMs });
    }
    nextToken = json.meta?.next_token;
    // No next page (or an empty page) means the start_time window is
    // exhausted.
    if (!nextToken || json.data.length === 0) break;
  }
  return out;
}

/**
 * Find (and consume) a recent post whose text exactly matches what we are
 * about to send and that was created within the dedupe window. Consuming the
 * match means two identical chunks in one publish can't both map to the same
 * existing post.
 */
function takeMatchingRecentPost(
  recent: { id: string; text: string; createdAtMs: number }[],
  text: string,
  sinceMs: number,
): string | null {
  if (!text) return null;
  const idx = recent.findIndex(
    (p) => p.text === text && p.createdAtMs >= sinceMs,
  );
  if (idx === -1) return null;
  const [match] = recent.splice(idx, 1);
  return match.id;
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
  const tweetRes = await platformFetch(tweetUrl, {
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

/**
 * POST /content/:id/publish-twitter
 * Publish a content item to the tenant's connected X account using their stored
 * OAuth 2.0 access token (refreshed on demand). Image uploads and tweet
 * creation both authorize with the bearer token — no OAuth 1.0a signing.
 */
router.post(
  "/content/:id/publish-twitter",
  trackSyncPublish,
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

    const text = buildPostText(item.title, item.caption);
    // Long captions are posted as a reply-chained thread instead of being
    // truncated, so the full message survives.
    const tweets = splitIntoTweets(text);

    // A publish can commit on X but return a transient-looking error, so a
    // retry (the user re-clicking, or any future auto-retry) would post the
    // same content twice. Before (re-)posting, probe the account's recent
    // tweets and short-circuit any chunk that already landed within the
    // dedupe window. Best-effort: probe failure means no short-circuit.
    const dedupeSinceMs = Date.now() - PUBLISH_DEDUPE_WINDOW_MS;
    let recentPosts: RecentTweet[] = [];
    const account = await getTwitterAccount(req.tenantId);
    if (account?.providerUserId) {
      try {
        recentPosts = await fetchRecentTweets(
          account.providerUserId,
          accessToken,
          dedupeSinceMs,
        );
      } catch (err) {
        req.log.warn(
          { err },
          "X duplicate-post probe failed; proceeding without dedupe",
        );
      }
    }

    try {
      let mediaId: string | null = null;

      // If the first tweet already landed, its media went with it — skip the
      // upload entirely.
      const existingFirstId = takeMatchingRecentPost(
        recentPosts,
        tweets[0],
        dedupeSinceMs,
      );

      if (!existingFirstId && item.imagePath) {
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
      let publishWarning: string | null = null;
      // Set when a follow-up tweet fails mid-thread: how many leading tweets
      // made it, so a resend can pick up from there.
      let chainPostedCount: number | null = null;

      for (let i = 0; i < tweets.length; i++) {
        try {
          const existingId =
            i === 0
              ? existingFirstId
              : takeMatchingRecentPost(recentPosts, tweets[i], dedupeSinceMs);
          let postId: string;
          if (existingId) {
            req.log.warn(
              { existingId, index: i },
              "X publish: this part of the content already landed recently; reusing the existing post instead of re-posting",
            );
            postId = existingId;
          } else {
            // The attached image goes on the first tweet only.
            const attachMedia = i === 0 ? mediaId : null;
            postId = await postTweet({
              text: tweets[i],
              mediaId: attachMedia,
              replyToId,
              accessToken,
            });
          }
          if (i === 0) {
            firstPostId = postId;
          }
          replyToId = postId;
        } catch (tweetError) {
          // The first tweet failing means nothing was posted — that is a
          // real publish failure. A follow-up failing leaves the thread
          // incomplete: keep the item published, surface a warning, and
          // record what is missing so it can be resent.
          if (i === 0) throw tweetError;
          req.log.error({ err: tweetError, index: i }, "X follow-up tweet failed");
          const remaining = tweets.length - i;
          publishWarning = `The post was published, but ${remaining} of ${tweets.length - 1} follow-up tweet${remaining === 1 ? "" : "s"} with the rest of the caption could not be posted.`;
          chainPostedCount = i;
          break;
        }
      }

      const handle = accountName.startsWith("@")
        ? accountName.slice(1)
        : accountName;
      const permalink = firstPostId
        ? `https://x.com/${encodeURIComponent(handle)}/status/${firstPostId}`
        : null;
      await db
        .update(contentItemsTable)
        .set({
          status: "published",
          failureReason: null,
          postId: firstPostId,
          permalink,
          // Persist which thread posts made it (with the exact texts, so a
          // later caption edit can't change what a resend posts) whenever the
          // thread is incomplete; the resend endpoint picks up from
          // postedCount, replying to lastPostedId. A complete publish starts
          // fresh, clearing any stale state from an earlier attempt.
          twitterChainState:
            chainPostedCount !== null && firstPostId && replyToId
              ? {
                  firstPostId,
                  lastPostedId: replyToId,
                  posts: tweets,
                  postedCount: chainPostedCount,
                }
              : null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(contentItemsTable.id, id),
            eq(contentItemsTable.tenantId, req.tenantId),
          ),
        );
      res.json({
        postId: firstPostId,
        permalink,
        tweetCount: tweets.length,
        ...(publishWarning ? { publishWarning } : {}),
      });
    } catch (error) {
      req.log.error({ err: error }, "X publish failed");
      const reason =
        error instanceof Error && error.message
          ? `X rejected the post: ${error.message}`
          : "Failed to publish to X.";
      // Persist the rejection so it stays reviewable in the Content Library
      // after the toast is gone. Best-effort: a DB hiccup here must not mask
      // the original publish error in the response.
      try {
        await db
          .update(contentItemsTable)
          .set({ status: "failed", failureReason: reason, updatedAt: new Date() })
          .where(
            and(
              eq(contentItemsTable.id, id),
              eq(contentItemsTable.tenantId, req.tenantId),
            ),
          );
      } catch (updateErr) {
        req.log.error(
          { err: updateErr, contentItemId: id },
          "Failed to record X publish failure",
        );
      }
      res.status(502).json({ error: reason });
    }
  },
);

/**
 * Resend the thread posts that failed during an earlier publish. Posts only
 * the missing pieces (from the persisted snapshot, so a later caption edit
 * cannot change what goes out), chained onto the last successfully posted
 * tweet, and clears the state once the thread is complete.
 */
router.post(
  "/content/:id/resend-twitter-posts",
  async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const item = await loadContentItem(id, req.tenantId);
    if (!item) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const state = item.twitterChainState;
    if (!state || state.postedCount >= state.posts.length) {
      res.status(400).json({
        error: "There are no missing X follow-up posts to resend.",
      });
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
    const { accessToken } = tokenResult;

    // Best-effort dedupe: if a previous resend attempt actually posted a
    // missing piece but the response was lost, reuse it instead of
    // double-posting.
    const dedupeSinceMs = Date.now() - PUBLISH_DEDUPE_WINDOW_MS;
    let recentPosts: RecentTweet[] = [];
    const account = await getTwitterAccount(req.tenantId);
    if (account?.providerUserId) {
      try {
        recentPosts = await fetchRecentTweets(
          account.providerUserId,
          accessToken,
          dedupeSinceMs,
        );
      } catch (err) {
        req.log.warn(
          { err },
          "X duplicate-post probe failed; proceeding without dedupe",
        );
      }
    }

    let postedCount = state.postedCount;
    let replyToId = state.lastPostedId;
    let publishWarning: string | null = null;
    for (let i = postedCount; i < state.posts.length; i++) {
      const text = state.posts[i]!;
      try {
        const existingId = takeMatchingRecentPost(
          recentPosts,
          text,
          dedupeSinceMs,
        );
        let postId: string;
        if (existingId) {
          req.log.warn(
            { existingId, index: i },
            "X resend: this part of the thread already landed recently; reusing the existing post instead of re-posting",
          );
          postId = existingId;
        } else {
          postId = await postTweet({
            text,
            mediaId: null,
            replyToId,
            accessToken,
          });
        }
        replyToId = postId;
        postedCount += 1;
      } catch (tweetError) {
        req.log.error({ err: tweetError, index: i }, "X thread resend failed");
        const remaining = state.posts.length - postedCount;
        publishWarning = `${remaining} of ${state.posts.length} thread post(s) still could not be published. You can try resending again.`;
        break;
      }
    }

    const complete = postedCount >= state.posts.length;
    await db
      .update(contentItemsTable)
      .set({
        twitterChainState: complete
          ? null
          : { ...state, postedCount, lastPostedId: replyToId },
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(contentItemsTable.id, id),
          eq(contentItemsTable.tenantId, req.tenantId),
        ),
      );

    res.json({
      postsPublished: postedCount,
      postsTotal: state.posts.length,
      postsRemaining: state.posts.length - postedCount,
      permalink: item.permalink ?? null,
      ...(publishWarning ? { publishWarning } : {}),
    });
  },
);

export default router;
