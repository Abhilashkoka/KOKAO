import {
  db,
  memberNotificationPreferencesTable,
  notificationsTable,
  pushTokensTable,
  tenantMembersTable,
  tenantsTable,
} from "@workspace/db";
import { and, count, eq, inArray, isNull, lt } from "drizzle-orm";
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
const EXPO_PUSH_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";
const EXPO_PUSH_CHUNK = 100;
const EXPO_PUSH_TIMEOUT_MS = 10_000;

/** Expo recommends waiting ~15 minutes before fetching push receipts. */
const RECEIPT_CHECK_DELAY_MS = 15 * 60 * 1000;
/** Pending receipts older than this are abandoned — Expo only retains
 * receipts for about a day, and an unresolved ticket is not evidence of a
 * dead device. */
const RECEIPT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Cap the in-memory pending-receipt buffer so a burst of sends during an
 * Expo receipts outage cannot grow memory without bound. Oldest entries are
 * dropped first — losing a receipt check is harmless (the token dies on a
 * later send or the unseen-token prune instead). */
const RECEIPT_PENDING_CAP = 10_000;

/** Tokens whose device hasn't re-registered (app launch) within this window
 * are pruned: an uninstalled app never errors, it just goes silent. */
export const PUSH_TOKEN_MAX_UNSEEN_MS = 90 * 24 * 60 * 60 * 1000;

/** How often the maintenance loop checks due receipts and prunes. */
const PUSH_MAINTENANCE_INTERVAL_MS = 15 * 60 * 1000;

interface PendingReceipt {
  ticketId: string;
  token: string;
  /** Earliest time this receipt should be fetched. */
  dueAt: number;
  /** When the ticket was issued, for expiry. */
  createdAt: number;
}

/** In-memory queue of push tickets awaiting a receipt check. Best-effort by
 * design: a process restart loses it, which only means those receipts go
 * unchecked — dead tokens are still caught on the next send or by the
 * unseen-token prune. */
const pendingReceipts: PendingReceipt[] = [];

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

/** Delete a set of dead device tokens. Never throws. */
async function deleteDeadTokens(
  deadTokens: string[],
  source: string,
): Promise<void> {
  if (deadTokens.length === 0) return;
  try {
    await db
      .delete(pushTokensTable)
      .where(inArray(pushTokensTable.token, deadTokens));
    logger.info(
      { count: deadTokens.length, source },
      "Removed unregistered push tokens",
    );
  } catch (err) {
    logger.error({ err, source }, "Failed to delete dead push tokens");
  }
}

/** Queue a ticket id for a later receipt check, evicting the oldest entries
 * when the buffer is full. */
function queueReceipt(ticketId: string, token: string): void {
  const now = Date.now();
  pendingReceipts.push({
    ticketId,
    token,
    dueAt: now + RECEIPT_CHECK_DELAY_MS,
    createdAt: now,
  });
  if (pendingReceipts.length > RECEIPT_PENDING_CAP) {
    pendingReceipts.splice(0, pendingReceipts.length - RECEIPT_PENDING_CAP);
  }
}

/**
 * Send prepared Expo push messages in chunks. Tokens Expo reports as
 * DeviceNotRegistered are deleted so dead devices stop consuming sends.
 * Successful tickets' ids are queued for a delayed receipt check, because
 * Expo also reports delivery failures asynchronously via receipts.
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
          id?: string;
          details?: { error?: string };
        }>;
      };
      const tickets = body.data ?? [];
      const deadTokens: string[] = [];
      tickets.forEach((ticket, idx) => {
        const token = chunk[idx]?.to;
        if (!token) return;
        if (
          ticket.status === "error" &&
          ticket.details?.error === "DeviceNotRegistered"
        ) {
          deadTokens.push(token);
        } else if (ticket.status === "ok" && ticket.id) {
          queueReceipt(ticket.id, token);
        }
      });
      await deleteDeadTokens(deadTokens, "ticket");
    } catch (err) {
      logger.error({ err }, "Failed to send an Expo push chunk");
    }
  }
  // Piggyback: any earlier tickets whose receipt-check delay has elapsed get
  // resolved on this send, so receipts are checked even without the
  // maintenance loop (e.g. in one-off scripts).
  await checkDuePushReceipts();
}

/**
 * Fetch receipts for pending tickets whose delay has elapsed and delete
 * tokens whose receipt reports DeviceNotRegistered. Receipts Expo hasn't
 * produced yet are re-queued until they expire. Never throws.
 */
