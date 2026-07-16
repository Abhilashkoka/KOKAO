import {
  describe,
  it,
  expect,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import request from "supertest";

vi.mock("@clerk/express", async () => {
  const { authState } = await import("../test/authState");
  return {
    getAuth: () =>
      authState.userId
        ? {
            userId: authState.userId,
            sessionClaims: { userId: authState.userId },
          }
        : {},
    clerkClient: {
      users: {
        getUser: async (id: string) => {
          const u = authState.users[id];
          if (!u) throw new Error("user not found");
          return u;
        },
      },
    },
    clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) =>
      next(),
  };
});

import express, { type Express } from "express";
import { randomUUID } from "crypto";
import {
  db,
  pool,
  tenantsTable,
  tenantMembersTable,
  teamInvitesTable,
  seatRequestsTable,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { requireTenant } from "../middlewares/requireTenant";
import teamRouter from "../routes/team";
import meRouter from "../routes/me";
import contentRouter from "../routes/content";
import { resetAuthState, actAs } from "../test/authState";
import {
  createTenant,
  deleteTenant,
  getTenant,
  insertContentItem,
} from "../test/dbHelpers";

function createTeamTestApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: Record<string, () => void> }).log = {
      info() {},
      error() {},
      warn() {},
      debug() {},
    };
    next();
  });
  // Mirror routes/index.ts ordering: requireTenant first, then routers.
  app.use("/api", requireTenant, meRouter, teamRouter, contentRouter);
  return app;
}

const app = createTeamTestApp();

async function setSeatLimit(tenantId: number, seatLimit: number | null) {
  await db
    .update(tenantsTable)
    .set({ seatLimit })
    .where(eq(tenantsTable.id, tenantId));
}

async function addMember(
  tenantId: number,
  role: "admin" | "member",
  email?: string,
): Promise<{ clerkUserId: string; memberId: number; email: string }> {
  const clerkUserId = `test_member_${randomUUID()}`;
  const memberEmail = email ?? `${clerkUserId}@example.com`;
  const [row] = await db
    .insert(tenantMembersTable)
    .values({ tenantId, clerkUserId, email: memberEmail, role })
    .returning();
  return { clerkUserId, memberId: row.id, email: memberEmail };
}

async function addPendingInvite(
  tenantId: number,
  email: string,
  role: "admin" | "member" = "member",
): Promise<number> {
  const [row] = await db
    .insert(teamInvitesTable)
    .values({
      tenantId,
      email: email.toLowerCase(),
      role,
      invitedByClerkUserId: "test_inviter",
    })
    .returning();
  return row.id;
}

/** Delete a tenant auto-provisioned for a clerk user during a test, if any. */
async function deleteTenantForClerkUser(clerkUserId: string) {
  const row = (
    await db
      .select({ id: tenantsTable.id })
      .from(tenantsTable)
      .where(eq(tenantsTable.clerkUserId, clerkUserId))
      .limit(1)
  )[0];
  if (row) await deleteTenant(row.id);
}

afterAll(async () => {
  await pool.end();
});

beforeEach(() => {
  resetAuthState();
});

