import { Router, type IRouter, type Request, type Response } from "express";
import { db, contentItemsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { ObjectStorageService } from "../lib/objectStorage";
import {
  GRAPH_BASE,
  getTenantCredentials,
  type FacebookCredentials,
  type InstagramCredentials,
} from "../lib/metaApi";
import { reverifyFacebook, reverifyInstagram } from "../lib/socialReverify";
import { enqueueBackgroundJob } from "../lib/backgroundJobs";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const objectStorageService = new ObjectStorageService();

/**
 * Polling configuration for waiting on an Instagram media container to finish
 * processing. Exported (and mutable) so tests can shrink the delays and attempt
 * cap without waiting real seconds.
 */
export const IG_CONTAINER_POLL = {
  maxAttempts: 12,
  initialDelayMs: 1500,
  maxDelayMs: 8000,
  backoffFactor: 1.5,
};

/**
 * Bounded retry configuration for the whole Instagram create -> poll -> publish
 * flow. Many failures are transient (a brief Graph API 5xx, a rate-limit blip,
 * or Instagram still processing the image past the poll cap), so the flow is
 * retried a small, capped number of times with exponential backoff before the
 * content item is finally marked "failed". Exported (and mutable) so tests can
 * shrink the delays and attempt cap without waiting real seconds.
 *
 * `maxAttempts` is the TOTAL number of attempts, including the first one.
 */
export const IG_PUBLISH_RETRY = {
  maxAttempts: 3,
  initialDelayMs: 2000,
  maxDelayMs: 30000,
  backoffFactor: 2,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Error thrown by the Instagram publish flow that carries whether the failure
 * is worth retrying. Transient failures (5xx, 429, network blips, still
 * processing) are retryable; definitive ones (bad image, revoked/invalid token,
 * other 4xx) are not, so they fail fast without wasting the retry budget.
 */
class InstagramPublishError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "InstagramPublishError";
    this.retryable = retryable;
  }
}

/**
 * A Graph API response is worth retrying only for transient server-side
 * conditions: HTTP 429 (rate limited) and any 5xx. Client errors (4xx) mean the
 * request itself is bad (revoked token, invalid image, etc.) and will keep
 * failing, so they are treated as non-retryable.
 */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Bounded retry/backoff configuration for Facebook publish writes. Facebook
 * photo/feed posts normally succeed on the first try, but the Graph API can
 * momentarily return a transient error (service temporarily unavailable, a
 * 5xx, or `is_transient`) — the same class of "not ready yet" hiccup the
 * Instagram flow guards against. Exported (and mutable) so tests can shrink the
 * delays and attempt cap without waiting real seconds.
 */
export const FB_PUBLISH_RETRY = {
  maxAttempts: 4,
  initialDelayMs: 1000,
  maxDelayMs: 8000,
  backoffFactor: 2,
};

type GraphError = {
  message?: string;
  code?: number;
  is_transient?: boolean;
};

/**
 * Decide whether a failed Graph API response is a transient hiccup worth
 * retrying. Definitive errors (bad token, invalid params, permissions) are NOT
 * retried — retrying them would just fail slower.
 */
function isTransientGraphError(status: number, error?: GraphError): boolean {
  if (status >= 500) return true;
  if (!error) return false;
  if (error.is_transient) return true;
  // code 1 = unknown/temporary, code 2 = service temporarily unavailable.
  if (error.code === 1 || error.code === 2) return true;
  return false;
}

/**
 * POST to a Graph API endpoint with a bounded, backing-off retry on transient
 * failures. `buildBody` is called fresh for every attempt because a request
 * body (FormData/Blob) is consumed once per fetch. Throws the last error once
 * a definitive failure is seen or the attempt cap is reached.
 */
async function postToGraphWithRetry<T extends { error?: GraphError }>(
  url: string,
  buildBody: () => FormData,
  label: string,
): Promise<T> {
  let delay = FB_PUBLISH_RETRY.initialDelayMs;
  let lastError = new Error(label);
  for (let attempt = 0; attempt < FB_PUBLISH_RETRY.maxAttempts; attempt++) {
    const res = await fetch(url, { method: "POST", body: buildBody() });
    const json = (await res.json()) as T;
    if (res.ok && !json.error) return json;

    lastError = new Error(json.error?.message || `${label} (${res.status})`);
    const transient = isTransientGraphError(res.status, json.error);
    if (!transient || attempt === FB_PUBLISH_RETRY.maxAttempts - 1) {
      throw lastError;
    }

    await sleep(delay);
    delay = Math.min(
      Math.round(delay * FB_PUBLISH_RETRY.backoffFactor),
      FB_PUBLISH_RETRY.maxDelayMs,
    );
  }
  throw lastError;
}

