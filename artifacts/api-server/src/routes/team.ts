import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  tenantsTable,
  tenantMembersTable,
  teamInvitesTable,
  seatRequestsTable,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { CreateTeamInviteBody, CreateSeatRequestBody } from "@workspace/api-zod";
import { requireWorkspaceAdmin } from "../middlewares/requireWorkspaceAdmin";
import {
  buildTeamOverview,
  getEffectiveSeatLimit,
  getSeatsUsed,
} from "../lib/team";
import {
  notifySeatRequestSubmitted,
  notifyTeamMemberLeft,
  notifyTeamMemberRemoved,
} from "../lib/notifications";
import { sendTeamInviteEmail } from "../lib/teamInviteEmail";

const router: IRouter = Router();

async function loadTenant(tenantId: number) {
  return (
    await db
      .select()
      .from(tenantsTable)
      .where(eq(tenantsTable.id, tenantId))
      .limit(1)
  )[0];
}

/** GET /team — overview visible to every workspace user. */
router.get("/team", async (req: Request, res: Response) => {
  res.json(await buildTeamOverview(req.tenantId, req.memberRole));
});

/**
 * POST /team/leave — an invited member/admin removes themselves from the
 * workspace. Owners cannot leave (the workspace IS their tenant). On the
 * next request the leaver gets their own personal workspace auto-provisioned.
 */
router.post("/team/leave", async (req: Request, res: Response) => {
  if (req.memberRole === "owner") {
    res.status(403).json({
      error: "The workspace owner cannot leave their own workspace",
    });
    return;
  }
  const deleted = (
    await db
      .delete(tenantMembersTable)
      .where(
        and(
          eq(tenantMembersTable.tenantId, req.tenantId),
          eq(tenantMembersTable.clerkUserId, req.clerkUserId),
        ),
      )
      .returning()
  )[0];
  if (!deleted) {
    res.status(404).json({ error: "Membership not found" });
    return;
  }
  // Best-effort: tell the owner the seat was freed and by whom.
  await notifyTeamMemberLeft(req.tenantId, {
    email: deleted.email,
    role: deleted.role,
  });
  res.json({ ok: true });
});

// Everything below manages the team: owner/admin only.
router.use("/team", requireWorkspaceAdmin);

router.param("id", (req, res, next, value) => {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  next();
});

/**
 * POST /team/invites
 * Invite a user by email. The invite consumes a seat immediately; it is
 * accepted automatically when a user with that VERIFIED email signs in
 * without a workspace of their own.
 */
router.post("/team/invites", async (req: Request, res: Response) => {
  const parsed = CreateTeamInviteBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Enter a valid email address" });
    return;
  }
  const email = parsed.data.email.trim().toLowerCase();
  const role = parsed.data.role === "admin" ? "admin" : "member";

  const tenant = await loadTenant(req.tenantId);
  if (!tenant) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const seatLimit = await getEffectiveSeatLimit(tenant);
  if (seatLimit <= 0) {
    res.status(403).json({
      error: "The team add-on is not enabled for this workspace",
    });
    return;
  }

  if (tenant.email && tenant.email.toLowerCase() === email) {
    res.status(400).json({ error: "That user is already the workspace owner" });
    return;
  }

  // Duplicate guards: already a member, or already invited.
  const [existingMember, existingInvite] = await Promise.all([
    db
      .select({ id: tenantMembersTable.id })
      .from(tenantMembersTable)
      .where(
        and(
          eq(tenantMembersTable.tenantId, req.tenantId),
          eq(tenantMembersTable.email, email),
        ),
      )
      .limit(1),
    db
      .select({ id: teamInvitesTable.id })
      .from(teamInvitesTable)
      .where(
        and(
          eq(teamInvitesTable.tenantId, req.tenantId),
          eq(teamInvitesTable.email, email),
          eq(teamInvitesTable.status, "pending"),
        ),
      )
      .limit(1),
  ]);
  if (existingMember.length > 0) {
    res.status(400).json({ error: "That user is already a team member" });
    return;
  }
  if (existingInvite.length > 0) {
    res.status(400).json({ error: "That email already has a pending invite" });
    return;
  }

  const seatsUsed = await getSeatsUsed(req.tenantId);
  if (seatsUsed >= seatLimit) {
    res.status(402).json({
      error: `All ${seatLimit} seats are in use. Request more seats to invite more people.`,
    });
    return;
  }

  await db.insert(teamInvitesTable).values({
    tenantId: req.tenantId,
    email,
    role,
    invitedByClerkUserId: req.clerkUserId,
  });

  // Best-effort invite email with the exact sign-in address the invitee must
  // use (invites are matched on the verified sign-in email). Fully detached:
  // a missing SendGrid connection or send failure never fails the invite.
  const workspaceName = tenant.name;
  void sendTeamInviteEmail({ to: email, workspaceName });

  res.json(await buildTeamOverview(req.tenantId, req.memberRole));
});

