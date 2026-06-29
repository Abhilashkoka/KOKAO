import { Router, type IRouter, type Request, type Response } from "express";
import { db, contentItemsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { PublishContentToFacebookBody } from "@workspace/api-zod";
import { ObjectStorageService } from "../lib/objectStorage";

const router: IRouter = Router();

const objectStorageService = new ObjectStorageService();

const GRAPH_VERSION = "v21.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

interface ManagedPage {
  id: string;
  name: string;
  access_token: string;
}

/**
 * The configured FACEBOOK_PAGE_ACCESS_TOKEN is treated as a USER access token
 * with pages_show_list / pages_read_engagement / pages_manage_posts. We resolve
 * the per-Page access token at request time via /me/accounts so a Page token is
 * always fresh and the user can choose which Page to publish to.
 */
async function fetchManagedPages(): Promise<ManagedPage[]> {
  const userToken = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
  if (!userToken) {
    throw new Error("FACEBOOK_PAGE_ACCESS_TOKEN is not configured");
  }
  const url = `${GRAPH_BASE}/me/accounts?fields=id,name,access_token&access_token=${encodeURIComponent(
    userToken,
  )}`;
  const res = await fetch(url);
  const json = (await res.json()) as {
    data?: ManagedPage[];
    error?: { message?: string };
  };
  if (!res.ok || json.error) {
    throw new Error(json.error?.message || `Facebook API error (${res.status})`);
  }
  return json.data ?? [];
}

router.param("id", (req, res, next, value) => {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  next();
});

router.get("/facebook/pages", async (req: Request, res: Response) => {
  try {
    const pages = await fetchManagedPages();
    res.json({ pages: pages.map((p) => ({ id: p.id, name: p.name })) });
  } catch (error) {
    req.log.error({ err: error }, "Failed to list Facebook pages");
    res.status(502).json({
      error:
        "Could not reach Facebook. Check that the connected access token is valid and has the pages_show_list permission.",
    });
  }
});

router.post(
  "/content/:id/publish-facebook",
  async (req: Request, res: Response) => {
    const parsed = PublishContentToFacebookBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }

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

    let pages: ManagedPage[];
    try {
      pages = await fetchManagedPages();
    } catch (error) {
      req.log.error({ err: error }, "Failed to resolve Facebook page token");
      res.status(502).json({
        error:
          "Could not reach Facebook. Check that the connected access token is valid.",
      });
      return;
    }

    const page = pages.find((p) => p.id === parsed.data.pageId);
    if (!page) {
      res.status(400).json({
        error: "Selected Facebook Page is not managed by the connected account.",
      });
      return;
    }

    const message = item.caption?.trim() || item.title;

    try {
      let postId: string;

      if (item.imagePath) {
        const file = await objectStorageService.getObjectEntityFile(
          item.imagePath,
        );
        const [buffer] = await file.download();

        const form = new FormData();
        form.append("access_token", page.access_token);
        if (message) form.append("caption", message);
        form.append(
          "source",
          new Blob([new Uint8Array(buffer)], { type: "image/png" }),
          "image.png",
        );

        const fbRes = await fetch(`${GRAPH_BASE}/${page.id}/photos`, {
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
        form.append("access_token", page.access_token);
        form.append("message", message);

        const fbRes = await fetch(`${GRAPH_BASE}/${page.id}/feed`, {
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
        ? `https://www.facebook.com/${postId}`
        : null;
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

export default router;
