import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  connectedAccountsTable,
  contentItemsTable,
  appCredentialsTable,
  type ThreadsAppCredentials,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { ObjectStorageService } from "../lib/objectStorage";
import { decryptJson } from "../lib/secretCrypto";
import {
  signOAuthState,
  verifySignedOAuthState,
  randomNonce,
} from "../lib/oauthState";
import {
  notifySocialConnectionFailed,
  resolveSocialConnectionNotifications,
} from "../lib/notifications";
import { chunkOnWhitespace } from "@workspace/social-limits";

const router: IRouter = Router();

const objectStorageService = new ObjectStorageService();

const OAUTH_SCOPE = "threads_basic,threads_content_publish";
const AUTH_BASE = "https://threads.net/oauth/authorize";
const TOKEN_URL = "https://graph.threads.net/oauth/access_token";
const GRAPH_BASE = "https://graph.threads.net/v1.0";
const LONG_LIVED_URL = "https://graph.threads.net/access_token";
const REFRESH_URL = "https://graph.threads.net/refresh_access_token";

/** Threads posts are capped at 500 characters of text. */
const THREADS_MAX_LENGTH = 500;

/**
 * App-level Threads OAuth credentials (the Threads App ID/Secret from a Meta
 * app with the "Access the Threads API" use case). Superadmin-managed database
 * row, encrypted at rest. Returns null when not configured.
 */
async function getCredentials(): Promise<{
  appId: string;
  appSecret: string;
} | null> {
  try {
    const row = (
      await db
        .select()
        .from(appCredentialsTable)
        .where(eq(appCredentialsTable.provider, "threads"))
        .limit(1)
    )[0];
    if (row) {
      const creds = decryptJson<ThreadsAppCredentials>(row.encryptedCredentials);
      if (creds.appId && creds.appSecret) return creds;
    }
  } catch {
    // Not configured / decrypt failure — treated as unconfigured.
  }
  return null;
}

function redirectUri(req: Request): string {
  const proto =
    (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0] ||
    req.protocol ||
    "https";
  const host =
    (req.headers["x-forwarded-host"] as string | undefined) || req.headers.host;
  return `${proto}://${host}/api/threads/auth/callback`;
}

async function isConfigured(): Promise<boolean> {
  return !!(await getCredentials()) && !!process.env.SESSION_SECRET;
}

async function getThreadsAccount(tenantId: number) {
  return (
    await db
      .select()
      .from(connectedAccountsTable)
      .where(
        and(
          eq(connectedAccountsTable.tenantId, tenantId),
          eq(connectedAccountsTable.platform, "threads"),
        ),
      )
      .limit(1)
  )[0];
}

type ThreadsAccount = NonNullable<Awaited<ReturnType<typeof getThreadsAccount>>>;

/**
 * Threads long-lived tokens last ~60 days and can be refreshed (rolling) once
 * they are at least 24h old. Proactively refresh when within the renewal
 * window so an actively-used connection never lapses. On a definitive
 * rejection the row is flipped to failed so the UI prompts a reconnect;
 * transient errors leave the stored token as-is. Never throws.
 */
const REFRESH_WHEN_REMAINING_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

