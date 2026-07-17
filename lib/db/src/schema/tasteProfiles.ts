import {
  pgTable,
  serial,
  integer,
  boolean,
  jsonb,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Per-tenant "taste memory": learned style preferences derived from user
 * behavior (saving, scheduling, publishing = approval; discarding = rejection).
 * The payload is a versioned JSON blob (see TasteProfilePayload in the
 * api-server tasteMemory lib). Learning is a soft signal fed into AI
 * generation prompts; the brand kit and the explicit user prompt always win.
 */
export const tasteProfilesTable = pgTable(
  "taste_profiles",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [uniqueIndex("taste_profiles_tenant_idx").on(table.tenantId)],
);

export type TasteProfileRow = typeof tasteProfilesTable.$inferSelect;
