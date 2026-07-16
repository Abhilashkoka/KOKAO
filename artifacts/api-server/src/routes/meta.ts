import { mergePublishedPlatform } from "../lib/publishedPlatforms";
import { buildPostText } from "../lib/postText";
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
import { enqueueBackgroundJob, isShuttingDown } from "../lib/backgroundJobs";
import { trackSyncPublish } from "../middlewares/trackSyncPublish";
import { logger } from "../lib/logger";
import { platformFetch, PlatformTimeoutError } from "../lib/platformFetch";
import {
  getImageDimensions,
  dimensionsCompatible,
  type ImageDimensions,
} from "../lib/imageDimensions";

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
 *
 * Retry idempotency: a "transient" failure does not prove the write did NOT
 * land — Meta can commit the post and then lose the response (network timeout
 * after write, or a 5xx returned after the commit). Blindly retrying in that
 * case creates a DUPLICATE post on the Page. The Graph API has no idempotency
 * key for Page posts, so after every transient failure the optional
 * `checkAlreadyPosted` probe queries the Page's recent posts; if the previous
 * attempt already landed, its result is returned and the retry (or final
 * throw) is short-circuited.
 */
async function postToGraphWithRetry<T extends { error?: GraphError }>(
  url: string,
  buildBody: () => FormData,
  label: string,
  checkAlreadyPosted?: () => Promise<T | null>,
): Promise<T> {
  let delay = FB_PUBLISH_RETRY.initialDelayMs;
  let lastError = new Error(label);
  for (let attempt = 0; attempt < FB_PUBLISH_RETRY.maxAttempts; attempt++) {
    const res = await platformFetch(url, { method: "POST", body: buildBody() });
    const json = (await res.json()) as T;
    if (res.ok && !json.error) return json;

    lastError = new Error(json.error?.message || `${label} (${res.status})`);
    const transient = isTransientGraphError(res.status, json.error);
    if (!transient) throw lastError;

    // The write may have committed despite the transient-looking error. Check
    // before retrying (and before the final throw) so we never double-post.
    if (checkAlreadyPosted) {
      try {
        const existing = await checkAlreadyPosted();
        if (existing) {
          logger.warn(
            { url: url.split("?")[0], attempt: attempt + 1 },
            "Facebook publish returned a transient error but the post already landed; skipping retry to avoid a duplicate",
          );
          return existing;
        }
      } catch (probeErr) {
        // The dedupe probe is best-effort: if it fails we fall back to the
        // normal retry rather than failing the whole publish.
        logger.warn(
          { err: probeErr },
          "Facebook duplicate-post probe failed; proceeding with retry",
        );
      }
    }

    if (attempt === FB_PUBLISH_RETRY.maxAttempts - 1) {
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
 * Pagination bounds for the duplicate-post probes. The probes filter
 * server-side with Graph's `since` param, so on a quiet account one page is
 * plenty — but a busy Page/IG account (or one posting from several tools at
 * once) can push the landed post past a single page, so the probes follow
 * `paging.next` links up to `maxPages`. Exported (and mutable) so tests can
 * exercise the pagination without huge fixtures.
 */
export const DEDUPE_PROBE = {
  pageSize: 25,
  maxPages: 5,
  // Caption-less IG probes must download candidate images to compare
  // dimensions; cap those downloads so a busy account can't turn one probe
  // into dozens of image fetches.
  maxImageFetches: 5,
};

type ProbePage<T> = {
  data?: T[];
  paging?: { next?: string };
  error?: GraphError;
};

/**
 * Fetch up to `DEDUPE_PROBE.maxPages` pages of a Graph edge, calling `match`
 * on each item, and return the first match. `firstUrl` must already carry the
 * `since` filter so the window is bounded server-side and a recently landed
 * post cannot scroll out of it. The token rides in the Authorization header
 * (never in a URL/log); Graph's `paging.next` links are followed as-is but
 * re-authenticated via the same header.
 */
async function probeGraphPages<T>(
  firstUrl: string,
  accessToken: string,
  match: (item: T) => string | null | Promise<string | null>,
): Promise<string | null> {
  let url: string | undefined = firstUrl;
  for (let page = 0; page < DEDUPE_PROBE.maxPages && url; page++) {
    const res = await platformFetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const json = (await res.json()) as ProbePage<T>;
    if (!res.ok || json.error || !Array.isArray(json.data)) return null;
    for (const item of json.data) {
      const id = await match(item);
      if (id) return id;
    }
    // An empty page means the `since` window is exhausted.
    if (json.data.length === 0) return null;
    url = json.paging?.next;
  }
  return null;
}

/**
 * Look for a post that the current publish attempt already created on the
 * Page: one created at/after `since` whose `message` exactly matches what we
 * sent. When the publish had NO caption (blank message), a landed post also
 * has no `message`, so the probe matches caption-less posts created at/after
 * `since` — otherwise a retried caption-less image publish after a
 * "committed but response lost" failure would still duplicate. But "any
 * blank post" alone could be someone ELSE's concurrent caption-less post
 * (another tool posting to the same Page), which would wrongly short-circuit
 * the retry — so when `expectedImage` is available the probe additionally
 * requires the candidate's photo attachment to have compatible pixel
 * dimensions (see dimensionsCompatible: exact, or a same-aspect downscaled
 * rendition). Without `expectedImage` (unparseable image) it degrades to the
 * weaker blank-match rather than risking a duplicate.
 * The window is bounded server-side via Graph's `since` param and the probe
 * paginates (see DEDUPE_PROBE) so a landed post on a busy Page cannot scroll
 * past the probed window. Used as the duplicate-post probe after a transient
 * publish failure. Returns the matching post id, or null. The Page token
 * rides in the Authorization header so it never lands in a URL/log.
 */
async function findRecentMatchingPagePost(
  pageId: string,
  pageAccessToken: string,
  message: string,
  since: Date,
  expectedImage: ImageDimensions | null = null,
): Promise<string | null> {
  const sinceSec = Math.floor(since.getTime() / 1000);
  // Only caption-less probes need the attachment media (image dimensions).
  const wantAttachments = !message ? expectedImage : null;
  const fields = wantAttachments
    ? "id,message,created_time,attachments{media}"
    : "id,message,created_time";
  return probeGraphPages<{
    id?: string;
    message?: string;
    created_time?: string;
    attachments?: {
      data?: Array<{ media?: { image?: { width?: number; height?: number } } }>;
    };
  }>(
    `${GRAPH_BASE}/${encodeURIComponent(pageId)}/posts?fields=${fields}&limit=${DEDUPE_PROBE.pageSize}&since=${sinceSec}`,
    pageAccessToken,
    (post) => {
      if (!post.id) return null;
      // Blank publishes match blank posts; non-blank publishes need the exact
      // text. Graph omits `message` entirely on caption-less photo posts.
      const matches = message ? post.message === message : !post.message;
      if (!matches) return null;
      if (wantAttachments) {
        // Stronger identity for caption-less publishes: the candidate's photo
        // must plausibly be OUR image, not just any blank post.
        const img = post.attachments?.data?.[0]?.media?.image;
        if (
          !img ||
          typeof img.width !== "number" ||
          typeof img.height !== "number" ||
          !dimensionsCompatible(wantAttachments, {
            width: img.width,
            height: img.height,
          })
        ) {
          return null;
        }
      }
      // Belt-and-braces: re-check the timestamp locally even though the
      // request already filtered with `since` server-side.
      const created = post.created_time ? Date.parse(post.created_time) : NaN;
      return !Number.isNaN(created) && created >= since.getTime()
        ? post.id
        : null;
    },
  );
}

/**
 * Look for an Instagram post that the current publish attempt already created:
 * one created at/after `since` whose `caption` exactly matches what we sent.
 * Used as the duplicate-post probe after a transient failure in the IG
 * create -> poll -> publish flow — `media_publish` can commit the post and
 * then lose the response, and re-running the whole flow would publish the
 * same image twice. When the publish had NO caption, a landed media item also
 * has no `caption`, so the probe matches caption-less media created at/after
 * `since` instead of skipping (which would let a retry duplicate a
 * caption-less image post). But "any blank media" alone could be someone
 * ELSE's concurrent caption-less post (another tool posting to the same
 * account), which would wrongly short-circuit the retry — so when
 * `expectedImage` is available the probe additionally downloads the
 * candidate's `media_url` (a public CDN URL, no token) and requires its pixel
 * dimensions to be compatible with the uploaded image (exact, or a
 * same-aspect downscaled rendition — Instagram recompresses/resizes). Those
 * downloads are capped at DEDUPE_PROBE.maxImageFetches per probe; when the
 * cap is hit, or without `expectedImage` (unparseable image), a blank
 * candidate is only accepted via the weaker blank-match when NO image signal
 * was ever available — otherwise it is skipped. The window is bounded server-side via Graph's
 * `since` param and the probe paginates (see DEDUPE_PROBE) so a landed post
 * on a busy account cannot scroll past the probed window. Returns the
 * matching media id, or null. The Page token rides in the Authorization
 * header so it never lands in a URL/log.
 */
async function findRecentMatchingInstagramMedia(
  igUserId: string,
  pageToken: string,
  caption: string,
  since: Date,
  expectedImage: ImageDimensions | null = null,
): Promise<string | null> {
  const sinceSec = Math.floor(since.getTime() / 1000);
  // Only caption-less probes need the media_url (image dimension check).
  const wantImageCheck = !caption ? expectedImage : null;
  const fields = wantImageCheck
    ? "id,caption,timestamp,media_url"
    : "id,caption,timestamp";
  let imageFetches = 0;
  return probeGraphPages<{
    id?: string;
    caption?: string;
    timestamp?: string;
    media_url?: string;
  }>(
    `${GRAPH_BASE}/${encodeURIComponent(igUserId)}/media?fields=${fields}&limit=${DEDUPE_PROBE.pageSize}&since=${sinceSec}`,
    pageToken,
    async (media) => {
      if (!media.id) return null;
      // Blank publishes match blank media; non-blank publishes need the exact
      // caption. Graph omits `caption` entirely on caption-less media.
      const matches = caption ? media.caption === caption : !media.caption;
      if (!matches) return null;
      // Belt-and-braces: re-check the timestamp locally even though the
      // request already filtered with `since` server-side.
      const created = media.timestamp ? Date.parse(media.timestamp) : NaN;
      if (Number.isNaN(created) || created < since.getTime()) return null;
      if (wantImageCheck) {
        // Stronger identity for caption-less publishes: the candidate's
        // image must plausibly be OUR image, not just any blank post. A
        // candidate that can't be verified (no media_url, download failure,
        // unparseable image, or fetch cap reached) is SKIPPED — wrongly
        // matching someone else's post would mean the user's post never
        // lands, which is worse than a rare duplicate.
        if (!media.media_url) return null;
        if (imageFetches >= DEDUPE_PROBE.maxImageFetches) return null;
        imageFetches++;
        try {
          const res = await platformFetch(media.media_url);
          if (!res.ok) return null;
          const bytes = new Uint8Array(await res.arrayBuffer());
          const dims = getImageDimensions(bytes);
          if (!dims || !dimensionsCompatible(wantImageCheck, dims)) {
            return null;
          }
        } catch {
          return null;
        }
      }
      return media.id;
    },
  );
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
    const statusRes = await platformFetch(
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
  platform: "facebook" | "instagram",
  meta?: { postId?: string | null; permalink?: string | null },
) {
  await db
    .update(contentItemsTable)
    .set({
      status: "published",
      failureReason: null,
      postId: meta?.postId || null,
      permalink: meta?.permalink || null,
      publishedPlatforms: mergePublishedPlatform(platform, {
        postId: meta?.postId || null,
        permalink: meta?.permalink || null,
      }),
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
  const createRes = await platformFetch(
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
  const publishRes = await platformFetch(
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
  const permalink = await fetchInstagramPermalink(postId, pageToken);
  return { postId, permalink };
}

/**
 * Best-effort: resolve an IG post's public permalink. Token goes in the
 * Authorization header so it never lands in a URL/access log.
 */
async function fetchInstagramPermalink(
  postId: string,
  pageToken: string,
): Promise<string | null> {
  try {
    const linkRes = await platformFetch(
      `${GRAPH_BASE}/${encodeURIComponent(postId)}?fields=permalink`,
      { headers: { Authorization: `Bearer ${pageToken}` } },
    );
    const linkJson = (await linkRes.json()) as { permalink?: string };
    return linkJson.permalink ?? null;
  } catch {
    return null;
  }
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
  const { id, tenantId, igUserId, pageToken, imagePath, caption } = params;
  let delay = IG_PUBLISH_RETRY.initialDelayMs;

  // For caption-less publishes the duplicate-post probe cannot match by text,
  // so it needs the uploaded image's dimensions as an identity signal.
  // Computed lazily (only when a probe actually runs) and cached across
  // retries. Best-effort: null means "no signal available".
  let expectedImage: ImageDimensions | null | undefined;
  const getExpectedImage = async (): Promise<ImageDimensions | null> => {
    if (expectedImage !== undefined) return expectedImage;
    if (caption) {
      expectedImage = null;
      return expectedImage;
    }
    try {
      const file = await objectStorageService.getObjectEntityFile(
        imagePath,
        tenantId,
      );
      const [buffer] = await file.download();
      expectedImage = getImageDimensions(new Uint8Array(buffer));
    } catch (err) {
      logger.warn(
        { err, contentItemId: id, tenantId },
        "Could not read the stored image for the Instagram duplicate-post probe",
      );
      expectedImage = null;
    }
    return expectedImage;
  };

  // Anchor for the duplicate-post probe: only IG posts created at/after this
  // moment can be a result of THIS publish job. A small backward buffer
  // absorbs clock skew between us and Meta.
  const publishStartedAt = new Date(Date.now() - 60_000);

  for (let attempt = 1; attempt <= IG_PUBLISH_RETRY.maxAttempts; attempt++) {
    try {
      const { postId, permalink } = await attemptInstagramPublish(params);
      await markPublished(id, tenantId, "instagram", { postId, permalink });
      return;
    } catch (error) {
      // Unknown (non-classified) errors — e.g. a network blip or a storage
      // hiccup — are treated as transient so they get the bounded retry rather
      // than failing on the first flake. Timeouts are the exception: a hung
      // platform call already burned its bounded window, and retrying a hang
      // during shutdown would eat the entire drain cap — fail fast instead.
      const retryable =
        error instanceof InstagramPublishError
          ? error.retryable
          : !(error instanceof PlatformTimeoutError);
      const attemptsLeft = attempt < IG_PUBLISH_RETRY.maxAttempts;

      // Retry idempotency: a transient-looking failure does not prove the
      // publish did NOT land — `media_publish` can commit the post and then
      // lose the response. Re-running the whole create -> poll -> publish flow
      // would post the same image twice. Before retrying (and before the final
      // give-up), probe the account's recent media and short-circuit if this
      // publish already landed. The probe is best-effort: if it fails we fall
      // back to the normal retry/give-up path.
      if (retryable) {
        try {
          const existingId = await findRecentMatchingInstagramMedia(
            igUserId,
            pageToken,
            caption,
            publishStartedAt,
            await getExpectedImage(),
          );
          if (existingId) {
            logger.warn(
              { contentItemId: id, tenantId, attempt, postId: existingId },
              "Instagram publish returned a transient error but the post already landed; skipping retry to avoid a duplicate",
            );
            const permalink = await fetchInstagramPermalink(
              existingId,
              pageToken,
            );
            await markPublished(id, tenantId, "instagram", {
              postId: existingId,
              permalink,
            });
            return;
          }
        } catch (probeErr) {
          logger.warn(
            { err: probeErr, contentItemId: id, tenantId },
            "Instagram duplicate-post probe failed; proceeding with retry",
          );
        }
      }

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
  trackSyncPublish,
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
    const message = buildPostText(item.title, item.caption);

    // Anchor for the duplicate-post probe: only posts created at/after this
    // moment can be a result of THIS publish request. A small backward buffer
    // absorbs clock skew between us and Meta.
    const publishStartedAt = new Date(Date.now() - 60_000);
    // For caption-less publishes the probe cannot match by text, so it needs
    // the uploaded image's dimensions as an identity signal (set below, once
    // the image bytes are in hand).
    let expectedImage: ImageDimensions | null = null;
    const checkAlreadyPosted = () =>
      findRecentMatchingPagePost(
        pageId,
        pageAccessToken,
        message,
        publishStartedAt,
        expectedImage,
      );

    try {
      let postId: string;

      if (item.imagePath) {
        const file = await objectStorageService.getObjectEntityFile(
          item.imagePath,
          req.tenantId,
        );
        const [buffer] = await file.download();
        if (!message) {
          expectedImage = getImageDimensions(new Uint8Array(buffer));
        }

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
        }>(`${GRAPH_BASE}/${pageId}/photos`, buildForm, "Facebook API error", async () => {
          const existingId = await checkAlreadyPosted();
          return existingId ? { post_id: existingId } : null;
        });
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
        }>(`${GRAPH_BASE}/${pageId}/feed`, buildForm, "Facebook API error", async () => {
          const existingId = await checkAlreadyPosted();
          return existingId ? { id: existingId } : null;
        });
        postId = fbJson.id || "";
      }

      const permalink = postId ? `https://www.facebook.com/${postId}` : null;
      await markPublished(id, req.tenantId, "facebook", { postId, permalink });
      res.json({ postId, permalink });
    } catch (error) {
      req.log.error({ err: error }, "Facebook publish failed");
      const reason =
        error instanceof Error && error.message
          ? `Facebook rejected the post: ${error.message}`
          : "Failed to publish to Facebook.";
      // Persist the rejection so it stays reviewable in the Content Library
      // after the toast is gone. Best-effort: a DB hiccup here must not mask
      // the original publish error in the response.
      try {
        await setContentStatus(id, req.tenantId, "failed", reason);
      } catch (updateErr) {
        req.log.error(
          { err: updateErr, contentItemId: id },
          "Failed to record Facebook publish failure",
        );
      }
      res.status(502).json({ error: reason });
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
    const caption = buildPostText(item.title, item.caption);
    const imagePath = item.imagePath;

    // Instagram fetches the image asynchronously, so the container can stay
    // IN_PROGRESS for tens of seconds — long enough to risk proxy/client
    // timeouts on a blocking request. Flip the item to "publishing", return
    // immediately, and run the create -> poll -> publish flow in the
    // background. The job persists the final "published"/"failed" status.
    //
    // If graceful shutdown has begun, refuse to start a new background publish
    // — the process is about to exit, so the job could be killed mid-flight
    // and leave the item stuck on "publishing". Return a retriable error
    // instead; any job that still races past this check is included in the
    // shutdown drain (see backgroundJobs.waitForPendingJobs).
    if (isShuttingDown()) {
      res.status(503).json({
        error:
          "The server is restarting. Your post was not published — please try again in a moment.",
      });
      return;
    }
    const previousStatus = item.status;
    await setContentStatus(id, req.tenantId, "publishing");

    const tenantId = req.tenantId;
    const accepted = enqueueBackgroundJob(() =>
      runInstagramPublish({
        id,
        tenantId,
        igUserId,
        pageToken,
        imagePath,
        caption,
      }),
    );
    if (!accepted) {
      // Shutdown began between the isShuttingDown() check above and the
      // enqueue. Nothing was sent to Instagram; revert the status we just set
      // so the item is not stuck on "publishing", and tell the client to
      // retry.
      try {
        await setContentStatus(
          id,
          req.tenantId,
          previousStatus,
          item.failureReason ?? null,
        );
      } catch (err) {
        req.log.error(
          { err, contentItemId: id },
          "Failed to revert content status after shutdown-rejected enqueue",
        );
      }
      res.status(503).json({
        error:
          "The server is restarting. Your post was not published — please try again in a moment.",
      });
      return;
    }

    res.status(202).json({ status: "publishing" });
  },
);

export default router;
