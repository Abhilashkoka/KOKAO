import { mergePublishedPlatform } from "../lib/publishedPlatforms";
import { recordTasteSignalFromContent } from "../lib/tasteMemory";
import { buildPostText } from "../lib/postText";
import { Router, type IRouter, type Request, type Response } from "express";
import { trackSyncPublish } from "../middlewares/trackSyncPublish";
import {
  db,
  connectedAccountsTable,
  contentItemsTable,
  appCredentialsTable,
  type LinkedinAppCredentials,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { ObjectStorageService } from "../lib/objectStorage";
import { decryptJson, encryptJson } from "../lib/secretCrypto";
import type { LinkedinOrganicStoredCredentials } from "../lib/linkedinOrganicRefresh";
import { platformFetch } from "../lib/platformFetch";
import {
  signOAuthState,
  verifySignedOAuthState,
  randomNonce,
} from "../lib/oauthState";
import { resolveSocialConnectionNotifications } from "../lib/notifications";
import {
  reverifyLinkedin,
  markAccountVerifyFailed,
  PublishAuthRevokedError,
  LINKEDIN_TOKEN_INVALID_MESSAGE,
} from "../lib/socialReverify";
import { splitForLinkedin } from "@workspace/social-limits";
import {
  tryAcquireResendLock,
  RESEND_IN_PROGRESS_MESSAGE,
  PUBLISH_IN_PROGRESS_MESSAGE,
} from "../lib/resendLock";
import { logger } from "../lib/logger";
import type { PublishOutcome } from "../lib/publishOutcome";
import {
  PublishTransientError,
  isTransientPlatformStatus,
} from "../lib/publishOutcome";
import {
  getLinkedinAppCredentials,
  isLinkedinAppConfigured,
  LINKEDIN_AUTH_BASE,
  linkedinTokenUrl,
  linkedinUserinfoUrl,
} from "../lib/linkedinApp";

const router: IRouter = Router();

/**
 * The same friendly reconnect message the pre-publish gate returns. A token
 * that dies in the window between the pre-publish re-verify and the actual
 * write must surface this — never the raw LinkedIn error.
 */
const LINKEDIN_RECONNECT_MESSAGE =
  "LinkedIn is not connected or its access token is no longer valid. Reconnect your LinkedIn account on the Accounts page and try again.";

const objectStorageService = new ObjectStorageService();

const LINKEDIN_VERSION = process.env.LINKEDIN_API_VERSION || "202506";
const OAUTH_SCOPE = "openid profile w_member_social";
const AUTH_BASE = LINKEDIN_AUTH_BASE;
const REST_BASE = "https://api.linkedin.com/rest";

/** Shared app-level LinkedIn OAuth credentials (see lib/linkedinApp). */
const getCredentials = getLinkedinAppCredentials;

function redirectUri(req: Request): string {
  const proto =
    (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0] ||
    req.protocol ||
    "https";
  const host =
    (req.headers["x-forwarded-host"] as string | undefined) || req.headers.host;
  return `${proto}://${host}/api/linkedin/auth/callback`;
}

const isConfigured = isLinkedinAppConfigured;

/**
 * LinkedIn's Posts API commentary uses the "Little Text" format, where a set of
 * reserved characters must be escaped with a leading backslash or the request
 * is rejected. Escape the backslash first so we don't double-escape.
 */
function escapeCommentary(text: string): string {
  return text.replace(/[\\<>@~#*_(){}\[\]|]/g, (c) => `\\${c}`);
}

/**
 * Post a single comment on an existing LinkedIn post via the socialActions
 * Comments API. Unlike the Posts API `commentary` field, comment `message.text`
 * is plain text (no "Little Text" escaping). The post URN must be URL-encoded
 * into the path. Throws on any non-2xx response so callers can surface the
 * failure without dropping the whole publish.
 */
async function postLinkedinComment(
  postUrn: string,
  author: string,
  text: string,
  baseHeaders: Record<string, string>,
): Promise<void> {
  const res = await platformFetch(
    `${REST_BASE}/socialActions/${encodeURIComponent(postUrn)}/comments`,
    {
      method: "POST",
      headers: { ...baseHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        actor: author,
        object: postUrn,
        message: { text },
      }),
    },
  );
  if (res.status !== 201 && !res.ok) {
    // The token died mid-sequence. Never surface the raw LinkedIn error.
    if (res.status === 401 || res.status === 403) {
      throw new PublishAuthRevokedError(LINKEDIN_RECONNECT_MESSAGE);
    }
    let detail = `LinkedIn comment error (${res.status})`;
    try {
      const errJson = (await res.json()) as { message?: string };
      if (errJson.message) detail = errJson.message;
    } catch {
      /* ignore non-JSON body */
    }
    throw new Error(detail);
  }
}

/**
 * Pagination bounds for the existing-comments probe. A post can accumulate
 * many comments (reader replies plus our own overflow chain), so an
 * already-posted overflow comment can scroll past the first page of the
 * socialActions comments listing. The probe pages with `start`/`count` up to
 * `maxPages` (mirrors LINKEDIN_DEDUPE_PROBE for the duplicate-post probe).
 * Exported (and mutable) so tests can exercise the pagination without huge
 * fixtures.
 */
export const LINKEDIN_COMMENT_PROBE = {
  pageSize: 50,
  maxPages: 5,
};

/**
 * List the texts of the comments that already exist on a LinkedIn post via the
 * socialActions Comments API. Used by the resend flow to detect comments that
 * actually landed even though the original response was lost, so a resend
 * never posts the same comment twice. Pages through the listing (see
 * LINKEDIN_COMMENT_PROBE) so a duplicate comment on a busy post cannot hide
 * past the first page. Best-effort: callers treat a thrown error as
 * "unknown" and fall back to the persisted postedCount.
 */
async function fetchExistingCommentTexts(
  postUrn: string,
  baseHeaders: Record<string, string>,
): Promise<Set<string>> {
  const texts = new Set<string>();
  for (let page = 0; page < LINKEDIN_COMMENT_PROBE.maxPages; page++) {
    const start = page * LINKEDIN_COMMENT_PROBE.pageSize;
    const res = await platformFetch(
      `${REST_BASE}/socialActions/${encodeURIComponent(postUrn)}/comments` +
        `?start=${start}&count=${LINKEDIN_COMMENT_PROBE.pageSize}`,
      { headers: baseHeaders },
    );
    if (!res.ok) {
      throw new Error(`LinkedIn comments list error (${res.status})`);
    }
    const json = (await res.json()) as {
      elements?: Array<{ message?: { text?: string } }>;
    };
    const elements = json.elements ?? [];
    for (const c of elements) {
      if (typeof c.message?.text === "string") texts.add(c.message.text);
    }
    // Stop when the page came back short (no more comments); maxPages bounds
    // the work on pathologically busy posts.
    if (elements.length < LINKEDIN_COMMENT_PROBE.pageSize) break;
  }
  return texts;
}

/**
 * How far back a previous publish attempt's post still counts as "this
 * content already landed". A retried publish (the user re-clicking after a
 * transient-looking failure) happens within minutes; older identical posts
 * are treated as intentional re-posts.
 */
const PUBLISH_DEDUPE_WINDOW_MS = 10 * 60 * 1000;

type RecentLinkedinPost = {
  id: string;
  commentary: string;
  createdAtMs: number;
};

/**
 * Pagination bounds for the duplicate-post probe. LinkedIn's Posts API has no
 * server-side time filter for the author finder, so the probe pages through
 * results (sorted newest-first) with `start`/`count` until it walks past the
 * dedupe window or hits `maxPages` — a busy account (or one posting from
 * several tools at once) can push a just-landed post past a single page.
 * Exported (and mutable) so tests can exercise the pagination without huge
 * fixtures.
 */
export const LINKEDIN_DEDUPE_PROBE = {
  pageSize: 50,
  maxPages: 5,
};

/**
 * Fetch the member's recent posts (created at/after `sinceMs`) so a
 * (re-)publish can detect that a previous attempt actually landed despite a
 * lost/transient-looking response. LinkedIn's Posts API has no idempotency
 * key for post creation, so probing recent posts is the only way to avoid
 * double-posting on retry. The probe paginates (see LINKEDIN_DEDUPE_PROBE)
 * so a landed post on a busy account cannot scroll past the probed window.
 * NOTE: results are sorted by LAST_MODIFIED, not creation time — an edited
 * old post can appear before a just-landed one — so the probe must NOT stop
 * early when a page contains only old posts; it pages until the results run
 * out or the maxPages cap bounds the work.
 * Best-effort: any failure is treated as "no recent posts" by the caller.
 */
async function fetchRecentLinkedinPosts(
  author: string,
  baseHeaders: Record<string, string>,
  sinceMs: number,
): Promise<RecentLinkedinPost[]> {
  const out: RecentLinkedinPost[] = [];
  for (let page = 0; page < LINKEDIN_DEDUPE_PROBE.maxPages; page++) {
    const start = page * LINKEDIN_DEDUPE_PROBE.pageSize;
    const res = await platformFetch(
      `${REST_BASE}/posts?author=${encodeURIComponent(author)}&q=author` +
        `&count=${LINKEDIN_DEDUPE_PROBE.pageSize}&start=${start}&sortBy=LAST_MODIFIED`,
      { headers: baseHeaders },
    );
    const json = (await res.json()) as {
      elements?: Array<{
        id?: string;
        commentary?: string;
        createdAt?: number;
      }>;
    };
    if (!res.ok || !Array.isArray(json.elements)) break;
    for (const p of json.elements) {
      if (!p.id || typeof p.commentary !== "string") continue;
      if (typeof p.createdAt !== "number") continue;
      out.push({
        id: p.id,
        commentary: p.commentary,
        createdAtMs: p.createdAt,
      });
    }
    // Stop when the page came back short (no more posts). Do NOT early-stop
    // on a page of old posts: LAST_MODIFIED ordering means an edited old
    // post can sort ahead of a just-landed one, so later pages can still
    // hold a fresh duplicate. maxPages bounds the work instead.
    if (json.elements.length < LINKEDIN_DEDUPE_PROBE.pageSize) break;
  }
  return out;
}

/**
 * Find a recent post whose commentary exactly matches what we are about to
 * send and that was created within the dedupe window. Returns its id so the
 * retry can short-circuit instead of posting a duplicate.
 */
function findMatchingRecentPost(
  recent: RecentLinkedinPost[],
  commentary: string,
  sinceMs: number,
): string | null {
  if (!commentary) return null;
  const match = recent.find(
    (p) => p.commentary === commentary && p.createdAtMs >= sinceMs,
  );
  return match ? match.id : null;
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

router.param("id", (req, res, next, value) => {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  next();
});

router.get("/linkedin/auth/url", async (req: Request, res: Response) => {
  const creds = await getCredentials();
  if (!creds || !process.env.SESSION_SECRET) {
    res.status(503).json({
      error:
        "LinkedIn is not configured. Ask an administrator to save the LinkedIn Client ID and Client Secret on the Admin page.",
    });
    return;
  }
  const params = new URLSearchParams({
    response_type: "code",
    client_id: creds.clientId,
    redirect_uri: redirectUri(req),
    state: signOAuthState(req.tenantId, randomNonce()),
    scope: OAUTH_SCOPE,
  });
  res.json({ url: `${AUTH_BASE}?${params.toString()}` });
});

/**
 * The OAuth callback lives on a separate PUBLIC router (mounted before the
 * session gate in routes/index.ts): it arrives as a top-level browser
 * navigation from linkedin.com that may not carry the app's session token.
 * The HMAC-signed, TTL'd `state` minted by /linkedin/auth/url is what
 * authenticates the request and identifies the initiating tenant.
 */
export const linkedinCallbackRouter: IRouter = Router();

linkedinCallbackRouter.get(
  "/linkedin/auth/callback",
  async (req: Request, res: Response) => {
  const webBase = "/accounts";
  const fail = (reason: string) =>
    res.redirect(`${webBase}?linkedin=error&reason=${encodeURIComponent(reason)}`);

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
    const tokenRes = await platformFetch(linkedinTokenUrl(), {
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
      refresh_token?: string;
      refresh_token_expires_in?: number;
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

    // Store the programmatic refresh token (when LinkedIn issues one) so the
    // connection sweep can silently renew the ~60-day access token and the
    // tenant never sees a reconnect prompt for a routine expiry (see
    // lib/linkedinOrganicRefresh.ts). Encrypted at rest; null when the app
    // has no refresh-token grant so stale creds from a prior connect can't
    // linger.
    const storedCredentials: LinkedinOrganicStoredCredentials | null =
      tokenJson.refresh_token
        ? {
            refreshToken: tokenJson.refresh_token,
            refreshTokenExpiresAt:
              tokenJson.refresh_token_expires_in != null
                ? Date.now() + tokenJson.refresh_token_expires_in * 1000
                : undefined,
          }
        : null;
    const encryptedCredentials = storedCredentials
      ? encryptJson(storedCredentials)
      : null;

    const userRes = await platformFetch(linkedinUserinfoUrl(), {
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
    const existing = await getLinkedinAccount(tenantId);
    if (existing) {
      await db
        .update(connectedAccountsTable)
        .set({
          accountName,
          status: "connected",
          accessToken,
          tokenExpiresAt: expiresAt,
          encryptedCredentials,
          providerUserId: userJson.sub,
          verifyStatus: "verified",
          verifyError: null,
          verifiedAt: now,
        })
        .where(eq(connectedAccountsTable.id, existing.id));
    } else {
      await db.insert(connectedAccountsTable).values({
        tenantId,
        platform: "linkedin",
        accountName,
        status: "connected",
        accessToken,
        tokenExpiresAt: expiresAt,
        encryptedCredentials,
        providerUserId: userJson.sub,
        verifyStatus: "verified",
        verifyError: null,
        verifiedAt: now,
      });
    }

    // Reconnecting clears any lingering "connection failed" notification.
    await resolveSocialConnectionNotifications(tenantId, "linkedin");

    res.redirect(`${webBase}?linkedin=connected`);
  } catch (error) {
    req.log.error({ err: error }, "LinkedIn OAuth callback failed");
    fail("server_error");
  }
  },
);

function serializeStatus(
  req: Request,
  account: Awaited<ReturnType<typeof getLinkedinAccount>> | undefined,
  configured: boolean,
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
    configured,
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
      account = (await reverifyLinkedin(req.tenantId)) ?? account;
    } catch (err) {
      req.log.error({ err }, "LinkedIn auto re-verify failed");
    }
  }
  res.json(serializeStatus(req, account, await isConfigured()));
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
        encryptedCredentials: null,
        providerUserId: null,
      })
      .where(eq(connectedAccountsTable.id, existing.id));
  }
  res.json(serializeStatus(req, undefined, await isConfigured()));
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
    const userRes = await platformFetch(linkedinUserinfoUrl(), {
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
        encryptedCredentials: null,
        providerUserId: null,
      })
      .where(eq(connectedAccountsTable.id, existing.id));
  }

  const refreshed = await getLinkedinAccount(req.tenantId);
  res.json(serializeStatus(req, refreshed, await isConfigured()));
});