/** DELETE /team/invites/:id — revoke a pending invite (frees the seat). */
router.delete("/team/invites/:id", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const updated = (
    await db
      .update(teamInvitesTable)
      .set({ status: "revoked" })
      .where(
        and(
          eq(teamInvitesTable.id, id),
          eq(teamInvitesTable.tenantId, req.tenantId),
          eq(teamInvitesTable.status, "pending"),
        ),
      )
      .returning()
  )[0];
  if (!updated) {
    res.status(404).json({ error: "Invite not found" });
    return;
  }
  res.json(await buildTeamOverview(req.tenantId, req.memberRole));
});

/**
 * DELETE /team/members/:id — remove a member (they lose access immediately).
 *
 * Any PENDING invite for the removed member's email is revoked in the same
 * operation. Otherwise a lingering duplicate/re-sent invite would be
 * auto-accepted by requireTenant on the ex-member's next sign-in, silently
 * re-adding them. Intended behavior: removal cuts access AND cancels any
 * standing invitation; rejoining requires a deliberate NEW invite sent after
 * the removal.
 */
router.delete("/team/members/:id", async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const deleted = (
    await db
      .delete(tenantMembersTable)
      .where(
        and(
          eq(tenantMembersTable.id, id),
          eq(tenantMembersTable.tenantId, req.tenantId),
        ),
      )
      .returning()
  )[0];
  if (!deleted) {
    res.status(404).json({ error: "Member not found" });
    return;
  }
  if (deleted.email) {
    await db
      .update(teamInvitesTable)
      .set({ status: "revoked" })
      .where(
        and(
          eq(teamInvitesTable.tenantId, req.tenantId),
          sql`lower(${teamInvitesTable.email}) = ${deleted.email.toLowerCase()}`,
          eq(teamInvitesTable.status, "pending"),
        ),
      );
  }
  // Best-effort: when a workspace ADMIN (not the owner) removed the member,
  // tell the owner who was removed and by whom. The owner removing someone
  // themselves gets no self-notification.
  if (req.memberRole !== "owner") {
    const actor = (
      await db
        .select({ email: tenantMembersTable.email })
        .from(tenantMembersTable)
        .where(
          and(
            eq(tenantMembersTable.tenantId, req.tenantId),
            eq(tenantMembersTable.clerkUserId, req.clerkUserId),
          ),
        )
        .limit(1)
    )[0];
    await notifyTeamMemberRemoved(
      req.tenantId,
      { email: deleted.email, role: deleted.role },
      { email: actor?.email ?? null },
    );
  }
  res.json(await buildTeamOverview(req.tenantId, req.memberRole));
});

/**
 * POST /team/seat-requests
 * Ask a superadmin for more seats. One pending request at a time.
 */
router.post("/team/seat-requests", async (req: Request, res: Response) => {
  const parsed = CreateSeatRequestBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  if (!Number.isInteger(parsed.data.requestedSeats)) {
    res.status(400).json({ error: "Seats must be a whole number" });
    return;
  }

  const pending = (
    await db
      .select({ id: seatRequestsTable.id })
      .from(seatRequestsTable)
      .where(
        and(
          eq(seatRequestsTable.tenantId, req.tenantId),
          eq(seatRequestsTable.status, "pending"),
        ),
      )
      .limit(1)
  )[0];
  if (pending) {
    res.status(400).json({
      error: "You already have a pending seat request. Wait for a decision first.",
    });
    return;
  }

  const note = parsed.data.note?.trim() || null;
  await db.insert(seatRequestsTable).values({
    tenantId: req.tenantId,
    requestedSeats: parsed.data.requestedSeats,
    note,
  });

  // Best-effort heads-up to platform admins; fully detached from the
  // response path so neither the name lookup nor the dispatch can fail
  // the already-created seat request.
  const requestedSeats = parsed.data.requestedSeats;
  const requestingTenantId = req.tenantId;
  void (async () => {
    let name: string | undefined;
    try {
      name = (await loadTenant(requestingTenantId))?.name;
    } catch {
      // fall back to the id-based label below
    }
    await notifySeatRequestSubmitted({
      requestingTenantId,
      requestingTenantName: name ?? `Tenant #${requestingTenantId}`,
      requestedSeats,
      note,
    });
  })();

  res.json(await buildTeamOverview(req.tenantId, req.memberRole));
});

export default router;
