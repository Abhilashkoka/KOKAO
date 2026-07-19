import {
  pgTable,
  text,
  serial,
  bigserial,
  integer,
  boolean,
  timestamp,
  doublePrecision,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Append-only analytics event stream (web + mobile + server-emitted).
 * Global context lives in dedicated columns; event-specific parameters go
 * into the jsonb `params` column. snake_case event names, GA4-compatible.
 *
 * Consent enforcement happens at INGESTION (server-side): columns that fall
 * under a consent category are nulled for users who have not opted in,
 * regardless of what the client sent.
 */
export const analyticsEventsTable = pgTable(
  "analytics_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    // Identity: pre-login events carry only anonymousId; post-login events
    // carry clerkUserId/tenantId. The merge links anonymousId -> user.
    tenantId: integer("tenant_id"),
    clerkUserId: text("clerk_user_id"),
    anonymousId: text("anonymous_id"),
    sessionId: text("session_id"),
    userRole: text("user_role"),
    eventName: text("event_name").notNull(),
    params: jsonb("params").$type<Record<string, unknown>>(),
    // Platform / device (device details are consent-gated for clients)
    platform: text("platform"), // web | ios | android | server
    appVersion: text("app_version"),
    osVersion: text("os_version"),
    browser: text("browser"),
    deviceModel: text("device_model"),
    networkType: text("network_type"),
    carrier: text("carrier"), // consent-gated (mobile)
    // Locale & geo
    language: text("language"),
    country: text("country"), // ISO code, geo-IP derived (coarse consent)
    region: text("region"),
    city: text("city"),
    latitude: doublePrecision("latitude"), // precise consent only
    longitude: doublePrecision("longitude"), // precise consent only
    // Acquisition
    source: text("source"),
    medium: text("medium"),
    campaign: text("campaign"),
    // Timing: client-reported occurrence time vs server receipt time.
    clientTimestamp: timestamp("client_timestamp", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("analytics_events_tenant_created_idx").on(t.tenantId, t.createdAt),
    index("analytics_events_name_created_idx").on(t.eventName, t.createdAt),
    index("analytics_events_user_idx").on(t.clerkUserId),
    index("analytics_events_anon_idx").on(t.anonymousId),
    index("analytics_events_session_idx").on(t.sessionId),
  ],
);

export type AnalyticsEvent = typeof analyticsEventsTable.$inferSelect;
export type InsertAnalyticsEvent = typeof analyticsEventsTable.$inferInsert;

/**
 * Per-USER consent state (keyed by Clerk user id, not tenant — a team member
 * carries their own consent into whichever workspace they work in).
 * All categories default OFF; respondedAt records that the user has seen and
 * answered the disclosure (used to gate the onboarding consent step).
 */
export const userConsentsTable = pgTable(
  "user_consents",
  {
    id: serial("id").primaryKey(),
    clerkUserId: text("clerk_user_id").notNull(),
    analytics: boolean("analytics").notNull().default(false),
    deviceDetails: boolean("device_details").notNull().default(false),
    locationCoarse: boolean("location_coarse").notNull().default(false),
    locationPrecise: boolean("location_precise").notNull().default(false),
    carrier: boolean("carrier").notNull().default(false),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
    promptDismissedAt: timestamp("prompt_dismissed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("user_consents_user_idx").on(t.clerkUserId)],
);

export type UserConsent = typeof userConsentsTable.$inferSelect;
