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
  },
  (t) => ({
    tokenUnique: uniqueIndex("push_tokens_token_uq").on(t.token),
  }),
);

export type PushToken = typeof pushTokensTable.$inferSelect;
