import { Router, type IRouter, type Request, type Response } from "express";
import { db, landingContentTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { GetLandingContentResponse as LandingContent } from "@workspace/api-zod";
import { requireSuperadmin } from "../middlewares/requireSuperadmin";
import { recordAdminAction } from "../lib/adminAudit";
import { DEFAULT_LANDING_CONTENT } from "../lib/landingDefaults";

/**
 * Loads the effective landing page document: the saved custom document when
 * present and still valid, otherwise the bundled default. A stored document
 * that no longer parses (schema drift) falls back to the default rather than
 * serving a broken page.
 */
async function loadLandingContent() {
  const [row] = await db
    .select()
    .from(landingContentTable)
    .where(eq(landingContentTable.id, 1))
    .limit(1);
  if (!row?.content) return DEFAULT_LANDING_CONTENT;
  const parsed = LandingContent.safeParse(row.content);
  return parsed.success ? parsed.data : DEFAULT_LANDING_CONTENT;
}

/**
 * Public read. Mounted BEFORE authentication: the landing and privacy pages
 * render for signed-out visitors.
 */
export const publicLandingContentRouter: IRouter = Router();

publicLandingContentRouter.get(
  "/landing-content",
  async (req: Request, res: Response) => {
    try {
      res.json(await loadLandingContent());
    } catch (error) {
      req.log.error({ err: error }, "Failed to load landing content");
      res.status(500).json({ error: "Failed to load landing content" });
    }
  },
);

/**
 * A CMS link/href value is safe when it is an internal path, a fragment, or
 * an explicit https/mailto URL. Anything else (javascript:, data:, protocol-
 * relative, etc.) is rejected so a stored document can never inject an
 * executable URL into every public visitor's page.
 */
function isSafeCmsUrl(value: string): boolean {
  if (value === "") return true;
  if (value.startsWith("//")) return false;
  if (value.startsWith("/") || value.startsWith("#")) return true;
  return /^(https:\/\/|mailto:)/i.test(value);
}

const LINK_KEYS = new Set(["href", "link", "cta_link", "cta_secondary_link"]);

/** Recursively collect every unsafe link-like string in the document. */
function findUnsafeLinks(node: unknown, path = ""): string[] {
  if (Array.isArray(node)) {
    return node.flatMap((item, i) => findUnsafeLinks(item, `${path}[${i}]`));
  }
  if (node && typeof node === "object") {
    return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) => {
      const childPath = path ? `${path}.${key}` : key;
      if (LINK_KEYS.has(key) && typeof value === "string" && !isSafeCmsUrl(value)) {
        return [childPath];
      }
      return findUnsafeLinks(value, childPath);
    });
  }
  return [];
}

/**
 * Writes. Mounted AFTER requireTenant; superadmin-only. Replaces the whole
 * document atomically (the editor always saves the full document).
 */
export const protectedLandingContentRouter: IRouter = Router();

protectedLandingContentRouter.put(
  "/landing-content",
  requireSuperadmin,
  async (req: Request, res: Response) => {
    const parsed = LandingContent.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request" });
      return;
    }

    const unsafeLinks = findUnsafeLinks(parsed.data);
    if (unsafeLinks.length > 0) {
      res.status(400).json({
        error: `Links must be internal paths, https:// or mailto: URLs. Invalid: ${unsafeLinks.join(", ")}`,
      });
      return;
    }

    // The logo must be an uploaded brand asset path or an https URL — never
    // an arbitrary string that could smuggle an executable scheme.
    const logo = parsed.data.site.logo;
    if (
      logo !== "" &&
      !/^\/api\/storage\/public-objects\/brand\/[\w-]+$/.test(logo) &&
      !/^https:\/\//i.test(logo)
    ) {
      res.status(400).json({ error: "Logo must be an uploaded asset or an https URL" });
      return;
    }

    const oldContent = await loadLandingContent();

    await db
      .insert(landingContentTable)
      .values({ id: 1, content: parsed.data })
      .onConflictDoUpdate({
        target: landingContentTable.id,
        set: { content: parsed.data },
      });

    const saved = await loadLandingContent();

    // Best-effort audit trail; never fail the save on an audit error.
    if (JSON.stringify(oldContent) !== JSON.stringify(saved)) {
      try {
        await recordAdminAction({
          action: "landing_content_change",
          actorTenantId: req.tenantId,
          actorEmail: req.tenantEmail,
          targetTenantId: null,
          targetEmail: null,
          // The full document is large; audit a compact summary instead.
          oldValue: JSON.stringify({ meta_title: oldContent.site.meta_title }),
          newValue: JSON.stringify({ meta_title: saved.site.meta_title }),
        });
      } catch (error) {
        req.log.error(
          { err: error },
          "Failed to write landing-content-change audit log",
        );
      }
    }

    res.json(saved);
  },
);