describe("plain member role restrictions (routes/team.ts)", () => {
  it("member gets 403 on POST /team/invites, DELETE invites/members, and no data changes", async () => {
    const owner = await createTenant({ email: "owner@example.com" });
    await setSeatLimit(owner.tenantId, 5);
    const member = await addMember(owner.tenantId, "member");
    const otherMember = await addMember(owner.tenantId, "member");
    const inviteId = await addPendingInvite(owner.tenantId, "pending@example.com");
    try {
      actAs(member.clerkUserId, member.email);

      // GET /team is readable by every workspace user.
      const overview = await request(app).get("/api/team");
      expect(overview.status).toBe(200);
      expect(overview.body.role).toBe("member");

      const invite = await request(app)
        .post("/api/team/invites")
        .send({ email: "newperson@example.com", role: "member" });
      expect(invite.status).toBe(403);

      const revoke = await request(app).delete(`/api/team/invites/${inviteId}`);
      expect(revoke.status).toBe(403);

      const remove = await request(app).delete(
        `/api/team/members/${otherMember.memberId}`,
      );
      expect(remove.status).toBe(403);

      const seatReq = await request(app)
        .post("/api/team/seat-requests")
        .send({ requestedSeats: 10 });
      expect(seatReq.status).toBe(403);

      // Nothing was actually mutated by the rejected calls.
      const invites = await db
        .select()
        .from(teamInvitesTable)
        .where(eq(teamInvitesTable.tenantId, owner.tenantId));
      expect(invites).toHaveLength(1);
      expect(invites[0].status).toBe("pending");
      const members = await db
        .select()
        .from(tenantMembersTable)
        .where(eq(tenantMembersTable.tenantId, owner.tenantId));
      expect(members).toHaveLength(2);
      const seatRequests = await db
        .select()
        .from(seatRequestsTable)
        .where(eq(seatRequestsTable.tenantId, owner.tenantId));
      expect(seatRequests).toHaveLength(0);
    } finally {
      await deleteTenant(owner.tenantId);
    }
  });

  it("member gets 403 on PATCH /me/settings and the workspace is unchanged", async () => {
    const owner = await createTenant({ email: "owner2@example.com" });
    await setSeatLimit(owner.tenantId, 5);
    const member = await addMember(owner.tenantId, "member");
    try {
      actAs(member.clerkUserId, member.email);

      const res = await request(app)
        .patch("/api/me/settings")
        .send({ name: "Hijacked Workspace" });
      expect(res.status).toBe(403);

      const tenant = await getTenant(owner.tenantId);
      expect(tenant.name).toBe("Test Workspace");
    } finally {
      await deleteTenant(owner.tenantId);
    }
  });

  it("admin member CAN invite (contrast: gate is role-based, not owner-only)", async () => {
    const owner = await createTenant({ email: "owner3@example.com" });
    await setSeatLimit(owner.tenantId, 5);
    const admin = await addMember(owner.tenantId, "admin");
    try {
      actAs(admin.clerkUserId, admin.email);

      const res = await request(app)
        .post("/api/team/invites")
        .send({ email: "invited-by-admin@example.com", role: "member" });
      expect(res.status).toBe(200);
      const invites = await db
        .select()
        .from(teamInvitesTable)
        .where(
          and(
            eq(teamInvitesTable.tenantId, owner.tenantId),
            eq(teamInvitesTable.email, "invited-by-admin@example.com"),
          ),
        );
      expect(invites).toHaveLength(1);
    } finally {
      await deleteTenant(owner.tenantId);
    }
  });
});

describe("invite auto-accept seat check (requireTenant)", () => {
  it("refuses to join when the seat limit was lowered below usage; user gets own workspace", async () => {
    const owner = await createTenant({ email: "owner4@example.com" });
    // Limit lowered to 1 (owner only) AFTER the invite was sent: the pending
    // invite makes seatsUsed = 2 > limit, so acceptance must be refused.
    const inviteEmail = `late-${randomUUID()}@example.com`;
    const inviteId = await addPendingInvite(owner.tenantId, inviteEmail);
    await setSeatLimit(owner.tenantId, 1);
    const newUserId = `test_new_${randomUUID()}`;
    try {
      actAs(newUserId, inviteEmail);

      const res = await request(app).get("/api/me");
      expect(res.status).toBe(200);
      // Provisioned a personal workspace instead of joining the full one.
      expect(res.body.team.role).toBe("owner");
      expect(res.body.tenant.id).not.toBe(owner.tenantId);

      // No membership row was created and the invite stays pending.
      const memberships = await db
        .select()
        .from(tenantMembersTable)
        .where(eq(tenantMembersTable.clerkUserId, newUserId));
      expect(memberships).toHaveLength(0);
      const invite = (
        await db
          .select()
          .from(teamInvitesTable)
          .where(eq(teamInvitesTable.id, inviteId))
          .limit(1)
      )[0];
      expect(invite.status).toBe("pending");
    } finally {
      await deleteTenantForClerkUser(newUserId);
      await deleteTenant(owner.tenantId);
    }
  });

  it("refuses to join when the team add-on is off (limit 0)", async () => {
    const owner = await createTenant({ email: "owner5@example.com" });
    const inviteEmail = `off-${randomUUID()}@example.com`;
    await addPendingInvite(owner.tenantId, inviteEmail);
    await setSeatLimit(owner.tenantId, 0);
    const newUserId = `test_new_${randomUUID()}`;
    try {
      actAs(newUserId, inviteEmail);

      const res = await request(app).get("/api/me");
      expect(res.status).toBe(200);
      expect(res.body.team.role).toBe("owner");
      expect(res.body.tenant.id).not.toBe(owner.tenantId);
    } finally {
      await deleteTenantForClerkUser(newUserId);
      await deleteTenant(owner.tenantId);
    }
  });

  it("accepts the invite when seats allow; member role and invite status update", async () => {
    const owner = await createTenant({ email: "owner6@example.com" });
    await setSeatLimit(owner.tenantId, 3);
    const inviteEmail = `join-${randomUUID()}@example.com`;
    const inviteId = await addPendingInvite(owner.tenantId, inviteEmail);
    const newUserId = `test_new_${randomUUID()}`;
    try {
      actAs(newUserId, inviteEmail);

      const res = await request(app).get("/api/me");
      expect(res.status).toBe(200);
      expect(res.body.tenant.id).toBe(owner.tenantId);
      expect(res.body.team.role).toBe("member");

      const invite = (
        await db
          .select()
          .from(teamInvitesTable)
          .where(eq(teamInvitesTable.id, inviteId))
          .limit(1)
      )[0];
      expect(invite.status).toBe("accepted");
    } finally {
      await deleteTenantForClerkUser(newUserId);
      await deleteTenant(owner.tenantId);
    }
  });
});

