import {
  db,
  tenantsTable,
  tenantMembersTable,
  teamInvitesTable,
  seatRequestsTable,
  type Tenant,
  type TenantMember,
  type TeamInvite,
  type SeatRequest,
} from "@workspace/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { getPlan } from "./plans";

export type TeamRole = "owner" | "admin" | "member";

/**
 * Effective seat limit for a workspace (including the owner's seat):
 * the superadmin-granted per-workspace override when set, otherwise the
 * plan's default team seat allotment. 0 means the team add-on is off.
 */
export async function getEffectiveSeatLimit(tenant: Tenant): Promise<number> {
  if (tenant.seatLimit !== null) return tenant.seatLimit;
  const plan = await getPlan(tenant.plan);
  return plan.teamSeats;
}

/** Owner + accepted members + pending invites all consume a seat. */
export async function getSeatsUsed(tenantId: number): Promise<number> {
  const [members, invites] = await Promise.all([
    db
      .select({ id: tenantMembersTable.id })
      .from(tenantMembersTable)
      .where(eq(tenantMembersTable.tenantId, tenantId)),
    db
      .select({ id: teamInvitesTable.id })
      .from(teamInvitesTable)
      .where(
        and(
          eq(teamInvitesTable.tenantId, tenantId),
          eq(teamInvitesTable.status, "pending"),
        ),
      ),
  ]);
  return 1 + members.length + invites.length;
}

/**
 * Details about the current user's membership in a workspace they were
 * invited to: who invited them and when they joined. Best-effort — the
 * inviter is resolved from the accepted invite matching the member's email,
 * and their email from the tenant owner row or a fellow member row.
 */
export async function getMembershipDetails(
  tenant: Tenant,
  clerkUserId: string,
): Promise<{ invitedByEmail: string | null; joinedAt: string | null }> {
  const membership = (
    await db
      .select()
      .from(tenantMembersTable)
      .where(
        and(
          eq(tenantMembersTable.tenantId, tenant.id),
          eq(tenantMembersTable.clerkUserId, clerkUserId),
        ),
      )
      .limit(1)
  )[0];
  if (!membership) return { invitedByEmail: null, joinedAt: null };

  let invitedByEmail: string | null = null;
  if (membership.email) {
    const invite = (
      await db
        .select()
        .from(teamInvitesTable)
        .where(
          and(
            eq(teamInvitesTable.tenantId, tenant.id),
            sql`lower(${teamInvitesTable.email}) = ${membership.email.toLowerCase()}`,
            eq(teamInvitesTable.status, "accepted"),
          ),
        )
        .orderBy(desc(teamInvitesTable.createdAt))
        .limit(1)
    )[0];
    const inviterId = invite?.invitedByClerkUserId ?? null;
    if (inviterId) {
      if (inviterId === tenant.clerkUserId) {
        invitedByEmail = tenant.email ?? null;
      } else {
        const inviter = (
          await db
            .select({ email: tenantMembersTable.email })
            .from(tenantMembersTable)
            .where(
              and(
                eq(tenantMembersTable.tenantId, tenant.id),
                eq(tenantMembersTable.clerkUserId, inviterId),
              ),
            )
            .limit(1)
        )[0];
        invitedByEmail = inviter?.email ?? null;
      }
    }
  }

  return {
    invitedByEmail,
    joinedAt: membership.createdAt.toISOString(),
  };
}

function serializeMember(m: TenantMember) {
  return {
    id: m.id,
    email: m.email ?? null,
    role: m.role as "admin" | "member",
    createdAt: m.createdAt.toISOString(),
  };
}

function serializeInvite(i: TeamInvite) {
  return {
    id: i.id,
    email: i.email,
    role: i.role as "admin" | "member",
    status: i.status as "pending" | "accepted" | "revoked",
    createdAt: i.createdAt.toISOString(),
  };
}

export function serializeSeatRequest(r: SeatRequest) {
  return {
    id: r.id,
    requestedSeats: r.requestedSeats,
    note: r.note ?? null,
    status: r.status as "pending" | "approved" | "denied",
    grantedSeats: r.grantedSeats ?? null,
    decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
  };
}

/**
 * Full team overview for the tenant's Settings > Team tab. `role` is the
 * calling user's role in this workspace.
 */
export async function buildTeamOverview(tenantId: number, role: TeamRole) {
  const tenant = (
    await db
      .select()
      .from(tenantsTable)
      .where(eq(tenantsTable.id, tenantId))
      .limit(1)
  )[0];
  if (!tenant) throw new Error("Tenant not found");

  const [seatLimit, members, pendingInvites, requests] = await Promise.all([
    getEffectiveSeatLimit(tenant),
    db
      .select()
      .from(tenantMembersTable)
      .where(eq(tenantMembersTable.tenantId, tenantId))
      .orderBy(tenantMembersTable.createdAt),
    db
      .select()
      .from(teamInvitesTable)
      .where(
        and(
          eq(teamInvitesTable.tenantId, tenantId),
          eq(teamInvitesTable.status, "pending"),
        ),
      )
      .orderBy(teamInvitesTable.createdAt),
    db
      .select()
      .from(seatRequestsTable)
      .where(eq(seatRequestsTable.tenantId, tenantId))
      .orderBy(desc(seatRequestsTable.createdAt))
      .limit(20),
  ]);

  return {
    enabled: seatLimit > 0,
    role,
    seatLimit,
    seatsUsed: 1 + members.length + pendingInvites.length,
    members: members.map(serializeMember),
    invites: pendingInvites.map(serializeInvite),
    seatRequests: requests.map(serializeSeatRequest),
  };
}
