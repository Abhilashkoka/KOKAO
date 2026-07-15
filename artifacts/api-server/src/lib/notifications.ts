import { db, notificationsTable, tenantsTable } from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";
import { logger } from "./logger";
import { fetchVerifiedEmail } from "./clerkUser";
import { sendEmail } from "./email";
import { getEffectiveSetting } from "./notificationSettings";

export const SOCIAL_CONNECTION_FAILED = "social_connection_failed";
export const PUBLISH_INTERRUPTED = "publish_interrupted";

const PLATFORM_LABELS: Record<string, string> = {
  facebook: "Facebook Page",
  instagram: "Instagram account",
  linkedin: "LinkedIn account",
  twitter: "X account",
  youtube: "YouTube channel",
  threads: "Threads profile",
};

function platformLabel(platform: string): string {
  return PLATFORM_LABELS[platform] ?? platform;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Absolute URL to the Accounts page where the tenant reconnects. Uses the
 * app's public domain (REPLIT_DOMAINS) so the link works from an email client;
 * falls back to the relative path if no public domain is available.
 */
function reconnectUrl(): string {
  const domain = (process.env.REPLIT_DOMAINS ?? "")
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean)[0];
  return domain ? `https://${domain}/accounts` : "/accounts";
}

/**
 * Best-effort email to the tenant's verified address when a connection breaks,
 * so a user who never opens the app still learns their token expired. Deduping
 * is inherited from the caller: this only runs right after a fresh notification
 * row is inserted, so a re-checked-but-still-broken token does not re-email.
 * Never throws — email is a side channel and must not break the caller.
 */
async function emailSocialConnectionFailed(
  tenantId: number,
  platform: string,
  label: string,
  bodyMessage: string,
): Promise<void> {
  try {
    const tenant = (
      await db
        .select({ clerkUserId: tenantsTable.clerkUserId })
        .from(tenantsTable)
        .where(eq(tenantsTable.id, tenantId))
        .limit(1)
    )[0];
    if (!tenant) return;

    const email = await fetchVerifiedEmail(tenant.clerkUserId);
    if (!email) return;

    const link = reconnectUrl();
    const subject = `${label} disconnected - reconnect needed`;
    const text = `${bodyMessage}\n\nReconnect your ${label}: ${link}`;
    const html =
      `<p>${escapeHtml(bodyMessage)}</p>` +
      `<p><a href="${escapeHtml(link)}">Reconnect your ${escapeHtml(label)}</a></p>`;

    await sendEmail({ to: email, subject, text, html });
  } catch (err) {
    logger.error(
      { err, tenantId, platform },
      "Failed to email social connection breakage",
    );
  }
}

/**
 * Auto-dismiss any unread "connection failed" notification for a platform the
 * moment its connection is verified again (reconnect, credential re-save, or
 * successful re-test). Marking the row read both hides the banner and re-arms
 * the dedupe so a future breakage produces a fresh notification. Never throws.
 */
export async function resolveSocialConnectionNotifications(
  tenantId: number,
  platform: string,
): Promise<void> {
  try {
    await db
      .update(notificationsTable)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notificationsTable.tenantId, tenantId),
          eq(notificationsTable.type, SOCIAL_CONNECTION_FAILED),
          eq(notificationsTable.platform, platform),
          isNull(notificationsTable.readAt),
        ),
      );
  } catch (err) {
    logger.error(
      { err, tenantId, platform },
      "Failed to resolve social connection notifications",
    );
  }
}

/**
 * Record an in-app notification that one or more of a tenant's posts were
 * auto-failed because a server restart interrupted publishing mid-flight.
 * Called from startup recovery, once per affected tenant. Deduped against an
 * existing UNREAD notification of the same type so repeated restarts do not
 * stack banners. In-app only — no email; this is a routine "just retry"
 * situation, not a broken connection. Never throws — a notification failure
 * must not break server startup recovery.
 */
export async function notifyPublishInterrupted(
  tenantId: number,
  titles: string[],
): Promise<void> {
  try {
    const existing = await db
      .select({ id: notificationsTable.id })
      .from(notificationsTable)
      .where(
        and(
          eq(notificationsTable.tenantId, tenantId),
          eq(notificationsTable.type, PUBLISH_INTERRUPTED),
          isNull(notificationsTable.readAt),
        ),
      )
      .limit(1);
    if (existing.length > 0) return;

    const effective = await getEffectiveSetting(tenantId, PUBLISH_INTERRUPTED);
    if (!effective.enabled) return;

    const count = titles.length;
    const firstTitle = titles[0] ?? "";
    const message =
      count === 1
        ? `"${firstTitle}" was being published when the server restarted, so it was marked failed. Nothing was wrong with the post — just publish it again from the Content Library.`
        : `${count} posts were being published when the server restarted, so they were marked failed. Nothing was wrong with them — just publish them again from the Content Library.`;

    await db.insert(notificationsTable).values({
      tenantId,
      type: PUBLISH_INTERRUPTED,
      platform: null,
      title:
        count === 1
          ? "A publish was interrupted"
          : `${count} publishes were interrupted`,
      message,
      linkUrl: "/library",
      inApp: effective.inApp,
    });
  } catch (err) {
    logger.error(
      { err, tenantId },
      "Failed to record publish-interrupted notification",
    );
  }
}

/**
 * Record a one-time notification that a tenant's social connection has broken
 * (an expired/revoked token flipped from verified to failed). Deduped so a
 * single breakage produces a single notification even if the token is
 * re-checked repeatedly: it only inserts when there is no existing UNREAD
 * social-connection-failed notification for the same tenant + platform. When
 * the tenant reconnects and the connection later breaks again, that is a new
 * breakage and produces a fresh notification. On a fresh breakage it also emails
 * the tenant's verified address (best effort). Never throws — a failure to
 * notify must not break the re-verification path that calls it.
 */
export async function notifySocialConnectionFailed(
  tenantId: number,
  platform: string,
  message?: string,
): Promise<void> {
  try {
    const existing = await db
      .select({ id: notificationsTable.id })
      .from(notificationsTable)
      .where(
        and(
          eq(notificationsTable.tenantId, tenantId),
          eq(notificationsTable.type, SOCIAL_CONNECTION_FAILED),
          eq(notificationsTable.platform, platform),
          isNull(notificationsTable.readAt),
        ),
      )
      .limit(1);
    if (existing.length > 0) return;

    // Resolve the tenant's effective channels (global policy folded with the
    // tenant's own preference). A fully disabled type produces nothing at all.
    const effective = await getEffectiveSetting(tenantId, SOCIAL_CONNECTION_FAILED);
    if (!effective.enabled) return;

    const label = platformLabel(platform);
    const resolvedMessage =
      message ??
      `Your ${label} connection is no longer valid. Reconnect it to keep publishing.`;

    // Always record the row (dedupe + audit); `inApp` controls banner
    // visibility so an email-only tenant still gets deduped correctly.
    await db.insert(notificationsTable).values({
      tenantId,
      type: SOCIAL_CONNECTION_FAILED,
      platform,
      title: `${label} disconnected`,
      message: resolvedMessage,
      linkUrl: "/accounts",
      inApp: effective.inApp,
    });

    // Fresh breakage only (past the dedupe guard) -> email when the tenant's
    // effective settings opt into the email channel.
    if (effective.email) {
      await emailSocialConnectionFailed(tenantId, platform, label, resolvedMessage);
    }
  } catch (err) {
    logger.error(
      { err, tenantId, platform },
      "Failed to record social connection notification",
    );
  }
}