export async function checkDuePushReceipts(): Promise<void> {
  try {
    const now = Date.now();
    const due: PendingReceipt[] = [];
    for (let i = pendingReceipts.length - 1; i >= 0; i--) {
      const p = pendingReceipts[i];
      if (now - p.createdAt > RECEIPT_MAX_AGE_MS) {
        pendingReceipts.splice(i, 1);
      } else if (p.dueAt <= now) {
        due.push(p);
        pendingReceipts.splice(i, 1);
      }
    }
    if (due.length === 0) return;

    for (let i = 0; i < due.length; i += EXPO_PUSH_CHUNK) {
      const batch = due.slice(i, i + EXPO_PUSH_CHUNK);
      try {
        const res = await fetch(EXPO_PUSH_RECEIPTS_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({ ids: batch.map((p) => p.ticketId) }),
          signal: AbortSignal.timeout(EXPO_PUSH_TIMEOUT_MS),
        });
        if (!res.ok) {
          logger.error(
            { status: res.status },
            "Expo receipt fetch failed with a non-OK status",
          );
          // Re-queue so a transient outage doesn't drop the checks.
          pendingReceipts.push(...batch);
          continue;
        }
        const body = (await res.json()) as {
          data?: Record<
            string,
            { status: string; details?: { error?: string } }
          >;
        };
        const receipts = body.data ?? {};
        const deadTokens: string[] = [];
        for (const p of batch) {
          const receipt = receipts[p.ticketId];
          if (!receipt) {
            // Not ready yet — try again on a later pass until it expires.
            pendingReceipts.push({ ...p, dueAt: Date.now() + RECEIPT_CHECK_DELAY_MS });
            continue;
          }
          if (
            receipt.status === "error" &&
            receipt.details?.error === "DeviceNotRegistered"
          ) {
            deadTokens.push(p.token);
          }
        }
        await deleteDeadTokens(deadTokens, "receipt");
      } catch (err) {
        logger.error({ err }, "Failed to fetch an Expo receipt batch");
        pendingReceipts.push(...batch);
      }
    }
  } catch (err) {
    logger.error({ err }, "Push receipt check failed");
  }
}

/** TEST ONLY: inspect/clear the pending receipt queue. */
export function _getPendingReceiptsForTest(): PendingReceipt[] {
  return pendingReceipts;
}

/**
 * Delete tokens whose device hasn't re-registered within
 * PUSH_TOKEN_MAX_UNSEEN_MS. An uninstalled app never returns an error — it
 * just stops launching, so lastSeenAt stops refreshing. Never throws.
 */
export async function pruneUnseenPushTokens(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - PUSH_TOKEN_MAX_UNSEEN_MS);
    const removed = await db
      .delete(pushTokensTable)
      .where(lt(pushTokensTable.lastSeenAt, cutoff))
      .returning({ id: pushTokensTable.id });
    if (removed.length > 0) {
      logger.info(
        { count: removed.length },
        "Pruned push tokens unseen for too long",
      );
    }
  } catch (err) {
    logger.error({ err }, "Failed to prune unseen push tokens");
  }
}

let maintenanceTimer: NodeJS.Timeout | null = null;

/**
 * Start the periodic push-token maintenance loop: resolves due push
 * receipts and prunes long-unseen tokens. Safe to call once at boot;
 * both steps are best-effort and never throw.
 */
export function startPushTokenMaintenance(): void {
  if (maintenanceTimer) return;
  maintenanceTimer = setInterval(() => {
    void checkDuePushReceipts();
    void pruneUnseenPushTokens();
  }, PUSH_MAINTENANCE_INTERVAL_MS);
  maintenanceTimer.unref();
}

export function stopPushTokenMaintenance(): void {
  if (maintenanceTimer) {
    clearInterval(maintenanceTimer);
    maintenanceTimer = null;
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
