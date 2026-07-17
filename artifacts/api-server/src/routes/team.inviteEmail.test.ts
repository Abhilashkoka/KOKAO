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

const sendEmailMock = vi.fn(
  async (_msg: { to: string; subject: string; text: string }) => true,
);
vi.mock("../lib/email", () => ({
  sendEmail: (msg: { to: string; subject: string; text: string }) =>
    sendEmailMock(msg),
  sendTestEmail: vi.fn(async () => ({ ok: true })),
  isEmailConfigured: vi.fn(async () => false),
  isConnectorEmailAvailable: vi.fn(async () => false),
}));

import {
  db,
  pool,
  tenantsTable,
  tenantMembersTable,
  teamInvitesTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { createTestApp } from "../test/testApp";
import { resetAuthState, actAs, authState } from "../test/authState";
import { createTenant, deleteTenant } from "../test/dbHelpers";
import { clearPendingInviteHintCache } from "../lib/teamInviteEmail";
import { randomUUID } from "crypto";

const app = createTestApp();

afterAll(async () => {
  await pool.end();
});

beforeEach(() => {
  resetAuthState();
  sendEmailMock.mockClear();
  clearPendingInviteHintCache();
});

async function cleanup(tenantId: number) {
  await db
    .delete(tenantMembersTable)
    .where(eq(tenantMembersTable.tenantId, tenantId));
  await db
    .delete(teamInvitesTable)
    .where(eq(teamInvitesTable.tenantId, tenantId));
  await deleteTenant(tenantId);
}

/** Wait for the detached (void) email send to settle. */
async function flush() {
  await new Promise((r) => setTimeout(r, 50));
}

describe("POST /team/invites — invite email", () => {
  it("emails the invitee the exact sign-in address and a link (best-effort)", async () => {
    const owner = await createTenant({ email: "owner@example.com" });
    await db
      .update(tenantsTable)
      .set({ seatLimit: 5, name: "Acme Workspace" })
      .where(eq(tenantsTable.id, owner.tenantId));
    try {
      actAs(owner.clerkUserId, "owner@example.com");
      const res = await request(app)
        .post("/api/team/invites")
        .send({ email: "Invitee@Example.com", role: "member" });
      expect(res.status).toBe(200);
      await flush();
      expect(sendEmailMock).toHaveBeenCalledTimes(1);
      const msg = sendEmailMock.mock.calls[0]![0];
      expect(msg.to).toBe("invitee@example.com");
      expect(msg.subject).toContain("Acme Workspace");
      expect(msg.text).toContain("invitee@example.com");
      expect(msg.text.toLowerCase()).toContain("sign in");
    } finally {
      await cleanup(owner.tenantId);
    }
  });

  it("still creates the invite when the email send fails", async () => {
    sendEmailMock.mockRejectedValueOnce(new Error("boom"));
    const owner = await createTenant({ email: "owner2@example.com" });
    await db
      .update(tenantsTable)
      .set({ seatLimit: 5 })
      .where(eq(tenantsTable.id, owner.tenantId));
    try {
      actAs(owner.clerkUserId, "owner2@example.com");
      const res = await request(app)
        .post("/api/team/invites")
        .send({ email: "someone@example.com", role: "member" });
      expect(res.status).toBe(200);
      const invites = await db
        .select()
        .from(teamInvitesTable)
        .where(eq(teamInvitesTable.tenantId, owner.tenantId));
      expect(invites).toHaveLength(1);
      await flush();
    } finally {
      await cleanup(owner.tenantId);
    }
  });
});

describe("GET /me — pending invite hint", () => {
  it("surfaces a pending invite sitting on a secondary verified email", async () => {
    const inviter = await createTenant({ email: "boss@example.com" });
    await db
      .update(tenantsTable)
      .set({ seatLimit: 5, name: "Boss Workspace" })
      .where(eq(tenantsTable.id, inviter.tenantId));
    // Invite sent to work@example.com.
    await db.insert(teamInvitesTable).values({
      tenantId: inviter.tenantId,
      email: "work@example.com",
      role: "member",
      invitedByClerkUserId: inviter.clerkUserId,
    });
    // The invitee signed in with a DIFFERENT primary email and got their own
    // workspace, but work@example.com is a secondary verified email.
    const invitee = await createTenant({ email: "personal@example.com" });
    try {
      actAs(invitee.clerkUserId, "personal@example.com");
      authState.users[invitee.clerkUserId]!.emailAddresses.push({
        id: "email_secondary",
        emailAddress: "work@example.com",
        verification: { status: "verified" },
      });
      const res = await request(app).get("/api/me");
      expect(res.status).toBe(200);
      expect(res.body.pendingInvite).toEqual({
        email: "work@example.com",
        workspaceName: "Boss Workspace",
      });
    } finally {
      await cleanup(inviter.tenantId);
      await deleteTenant(invitee.tenantId);
    }
  });

  it("returns null when there is no pending invite for any verified email", async () => {
    const solo = await createTenant({ email: `solo-${randomUUID()}@example.com` });
    try {
      actAs(solo.clerkUserId, solo.email);
      const res = await request(app).get("/api/me");
      expect(res.status).toBe(200);
      expect(res.body.pendingInvite).toBeNull();
    } finally {
      await deleteTenant(solo.tenantId);
    }
  });

  it("ignores unverified emails", async () => {
    const inviter = await createTenant({ email: "boss2@example.com" });
    await db
      .update(tenantsTable)
      .set({ seatLimit: 5 })
      .where(eq(tenantsTable.id, inviter.tenantId));
    await db.insert(teamInvitesTable).values({
      tenantId: inviter.tenantId,
      email: "unverified@example.com",
      role: "member",
      invitedByClerkUserId: inviter.clerkUserId,
    });
    const invitee = await createTenant({ email: "primary2@example.com" });
    try {
      actAs(invitee.clerkUserId, "primary2@example.com");
      authState.users[invitee.clerkUserId]!.emailAddresses.push({
        id: "email_unverified",
        emailAddress: "unverified@example.com",
        verification: { status: "unverified" },
      });
      const res = await request(app).get("/api/me");
      expect(res.status).toBe(200);
      expect(res.body.pendingInvite).toBeNull();
    } finally {
      await cleanup(inviter.tenantId);
      await deleteTenant(invitee.tenantId);
    }
  });
});
