import {
  db,
  memberNotificationPreferencesTable,
  notificationsTable,
  pushReceiptQueueTable,
  pushTokensTable,
  tenantMembersTable,
  tenantsTable,
} from "@workspace/db";
import { and, count, eq, inArray, isNull, lt, lte, notInArray, sql } from "drizzle-orm";
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
/** Cap the persisted pending-receipt queue so a burst of sends during an
 * Expo receipts outage cannot grow the table without bound. Oldest entries
 * are dropped first — losing a receipt check is harmless (the token dies on
 * a later send or the unseen-token prune instead). */
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
  dueAt: Date;
  /** When the ticket was issued, for expiry. */
  createdAt: Date;
}

export interface PushPayload {
  title: string;
  message: string;
  linkUrl?: string | null;
  /** The content item this notification is about, when there is exactly
   * one — lets the mobile app deep-link straight to the post's edit
   * screen instead of the library list. */
  contentItemId?: number | null;
  type: string;
}

interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  sound: "default";
  badge?: number;
  data: { url?: string; type: string; contentItemId?: number };
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

/** Persist ticket ids for a later receipt check so pending checks survive a
 * server restart. Best-effort: an insert failure only means those receipts
 * go unchecked — dead tokens are still caught on the next send or by the
 * unseen-token prune. Never throws. */
async function queueReceipts(
  entries: Array<{ ticketId: string; token: string }>,
): Promise<void> {
  if (entries.length === 0) return;
  try {
    const now = Date.now();
    await db
      .insert(pushReceiptQueueTable)
      .values(
        entries.map((e) => ({
          ticketId: e.ticketId,
          token: e.token,
          dueAt: new Date(now + RECEIPT_CHECK_DELAY_MS),
          createdAt: new Date(now),
        })),
      )
      .onConflictDoNothing();
  } catch (err) {
    logger.error(
      { err, count: entries.length },
      "Failed to queue push receipts for checking",
    );
  }
}

/** Drop the oldest queued receipts beyond the cap so a burst of sends during
 * an Expo receipts outage cannot grow the table without bound. Never
 * throws. */
async function enforceReceiptQueueCap(): Promise<void> {
  try {
    const keep = db
      .select({ ticketId: pushReceiptQueueTable.ticketId })
      .from(pushReceiptQueueTable)
      .orderBy(
        sql`${pushReceiptQueueTable.createdAt} DESC, ${pushReceiptQueueTable.ticketId} DESC`,
      )
      .limit(RECEIPT_PENDING_CAP);
    await db
      .delete(pushReceiptQueueTable)
      .where(notInArray(pushReceiptQueueTable.ticketId, keep));
  } catch (err) {
    logger.error({ err }, "Failed to cap the push receipt queue");
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
      const toQueue: Array<{ ticketId: string; token: string }> = [];
      tickets.forEach((ticket, idx) => {
        const token = chunk[idx]?.to;
        if (!token) return;
        if (
          ticket.status === "error" &&
          ticket.details?.error === "DeviceNotRegistered"
        ) {
          deadTokens.push(token);
        } else if (ticket.status === "ok" && ticket.id) {
          toQueue.push({ ticketId: ticket.id, token });
        }
      });
      await queueReceipts(toQueue);
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
    const now = new Date();

    // Drop entries older than Expo's receipt retention window.
    await db
      .delete(pushReceiptQueueTable)
      .where(
        lt(
          pushReceiptQueueTable.createdAt,
          new Date(now.getTime() - RECEIPT_MAX_AGE_MS),
        ),
      );

    // Atomically claim due rows by bumping dueAt one check-delay forward:
    // the same rows can't be claimed twice concurrently, and a crash
    // mid-check simply retries them on a later pass (until they expire).
    const due: PendingReceipt[] = await db
      .update(pushReceiptQueueTable)
      .set({ dueAt: new Date(now.getTime() + RECEIPT_CHECK_DELAY_MS) })
      .where(lte(pushReceiptQueueTable.dueAt, now))
      .returning({
        ticketId: pushReceiptQueueTable.ticketId,
        token: pushReceiptQueueTable.token,
        dueAt: pushReceiptQueueTable.dueAt,
        createdAt: pushReceiptQueueTable.createdAt,
      });
    if (due.length === 0) {
      await enforceReceiptQueueCap();
      return;
    }

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
          // Rows stay queued (dueAt was bumped), so a transient outage
          // doesn't drop the checks.
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
        const resolvedTicketIds: string[] = [];
        for (const p of batch) {
          const receipt = receipts[p.ticketId];
          if (!receipt) {
            // Not ready yet — the row remains queued for a later pass
            // until it expires.
            continue;
          }
          resolvedTicketIds.push(p.ticketId);
          if (
            receipt.status === "error" &&
            receipt.details?.error === "DeviceNotRegistered"
          ) {
            deadTokens.push(p.token);
          }
        }
        if (resolvedTicketIds.length > 0) {
          await db
            .delete(pushReceiptQueueTable)
            .where(inArray(pushReceiptQueueTable.ticketId, resolvedTicketIds));
        }
        await deleteDeadTokens(deadTokens, "receipt");
      } catch (err) {
        logger.error({ err }, "Failed to fetch an Expo receipt batch");
        // Rows stay queued (dueAt was bumped) for a later retry.
      }
    }

    await enforceReceiptQueueCap();
  } catch (err) {
    logger.error({ err }, "Push receipt check failed");
  }
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
      ...(payload.contentItemId != null
        ? { contentItemId: payload.contentItemId }
        : {}),
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
