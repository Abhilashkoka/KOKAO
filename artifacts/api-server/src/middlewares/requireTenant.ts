import type { Request, Response, NextFunction } from "express";
import { getAuth } from "@clerk/express";
import {
  db,
  tenantsTable,
  tenantMembersTable,
  teamInvitesTable,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { getEffectiveSeatLimit, getSeatsUsed } from "../lib/team";
import { fetchVerifiedEmail } from "../lib/clerkUser";
import { isSuperadminEmail } from "../lib/superadmins";

/**
 * Resolves the Clerk-authenticated user to a KOKAO tenant, auto-provisioning
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
    let memberRole: "owner" | "admin" | "member" = "owner";

    if (!tenant) {
      // Not a workspace owner — maybe a team member of another workspace.
      const membership = (
        await db
          .select()
          .from(tenantMembersTable)
          .where(eq(tenantMembersTable.clerkUserId, clerkUserId))
          .limit(1)
      )[0];
      if (membership) {
        tenant = (
          await db
            .select()
            .from(tenantsTable)
            .where(eq(tenantsTable.id, membership.tenantId))
            .limit(1)
        )[0];
        if (tenant) memberRole = membership.role === "admin" ? "admin" : "member";
      }
    }

    if (!tenant) {
      const email = await fetchVerifiedEmail(clerkUserId);

      // First sign-in with a pending team invite matching the VERIFIED email:
      // join that workspace instead of provisioning a personal one. Seats are
      // re-checked at acceptance time in case the limit was lowered since the
      // invite was sent.
      if (email) {
        const invite = (
          await db
            .select()
            .from(teamInvitesTable)
            .where(
              and(
                sql`lower(${teamInvitesTable.email}) = ${email.toLowerCase()}`,
                eq(teamInvitesTable.status, "pending"),
              ),
            )
            .orderBy(teamInvitesTable.createdAt)
            .limit(1)
        )[0];
        if (invite) {
          const inviteTenant = (
            await db
              .select()
              .from(tenantsTable)
              .where(eq(tenantsTable.id, invite.tenantId))
              .limit(1)
          )[0];
          if (inviteTenant) {
            const [limit, used] = await Promise.all([
              getEffectiveSeatLimit(inviteTenant),
              getSeatsUsed(inviteTenant.id),
            ]);
            // The pending invite itself already holds a seat, so acceptance
            // never grows usage — only require the limit is still positive
            // and usage is within it.
            if (limit > 0 && used <= limit) {
              await db
                .insert(tenantMembersTable)
                .values({
                  tenantId: invite.tenantId,
                  clerkUserId,
                  email,
                  role: invite.role === "admin" ? "admin" : "member",
                })
                .onConflictDoNothing();
              const membership = (
                await db
                  .select()
                  .from(tenantMembersTable)
                  .where(eq(tenantMembersTable.clerkUserId, clerkUserId))
                  .limit(1)
              )[0];
              if (membership && membership.tenantId === invite.tenantId) {
                await db
                  .update(teamInvitesTable)
                  .set({ status: "accepted", acceptedAt: new Date() })
                  .where(eq(teamInvitesTable.id, invite.id));
                tenant = inviteTenant;
                memberRole =
                  membership.role === "admin" ? "admin" : "member";
              }
            }
          }
        }
      }

      if (!tenant) {
        // Concurrent first requests race with invite auto-accept: another
        // request may have consumed the pending invite (marking it accepted)
        // after our membership check but before our invite lookup. Re-check
        // membership before provisioning a personal tenant, otherwise the
        // user ends up owning a personal workspace that permanently shadows
        // their team membership.
        const lateMembership = (
          await db
            .select()
            .from(tenantMembersTable)
            .where(eq(tenantMembersTable.clerkUserId, clerkUserId))
            .limit(1)
        )[0];
        if (lateMembership) {
          tenant = (
            await db
              .select()
              .from(tenantsTable)
              .where(eq(tenantsTable.id, lateMembership.tenantId))
              .limit(1)
          )[0];
          if (tenant) {
            memberRole = lateMembership.role === "admin" ? "admin" : "member";
          }
        }
      }

      if (!tenant) {
        // Conflict-safe provisioning: concurrent first requests for the same
        // clerkUserId race here, so insert-on-conflict-do-nothing then reselect.
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
        memberRole = "owner";
      }
    }

    if (!tenant) {
      res.status(500).json({ error: "Failed to resolve tenant" });
      return;
    }

    // Backfill email for tenants provisioned before we captured it. Owner
    // only: a member's email must never overwrite the workspace owner's.
    if (!tenant.email && memberRole === "owner") {
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
    req.memberRole = memberRole;
    // Superadmin status is a property of the OWNER's identity, never
    // inherited by team members working inside the workspace.
    if (memberRole === "owner") {
      // Granted-in-app flag (DB-backed), trusted directly by requireSuperadmin.
      req.tenantIsSuperadmin = tenant.isSuperadmin;
      // Effective hint for the UI (/me): granted in-app OR allowlisted email.
      req.isSuperadmin = tenant.isSuperadmin || isSuperadminEmail(tenant.email);
    } else {
      req.tenantIsSuperadmin = false;
      req.isSuperadmin = false;
    }
    next();
  } catch (error) {
    req.log.error({ err: error }, "Failed to resolve tenant");
    res.status(500).json({ error: "Failed to resolve tenant" });
  }
}
