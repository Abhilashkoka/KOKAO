import { Router, type IRouter, type Request, type Response } from "express";
import { db, contentItemsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { ObjectStorageService } from "../lib/objectStorage";
import {
  TWITTER_API_BASE,
  buildOAuthHeader,
  getTwitterAppCredentials,
  getTenantTwitterCredentials,
  uploadTwitterMedia,
  type TwitterCredentials,
} from "../lib/twitterApi";
import { trimToTweetLength } from "@workspace/social-limits";

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
 * Publish a content item to the tenant's connected X (Twitter) account using
 * their stored, encrypted OAuth 1.0a access token + secret. Requires the
 * admin-configured app-level API key/secret to sign requests.
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

    const account = await getTenantTwitterCredentials(req.tenantId);
    if (!account || !account.verified) {
      res.status(400).json({
        error:
          "X is not connected or not verified. Add and verify your X access token on the Accounts page first.",
      });
      return;
    }

    const creds: TwitterCredentials = account.creds;
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
          app,
          creds,
        });
      }

      const tweetUrl = `${TWITTER_API_BASE}/2/tweets`;
      const tweetAuth = buildOAuthHeader({
        method: "POST",
        url: tweetUrl,
        consumerKey: app.apiKey,
        consumerSecret: app.apiSecret,
        token: creds.accessToken,
        tokenSecret: creds.accessTokenSecret,
      });
      const tweetBody: Record<string, unknown> = { text };
      if (mediaId) {
        tweetBody.media = { media_ids: [mediaId] };
      }
      const tweetRes = await fetch(tweetUrl, {
        method: "POST",
        headers: {
          Authorization: tweetAuth,
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
      const handle = account.accountName.startsWith("@")
        ? account.accountName.slice(1)
        : account.accountName;
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