async function maybeRefreshToken(
  tenantId: number,
  account: ThreadsAccount,
): Promise<ThreadsAccount> {
  if (!account.accessToken || account.tokenExpiresAt === null) return account;
  const remaining = account.tokenExpiresAt.getTime() - Date.now();
  if (remaining > REFRESH_WHEN_REMAINING_MS) return account;

  try {
    const params = new URLSearchParams({
      grant_type: "th_refresh_token",
      access_token: account.accessToken,
    });
    const res = await fetch(`${REFRESH_URL}?${params.toString()}`);
    const json = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (res.ok && json.access_token) {
      await db
        .update(connectedAccountsTable)
        .set({
          accessToken: json.access_token,
          tokenExpiresAt: json.expires_in
            ? new Date(Date.now() + json.expires_in * 1000)
            : null,
          status: "connected",
          verifyStatus: "verified",
          verifyError: null,
          verifiedAt: new Date(),
        })
        .where(eq(connectedAccountsTable.id, account.id));
      await resolveSocialConnectionNotifications(account.tenantId, "threads");
    } else if (remaining <= 0 || res.status === 400 || res.status === 401) {
      // Token already dead and Threads refused to renew it.
      await db
        .update(connectedAccountsTable)
        .set({
          status: "error",
          verifyStatus: "failed",
          verifyError:
            "Your Threads access is no longer valid. Reconnect Threads to keep publishing.",
          verifiedAt: new Date(),
        })
        .where(eq(connectedAccountsTable.id, account.id));
      if (account.verifyStatus === "verified") {
        await notifySocialConnectionFailed(
          tenantId,
          "threads",
          "Your Threads access is no longer valid. Reconnect Threads to keep publishing.",
        );
      }
    }
  } catch {
    // Transient/network error: keep the stored token, try again next time.
  }

  return (await getThreadsAccount(tenantId)) ?? account;
}

router.param("id", (req, res, next, value) => {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  next();
});

router.get("/threads/auth/url", async (req: Request, res: Response) => {
  const creds = await getCredentials();
  if (!creds || !process.env.SESSION_SECRET) {
    res.status(503).json({
      error:
        "Threads is not configured. Ask an administrator to save the Threads App ID and App Secret on the Admin page.",
    });
    return;
  }
  const params = new URLSearchParams({
    client_id: creds.appId,
    redirect_uri: redirectUri(req),
    scope: OAUTH_SCOPE,
    response_type: "code",
    state: signOAuthState(req.tenantId, randomNonce()),
  });
  res.json({ url: `${AUTH_BASE}?${params.toString()}` });
});

/**
 * The OAuth callback lives on a separate PUBLIC router (mounted before the
 * session gate in routes/index.ts): it arrives as a top-level browser
 * navigation from threads.net that may not carry the app's session token.
 * The HMAC-signed, TTL'd `state` minted by /threads/auth/url is what
 * authenticates the request and identifies the initiating tenant.
 */
export const threadsCallbackRouter: IRouter = Router();

threadsCallbackRouter.get(
  "/threads/auth/callback",
  async (req: Request, res: Response) => {
    const webBase = "/accounts";
    const fail = (reason: string) =>
      res.redirect(`${webBase}?threads=error&reason=${encodeURIComponent(reason)}`);

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
      // 1) Exchange the code for a short-lived (1h) token.
      const tokenRes = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: creds.appId,
          client_secret: creds.appSecret,
          grant_type: "authorization_code",
          redirect_uri: redirectUri(req),
          code,
        }).toString(),
      });
      const tokenJson = (await tokenRes.json()) as {
        access_token?: string;
        user_id?: number | string;
        error_message?: string;
      };
      if (!tokenRes.ok || !tokenJson.access_token) {
        req.log.error(
          { status: tokenRes.status, error: tokenJson.error_message },
          "Threads token exchange failed",
        );
        fail("token_exchange");
        return;
      }

      // 2) Upgrade to a long-lived (~60 day) token so the connection outlives
      // the one-hour short-lived token. The secret goes in the query per the
      // Threads API contract; this is a server-to-server HTTPS call.
      const longParams = new URLSearchParams({
        grant_type: "th_exchange_token",
        client_secret: creds.appSecret,
        access_token: tokenJson.access_token,
      });
      const longRes = await fetch(`${LONG_LIVED_URL}?${longParams.toString()}`);
      const longJson = (await longRes.json()) as {
        access_token?: string;
        expires_in?: number;
      };
      if (!longRes.ok || !longJson.access_token) {
        req.log.error(
          { status: longRes.status },
          "Threads long-lived token exchange failed",
        );
        fail("token_exchange");
        return;
      }

      const accessToken = longJson.access_token;
      const expiresAt = longJson.expires_in
        ? new Date(Date.now() + longJson.expires_in * 1000)
        : null;

      // 3) Look up the profile for a display name + stable user id.
      const meRes = await fetch(
        `${GRAPH_BASE}/me?fields=id,username&access_token=${encodeURIComponent(accessToken)}`,
      );
      const meJson = (await meRes.json()) as { id?: string; username?: string };
      if (!meRes.ok || !meJson.id) {
        req.log.error({ status: meRes.status }, "Threads profile lookup failed");
        fail("profile_lookup");
        return;
      }

      const accountName = meJson.username ? `@${meJson.username}` : "Threads";
      const now = new Date();
      const existing = await getThreadsAccount(tenantId);
      if (existing) {
        await db
          .update(connectedAccountsTable)
          .set({
            accountName,
            status: "connected",
            accessToken,
            tokenExpiresAt: expiresAt,
            providerUserId: meJson.id,
            verifyStatus: "verified",
            verifyError: null,
            verifiedAt: now,
          })
          .where(eq(connectedAccountsTable.id, existing.id));
      } else {
        await db.insert(connectedAccountsTable).values({
          tenantId,
          platform: "threads",
          accountName,
          status: "connected",
          accessToken,
          tokenExpiresAt: expiresAt,
          providerUserId: meJson.id,
          verifyStatus: "verified",
          verifyError: null,
          verifiedAt: now,
        });
      }

      // Reconnecting clears any lingering "connection failed" notification.
      await resolveSocialConnectionNotifications(tenantId, "threads");

      res.redirect(`${webBase}?threads=connected`);
    } catch (error) {
      req.log.error({ err: error }, "Threads OAuth callback failed");
      fail("server_error");
    }
  },
);