/**
 * Instagram fetches the container's image asynchronously, so a freshly created
 * container usually reports `status_code: IN_PROGRESS` for a moment. Publishing
 * before it becomes `FINISHED` fails, so poll the container status (with
 * capped, backing-off retries) until it's ready. Throws on a definitive
 * `ERROR`/`EXPIRED` status or once the attempt cap is reached.
 */
async function waitForContainerReady(
  creationId: string,
  pageToken: string,
): Promise<void> {
  let delay = IG_CONTAINER_POLL.initialDelayMs;
  for (let attempt = 0; attempt < IG_CONTAINER_POLL.maxAttempts; attempt++) {
    // Token rides in the Authorization header so it never lands in a URL/log.
    const statusRes = await fetch(
      `${GRAPH_BASE}/${encodeURIComponent(creationId)}?fields=status_code`,
      { headers: { Authorization: `Bearer ${pageToken}` } },
    );
    const statusJson = (await statusRes.json()) as {
      status_code?: string;
      error?: { message?: string };
    };
    if (!statusRes.ok || statusJson.error) {
      throw new InstagramPublishError(
        statusJson.error?.message ||
          `Instagram API error while checking media status (${statusRes.status})`,
        isRetryableStatus(statusRes.status),
      );
    }

    const status = statusJson.status_code;
    if (status === "FINISHED") return;
    if (status === "ERROR" || status === "EXPIRED") {
      // A definitive processing failure (e.g. a bad/unsupported image). Retrying
      // the same image will keep failing, so fail fast.
      throw new InstagramPublishError(
        `Instagram could not process the image (status: ${status}). Try publishing again.`,
        false,
      );
    }

    // IN_PROGRESS (or an unexpected status): wait and retry unless this was the
    // final attempt.
    if (attempt < IG_CONTAINER_POLL.maxAttempts - 1) {
      await sleep(delay);
      delay = Math.min(
        Math.round(delay * IG_CONTAINER_POLL.backoffFactor),
        IG_CONTAINER_POLL.maxDelayMs,
      );
    }
  }

  // Still IN_PROGRESS past the poll cap. This is usually transient (Instagram
  // just needs more time), so it is retryable.
  throw new InstagramPublishError(
    "Instagram is still processing the image and did not finish in time. Please try publishing again in a moment.",
    true,
  );
}

router.param("id", (req, res, next, value) => {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  next();
});

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
      failureReason: null,
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

async function setContentStatus(
  id: number,
  tenantId: number,
  status: string,
  failureReason: string | null = null,
) {
  await db
    .update(contentItemsTable)
    .set({ status, failureReason, updatedAt: new Date() })
    .where(
      and(
        eq(contentItemsTable.id, id),
        eq(contentItemsTable.tenantId, tenantId),
      ),
    );
}

type InstagramPublishParams = {
  id: number;
  tenantId: number;
  igUserId: string;
  pageToken: string;
  imagePath: string;
  caption: string;
};

/**
 * One attempt at the Instagram create -> poll -> publish flow. Returns the
 * published post id and (best-effort) permalink on success, or throws. Failures
 * from the Graph API are thrown as `InstagramPublishError` carrying whether the
 * failure is transient (worth retrying) or definitive (fail fast).
 */
