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

const emailState = vi.hoisted(() => ({
  sent: [] as { to: string; subject: string }[],
  forceEmailOn: false,
  verifiedEmails: {} as Record<string, string | null>,
}));

vi.mock("../lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/email")>();
  return {
    ...actual,
    sendEmail: vi.fn(async (msg: { to: string; subject: string }) => {
      emailState.sent.push({ to: msg.to, subject: msg.subject });
      return true;
    }),
  };
});

vi.mock("../lib/clerkUser", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/clerkUser")>();
  return {
    ...actual,
    fetchVerifiedEmail: vi.fn(
      async (clerkUserId: string) =>
        emailState.verifiedEmails[clerkUserId] ?? null,
    ),
  };
});

vi.mock("../lib/notificationSettings", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../lib/notificationSettings")>();
  return {
    ...actual,
    getEffectiveSetting: vi.fn(async (tenantId: number, type: string) => {
      if (emailState.forceEmailOn) {
        return { enabled: true, inApp: true, email: true };
      }
      return actual.getEffectiveSetting(tenantId, type);
    }),
  };
});

import {
  db,
  pool,
  tenantsTable,
  tenantMembersTable,
  teamInvitesTable,
  notificationsTable,
  memberNotificationPreferencesTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTestApp } from "../test/testApp";
import { resetAuthState, actAs } from "../test/authState";
import { createTenant, deleteTenant } from "../test/dbHelpers";
import { notifySeatRequestDecided } from "../lib/notifications";
import { randomUUID } from "crypto";

const app = createTestApp();

afterAll(async () => {
  await pool.end();
});

