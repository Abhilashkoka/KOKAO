import type { Request, Response, NextFunction } from "express";
import { getAuth } from "@clerk/express";
import { db, tenantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { fetchVerifiedEmail } from "../lib/clerkUser";
import { isSuperadminEmail } from "../lib/superadmins";

/**
 * Resolves the Clerk-authenticated user to a SocialForge tenant, auto-provisioning
 * one on first authenticated request. Attaches `req.tenantId`, `req.clerkUserId`,
 * `req.tenantEmail`, and `req.isSuperadmin`.
 *
 * NOTE: `req.isSuperadmin` here is derived from the cached tenant email and is only
 * a UI hint (exposed via /me). The authoritative authorization gate is
 * `requireSuperadmin`, which re-checks the live verified Clerk email.
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
      const authReason = String(res.getHeader("x-clerk-auth-reason") ?? "");
      const cookieNames = (req.headers.cookie ?? "")
        .split(";")
        .map((c) => c.split("=")[0]?.trim())
        .filter((n): n is string => Boolean(n));
      const clerkCookieNames = cookieNames.filter(
        (n) =>
          n.startsWith("__session") ||
          n.startsWith("__client_uat") ||
          n.startsWith("__clerk_db_jwt"),
      );
      const hasDuplicateClerkCookies =
        new Set(clerkCookieNames).size < clerkCookieNames.length;

      // Self-heal for cookie shadowing: when the browser holds DUPLICATE Clerk
      // cookies (same name set on overlapping domain/path scopes), the stale
      // copy can shadow the fresh one, so every request — including ones made
      // right after a fresh sign-in — arrives with an expired token and the
      // user appears permanently signed out. Expire every Clerk cookie on the
      // scopes we can address; clerk-js re-establishes clean cookies on the
      // next sign-in. Only triggers on the duplicate+expired combination, so
      // routine short-lived token refresh gaps never log anyone out.
      if (authReason.includes("token-expired") && hasDuplicateClerkCookies) {
        const rawHost = String(
          req.headers["x-forwarded-host"] ?? req.headers.host ?? "",
        )
          .split(",")[0]!
          .trim()
          .split(":")[0]!;
        // Only echo a well-formed hostname into the Domain attribute.
        const host = /^[a-zA-Z0-9.-]+$/.test(rawHost) ? rawHost : "";
        const expire =
          "=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0";
        for (const name of new Set(clerkCookieNames)) {
          res.append("Set-Cookie", `${name}${expire}`);
          res.append("Set-Cookie", `${name}${expire}; Secure; SameSite=None`);
          if (host) {
            res.append("Set-Cookie", `${name}${expire}; Domain=${host}`);
            res.append(
              "Set-Cookie",
              `${name}${expire}; Domain=${host}; Secure; SameSite=None`,
            );
          }
        }
        req.log.warn(
          { clerkCookieNames },
          "cleared duplicate stale clerk cookies",
        );
      }

      req.log.warn(
        {
          authStatus: res.getHeader("x-clerk-auth-status"),
          authReason,
          authMessage: res.getHeader("x-clerk-auth-message"),
          hasCookieHeader: Boolean(req.headers.cookie),
          cookieNames,
          hasAuthorizationHeader: Boolean(req.headers.authorization),
        },
        "clerk auth rejected",
      );
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
      const email = await fetchVerifiedEmail(clerkUserId);
      await db
        .insert(tenantsTable)
        .values({ clerkUserId, email, name: "My Workspace" })
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

    // Backfill email for tenants provisioned before we captured it.
    if (!tenant.email) {
      const email = await fetchVerifiedEmail(clerkUserId);
      if (email) {
        const updated = (
          await db
            .update(tenantsTable)
            .set({ email })
            .where(eq(tenantsTable.id, tenant.id))
            .returning()
        )[0];
        if (updated) tenant = updated;
      }
    }

    req.tenantId = tenant.id;
    req.clerkUserId = clerkUserId;
    req.tenantEmail = tenant.email ?? null;
    // Granted-in-app flag (DB-backed), trusted directly by requireSuperadmin.
    req.tenantIsSuperadmin = tenant.isSuperadmin;
    // Effective hint for the UI (/me): granted in-app OR allowlisted by email.
    req.isSuperadmin = tenant.isSuperadmin || isSuperadminEmail(tenant.email);
    next();
  } catch (error) {
    req.log.error({ err: error }, "Failed to resolve tenant");
    res.status(500).json({ error: "Failed to resolve tenant" });
  }
}