describe("member removal cuts access immediately (DELETE /team/members/:id)", () => {
  it("removed member's next request resolves a fresh personal workspace, not the old tenant", async () => {
    const owner = await createTenant({ email: "owner-remove@example.com" });
    await setSeatLimit(owner.tenantId, 5);
    const member = await addMember(owner.tenantId, "member");
    const contentId = await insertContentItem(owner.tenantId, {
      caption: "owner workspace secret",
    });
    try {
      // Sanity: while a member, requests resolve to the shared workspace and
      // tenant-scoped reads return the workspace's data.
      actAs(member.clerkUserId, member.email);
      const meBefore = await request(app).get("/api/me");
      expect(meBefore.status).toBe(200);
      expect(meBefore.body.tenant.id).toBe(owner.tenantId);
      expect(meBefore.body.team.role).toBe("member");
      const contentBefore = await request(app).get("/api/content");
      expect(contentBefore.status).toBe(200);
      expect(
        contentBefore.body.map((c: { id: number }) => c.id),
      ).toContain(contentId);

      // Owner removes the member.
      actAs(owner.clerkUserId, owner.email);
      const remove = await request(app).delete(
        `/api/team/members/${member.memberId}`,
      );
      expect(remove.status).toBe(200);
      const rows = await db
        .select()
        .from(tenantMembersTable)
        .where(eq(tenantMembersTable.tenantId, owner.tenantId));
      expect(rows).toHaveLength(0);

      // The ex-member's VERY NEXT request must no longer resolve the shared
      // workspace: requireTenant provisions a fresh personal one instead.
      actAs(member.clerkUserId, member.email);
      const meAfter = await request(app).get("/api/me");
      expect(meAfter.status).toBe(200);
      expect(meAfter.body.team.role).toBe("owner");
      expect(meAfter.body.tenant.id).not.toBe(owner.tenantId);

      // Tenant-scoped reads no longer return the old workspace's data.
      const contentAfter = await request(app).get("/api/content");
      expect(contentAfter.status).toBe(200);
      expect(
        contentAfter.body.map((c: { id: number }) => c.id),
      ).not.toContain(contentId);
      const byId = await request(app).get(`/api/content/${contentId}`);
      expect(byId.status).toBe(404);

      // /team now describes the fresh personal workspace, not the old team.
      const teamAfter = await request(app).get("/api/team");
      expect(teamAfter.status).toBe(200);
      expect(teamAfter.body.role).toBe("owner");
      expect(teamAfter.body.members ?? []).toHaveLength(0);
    } finally {
      await deleteTenantForClerkUser(member.clerkUserId);
      await deleteTenant(owner.tenantId);
    }
  });
});

describe("superadmin never inherited by members", () => {
  it("a joined member's /me shows isSuperadmin=false even when the owner is a superadmin", async () => {
    const owner = await createTenant({
      email: "super-owner@example.com",
      isSuperadmin: true,
    });
    await setSeatLimit(owner.tenantId, 5);
    const member = await addMember(owner.tenantId, "member");
    try {
      // Sanity: the owner themselves sees isSuperadmin=true.
      actAs(owner.clerkUserId, owner.email);
      const ownerMe = await request(app).get("/api/me");
      expect(ownerMe.status).toBe(200);
      expect(ownerMe.body.isSuperadmin).toBe(true);

      // The member, operating inside the same workspace, must not inherit it.
      actAs(member.clerkUserId, member.email);
      const memberMe = await request(app).get("/api/me");
      expect(memberMe.status).toBe(200);
      expect(memberMe.body.tenant.id).toBe(owner.tenantId);
      expect(memberMe.body.isSuperadmin).toBe(false);
      expect(memberMe.body.isOwner).toBe(false);
    } finally {
      await deleteTenant(owner.tenantId);
    }
  });
});