/**
 * Upload the item's image (if any) and create the LinkedIn post, returning the
 * new post's URN ("" when LinkedIn does not return one). Extracted so the
 * publish route can skip the whole sequence when a duplicate-post probe finds
 * the content already landed. Throws on any failure.
 */
async function createLinkedinPost(opts: {
  item: { imagePath: string | null; title: string };
  author: string;
  commentary: string;
  baseHeaders: Record<string, string>;
  token: string;
  tenantId: number;
}): Promise<string> {
  const { item, author, commentary, baseHeaders, token, tenantId } = opts;
  let imageUrn: string | null = null;

  if (item.imagePath) {
    const file = await objectStorageService.getObjectEntityFile(
      item.imagePath,
      tenantId,
    );
    const [buffer] = await file.download();

    const initRes = await platformFetch(`${REST_BASE}/images?action=initializeUpload`, {
      method: "POST",
      headers: { ...baseHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ initializeUploadRequest: { owner: author } }),
    });
    const initJson = (await initRes.json()) as {
      value?: { uploadUrl?: string; image?: string };
    };
    if (!initRes.ok || !initJson.value?.uploadUrl || !initJson.value.image) {
      // The token died mid-publish (revoked between the pre-publish
      // re-verify and this write). Never surface the raw LinkedIn error.
      if (initRes.status === 401 || initRes.status === 403) {
        throw new PublishAuthRevokedError(LINKEDIN_RECONNECT_MESSAGE);
      }
      if (isTransientPlatformStatus(initRes.status)) {
        throw new PublishTransientError(
          `Image upload could not be initialized (${initRes.status})`,
        );
      }
      throw new Error(`Image upload could not be initialized (${initRes.status})`);
    }

    const uploadRes = await platformFetch(initJson.value.uploadUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": imageContentType(item.imagePath),
      },
      body: new Uint8Array(buffer),
    });
    if (!uploadRes.ok) {
      // The token died mid-upload (revoked between the pre-publish
      // re-verify and this write). Never surface the raw LinkedIn error.
      if (uploadRes.status === 401 || uploadRes.status === 403) {
        throw new PublishAuthRevokedError(LINKEDIN_RECONNECT_MESSAGE);
      }
      if (isTransientPlatformStatus(uploadRes.status)) {
        throw new PublishTransientError(
          `Image binary upload failed (${uploadRes.status})`,
        );
      }
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

  const postRes = await platformFetch(`${REST_BASE}/posts`, {
    method: "POST",
    headers: { ...baseHeaders, "Content-Type": "application/json" },
    body: JSON.stringify(postBody),
  });
  if (postRes.status !== 201 && !postRes.ok) {
    // The token died mid-publish (revoked between the pre-publish re-verify
    // and this write). Never surface the raw LinkedIn error.
    if (postRes.status === 401 || postRes.status === 403) {
      throw new PublishAuthRevokedError(LINKEDIN_RECONNECT_MESSAGE);
    }
    let detail = `LinkedIn API error (${postRes.status})`;
    try {
      const errJson = (await postRes.json()) as { message?: string };
      if (errJson.message) detail = errJson.message;
    } catch {
      /* ignore non-JSON body */
    }
    if (isTransientPlatformStatus(postRes.status)) {
      throw new PublishTransientError(detail);
    }
    throw new Error(detail);
  }

  return (
    postRes.headers.get("x-restli-id") ||
    postRes.headers.get("x-linkedin-id") ||
    ""
  );
}

