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

    // TEMP DEBUG (auth 401 investigation): log what Clerk sees without leaking
    // any secret values — cookie presence as booleans + non-secret JWT claims.
    const cookieHeader = req.headers.cookie ?? "";
    let sessionClaimsDebug: Record<string, unknown> = {};
    try {
      const m = cookieHeader.match(/(?:^|;\s*)__session=([^;]+)/);
      if (m) {
        const token = decodeURIComponent(m[1]);
        const parts = token.split(".");
        sessionClaimsDebug.jwtParts = parts.length;
        if (parts.length === 3) {
          const payload = JSON.parse(
            Buffer.from(parts[1], "base64url").toString("utf8"),
          ) as Record<string, unknown>;
          const nowSec = Math.floor(Date.now() / 1000);
          sessionClaimsDebug = {
            jwtParts: 3,
            iss: payload.iss,
            azp: payload.azp,
            hasSub: Boolean(payload.sub),
            iat: payload.iat,
            exp: payload.exp,
            nbf: payload.nbf,
            nowSec,
            expired:
              typeof payload.exp === "number" ? payload.exp < nowSec : null,
            notYetValid:
              typeof payload.nbf === "number" ? payload.nbf > nowSec : null,
          };
        }
      } else {
        sessionClaimsDebug.noSessionCookieMatch = true;
      }
    } catch (e) {
      sessionClaimsDebug.decodeError = String(e);
    }
    req.log.info(
      {
        authUserId: auth?.userId ?? null,
        authSessionId: (auth as { sessionId?: string } | undefined)?.sessionId ?? null,
        authStatus: (auth as { status?: string } | undefined)?.status ?? null,
        authReason: (auth as { reason?: string } | undefined)?.reason ?? null,
        hasCookieHeader: cookieHeader.length > 0,
        hasSessionCookie: cookieHeader.includes("__session"),
        hasClientCookie: cookieHeader.includes("__client"),
        sessionClaimsDebug,
      },
      "requireTenant auth debug",
    );

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
