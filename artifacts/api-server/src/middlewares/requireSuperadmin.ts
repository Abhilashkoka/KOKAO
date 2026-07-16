import type { Request, Response, NextFunction } from "express";
import { db, tenantsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { fetchVerifiedEmail } from "../lib/clerkUser";
import { isSuperadminEmail } from "../lib/superadmins";

/**
 * Authoritative gate for cross-tenant superadmin routes. Must be mounted AFTER
 * requireTenant.
 *
 * Unlike the cached `req.isSuperadmin` hint, this re-resolves the user's CURRENT
 * verified primary email directly from Clerk and checks the allowlist live. This
 * ties privilege to the live verified identity: an email change that drops the
 * user off the allowlist revokes access immediately, and stale/unverified DB
 * email can never grant access. It fails closed (403) on any Clerk error.
 *
 * Admin routes are low-traffic (only superadmins reach them), so the extra Clerk
 * lookup here does not affect normal request paths.
 */
export async function requireSuperadmin(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    // Granted-in-app superadmins are trusted directly from the DB flag (loaded
    // fresh each request by requireTenant) — no Clerk lookup needed.
    if (req.tenantIsSuperadmin) {
      req.isSuperadmin = true;
      next();
      return;
    }

    // Otherwise this can only be a "root" (allowlisted) superadmin, which must
    // be verified against the live verified Clerk email.
    const liveEmail = await fetchVerifiedEmail(req.clerkUserId);
    if (!isSuperadminEmail(liveEmail)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    // Self-heal the cached email so the /me hint and admin table stay accurate.
    // Only when the request runs in the user's OWN tenant: a team member's
    // req.tenantId points at someone else's workspace, and the cached email
    // column belongs to that workspace's owner — never overwrite it with the
    // member's identity. The clerkUserId condition makes this owner-only at
    // the database level regardless of how the request context was resolved.
    if (
      liveEmail &&
      liveEmail !== req.tenantEmail &&
      req.memberRole === "owner"
    ) {
      await db
        .update(tenantsTable)
        .set({ email: liveEmail })
        .where(
          and(
            eq(tenantsTable.id, req.tenantId),
            eq(tenantsTable.clerkUserId, req.clerkUserId),
          ),
        );
      req.tenantEmail = liveEmail;
    }

    req.isSuperadmin = true;
    next();
  } catch (error) {
    req.log.error({ err: error }, "Superadmin check failed");
    res.status(403).json({ error: "Forbidden" });
  }
}