/**
 * Full LinkedIn publish flow with no req/res dependency, so it can be driven
 * both by the manual publish HTTP handler and by the scheduled-publish
 * executor. The caller MUST hold the per-item publish lock
 * (tryAcquireResendLock) — the core does not acquire it. Returns a
 * PublishOutcome the caller translates into an HTTP response (or a scheduled
 * post row update).
 */
export async function publishLinkedinCore(
  tenantId: number,
  contentItemId: number,
): Promise<PublishOutcome> {
  const id = contentItemId;
  const item = (
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
  if (!item) {
    return { ok: false, errorStatus: 404, error: "Not found" };
  }

  let account = await getLinkedinAccount(tenantId);
  // Re-check the token against LinkedIn right before publishing so a
  // revoked/expired token is caught here instead of producing a confusing raw
  // publish error. Force the check regardless of staleness.
  if (account?.accessToken) {
    try {
      account =
        (await reverifyLinkedin(tenantId, { force: true })) ?? account;
    } catch (err) {
      logger.error(
        { err, tenantId, contentItemId },
        "LinkedIn pre-publish re-verify failed",
      );
    }
  }
  const tokenValid =
    !!account?.accessToken &&
    account.verifyStatus !== "failed" &&
    (account.tokenExpiresAt === null ||
      account.tokenExpiresAt.getTime() > Date.now());
  if (!account || !tokenValid || !account.providerUserId) {
    // A timestamp-expired token whose row was NOT flipped to failed means the
    // silent refresh hit a passing outage (a definitive refresh rejection
    // marks the row failed). That is a transient condition — the next
    // refresh attempt will likely succeed — so surface 503 for the scheduled
    // executor's bounded auto-retry instead of a permanent reconnect error.
    const transientRefreshOutage =
      !!account?.accessToken &&
      account.verifyStatus === "verified" &&
      !!account.providerUserId &&
      account.tokenExpiresAt !== null &&
      account.tokenExpiresAt.getTime() <= Date.now();
    if (transientRefreshOutage) {
      return {
        ok: false,
        errorStatus: 503,
        error:
          "LinkedIn could not refresh the access token due to a temporary problem. Please try again in a few minutes.",
      };
    }
    return {
      ok: false,
      errorStatus: 400,
      error:
        "LinkedIn is not connected or its access token is no longer valid. Reconnect your LinkedIn account on the Accounts page and try again.",
    };
  }

  const token = account.accessToken!;
  const author = `urn:li:person:${account.providerUserId}`;
  // LinkedIn has no native thread, so a caption over the post limit keeps its
  // first chunk in the post and the remainder goes out as follow-up comments,
  // so the full message still reaches readers. Split on the VISIBLE text
  // BEFORE escaping (the "Little Text" backslashes are formatting markers, not
  // counted against the limit).
  const { main, comments: overflowComments } = splitForLinkedin(
    buildPostText(item.title, item.caption),
  );
  const commentary = escapeCommentary(main);

  const baseHeaders = {
    Authorization: `Bearer ${token}`,
    "LinkedIn-Version": LINKEDIN_VERSION,
    "X-Restli-Protocol-Version": "2.0.0",
  };

  // A publish can commit on LinkedIn but return a transient-looking error
  // (or the response can be lost entirely), so a retry — the user
  // re-clicking Publish — would post the same content twice. Before
  // (re-)posting, probe the member's recent posts and short-circuit when an
  // identical post already landed within the dedupe window. Best-effort:
  // probe failure means no short-circuit.
  let existingPostId: string | null = null;
  try {
    const sinceMs = Date.now() - PUBLISH_DEDUPE_WINDOW_MS;
    const recent = await fetchRecentLinkedinPosts(
      author,
      baseHeaders,
      sinceMs,
    );
    existingPostId = findMatchingRecentPost(recent, commentary, sinceMs);
  } catch (err) {
    logger.warn(
      { err, tenantId, contentItemId },
      "LinkedIn duplicate-post probe failed; proceeding without dedupe",
    );
  }

  // When the dedupe probe matches, work out how many overflow comments the
  // earlier attempt already posted so a resumed publish never re-posts them:
  // a persisted resend snapshot for that post is authoritative; an item
  // already marked published against the same post means the whole sequence
  // (post + comments) completed earlier.
  let alreadyPostedComments = 0;
  if (existingPostId) {
    const priorState = item.linkedinCommentState;
    if (priorState && priorState.postUrn === existingPostId) {
      alreadyPostedComments = Math.min(
        priorState.postedCount,
        overflowComments.length,
      );
    } else if (item.status === "published" && item.postId === existingPostId) {
      alreadyPostedComments = overflowComments.length;
    }
  }

  try {
    let postId: string;
    if (existingPostId) {
      logger.warn(
        { existingPostId, tenantId, contentItemId },
        "LinkedIn publish: identical post already landed recently; reusing the existing post instead of re-posting",
      );
      postId = existingPostId;
    } else {
      postId = await createLinkedinPost({
        item,
        author,
        commentary,
        baseHeaders,
        token,
        tenantId,
      });
    }

    const permalink = postId
      ? `https://www.linkedin.com/feed/update/${postId}`
      : null;

    await db
      .update(contentItemsTable)
      .set({
        status: "published",
        failureReason: null,
        postId: postId || null,
        permalink,
        publishedPlatforms: mergePublishedPlatform("linkedin", {
          postId: postId || null,
          permalink,
        }),
        // A fresh publish starts a new comment sequence; any resend state
        // from an earlier publish points at a stale post URN.
        linkedinCommentState: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(contentItemsTable.id, id),
          eq(contentItemsTable.tenantId, tenantId),
        ),
      );

    // Taste memory: a successful publish is the strongest approval signal.
    void recordTasteSignalFromContent(tenantId, id, "published");

    // The main post succeeded and is now marked published. Overflow text goes
    // out as follow-up comments so the full caption reaches readers. A comment
    // failure must NOT undo the published post — surface it instead of failing
    // silently. Comments can only be posted when we know the post's URN.
    let commentsPosted = alreadyPostedComments;
    let commentWarning: string | null = null;
    if (overflowComments.length > 0) {
      if (!postId) {
        commentWarning =
          "The post was published, but LinkedIn did not return a post id, so the rest of the caption could not be added as comments.";
      } else {
        // When resuming against a post that already landed, the persisted
        // snapshot count can undercount (a comment landed but its response
        // was lost). Probe the post's existing comments and skip exact-text
        // matches so a resumed publish never posts a duplicate. Best-effort:
        // a probe failure means no skipping.
        let existingTexts: Set<string> | null = null;
        if (existingPostId && alreadyPostedComments < overflowComments.length) {
          try {
            existingTexts = await fetchExistingCommentTexts(
              postId,
              baseHeaders,
            );
          } catch (err) {
            logger.warn(
              { err, postId, tenantId, contentItemId },
              "LinkedIn existing-comments probe failed; resuming without dedupe",
            );
          }
        }
        for (
          let index = alreadyPostedComments;
          index < overflowComments.length;
          index++
        ) {
          const text = overflowComments[index]!;
          if (existingTexts?.has(text)) {
            logger.warn(
              { postId, index, tenantId, contentItemId },
              "LinkedIn comment already exists on the reused post; skipping instead of re-posting",
            );
            commentsPosted += 1;
            continue;
          }
          try {
            await postLinkedinComment(postId, author, text, baseHeaders);
            commentsPosted += 1;
          } catch (commentError) {
            logger.error(
              { err: commentError, postId, tenantId, contentItemId },
              "LinkedIn overflow comment failed",
            );
            // The token died mid-sequence: the post is already published,
            // so keep the item published with a warning, but still flip
            // the account row so the Accounts page prompts a reconnect.
            if (commentError instanceof PublishAuthRevokedError) {
              try {
                await markAccountVerifyFailed(
                  tenantId,
                  "linkedin",
                  LINKEDIN_TOKEN_INVALID_MESSAGE,
                );
              } catch (markErr) {
                logger.error(
                  { err: markErr, tenantId, contentItemId },
                  "Failed to flip LinkedIn account to failed after mid-sequence auth error",
                );
              }
            }
            const remaining = overflowComments.length - index;
            commentWarning = `The post was published, but ${remaining} of ${overflowComments.length} follow-up comment(s) with the rest of the caption could not be posted.`;
            break;
          }
        }
        // Persist which numbered comments made it (with the exact texts, so
        // a later caption edit can't renumber a resend) whenever the
        // sequence is incomplete; the resend endpoint picks up from
        // postedCount. Best-effort: a DB hiccup must not fail the publish.
        if (commentsPosted < overflowComments.length) {
          try {
            await db
              .update(contentItemsTable)
              .set({
                linkedinCommentState: {
                  postUrn: postId,
                  comments: overflowComments,
                  postedCount: commentsPosted,
                },
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(contentItemsTable.id, id),
                  eq(contentItemsTable.tenantId, tenantId),
                ),
              );
          } catch (stateErr) {
            logger.error(
              { err: stateErr, contentItemId: id, tenantId },
              "Failed to record LinkedIn comment resend state",
            );
          }
        }
      }
    }

    return {
      ok: true,
      postId,
      permalink,
      extra: {
        commentsPosted,
        commentsTotal: overflowComments.length,
        ...(commentWarning ? { commentWarning } : {}),
      },
    };
  } catch (error) {
    logger.error(
      { err: error, tenantId, contentItemId },
      "LinkedIn publish failed",
    );

    // The token died in the window between the pre-publish re-verify and
    // the actual write. Surface the same friendly reconnect message the
    // pre-publish gate uses (never the raw LinkedIn error) and flip the
    // account row to "failed" so the Accounts page prompts a reconnect.
    if (error instanceof PublishAuthRevokedError) {
      try {
        await markAccountVerifyFailed(
          tenantId,
          "linkedin",
          LINKEDIN_TOKEN_INVALID_MESSAGE,
        );
      } catch (markErr) {
        logger.error(
          { err: markErr, tenantId, contentItemId },
          "Failed to flip LinkedIn account to failed after mid-publish auth error",
        );
      }
      try {
        await db
          .update(contentItemsTable)
          .set({
            status: "failed",
            failureReason: error.message,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(contentItemsTable.id, id),
              eq(contentItemsTable.tenantId, tenantId),
            ),
          );
      } catch (updateErr) {
        logger.error(
          { err: updateErr, contentItemId: id, tenantId },
          "Failed to record LinkedIn publish failure",
        );
      }
      return { ok: false, errorStatus: 400, error: error.message };
    }

    const reason =
      error instanceof PublishTransientError
        ? `LinkedIn is temporarily unavailable: ${error.message}`
        : error instanceof Error && error.message
          ? `LinkedIn rejected the post: ${error.message}`
          : "Failed to publish to LinkedIn.";
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
            eq(contentItemsTable.tenantId, tenantId),
          ),
        );
    } catch (updateErr) {
      logger.error(
        { err: updateErr, contentItemId: id, tenantId },
        "Failed to record LinkedIn publish failure",
      );
    }
    return {
      ok: false,
      // A transient platform outage (5xx/429) is 503 so the scheduled
      // executor's bounded auto-retry re-queues the post instead of failing
      // it permanently; anything else stays a definitive 502.
      errorStatus: error instanceof PublishTransientError ? 503 : 502,
      error: reason,
    };
  }
}