beforeEach(() => {
  resetAuthState();
  emailState.sent = [];
  emailState.forceEmailOn = false;
  emailState.verifiedEmails = {};
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

  it("emails the owner and admin members (not the leaver) when the email channel is on", async () => {
    const { owner, memberClerkUserId } = await seedMembership();
    const adminClerkUserId = `test_${randomUUID()}`;
    try {
      await db.insert(tenantMembersTable).values({
        tenantId: owner.tenantId,
        clerkUserId: adminClerkUserId,
        email: "admin@example.com",
        role: "admin",
      });
      emailState.forceEmailOn = true;
      emailState.verifiedEmails = {
        [owner.clerkUserId]: "owner@example.com",
        [adminClerkUserId]: "admin-verified@example.com",
        [memberClerkUserId]: "leaver@example.com",
      };

      actAs(memberClerkUserId, "member@example.com");
      const res = await request(app).post("/api/team/leave");
      expect(res.status).toBe(200);

      const recipients = emailState.sent.map((m) => m.to).sort();
      expect(recipients).toEqual([
        "admin-verified@example.com",
        "owner@example.com",
      ]);
      expect(recipients).not.toContain("leaver@example.com");
    } finally {
      await cleanup(owner.tenantId);
    }
  });

  it("deletes the leaver's saved notification preferences for the workspace only", async () => {
    const { owner, memberClerkUserId } = await seedMembership();
    const otherWorkspace = await createTenant({ email: "other@example.com" });
    try {
      await db.insert(memberNotificationPreferencesTable).values([
        {
          tenantId: owner.tenantId,
          clerkUserId: memberClerkUserId,
          type: "team_member_left",
          inApp: true,
          email: false,
        },
        {
          // Same person's preference in a DIFFERENT workspace must survive.
          tenantId: otherWorkspace.tenantId,
          clerkUserId: memberClerkUserId,
          type: "team_member_left",
          inApp: true,
          email: false,
        },
      ]);

      actAs(memberClerkUserId, "member@example.com");
      const res = await request(app).post("/api/team/leave");
      expect(res.status).toBe(200);

      const rows = await db
        .select()
        .from(memberNotificationPreferencesTable)
        .where(
          eq(
            memberNotificationPreferencesTable.clerkUserId,
            memberClerkUserId,
          ),
        );
      expect(rows).toHaveLength(1);
      expect(rows[0].tenantId).toBe(otherWorkspace.tenantId);
    } finally {
      await db
        .delete(memberNotificationPreferencesTable)
        .where(
          eq(
            memberNotificationPreferencesTable.clerkUserId,
            memberClerkUserId,
          ),
        );
      await deleteTenant(otherWorkspace.tenantId);
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

  it("emails the owner and other admins but not the acting admin when the email channel is on", async () => {
    const { owner, membership } = await seedMembership();
    const actingAdminId = `test_${randomUUID()}`;
    const otherAdminId = `test_${randomUUID()}`;
    await db.insert(tenantMembersTable).values([
      {
        tenantId: owner.tenantId,
        clerkUserId: actingAdminId,
        email: "acting-admin@example.com",
        role: "admin",
      },
      {
        tenantId: owner.tenantId,
        clerkUserId: otherAdminId,
        email: "other-admin@example.com",
        role: "admin",
      },
    ]);
    try {
      emailState.forceEmailOn = true;
      emailState.verifiedEmails = {
        [owner.clerkUserId]: "owner@example.com",
        [actingAdminId]: "acting-admin@example.com",
        [otherAdminId]: "other-admin@example.com",
      };

      actAs(actingAdminId, "acting-admin@example.com");
      const res = await request(app).delete(
        `/api/team/members/${membership.id}`,
      );
      expect(res.status).toBe(200);

      const recipients = emailState.sent.map((m) => m.to).sort();
      expect(recipients).toEqual([
        "other-admin@example.com",
        "owner@example.com",
      ]);
      expect(recipients).not.toContain("acting-admin@example.com");
    } finally {
      await cleanup(owner.tenantId);
    }
  });

  it("notifies the removed member on their own personal tenant and emails them", async () => {
    const { owner, membership, memberClerkUserId } = await seedMembership();
    // The removed person already has their own personal workspace.
    const personal = await createTenant({ email: null });
    await db
      .update(tenantsTable)
      .set({ clerkUserId: memberClerkUserId })
      .where(eq(tenantsTable.id, personal.tenantId));
    try {
      emailState.forceEmailOn = true;
      emailState.verifiedEmails = {
        [memberClerkUserId]: "removed-verified@example.com",
      };
      actAs(owner.clerkUserId, "owner@example.com");
      const res = await request(app).delete(
        `/api/team/members/${membership.id}`,
      );
      expect(res.status).toBe(200);

      const notifications = await db
        .select()
        .from(notificationsTable)
        .where(eq(notificationsTable.tenantId, personal.tenantId));
      const removed = notifications.filter(
        (n) => n.type === "removed_from_workspace",
      );
      expect(removed).toHaveLength(1);
      expect(removed[0].title).toContain("Acme Workspace");
      expect(removed[0].message).toContain("no longer have access");

      expect(emailState.sent.map((m) => m.to)).toContain(
        "removed-verified@example.com",
      );
    } finally {
      await deleteTenant(personal.tenantId);
      await cleanup(owner.tenantId);
    }
  });

  it("still succeeds and emails the removed member when they have no personal tenant yet", async () => {
    const { owner, membership, memberClerkUserId } = await seedMembership();
    try {
      emailState.verifiedEmails = {
        [memberClerkUserId]: "no-tenant-yet@example.com",
      };
      actAs(owner.clerkUserId, "owner@example.com");
      const res = await request(app).delete(
        `/api/team/members/${membership.id}`,
      );
      expect(res.status).toBe(200);

      // No personal tenant exists, so no in-app row anywhere — but the email
      // heads-up still goes out (default policy leaves email optional=on).
      expect(emailState.sent.map((m) => m.to)).toContain(
        "no-tenant-yet@example.com",
      );
    } finally {
      await cleanup(owner.tenantId);
    }
  });

  it("deletes the removed member's saved notification preferences for the workspace only", async () => {
    const { owner, membership, memberClerkUserId } = await seedMembership();
    const otherWorkspace = await createTenant({ email: "other2@example.com" });
    try {
      await db.insert(memberNotificationPreferencesTable).values([
        {
          tenantId: owner.tenantId,
          clerkUserId: memberClerkUserId,
          type: "team_member_left",
          inApp: true,
          email: false,
        },
        {
          // Same person's preference in a DIFFERENT workspace must survive.
          tenantId: otherWorkspace.tenantId,
          clerkUserId: memberClerkUserId,
          type: "team_member_left",
          inApp: true,
          email: false,
        },
      ]);

      actAs(owner.clerkUserId, "owner@example.com");
      const res = await request(app).delete(
        `/api/team/members/${membership.id}`,
      );
      expect(res.status).toBe(200);

      const rows = await db
        .select()
        .from(memberNotificationPreferencesTable)
        .where(
          eq(
            memberNotificationPreferencesTable.clerkUserId,
            memberClerkUserId,
          ),
        );
      expect(rows).toHaveLength(1);
      expect(rows[0].tenantId).toBe(otherWorkspace.tenantId);
    } finally {
      await db
        .delete(memberNotificationPreferencesTable)
        .where(
          eq(
            memberNotificationPreferencesTable.clerkUserId,
            memberClerkUserId,
          ),
        );
      await deleteTenant(otherWorkspace.tenantId);
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

describe("invite auto-accept join notification", () => {
  async function seedPendingInvite(role: "member" | "admin" = "member") {
    const owner = await createTenant({ email: "owner@example.com" });
    await db
      .update(tenantsTable)
      .set({ seatLimit: 5, name: "Acme Workspace" })
      .where(eq(tenantsTable.id, owner.tenantId));
    const inviteeClerkUserId = `test_${randomUUID()}`;
    const inviteeEmail = `invitee-${randomUUID()}@example.com`;
    await db.insert(teamInvitesTable).values({
      tenantId: owner.tenantId,
      email: inviteeEmail,
      role,
      status: "pending",
      invitedByClerkUserId: owner.clerkUserId,
    });
    return { owner, inviteeClerkUserId, inviteeEmail };
  }

  it("records a team_member_joined notification when an invited user first signs in", async () => {
    const { owner, inviteeClerkUserId, inviteeEmail } =
      await seedPendingInvite();
    try {
      emailState.verifiedEmails = { [inviteeClerkUserId]: inviteeEmail };
      actAs(inviteeClerkUserId, inviteeEmail);
      const res = await request(app).get("/api/me");
      expect(res.status).toBe(200);
      expect(res.body.team.role).toBe("member");

      const notifications = await db
        .select()
        .from(notificationsTable)
        .where(eq(notificationsTable.tenantId, owner.tenantId));
      const joined = notifications.filter(
        (n) => n.type === "team_member_joined",
      );
      expect(joined).toHaveLength(1);
      expect(joined[0].message).toContain(inviteeEmail);
      expect(joined[0].message).toContain("as a member");
    } finally {
      await cleanup(owner.tenantId);
    }
  });

  it("emails the owner and admin members but never the joiner when email is on", async () => {
    const { owner, inviteeClerkUserId, inviteeEmail } =
      await seedPendingInvite("admin");
    const adminClerkUserId = `test_${randomUUID()}`;
    try {
      await db.insert(tenantMembersTable).values({
        tenantId: owner.tenantId,
        clerkUserId: adminClerkUserId,
        email: "existing-admin@example.com",
        role: "admin",
      });
      emailState.forceEmailOn = true;
      emailState.verifiedEmails = {
        [owner.clerkUserId]: "owner@example.com",
        [adminClerkUserId]: "existing-admin-verified@example.com",
        [inviteeClerkUserId]: inviteeEmail,
      };

      actAs(inviteeClerkUserId, inviteeEmail);
      const res = await request(app).get("/api/me");
      expect(res.status).toBe(200);
      expect(res.body.team.role).toBe("admin");

      const recipients = emailState.sent.map((m) => m.to).sort();
      expect(recipients).toEqual([
        "existing-admin-verified@example.com",
        "owner@example.com",
      ]);
      expect(recipients).not.toContain(inviteeEmail);
    } finally {
      await cleanup(owner.tenantId);
    }
  });

  it("does not notify when the notification type is disabled", async () => {
    const { owner, inviteeClerkUserId, inviteeEmail } =
      await seedPendingInvite();
    try {
      const { getEffectiveSetting } = await import(
        "../lib/notificationSettings"
      );
      vi.mocked(getEffectiveSetting).mockResolvedValueOnce({
        enabled: false,
        inApp: false,
        email: false,
      });
      emailState.verifiedEmails = { [inviteeClerkUserId]: inviteeEmail };
      actAs(inviteeClerkUserId, inviteeEmail);
      const res = await request(app).get("/api/me");
      expect(res.status).toBe(200);

      const notifications = await db
        .select()
        .from(notificationsTable)
        .where(eq(notificationsTable.tenantId, owner.tenantId));
      expect(
        notifications.filter((n) => n.type === "team_member_joined"),
      ).toHaveLength(0);
      expect(emailState.sent).toHaveLength(0);
    } finally {
      await cleanup(owner.tenantId);
    }
  });

  it("notifies exactly once when several first requests race the invite accept", async () => {
    const { owner, inviteeClerkUserId, inviteeEmail } =
      await seedPendingInvite();
    try {
      emailState.forceEmailOn = true;
      emailState.verifiedEmails = {
        [owner.clerkUserId]: "owner@example.com",
        [inviteeClerkUserId]: inviteeEmail,
      };
      actAs(inviteeClerkUserId, inviteeEmail);

      // A brand-new user's browser fires several API requests in parallel on
      // first load; all of them can pass the membership check before any
      // finishes the invite flip.
      const responses = await Promise.all([
        request(app).get("/api/me"),
        request(app).get("/api/me"),
        request(app).get("/api/me"),
        request(app).get("/api/me"),
      ]);
      for (const res of responses) {
        expect(res.status).toBe(200);
        expect(res.body.team.role).toBe("member");
      }

      const notifications = await db
        .select()
        .from(notificationsTable)
        .where(eq(notificationsTable.tenantId, owner.tenantId));
      expect(
        notifications.filter((n) => n.type === "team_member_joined"),
      ).toHaveLength(1);
      expect(
        emailState.sent.filter((m) => m.to === "owner@example.com"),
      ).toHaveLength(1);

      // The member row itself is still a single one.
      const members = await db
        .select()
        .from(tenantMembersTable)
        .where(eq(tenantMembersTable.clerkUserId, inviteeClerkUserId));
      expect(members).toHaveLength(1);
    } finally {
      await cleanup(owner.tenantId);
    }
  });
});

describe("notifySeatRequestDecided recipient fan-out", () => {
  it("emails the owner and admin members when the email channel is on", async () => {
    const { owner } = await seedMembership();
    const adminClerkUserId = `test_${randomUUID()}`;
    try {
      await db.insert(tenantMembersTable).values({
        tenantId: owner.tenantId,
        clerkUserId: adminClerkUserId,
        email: "admin@example.com",
        role: "admin",
      });
      emailState.forceEmailOn = true;
      emailState.verifiedEmails = {
        [owner.clerkUserId]: "owner@example.com",
        [adminClerkUserId]: "admin-verified@example.com",
      };

      await notifySeatRequestDecided(owner.tenantId, {
        approved: true,
        grantedSeats: 8,
      });

      const recipients = emailState.sent.map((m) => m.to).sort();
      expect(recipients).toEqual([
        "admin-verified@example.com",
        "owner@example.com",
      ]);
      // Plain members are never emailed (the seeded member has no verified
      // email registered, and even with one they are not in the recipient set).
    } finally {
      await cleanup(owner.tenantId);
    }
  });
});