async function attemptInstagramPublish(
  params: InstagramPublishParams,
): Promise<{ postId: string; permalink: string | null }> {
  const { tenantId, igUserId, pageToken, imagePath, caption } = params;

  // Instagram fetches the image itself, so it needs a public URL. Mint a
  // short-lived signed GET URL for the private object.
  const imageUrl = await objectStorageService.getSignedDownloadURL(
    imagePath,
    tenantId,
    900,
  );

  // Step 1: create the media container.
  const createForm = new URLSearchParams({
    image_url: imageUrl,
    caption,
    access_token: pageToken,
  });
  const createRes = await fetch(
    `${GRAPH_BASE}/${encodeURIComponent(igUserId)}/media`,
    { method: "POST", body: createForm },
  );
  const createJson = (await createRes.json()) as {
    id?: string;
    error?: { message?: string };
  };
  if (!createRes.ok || createJson.error || !createJson.id) {
    throw new InstagramPublishError(
      createJson.error?.message || `Instagram API error (${createRes.status})`,
      isRetryableStatus(createRes.status),
    );
  }

  // Step 2: wait for Instagram to finish fetching/processing the image.
  // Publishing an IN_PROGRESS container fails, so poll until it's ready.
  await waitForContainerReady(createJson.id, pageToken);

  // Step 3: publish the container.
  const publishForm = new URLSearchParams({
    creation_id: createJson.id,
    access_token: pageToken,
  });
  const publishRes = await fetch(
    `${GRAPH_BASE}/${encodeURIComponent(igUserId)}/media_publish`,
    { method: "POST", body: publishForm },
  );
  const publishJson = (await publishRes.json()) as {
    id?: string;
    error?: { message?: string };
  };
  if (!publishRes.ok || publishJson.error || !publishJson.id) {
    throw new InstagramPublishError(
      publishJson.error?.message || `Instagram API error (${publishRes.status})`,
      isRetryableStatus(publishRes.status),
    );
  }

  const postId = publishJson.id;

  // Best-effort: resolve the post's public permalink. Token goes in the
  // Authorization header so it never lands in a URL/access log.
  let permalink: string | null = null;
  try {
    const linkRes = await fetch(
      `${GRAPH_BASE}/${encodeURIComponent(postId)}?fields=permalink`,
      { headers: { Authorization: `Bearer ${pageToken}` } },
    );
    const linkJson = (await linkRes.json()) as { permalink?: string };
    permalink = linkJson.permalink ?? null;
  } catch {
    permalink = null;
  }

  return { postId, permalink };
}

/**
 * Run the full Instagram create -> poll -> publish flow in a background job
 * (after the HTTP response has already been sent, since the container can stay
 * IN_PROGRESS for tens of seconds). It owns persisting the outcome: the content
 * item is flipped to "published" on success, or "failed" once retries are
 * exhausted. Transient failures are retried a small, capped number of times
 * with exponential backoff; definitive failures (bad image, revoked token) fail
 * fast without wasting the retry budget.
 */
async function runInstagramPublish(
  params: InstagramPublishParams,
): Promise<void> {
  const { id, tenantId } = params;
  let delay = IG_PUBLISH_RETRY.initialDelayMs;

  for (let attempt = 1; attempt <= IG_PUBLISH_RETRY.maxAttempts; attempt++) {
    try {
      const { postId, permalink } = await attemptInstagramPublish(params);
      await markPublished(id, tenantId, { postId, permalink });
      return;
    } catch (error) {
      // Unknown (non-classified) errors — e.g. a network blip or a storage
      // hiccup — are treated as transient so they get the bounded retry rather
      // than failing on the first flake.
      const retryable =
        error instanceof InstagramPublishError ? error.retryable : true;
      const attemptsLeft = attempt < IG_PUBLISH_RETRY.maxAttempts;

      if (retryable && attemptsLeft) {
        logger.warn(
          { err: error, contentItemId: id, tenantId, attempt },
          "Instagram publish attempt failed; retrying after backoff",
        );
        await sleep(delay);
        delay = Math.min(
          Math.round(delay * IG_PUBLISH_RETRY.backoffFactor),
          IG_PUBLISH_RETRY.maxDelayMs,
        );
        continue;
      }

      logger.error(
        { err: error, contentItemId: id, tenantId, attempt, retryable },
        retryable
          ? "Instagram background publish failed after exhausting retries"
          : "Instagram background publish failed (non-retryable)",
      );
      // Flip the item to "failed" so the UI can surface it instead of leaving it
      // stuck on "publishing" forever.
      try {
        const reason =
          error instanceof Error && error.message
            ? `Instagram rejected the post: ${error.message}`
            : "Instagram rejected the post.";
        await setContentStatus(id, tenantId, "failed", reason);
      } catch (updateErr) {
        logger.error(
          { err: updateErr, contentItemId: id, tenantId },
          "Failed to mark Instagram content item as failed",
        );
      }
      return;
    }
  }
}

/**
 * POST /content/:id/publish-facebook
 * Publish to the tenant's connected Facebook Page using their stored,
 * encrypted Page token + Page ID.
 */