router.post(
  "/content/:id/publish-linkedin",
  trackSyncPublish,
  async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    // Guard against two truly simultaneous publish clicks: both would read
    // the item and run the dedupe probe before either has posted, so the
    // probe can't see the other's writes — without the lock both could post.
    const releasePublishLock = tryAcquireResendLock("linkedin", id);
    if (!releasePublishLock) {
      res.status(409).json({ error: PUBLISH_IN_PROGRESS_MESSAGE });
      return;
    }
    try {
      const outcome = await publishLinkedinCore(req.tenantId, id);
      if (outcome.ok) {
        res.json({
          postId: outcome.postId,
          permalink: outcome.permalink,
          ...(outcome.extra ?? {}),
        });
      } else {
        res.status(outcome.errorStatus).json({ error: outcome.error });
      }
    } finally {
      releasePublishLock();
    }
  },
);

/**
 * Resend the follow-up comments that failed during an earlier publish. Posts
 * only the missing comments (from the persisted snapshot, so the original
 * "(i/n)" numbering is preserved even if the caption was edited since), and
 * clears the state once the sequence is complete.
 */
router.post(
  "/content/:id/resend-linkedin-comments",
  async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    // Guard against two truly simultaneous resend clicks: both would read
    // the same postedCount and probe before either has posted, so the dedupe
    // probe can't see the other's writes.
    const releaseLock = tryAcquireResendLock("linkedin", id);
    if (!releaseLock) {
      res.status(409).json({ error: RESEND_IN_PROGRESS_MESSAGE });
      return;
    }
    try {
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

    const state = item.linkedinCommentState;
    if (!state || state.postedCount >= state.comments.length) {
      res.status(400).json({
        error: "There are no missing LinkedIn follow-up comments to resend.",
        code: "already_complete",
      });
      return;
    }

    let account = await getLinkedinAccount(req.tenantId);
    if (account?.accessToken) {
      try {
        account =
          (await reverifyLinkedin(req.tenantId, { force: true })) ?? account;
      } catch (err) {
        req.log.error({ err }, "LinkedIn pre-resend re-verify failed");
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

    const author = `urn:li:person:${account.providerUserId}`;
    const baseHeaders = {
      Authorization: `Bearer ${account.accessToken!}`,
      "LinkedIn-Version": LINKEDIN_VERSION,
      "X-Restli-Protocol-Version": "2.0.0",
    };

    // A comment can land on LinkedIn even when the original response was lost
    // (timeout/network blip), so the persisted postedCount may undercount.
    // Probe the post's existing comments and skip any whose text already
    // appears, so a resend never posts a duplicate. Best-effort: a probe
    // failure means no skipping (same behavior as before).
    let existingTexts: Set<string> | null = null;
    try {
      existingTexts = await fetchExistingCommentTexts(
        state.postUrn,
        baseHeaders,
      );
    } catch (err) {
      req.log.warn(
        { err, postUrn: state.postUrn },
        "LinkedIn existing-comments probe failed; resending without dedupe",
      );
    }

    let postedCount = state.postedCount;
    let commentWarning: string | null = null;
    for (let i = postedCount; i < state.comments.length; i++) {
      const text = state.comments[i]!;
      if (existingTexts?.has(text)) {
        req.log.warn(
          { postUrn: state.postUrn, index: i },
          "LinkedIn comment already exists on the post; skipping instead of re-posting",
        );
        postedCount += 1;
        continue;
      }
      try {
        await postLinkedinComment(
          state.postUrn,
          author,
          state.comments[i]!,
          baseHeaders,
        );
        postedCount += 1;
      } catch (commentError) {
        req.log.error(
          { err: commentError, postUrn: state.postUrn },
          "LinkedIn comment resend failed",
        );
        const remaining = state.comments.length - postedCount;
        commentWarning = `${remaining} of ${state.comments.length} follow-up comment(s) still could not be posted. You can try resending again.`;
        break;
      }
    }

    const complete = postedCount >= state.comments.length;
    await db
      .update(contentItemsTable)
      .set({
        linkedinCommentState: complete
          ? null
          : { ...state, postedCount },
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(contentItemsTable.id, id),
          eq(contentItemsTable.tenantId, req.tenantId),
        ),
      );

    res.json({
      commentsPosted: postedCount,
      commentsTotal: state.comments.length,
      commentsRemaining: state.comments.length - postedCount,
      permalink:
        item.permalink ??
        `https://www.linkedin.com/feed/update/${state.postUrn}`,
      ...(commentWarning ? { commentWarning } : {}),
    });
    } finally {
      releaseLock();
    }
  },
);

export default router;
