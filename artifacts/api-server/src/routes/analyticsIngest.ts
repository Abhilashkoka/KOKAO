import { Router, type IRouter, type Request, type Response } from "express";
import { getAuth } from "@clerk/express";
import { db, analyticsEventsTable } from "@workspace/db";
import { z } from "zod/v4";
import {
  ANONYMOUS_ALLOWED_EVENTS,
  EVENT_NAME_RE,
  MAX_PARAMS_BYTES,
  NO_CONSENT,
  geoFromRequest,
  loadConsent,
  mergeAnonymousEvents,
  resolveTenantLight,
  toConsentFlags,
  type ConsentFlags,
  type InsertAnalyticsEvent,
} from "../lib/analytics";

/**
 * Batch analytics ingestion. PUBLIC (mounted before requireTenant) so that
 * pre-login pages can record core lifecycle events under an anonymous id.
 *
 * Consent is enforced SERVER-SIDE at this choke point:
 * - Anonymous batches: only core lifecycle events are accepted, and every
 *   consent-gated field (device details, location, carrier) is stripped.
 * - Authenticated batches: the user's STORED consent decides what is kept —
 *   no `analytics` consent means the whole batch is dropped; category
 *   opt-outs null the corresponding columns regardless of what was sent.
 */
const router: IRouter = Router();

const EventInput = z.object({
  name: z.string().min(1).max(80),
  params: z.record(z.string(), z.unknown()).optional(),
  clientTimestamp: z.string().optional(),
});

const ContextInput = z.object({
  platform: z.enum(["web", "ios", "android"]).optional(),
  appVersion: z.string().max(40).optional(),
  osVersion: z.string().max(60).optional(),
  browser: z.string().max(80).optional(),
  deviceModel: z.string().max(80).optional(),
  networkType: z.string().max(30).optional(),
  carrier: z.string().max(60).optional(),
  language: z.string().max(20).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  source: z.string().max(120).optional(),
  medium: z.string().max(60).optional(),
  campaign: z.string().max(120).optional(),
});

const IngestInput = z.object({
  anonymousId: z.string().max(64).optional(),
  sessionId: z.string().max(64).optional(),
  context: ContextInput.optional(),
  events: z.array(EventInput).min(1).max(100),
});

function parseClientTimestamp(value: string | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  // Reject wildly skewed client clocks (older than 7 days or in the future).
  const now = Date.now();
  if (d.getTime() > now + 5 * 60_000 || d.getTime() < now - 7 * 86_400_000) {
    return null;
  }
  return d;
}

function sanitizeParams(
  params: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  if (!params) return null;
  try {
    const json = JSON.stringify(params);
    if (json.length > MAX_PARAMS_BYTES) return { _truncated: true };
    return params;
  } catch {
    return null;
  }
}

router.post("/analytics/events", async (req: Request, res: Response) => {
  const parsed = IngestInput.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  try {
    const auth = getAuth(req);
    const claims = auth?.sessionClaims as { userId?: string } | undefined;
    const clerkUserId = claims?.userId ?? auth?.userId ?? null;

    const { anonymousId, sessionId, context, events } = parsed.data;

    let consent: ConsentFlags = NO_CONSENT;
    let tenantId: number | null = null;
    let userRole: string | null = null;

    if (clerkUserId) {
      const [consentRow, tenant] = await Promise.all([
        loadConsent(clerkUserId),
        resolveTenantLight(clerkUserId),
      ]);
      consent = toConsentFlags(consentRow);
      tenantId = tenant?.tenantId ?? null;
      userRole = tenant?.role ?? null;

      if (!consent.analytics) {
        // Stored consent wins over whatever the client sent.
        res.json({ accepted: 0, dropped: events.length });
        return;
      }
      if (anonymousId) {
        // Link this user's earlier anonymous events to their identity.
        await mergeAnonymousEvents(anonymousId, clerkUserId, tenantId);
      }
    }

    const geo = geoFromRequest(req);
    const rows: InsertAnalyticsEvent[] = [];
    let dropped = 0;

    for (const event of events) {
      if (!EVENT_NAME_RE.test(event.name)) {
        dropped += 1;
        continue;
      }
      if (!clerkUserId && !ANONYMOUS_ALLOWED_EVENTS.has(event.name)) {
        dropped += 1;
        continue;
      }
      const allowDevice = Boolean(clerkUserId) && consent.deviceDetails;
      const allowCoarse = Boolean(clerkUserId) && consent.locationCoarse;
      const allowPrecise = Boolean(clerkUserId) && consent.locationPrecise;
      const allowCarrier = Boolean(clerkUserId) && consent.carrier;
      rows.push({
        eventName: event.name,
        params: sanitizeParams(event.params),
        clientTimestamp: parseClientTimestamp(event.clientTimestamp),
        tenantId,
        clerkUserId,
        anonymousId: anonymousId ?? null,
        sessionId: sessionId ?? null,
        userRole,
        platform: context?.platform ?? null,
        appVersion: context?.appVersion ?? null,
        language: context?.language ?? null,
        source: context?.source ?? null,
        medium: context?.medium ?? null,
        campaign: context?.campaign ?? null,
        // Consent-gated fields: nulled unless the STORED consent allows them.
        osVersion: allowDevice ? (context?.osVersion ?? null) : null,
        browser: allowDevice ? (context?.browser ?? null) : null,
        deviceModel: allowDevice ? (context?.deviceModel ?? null) : null,
        networkType: allowDevice ? (context?.networkType ?? null) : null,
        carrier: allowCarrier ? (context?.carrier ?? null) : null,
        country: allowCoarse ? geo.country : null,
        region: allowCoarse ? geo.region : null,
        city: allowCoarse ? geo.city : null,
        latitude: allowPrecise ? (context?.latitude ?? null) : null,
        longitude: allowPrecise ? (context?.longitude ?? null) : null,
      });
    }

    let accepted = 0;
    if (rows.length > 0) {
      // ON CONFLICT DO NOTHING against the partial unique index on
      // (anonymous_id) WHERE event_name = 'first_open': a client retrying an
      // ambiguously-failed first send (request landed, response lost) must
      // not double-count the install. Duplicates are reported as dropped.
      const inserted = await db
        .insert(analyticsEventsTable)
        .values(rows)
        .onConflictDoNothing()
        .returning({ id: analyticsEventsTable.id });
      accepted = inserted.length;
      dropped += rows.length - accepted;
    }
    res.json({ accepted, dropped });
  } catch (error) {
    req.log.error({ err: error }, "Analytics ingestion failed");
    res.status(500).json({ error: "Failed to record events" });
  }
});

export default router;
