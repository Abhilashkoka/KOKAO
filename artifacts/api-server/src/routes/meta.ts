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

async function markPublished(id: number, tenantId: number) {
  await db
    .update(contentItemsTable)
    .set({ status: "published", updatedAt: new Date() })
    .where(
      and(
        eq(contentItemsTable.id, id),
        eq(contentItemsTable.tenantId, tenantId),
      ),
    );
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
        );
        const [buffer] = await file.download();

        const form = new FormData();
        form.append("access_token", pageAccessToken);
        if (message) form.append("caption", message);
        form.append(
          "source",
          new Blob([new Uint8Array(buffer)], { type: "image/png" }),
          "image.png",
        );

        const fbRes = await fetch(`${GRAPH_BASE}/${pageId}/photos`, {
          method: "POST",
          body: form,
        });
        const fbJson = (await fbRes.json()) as {
          id?: string;
          post_id?: string;
          error?: { message?: string };
        };
        if (!fbRes.ok || fbJson.error) {
          throw new Error(
            fbJson.error?.message || `Facebook API error (${fbRes.status})`,
          );
        }
        postId = fbJson.post_id || fbJson.id || "";
      } else {
        const form = new FormData();
        form.append("access_token", pageAccessToken);
        form.append("message", message);

        const fbRes = await fetch(`${GRAPH_BASE}/${pageId}/feed`, {
          method: "POST",
          body: form,
        });
        const fbJson = (await fbRes.json()) as {
          id?: string;
          error?: { message?: string };
        };
        if (!fbRes.ok || fbJson.error) {
          throw new Error(
            fbJson.error?.message || `Facebook API error (${fbRes.status})`,
          );
        }
        postId = fbJson.id || "";
      }

      await markPublished(id, req.tenantId);
      const permalink = postId ? `https://www.facebook.com/${postId}` : null;
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

    try {
      // Instagram fetches the image itself, so it needs a public URL. Mint a
      // short-lived signed GET URL for the private object.
      const imageUrl = await objectStorageService.getSignedDownloadURL(
        item.imagePath,
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
        throw new Error(
          createJson.error?.message ||
            `Instagram API error (${createRes.status})`,
        );
      }

      // Step 2: publish the container.
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
        throw new Error(
          publishJson.error?.message ||
            `Instagram API error (${publishRes.status})`,
        );
      }

      await markPublished(id, req.tenantId);
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

      res.json({ postId, permalink });
    } catch (error) {
      req.log.error({ err: error }, "Instagram publish failed");
      res.status(502).json({
        error:
          error instanceof Error
            ? `Instagram rejected the post: ${error.message}`
            : "Failed to publish to Instagram.",
      });
    }
  },
);

export default router;
