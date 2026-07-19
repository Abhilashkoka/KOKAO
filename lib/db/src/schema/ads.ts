import {
  pgTable,
  text,
  serial,
  integer,
  boolean,
  timestamp,
  jsonb,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Paid-media (advertising) module tables.
 *
 * The module is platform-agnostic by design: Meta Ads ships first, and
 * Google/LinkedIn/TikTok Ads plug into the same connection/draft/change-log
 * shape later. Nothing in these tables is Meta-specific except the `platform`
 * discriminator values.
 */

/**
 * A tenant's connection to one ad account on one ads platform (e.g. a Meta
 * ad account). Credentials (the ads-scoped access token) are stored as an
 * AES-256-GCM encrypted JSON blob, same as organic social credentials.
 * One connection per tenant+platform.
 */
export const adAccountConnectionsTable = pgTable(
  "ad_account_connections",
  {
    id: serial("id").primaryKey(),
    tenantId: integer("tenant_id").notNull(),
    platform: text("platform").notNull(),
    /** Remote ad account id (Meta: "act_<n>"). Empty until an account is picked. */
    adAccountId: text("ad_account_id").notNull().default(""),
    adAccountName: text("ad_account_name").notNull().default(""),
    /** Account currency code reported by the platform (e.g. "USD", "INR"). */
    currency: text("currency"),
    /**
     * connected | pending_selection (token stored, ad account not chosen yet)
     */
    status: text("status").notNull().default("pending_selection"),
    /** Encrypted JSON credentials (Meta: { accessToken }). */
    encryptedCredentials: text("encrypted_credentials"),
    verifyStatus: text("verify_status"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    verifyError: text("verify_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("ad_account_connections_tenant_platform_idx").on(
      t.tenantId,
      t.platform,
    ),
  ],
);

export type AdAccountConnection = typeof adAccountConnectionsTable.$inferSelect;

/** One proposed field change inside a draft: before → after. */
export interface AdChangeField {
  field: string;
  /** Human-readable current value snapshot (null when creating). */
  before: string | null;
  /** Human-readable proposed value. */
  after: string | null;
}

/**
 * A draft change request against an ad platform: created first, reviewed as a
 * human-readable before/after diff, and only applied to the ad account after
 * the workspace OWNER explicitly approves it.
 *
 * Statuses: draft → approved (transitional, while applying) →
 * applied | failed; or rejected (never applied); or expired (the underlying
 * remote state changed since the draft was created).
 */
export const adChangeRequestsTable = pgTable(
  "ad_change_requests",
  {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  connectionId: integer("connection_id").notNull(),
  platform: text("platform").notNull(),
  /** campaign | adset | ad */
  targetType: text("target_type").notNull(),
  /** Remote object id; null for `create` drafts until applied. */
  targetId: text("target_id"),
  /** Display name of the target at draft time (or the proposed name). */
  targetName: text("target_name").notNull().default(""),
  /** create | update */
  action: text("action").notNull(),
  /** Human-readable before/after diff shown at review time. */
  changes: jsonb("changes").$type<AdChangeField[]>().notNull(),
  /**
   * Raw parameters the adapter needs to perform the write (validated,
   * platform-specific). Never contains secrets.
   */
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  /**
   * Snapshot of the remote object's relevant fields when the draft was
   * created; re-checked at apply time so drafts expire when remote state
   * drifted. Null for creates.
   */
  beforeSnapshot: jsonb("before_snapshot").$type<Record<string, unknown> | null>(),
  status: text("status").notNull().default("draft"),
  /** Guards against duplicate drafts from retries; unique PER TENANT. */
  idempotencyKey: text("idempotency_key").notNull(),
  createdByClerkUserId: text("created_by_clerk_user_id").notNull(),
  createdByEmail: text("created_by_email"),
  approvedByClerkUserId: text("approved_by_clerk_user_id"),
  approvedByEmail: text("approved_by_email"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  appliedAt: timestamp("applied_at", { withTimezone: true }),
  /** Remote id of the created object (create drafts). */
  resultTargetId: text("result_target_id"),
  /** verified | mismatch | unverified — post-apply remote verification. */
  verifyStatus: text("verify_status"),
  failureReason: text("failure_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("ad_change_requests_tenant_idempotency_idx").on(
      t.tenantId,
      t.idempotencyKey,
    ),
  ],
);

export type AdChangeRequest = typeof adChangeRequestsTable.$inferSelect;

/**
 * Append-only per-tenant log of every APPLIED ads change: who approved it and
 * exactly what changed. Rows are never updated or deleted.
 */
export const adsChangeLogsTable = pgTable("ads_change_logs", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull(),
  changeRequestId: integer("change_request_id"),
  platform: text("platform").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id"),
  targetName: text("target_name").notNull().default(""),
  action: text("action").notNull(),
  changes: jsonb("changes").$type<AdChangeField[]>().notNull(),
  /** applied | failed */
  outcome: text("outcome").notNull(),
  /** verified | mismatch | unverified */
  verifyStatus: text("verify_status"),
  failureReason: text("failure_reason"),
  approvedByClerkUserId: text("approved_by_clerk_user_id"),
  approvedByEmail: text("approved_by_email"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AdsChangeLog = typeof adsChangeLogsTable.$inferSelect;

/**
 * App-level (platform-wide) settings for the ads module. Single row, managed
 * by superadmins only. `enabled` is the global on/off switch for the whole
 * paid-media module.
 */
export const adsSettingsTable = pgTable("ads_settings", {
  id: serial("id").primaryKey(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type AdsSettings = typeof adsSettingsTable.$inferSelect;
