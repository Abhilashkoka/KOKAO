import {
  db,
  memberNotificationPreferencesTable,
  notificationsTable,
  pushTokensTable,
  tenantMembersTable,
  tenantsTable,
} from "@workspace/db";
import { and, count, eq, inArray, isNull } from "drizzle-orm";
import { logger } from "./logger";
import { getFeatureFlags } from "./featureFlags";
import { getEffectiveSetting } from "./notificationSettings";

/**
 * Mobile push notification delivery via Expo's push service.
 *
 * Push is a best-effort side channel like email: every function here catches
 * its own errors and never throws, so a push failure can never break the
 * primary action (a publish, a sweep, an admin decision) that raised the
 * notification. Delivery is keyless — Expo's push API authenticates the
 * device by its token — so there is nothing to configure server-side.
 */

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_PUSH_CHUNK = 100;
const EXPO_PUSH_TIMEOUT_MS = 10_000;

export interface PushPayload {
  title: string;
  message: string;
  linkUrl?: string | null;
  type: string;
}

interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  sound: "default";
  badge?: number;
  data: { url?: string; type: string };
}

function looksLikeExpoToken(token: string): boolean {
  return /^Expo(nent)?PushToken\[[^\]]+\]$/.test(token);
}

export { looksLikeExpoToken };

/**
 * Send prepared Expo push messages in chunks. Tokens Expo reports as
 * DeviceNotRegistered are deleted so dead devices stop consuming sends.
 * Never throws.
 */
async function sendExpoPushMessages(messages: ExpoPushMessage[]): Promise<void> {
  for (let i = 0; i < messages.length; i += EXPO_PUSH_CHUNK) {
    const chunk = messages.slice(i, i + EXPO_PUSH_CHUNK);
    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(chunk),
        signal: AbortSignal.timeout(EXPO_PUSH_TIMEOUT_MS),
      });
      if (!res.ok) {
        logger.error(
          { status: res.status },
          "Expo push send failed with a non-OK status",
        );
        continue;
      }
      const body = (await res.json()) as {
        data?: Array<{
          status: string;
          details?: { error?: string };
        }>;
      };
      const tickets = body.data ?? [];
      const deadTokens: string[] = [];
      tickets.forEach((ticket, idx) => {
        if (
          ticket.status === "error" &&
          ticket.details?.error === "DeviceNotRegistered"
        ) {
          const token = chunk[idx]?.to;
          if (token) deadTokens.push(token);
        }
      });
      if (deadTokens.length > 0) {
        await db
          .delete(pushTokensTable)
          .where(inArray(pushTokensTable.token, deadTokens));
        logger.info(
          { count: deadTokens.length },
          "Removed unregistered push tokens",
        );
      }
    } catch (err) {
      logger.error({ err }, "Failed to send an Expo push chunk");
    }
  }
}

/**
 * Push one notification to every registered device of a set of users.
 * Never throws.
 */
async function pushToUsers(
  clerkUserIds: string[],
  payload: PushPayload,
  badge?: number,
): Promise<void> {
  if (clerkUserIds.length === 0) return;
  const rows = await db
    .select({ token: pushTokensTable.token })
    .from(pushTokensTable)
    .where(inArray(pushTokensTable.clerkUserId, clerkUserIds));
  const tokens = Array.from(new Set(rows.map((r) => r.token)));
  if (tokens.length === 0) return;

  const messages: ExpoPushMessage[] = tokens.map((to) => ({
    to,
    title: payload.title,
    body: payload.message,
    sound: "default",
    ...(badge !== undefined ? { badge } : {}),
    data: {
      ...(payload.linkUrl ? { url: payload.linkUrl } : {}),
      type: payload.type,
    },
  }));
  await sendExpoPushMessages(messages);
}

/**
 * The push counterpart of an in-app tenant notification: called by the
 * dispatch choke point (lib/notifications.ts) right after a FRESH
 * notification row is inserted, so it inherits the caller's dedupe — an
 * updated-in-place unread banner never re-pushes, matching email behavior.
 *
 * Recipients mirror the shared in-app feed: the workspace OWNER's devices
 * (gated by the tenant-scoped effective `push` channel for the type) plus
 * every team member's devices EXCEPT members who opted their own push off
 * for this type (member-scoped preference, default on). The platform-wide
 * `pushNotifications` kill switch silences everything; the check fails OPEN
 * on DB errors like the route middleware so a transient outage never mutes
 * alerts. Never throws.
 */
export async function sendTenantPush(
  tenantId: number,
  type: string,
  payload: Omit<PushPayload, "type">,
): Promise<void> {
  try {
    try {
      const flags = await getFeatureFlags();
      if (!flags.pushNotifications) return;
    } catch (err) {
      logger.error({ err }, "Push feature flag check failed; sending anyway");
    }

    const effective = await getEffectiveSetting(tenantId, type);
    if (!effective.enabled) return;

    const recipients = new Set<string>();

    if (effective.push) {
      const tenant = (
        await db
          .select({ clerkUserId: tenantsTable.clerkUserId })
          .from(tenantsTable)
          .where(eq(tenantsTable.id, tenantId))
          .limit(1)
      )[0];
      if (tenant) recipients.add(tenant.clerkUserId);
    }

    // Team members: each member's own member-scoped push choice governs
    // their devices (missing row = default on). The owner's tenant-scoped
    // choice never silences a member, and vice versa.
    const members = await db
      .select({ clerkUserId: tenantMembersTable.clerkUserId })
      .from(tenantMembersTable)
      .where(eq(tenantMembersTable.tenantId, tenantId));
    if (members.length > 0) {
      const optOuts = await db
        .select({
          clerkUserId: memberNotificationPreferencesTable.clerkUserId,
          push: memberNotificationPreferencesTable.push,
        })
        .from(memberNotificationPreferencesTable)
        .where(
          and(
            eq(memberNotificationPreferencesTable.tenantId, tenantId),
            eq(memberNotificationPreferencesTable.type, type),
          ),
        );
      const pushOff = new Set(
        optOuts.filter((r) => r.push === false).map((r) => r.clerkUserId),
      );
      for (const m of members) {
        if (!pushOff.has(m.clerkUserId)) recipients.add(m.clerkUserId);
      }
    }

    // iOS app-icon badge: the unread count of this tenant's in-app feed —
    // the same feed every recipient (owner and members) sees in the app.
    // Computed after the fresh row insert so it includes this notification.
    // Best-effort: a count failure just sends the push without a badge.
    let badge: number | undefined;
    try {
      const unread = (
        await db
          .select({ value: count() })
          .from(notificationsTable)
          .where(
            and(
              eq(notificationsTable.tenantId, tenantId),
              eq(notificationsTable.inApp, true),
              isNull(notificationsTable.readAt),
            ),
          )
      )[0];
      if (unread) badge = unread.value;
    } catch (err) {
      logger.error({ err, tenantId }, "Failed to compute push badge count");
    }

    await pushToUsers(Array.from(recipients), { ...payload, type }, badge);
  } catch (err) {
    logger.error({ err, tenantId, type }, "Failed to send tenant push");
  }
}