function serializeStatus(
  req: Request,
  account: Awaited<ReturnType<typeof getThreadsAccount>> | undefined,
  configured: boolean,
) {
  const connected =
    !!account?.accessToken &&
    account.verifyStatus !== "failed" &&
    (account.tokenExpiresAt === null ||
      account.tokenExpiresAt.getTime() > Date.now());
  const expired = !!account?.accessToken && !connected;
  return {
    connected,
    accountName: connected ? account!.accountName : null,
    configured,
    redirectUri: redirectUri(req),
    expired,
  };
}

router.get("/threads/status", async (req: Request, res: Response) => {
  let account = await getThreadsAccount(req.tenantId);
  if (account?.accessToken && account.verifyStatus !== "failed") {
    account = await maybeRefreshToken(req.tenantId, account);
  }
  res.json(serializeStatus(req, account, await isConfigured()));
});

router.delete("/threads", async (req: Request, res: Response) => {
  const existing = await getThreadsAccount(req.tenantId);
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
  res.json(serializeStatus(req, undefined, await isConfigured()));
});

router.post("/threads/retest", async (req: Request, res: Response) => {
  const existing = await getThreadsAccount(req.tenantId);
  if (!existing?.accessToken) {
    res.status(400).json({ error: "No stored Threads connection to re-test." });
    return;
  }

  let stillValid = false;
  let accountName = existing.accountName;
  let providerUserId = existing.providerUserId;
  try {
    const meRes = await fetch(
      `${GRAPH_BASE}/me?fields=id,username&access_token=${encodeURIComponent(existing.accessToken)}`,
    );
    const meJson = (await meRes.json()) as { id?: string; username?: string };
    if (meRes.ok && meJson.id) {
      stillValid = true;
      accountName = meJson.username ? `@${meJson.username}` : accountName;
      providerUserId = meJson.id;
    }
  } catch (error) {
    req.log.error({ err: error }, "Threads re-test failed");
  }

  if (stillValid) {
    await db
      .update(connectedAccountsTable)
      .set({
        status: "connected",
        accountName,
        providerUserId,
        verifyStatus: "verified",
        verifyError: null,
        verifiedAt: new Date(),
      })
      .where(eq(connectedAccountsTable.id, existing.id));
    await resolveSocialConnectionNotifications(existing.tenantId, "threads");
  } else {
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

  const refreshed = await getThreadsAccount(req.tenantId);
  res.json(serializeStatus(req, refreshed, await isConfigured()));
});

type ThreadsErrorBody = {
  error?: { message?: string; error_user_msg?: string };
};

async function threadsErrorMessage(res: globalThis.Response, fallback: string) {
  try {
    const json = (await res.json()) as ThreadsErrorBody;
    return json.error?.error_user_msg || json.error?.message || fallback;
  } catch {
    return fallback;
  }
}

/**
 * How far back a previous publish attempt's posts still count as "this
 * content already landed". A retried publish (the user re-clicking after a
 * transient-looking failure, or any future auto-retry) happens within
 * minutes; older identical posts are treated as intentional re-posts.
 */
const PUBLISH_DEDUPE_WINDOW_MS = 10 * 60 * 1000;

type RecentThreadPost = { id: string; text: string; createdAtMs: number };

/**
 * Fetch the account's most recent Threads posts so a (re-)publish can detect
 * that a previous attempt actually landed despite a lost/transient-looking
 * response. Threads has no idempotency key for publishing, and long captions
 * publish as multi-post reply chains, so a blind retry can duplicate several
 * posts at once. Best-effort: any failure is treated as "no recent posts" by
 * the caller. The limit covers a full reply chain from a prior attempt.
 */
async function fetchRecentThreadPosts(
  userId: string,
  accessToken: string,
): Promise<RecentThreadPost[]> {
  const res = await fetch(
    `${GRAPH_BASE}/${encodeURIComponent(userId)}/threads?fields=id,text,timestamp&limit=25&access_token=${encodeURIComponent(accessToken)}`,
  );
  const json = (await res.json()) as {
    data?: Array<{ id?: string; text?: string; timestamp?: string }>;
  };
  if (!res.ok || !Array.isArray(json.data)) return [];
  const out: RecentThreadPost[] = [];
  for (const p of json.data) {
    if (!p.id || typeof p.text !== "string") continue;
    const createdAtMs = p.timestamp ? Date.parse(p.timestamp) : NaN;
    if (Number.isNaN(createdAtMs)) continue;
    out.push({ id: p.id, text: p.text, createdAtMs });
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
  recent: RecentThreadPost[],
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
 * Create a media container and publish it. Returns the published Threads
 * media id. `replyToId` chains the post as a reply for long-caption threads.
 */
async function publishOneThread(opts: {
  userId: string;
  accessToken: string;
  text: string;
  imageUrl: string | null;
  replyToId: string | null;
}): Promise<string> {
  const { userId, accessToken, text, imageUrl, replyToId } = opts;

  const createParams = new URLSearchParams({
    media_type: imageUrl ? "IMAGE" : "TEXT",
    text,
    access_token: accessToken,
  });
  if (imageUrl) createParams.set("image_url", imageUrl);
  if (replyToId) createParams.set("reply_to_id", replyToId);

  const createRes = await fetch(`${GRAPH_BASE}/${userId}/threads`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: createParams.toString(),
  });
  if (!createRes.ok) {
    throw new Error(
      await threadsErrorMessage(
        createRes,
        `Threads container error (${createRes.status})`,
      ),
    );
  }
  const createJson = (await createRes.json()) as { id?: string };
  if (!createJson.id) {
    throw new Error("Threads did not return a media container id.");
  }

  const publishRes = await fetch(`${GRAPH_BASE}/${userId}/threads_publish`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      creation_id: createJson.id,
      access_token: accessToken,
    }).toString(),
  });
  if (!publishRes.ok) {
    throw new Error(
      await threadsErrorMessage(
        publishRes,
        `Threads publish error (${publishRes.status})`,
      ),
    );
  }
  const publishJson = (await publishRes.json()) as { id?: string };
  if (!publishJson.id) {
    throw new Error("Threads did not return a published post id.");
  }
  return publishJson.id;
}

