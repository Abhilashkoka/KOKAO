import {
  db,
  analyticsEventsTable,
  userConsentsTable,
  tenantsTable,
  tenantMembersTable,
  type UserConsent,
  type InsertAnalyticsEvent,
} from "@workspace/db";
import { eq, and, isNull } from "drizzle-orm";
import type { Request } from "express";
import { logger } from "./logger";

/** Consent categories. Everything defaults to OFF until the user opts in. */
export interface ConsentFlags {
  analytics: boolean;
  deviceDetails: boolean;
  locationCoarse: boolean;
  locationPrecise: boolean;
  carrier: boolean;
}

export const NO_CONSENT: ConsentFlags = {
  analytics: false,
  deviceDetails: false,
  locationCoarse: false,
  locationPrecise: false,
  carrier: false,
};

export function toConsentFlags(row: UserConsent | undefined): ConsentFlags {
  if (!row) return NO_CONSENT;
  return {
    analytics: row.analytics,
    deviceDetails: row.deviceDetails,
    locationCoarse: row.locationCoarse,
    locationPrecise: row.locationPrecise,
    carrier: row.carrier,
  };
}

export async function loadConsent(
  clerkUserId: string,
): Promise<UserConsent | undefined> {
  return (
    await db
      .select()
      .from(userConsentsTable)
      .where(eq(userConsentsTable.clerkUserId, clerkUserId))
      .limit(1)
  )[0];
}

/**
 * Events an ANONYMOUS (pre-login) client may record. There is no stored
 * consent for anonymous visitors, so only core lifecycle/acquisition events
 * are accepted and every consent-gated field is stripped server-side.
 */
export const ANONYMOUS_ALLOWED_EVENTS = new Set([
  "first_open",
  "session_start",
  "page_view",
  "screen_view",
  "sign_up",
  "login",
]);

export const EVENT_NAME_RE = /^[a-z0-9_]{1,80}$/;

/** Cap for the serialized params payload of a single event. */
export const MAX_PARAMS_BYTES = 4096;

/**
 * Coarse geo from trusted edge headers when present (Cloudflare / GCP /
 * Vercel style). We deliberately avoid bundling an IP database; when no edge
 * header exists the country stays null.
 */
export function geoFromRequest(req: Request): {
  country: string | null;
  region: string | null;
  city: string | null;
} {
  const h = (name: string): string | null => {
    const v = req.headers[name];
    const s = Array.isArray(v) ? v[0] : v;
    return s && s !== "ZZ" && s !== "XX" ? s : null;
  };
  return {
    country:
      h("cf-ipcountry") ?? h("x-appengine-country") ?? h("x-vercel-ip-country"),
    region: h("x-appengine-region") ?? h("x-vercel-ip-country-region"),
    city: h("x-appengine-city") ?? h("x-vercel-ip-city"),
  };
}

/**
 * Server-emitted telemetry (billing events, sampled API latency). This is
 * own-infrastructure metering — disclosed in the privacy settings but not
 * consent-gated, and it never contains PII. Best-effort: failures are logged
 * and never break the calling flow.
 */
export async function recordServerEvent(event: {
  name: string;
  tenantId?: number | null;
  clerkUserId?: string | null;
  sessionId?: string | null;
  params?: Record<string, unknown>;
}): Promise<void> {
  try {
    await db.insert(analyticsEventsTable).values({
      eventName: event.name,
      tenantId: event.tenantId ?? null,
      clerkUserId: event.clerkUserId ?? null,
      sessionId: event.sessionId ?? null,
      params: event.params ?? null,
      platform: "server",
    });
  } catch (error) {
    logger.error({ err: error, event: event.name }, "Failed to record server event");
  }
}

/**
 * Resolve an authenticated Clerk user to a tenant WITHOUT provisioning one
 * (ingestion must never create workspaces as a side effect).
 */
export async function resolveTenantLight(
  clerkUserId: string,
): Promise<{ tenantId: number; role: "owner" | "admin" | "member" } | null> {
  const owned = (
    await db
      .select({ id: tenantsTable.id })
      .from(tenantsTable)
      .where(eq(tenantsTable.clerkUserId, clerkUserId))
      .limit(1)
  )[0];
  if (owned) return { tenantId: owned.id, role: "owner" };
  const membership = (
    await db
      .select()
      .from(tenantMembersTable)
      .where(eq(tenantMembersTable.clerkUserId, clerkUserId))
      .limit(1)
  )[0];
  if (membership) {
    return {
      tenantId: membership.tenantId,
      role: membership.role === "admin" ? "admin" : "member",
    };
  }
  return null;
}

/**
 * Anonymous -> user identity merge: once a user signs in, earlier events
 * recorded under their anonymous id are linked to their user (and tenant).
 */
export async function mergeAnonymousEvents(
  anonymousId: string,
  clerkUserId: string,
  tenantId: number | null,
): Promise<void> {
  try {
    await db
      .update(analyticsEventsTable)
      .set({ clerkUserId, tenantId })
      .where(
        and(
          eq(analyticsEventsTable.anonymousId, anonymousId),
          isNull(analyticsEventsTable.clerkUserId),
        ),
      );
  } catch (error) {
    logger.error({ err: error }, "Failed to merge anonymous analytics events");
  }
}

export type { InsertAnalyticsEvent };
