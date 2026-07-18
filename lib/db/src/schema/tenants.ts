import {
  pgTable,
  text,
  serial,
  timestamp,
  boolean,
  integer,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const tenantsTable = pgTable("tenants", {
  id: serial("id").primaryKey(),
  clerkUserId: text("clerk_user_id").notNull().unique(),
  email: text("email"),
  name: text("name").notNull(),
  plan: text("plan").notNull().default("free"),
  aiModel: text("ai_model").notNull().default("gpt-5.4"),
  industry: text("industry"),
  brandOnboardingComplete: boolean("brand_onboarding_complete")
    .notNull()
    .default(false),
  isSuperadmin: boolean("is_superadmin").notNull().default(false),
  // Per-workspace team seat override granted by a superadmin (via an approved
  // seat request). null = use the plan's default teamSeats allotment.
  seatLimit: integer("seat_limit"),
  // Per-tenant override for the canvas-design image prompt skill.
  // null = follow the global design_skill_settings switch.
  designSkillEnabled: boolean("design_skill_enabled"),
  // Set when a superadmin manually overrides the tenant's plan. While set,
  // Razorpay subscription webhooks must NOT sync the plan (admin override
  // wins). Cleared when the tenant takes a billing action themselves
  // (subscribe verification, switch to pay-as-you-go).
  planOverriddenAt: timestamp("plan_overridden_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertTenantSchema = createInsertSchema(tenantsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertTenant = z.infer<typeof insertTenantSchema>;
export type Tenant = typeof tenantsTable.$inferSelect;
