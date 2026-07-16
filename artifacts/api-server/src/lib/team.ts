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
import { and, desc, eq } from "drizzle-orm";
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
