import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";

/**
 * Additional users who belong to a tenant's workspace (the owner is the
 * tenant row itself via tenants.clerkUserId and is NOT duplicated here).
 * A Clerk user can be a member of at most one workspace (unique), mirroring
 * the one-tenant-per-user model.
 */
export const tenantMembersTable = pgTable("tenant_members", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  clerkUserId: text("clerk_user_id").notNull().unique(),
  email: text("email"),
  role: text("role").notNull().default("member"), // "admin" | "member"
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type TenantMember = typeof tenantMembersTable.$inferSelect;

/**
 * Pending email invitations to join a workspace. Accepted automatically when
 * a user whose VERIFIED Clerk email matches signs in (and has no workspace of
 * their own yet). Pending invites count against the seat limit.
 */
export const teamInvitesTable = pgTable("team_invites", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  role: text("role").notNull().default("member"),
  status: text("status").notNull().default("pending"), // pending | accepted | revoked
  invitedByClerkUserId: text("invited_by_clerk_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
});

export type TeamInvite = typeof teamInvitesTable.$inferSelect;

/**
 * Requests from a workspace for more team seats, decided by a superadmin.
 * Approval writes the granted seat count to tenants.seat_limit (an override
 * of the plan's default team seat allotment).
 */
export const seatRequestsTable = pgTable("seat_requests", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  requestedSeats: integer("requested_seats").notNull(),
  note: text("note"),
  status: text("status").notNull().default("pending"), // pending | approved | denied
  grantedSeats: integer("granted_seats"),
  decidedByEmail: text("decided_by_email"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type SeatRequest = typeof seatRequestsTable.$inferSelect;
