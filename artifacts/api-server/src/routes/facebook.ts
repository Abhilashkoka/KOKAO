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
 * Resolve the Facebook Page(s) the configured FACEBOOK_PAGE_ACCESS_TOKEN can
 * publish to. The token may be either:
 *  - a USER access token (pages_show_list/pages_manage_posts): we list managed
 *    Pages via /me/accounts and use each Page's own access token; or
 *  - a PAGE access token: /me/accounts is empty, so the token itself is the
 *    Page token and /me resolves to that single Page.
 * Supporting both means the user can paste whichever token Graph API Explorer
 * hands them.
 */
async function fetchManagedPages(): Promise<ManagedPage[]> {
  const token = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
  if (!token) {
    throw new Error("FACEBOOK_PAGE_ACCESS_TOKEN is not configured");
  }

  // Try the user-token path first.
  const accRes = await fetch(
    `${GRAPH_BASE}/me/accounts?fields=id,name,access_token&access_token=${encodeURIComponent(
      token,
    )}`,
  );
  const accJson = (await accRes.json()) as {
    data?: ManagedPage[];
    error?: { message?: string };
  };
  if (accRes.ok && Array.isArray(accJson.data) && accJson.data.length > 0) {
    return accJson.data;
  }

  // Fall back to treating it as a Page token: /me resolves to the Page itself.
  const meRes = await fetch(
    `${GRAPH_BASE}/me?fields=id,name,category&access_token=${encodeURIComponent(
      token,
    )}`,
  );
  const meJson = (await meRes.json()) as {
    id?: string;
    name?: string;
    category?: string;
    error?: { message?: string };
  };
  if (!meRes.ok || meJson.error) {
    throw new Error(
      meJson.error?.message ||
        accJson.error?.message ||
        `Facebook API error (${meRes.status})`,
    );
  }
  // A Page identity carries a `category`; a user identity does not.
  if (meJson.id && meJson.category) {
    return [{ id: meJson.id, name: meJson.name ?? "Facebook Page", access_token: token }];
  }

  // Valid user token but no managed Pages.
  return [];
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