router.post(
  "/content/:id/publish-facebook",
  async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const item = await loadContentItem(id, req.tenantId);
    if (!item) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    // Re-check the stored token against Meta right before publishing so an
    // expired/revoked token is caught here (and flipped to "failed") instead of
    // producing a confusing raw publish error.
    try {
      await reverifyFacebook(req.tenantId, { force: true });
    } catch (err) {
      req.log.error({ err }, "Facebook pre-publish re-verify failed");
    }
    const fb = await getTenantCredentials<FacebookCredentials>(
      req.tenantId,
      "facebook",
    );
    if (!fb || !fb.verified) {
      res.status(400).json({
        error:
          "Facebook is not connected or its access token is no longer valid. Reconnect your Page on the Accounts page and try again.",
      });
      return;
    }

    const { pageId, pageAccessToken } = fb.creds;
    const message = item.caption?.trim() || item.title;

    try {
      let postId: string;

      if (item.imagePath) {
        const file = await objectStorageService.getObjectEntityFile(
          item.imagePath,
          req.tenantId,
        );
        const [buffer] = await file.download();

        // Rebuild the multipart body per attempt: a FormData/Blob body is
        // consumed once per fetch, so the retry helper needs a fresh one.
        const buildForm = () => {
          const form = new FormData();
          form.append("access_token", pageAccessToken);
          if (message) form.append("caption", message);
          form.append(
            "source",
            new Blob([new Uint8Array(buffer)], { type: "image/png" }),
            "image.png",
          );
          return form;
        };

        const fbJson = await postToGraphWithRetry<{
          id?: string;
          post_id?: string;
          error?: GraphError;
        }>(`${GRAPH_BASE}/${pageId}/photos`, buildForm, "Facebook API error");
        postId = fbJson.post_id || fbJson.id || "";
      } else {
        const buildForm = () => {
          const form = new FormData();
          form.append("access_token", pageAccessToken);
          form.append("message", message);
          return form;
        };

        const fbJson = await postToGraphWithRetry<{
          id?: string;
          error?: GraphError;
        }>(`${GRAPH_BASE}/${pageId}/feed`, buildForm, "Facebook API error");
        postId = fbJson.id || "";
      }

      const permalink = postId ? `https://www.facebook.com/${postId}` : null;
      await markPublished(id, req.tenantId, { postId, permalink });
      res.json({ postId, permalink });
    } catch (error) {
      req.log.error({ err: error }, "Facebook publish failed");
      res.status(502).json({
        error:
          error instanceof Error
            ? `Facebook rejected the post: ${error.message}`
            : "Failed to publish to Facebook.",
      });
    }
  },
);

/**
 * POST /content/:id/publish-instagram
 * Publish to the tenant's connected Instagram Business account. Instagram
 * requires an image and rides on the tenant's Facebook Page access token.
 */
router.post(
  "/content/:id/publish-instagram",
  async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const item = await loadContentItem(id, req.tenantId);
    if (!item) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    if (!item.imagePath) {
      res.status(400).json({
        error: "Instagram posts require an image. Add an image to this content first.",
      });
      return;
    }

    // Re-check the stored credentials against Meta right before publishing so an
    // expired/revoked token is caught here (and flipped to "failed") instead of
    // producing a confusing raw publish error. Facebook first, since Instagram
    // publishing rides on the Page token.
    try {
      await reverifyFacebook(req.tenantId, { force: true });
      await reverifyInstagram(req.tenantId, { force: true });
    } catch (err) {
      req.log.error({ err }, "Instagram pre-publish re-verify failed");
    }
    const [ig, fb] = await Promise.all([
      getTenantCredentials<InstagramCredentials>(req.tenantId, "instagram"),
      getTenantCredentials<FacebookCredentials>(req.tenantId, "facebook"),
    ]);
    if (!ig || !ig.verified) {
      res.status(400).json({
        error:
          "Instagram is not connected or its connection is no longer valid. Reconnect your Instagram Business account on the Accounts page and try again.",
      });
      return;
    }
    if (!fb || !fb.verified) {
      res.status(400).json({
        error:
          "Instagram publishing needs a valid Facebook Page connection, but the Page token is no longer valid. Reconnect Facebook and try again.",
      });
      return;
    }

    const pageToken = fb.creds.pageAccessToken;
    const igUserId = ig.creds.igUserId;
    const caption = item.caption?.trim() || item.title;
    const imagePath = item.imagePath;

    // Instagram fetches the image asynchronously, so the container can stay
    // IN_PROGRESS for tens of seconds — long enough to risk proxy/client
    // timeouts on a blocking request. Flip the item to "publishing", return
    // immediately, and run the create -> poll -> publish flow in the
    // background. The job persists the final "published"/"failed" status.
    await setContentStatus(id, req.tenantId, "publishing");

    const tenantId = req.tenantId;
    enqueueBackgroundJob(() =>
      runInstagramPublish({
        id,
        tenantId,
        igUserId,
        pageToken,
        imagePath,
        caption,
      }),
    );

    res.status(202).json({ status: "publishing" });
  },
);

export default router;