router.post(
  "/content/:id/publish-threads",
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

    let account = await getThreadsAccount(req.tenantId);
    if (account?.accessToken && account.verifyStatus !== "failed") {
      account = await maybeRefreshToken(req.tenantId, account);
    }
    const tokenValid =
      !!account?.accessToken &&
      account.verifyStatus !== "failed" &&
      (account.tokenExpiresAt === null ||
        account.tokenExpiresAt.getTime() > Date.now());
    if (!account || !tokenValid || !account.providerUserId) {
      res.status(400).json({
        error:
          "Threads is not connected or its access is no longer valid. Reconnect your Threads account on the Accounts page and try again.",
      });
      return;
    }

    const accessToken = account.accessToken!;
    const userId = account.providerUserId;

    // Long captions become a reply-chained thread (Threads is built for this):
    // the first post carries the image, follow-ups carry the remaining text.
    const fullText = (item.caption?.trim() || item.title).trim();
    const chunks = chunkOnWhitespace(fullText, THREADS_MAX_LENGTH);

    // A publish can commit on Threads but return a transient-looking error,
    // so a retry (the user re-clicking, or any future auto-retry) would post
    // the same content twice — and long captions duplicate a whole reply
    // chain. Before (re-)posting, probe the account's recent posts and
    // short-circuit any chunk that already landed within the dedupe window.
    // Best-effort: probe failure means no short-circuit.
    let recentPosts: RecentThreadPost[] = [];
    try {
      recentPosts = await fetchRecentThreadPosts(userId, accessToken);
    } catch (err) {
      req.log.warn(
        { err },
        "Threads duplicate-post probe failed; proceeding without dedupe",
      );
    }
    const dedupeSinceMs = Date.now() - PUBLISH_DEDUPE_WINDOW_MS;

    try {
      let firstPostId: string | null = null;
      let replyToId: string | null = null;
      let postsPublished = 0;
      let publishWarning: string | null = null;

      // If the first post already landed, its image went with it — skip
      // minting a signed URL entirely.
      const existingFirstId = takeMatchingRecentPost(
        recentPosts,
        chunks[0],
        dedupeSinceMs,
      );

      // Threads fetches the image itself, so hand it a short-lived signed GET
      // URL for the private object.
      let imageUrl: string | null = null;
      if (!existingFirstId && item.imagePath) {
        imageUrl = await objectStorageService.getSignedDownloadURL(
          item.imagePath,
          req.tenantId,
        );
      }

      for (const [index, text] of chunks.entries()) {
        try {
          const existingId =
            index === 0
              ? existingFirstId
              : takeMatchingRecentPost(recentPosts, text, dedupeSinceMs);
          let postId: string;
          if (existingId) {
            req.log.warn(
              { existingId, index },
              "Threads publish: this part of the content already landed recently; reusing the existing post instead of re-posting",
            );
            postId = existingId;
          } else {
            postId = await publishOneThread({
              userId,
              accessToken,
              text,
              imageUrl: index === 0 ? imageUrl : null,
              replyToId,
            });
            postsPublished += 1;
          }
          replyToId = postId;
          if (index === 0) firstPostId = postId;
        } catch (chunkError) {
          if (index === 0) throw chunkError;
          req.log.error(
            { err: chunkError, index },
            "Threads follow-up reply failed",
          );
          const remaining = chunks.length - index;
          publishWarning = `The post was published, but ${remaining} of ${chunks.length - 1} follow-up repl${remaining === 1 ? "y" : "ies"} with the rest of the caption could not be posted.`;
          break;
        }
      }

      const permalink = account.accountName?.startsWith("@")
        ? `https://www.threads.net/${account.accountName}`
        : null;

      await db
        .update(contentItemsTable)
        .set({
          status: "published",
          failureReason: null,
          postId: firstPostId,
          permalink,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(contentItemsTable.id, id),
            eq(contentItemsTable.tenantId, req.tenantId),
          ),
        );

      res.json({
        postId: firstPostId ?? "",
        permalink,
        postsPublished,
        postsTotal: chunks.length,
        ...(publishWarning ? { publishWarning } : {}),
      });
    } catch (error) {
      req.log.error({ err: error }, "Threads publish failed");
      const reason =
        error instanceof Error && error.message
          ? `Threads rejected the post: ${error.message}`
          : "Failed to publish to Threads.";
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
          "Failed to record Threads publish failure",
        );
      }
      res.status(502).json({ error: reason });
    }
  },
);

export default router;
