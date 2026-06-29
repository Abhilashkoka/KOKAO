import type { Request, Response, NextFunction } from "express";
import { getAuth } from "@clerk/express";
import { db, tenantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

/**
 * Resolves the Clerk-authenticated user to a SocialForge tenant, auto-provisioning
 * one on first authenticated request. Attaches `req.tenantId` and `req.clerkUserId`.
 * Responds 401 when there is no authenticated session.
 */
export async function requireTenant(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const auth = getAuth(req);
    const claims = auth?.sessionClaims as { userId?: string } | undefined;
    const clerkUserId = claims?.userId ?? auth?.userId ?? null;

    if (!clerkUserId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    let tenant = (
      await db
        .select()
        .from(tenantsTable)
        .where(eq(tenantsTable.clerkUserId, clerkUserId))
        .limit(1)
    )[0];

    if (!tenant) {
      // Conflict-safe provisioning: concurrent first requests for the same
      // clerkUserId race here, so insert-on-conflict-do-nothing then reselect.
      await db
        .insert(tenantsTable)
        .values({ clerkUserId, name: "My Workspace" })
        .onConflictDoNothing();
      tenant = (
        await db
          .select()
          .from(tenantsTable)
          .where(eq(tenantsTable.clerkUserId, clerkUserId))
          .limit(1)
      )[0];
    }

    if (!tenant) {
      res.status(500).json({ error: "Failed to resolve tenant" });
      return;
    }

    req.tenantId = tenant.id;
    req.clerkUserId = clerkUserId;
    next();
  } catch (error) {
    req.log.error({ err: error }, "Failed to resolve tenant");
    res.status(500).json({ error: "Failed to resolve tenant" });
  }
}
