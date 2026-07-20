import {
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Expo push notification device tokens, one row per registered device token.
 * Tokens belong to a PERSON (clerkUserId), not a workspace: a phone follows
 * its signed-in user across whichever workspaces they work in, and dispatch
 * decides per-notification which users' devices to reach. Re-registering an
 * existing token re-binds it to the CURRENT signer (a shared/handed-over
 * device must never keep pushing to the previous user). Dead tokens
 * (Expo "DeviceNotRegistered" receipts) are deleted by the push sender.
 */
export const pushTokensTable = pgTable(
  "push_tokens",
  {
    id: serial("id").primaryKey(),
    // The device owner's Clerk user id.
    clerkUserId: text("clerk_user_id").notNull(),
    // The Expo push token, e.g. "ExponentPushToken[xxxx]". Globally unique.
    token: text("token").notNull(),
    // Device OS hint: "ios" | "android" | "unknown".
    platform: text("platform").notNull().default("unknown"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Refreshed on every (re-)registration — the mobile app re-registers on
    // each launch, so a token whose lastSeenAt is months old belongs to a
    // device that stopped opening the app (likely uninstalled). The push
    // maintenance loop prunes tokens unseen for PUSH_TOKEN_MAX_UNSEEN_MS.
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    tokenUnique: uniqueIndex("push_tokens_token_uq").on(t.token),
  }),
);

export type PushToken = typeof pushTokensTable.$inferSelect;

/**
 * Push tickets awaiting an Expo receipt check, persisted so pending checks
 * survive a server restart. The push maintenance loop claims due rows
 * (bumping dueAt forward so a crash mid-check just retries later), deletes
 * rows once their receipt resolves, and drops entries older than the
 * receipt retention window (~24h) — an unresolved ticket is not evidence
 * of a dead device.
 */
export const pushReceiptQueueTable = pgTable("push_receipt_queue", {
  // Expo push ticket id — globally unique, natural primary key.
  ticketId: text("ticket_id").primaryKey(),
  // The device token the ticket was issued for.
  token: text("token").notNull(),
  // Earliest time this receipt should be fetched.
  dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
  // When the ticket was issued, for expiry.
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type PushReceiptQueueRow = typeof pushReceiptQueueTable.$inferSelect;
