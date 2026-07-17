import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
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

import {
  db,
  pool,
  tenantsTable,
  tenantMembersTable,
  teamInvitesTable,
  notificationsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTestApp } from "../test/testApp";
import { resetAuthState, actAs } from "../test/authState";
import { createTenant, deleteTenant } from "../test/dbHelpers";
import { randomUUID } from "crypto";

const app = createTestApp();

afterAll(async () => {
  await pool.end();
});

beforeEach(() => {
  resetAuthState();
});

async function seedMembership(opts: { withInvite?: boolean } = {}) {
  const owner = await createTenant({ email: "owner@example.com" });
  const memberClerkUserId = `test_${randomUUID()}`;
  const memberEmail = `member-${randomUUID()}@example.com`;
  // Give the workspace seats so team features are "enabled".
  await db
    .update(tenantsTable)
    .set({ seatLimit: 5, name: "Acme Workspace" })
    .where(eq(tenantsTable.id, owner.tenantId));
  if (opts.withInvite) {
    await db.insert(teamInvitesTable).values({
      tenantId: owner.tenantId,
      email: memberEmail,
      role: "member",
      status: "accepted",
      acceptedAt: new Date(),
      invitedByClerkUserId: owner.clerkUserId,
    });
  }
  const [membership] = await db
    .insert(tenantMembersTable)
    .values({
      tenantId: owner.tenantId,
      clerkUserId: memberClerkUserId,
      email: memberEmail,
      role: "member",
    })
    .returning();
  return { owner, memberClerkUserId, memberEmail, membership };
}

async function cleanup(ownerTenantId: number) {
  await db
    .delete(tenantMembersTable)
    .where(eq(tenantMembersTable.tenantId, ownerTenantId));
  await db
    .delete(teamInvitesTable)
    .where(eq(teamInvitesTable.tenantId, ownerTenantId));
  await deleteTenant(ownerTenantId);
}

describe("GET /me for invited members", () => {
  it("includes the workspace name, inviter email, and join date", async () => {
    const { owner, memberClerkUserId } = await seedMembership({
      withInvite: true,
    });
    try {
      actAs(memberClerkUserId, "member@example.com");
      const res = await request(app).get("/api/me");
      expect(res.status).toBe(200);
      expect(res.body.team.role).toBe("member");
      expect(res.body.team.workspaceName).toBe("Acme Workspace");
      expect(res.body.team.invitedByEmail).toBe("owner@example.com");
      expect(res.body.team.joinedAt).toBeTruthy();
    } finally {
      await cleanup(owner.tenantId);
    }
  });

  it("returns null inviter details for the owner", async () => {
    const owner = await createTenant({ email: "solo@example.com" });
    try {
      actAs(owner.clerkUserId, "solo@example.com");
      const res = await request(app).get("/api/me");
      expect(res.status).toBe(200);
      expect(res.body.team.role).toBe("owner");
      expect(res.body.team.workspaceName).toBe("Test Workspace");
      expect(res.body.team.invitedByEmail).toBeNull();
      expect(res.body.team.joinedAt).toBeNull();
    } finally {
      await deleteTenant(owner.tenantId);
    }
  });
});

describe("POST /team/leave", () => {
  it("lets a member leave, removes their membership row, and notifies the owner", async () => {
    const { owner, memberClerkUserId, memberEmail } = await seedMembership();
    try {
      actAs(memberClerkUserId, "member@example.com");
      const res = await request(app).post("/api/team/leave");
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);

      const rows = await db
        .select()
        .from(tenantMembersTable)
        .where(eq(tenantMembersTable.clerkUserId, memberClerkUserId));
      expect(rows).toHaveLength(0);

      // The owner gets an in-app notification naming who left.
      const notifications = await db
        .select()
        .from(notificationsTable)
        .where(eq(notificationsTable.tenantId, owner.tenantId));
      const left = notifications.filter((n) => n.type === "team_member_left");
      expect(left).toHaveLength(1);
      expect(left[0].message).toContain(memberEmail);

      // The next request auto-provisions a personal workspace for them.
      const me = await request(app).get("/api/me");
      expect(me.status).toBe(200);
      expect(me.body.team.role).toBe("owner");
      // Clean up the freshly provisioned personal tenant.
      const [personal] = await db
        .select()
        .from(tenantsTable)
        .where(eq(tenantsTable.clerkUserId, memberClerkUserId));
      if (personal) await deleteTenant(personal.id);
    } finally {
      await cleanup(owner.tenantId);
    }
  });

  it("rejects the workspace owner with 403", async () => {
    const owner = await createTenant({ email: "boss@example.com" });
    try {
      actAs(owner.clerkUserId, "boss@example.com");
      const res = await request(app).post("/api/team/leave");
      expect(res.status).toBe(403);
    } finally {
      await deleteTenant(owner.tenantId);
    }
  });
});

describe("DELETE /team/members/:id", () => {
  it("notifies the owner when an admin (not the owner) removes a member", async () => {
    const { owner, membership, memberEmail } = await seedMembership();
    const adminClerkUserId = `test_${randomUUID()}`;
    const adminEmail = `admin-${randomUUID()}@example.com`;
    await db.insert(tenantMembersTable).values({
      tenantId: owner.tenantId,
      clerkUserId: adminClerkUserId,
      email: adminEmail,
      role: "admin",
    });
    try {
      actAs(adminClerkUserId, adminEmail);
      const res = await request(app).delete(
        `/api/team/members/${membership.id}`,
      );
      expect(res.status).toBe(200);

      const notifications = await db
        .select()
        .from(notificationsTable)
        .where(eq(notificationsTable.tenantId, owner.tenantId));
      const removed = notifications.filter(
        (n) => n.type === "team_member_removed",
      );
      expect(removed).toHaveLength(1);
      expect(removed[0].message).toContain(memberEmail);
      expect(removed[0].message).toContain(adminEmail);
    } finally {
      await cleanup(owner.tenantId);
    }
  });

  it("does not self-notify when the owner removes a member", async () => {
    const { owner, membership } = await seedMembership();
    try {
      actAs(owner.clerkUserId, "owner@example.com");
      const res = await request(app).delete(
        `/api/team/members/${membership.id}`,
      );
      expect(res.status).toBe(200);

      const notifications = await db
        .select()
        .from(notificationsTable)
        .where(eq(notificationsTable.tenantId, owner.tenantId));
      const removed = notifications.filter(
        (n) => n.type === "team_member_removed",
      );
      expect(removed).toHaveLength(0);
    } finally {
      await cleanup(owner.tenantId);
    }
  });
});
