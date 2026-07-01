import { db, notificationsTable, tenantsTable } from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";
import { logger } from "./logger";
import { fetchVerifiedEmail } from "./clerkUser";
import { sendEmail } from "./email";

export const SOCIAL_CONNECTION_FAILED = "social_connection_failed";

const PLATFORM_LABELS: Record<string, string> = {
  facebook: "Facebook Page",
  instagram: "Instagram account",
  linkedin: "LinkedIn account",
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

    const label = platformLabel(platform);
    const resolvedMessage =
      message ??
      `Your ${label} connection is no longer valid. Reconnect it to keep publishing.`;

    await db.insert(notificationsTable).values({
      tenantId,
      type: SOCIAL_CONNECTION_FAILED,
      platform,
      title: `${label} disconnected`,
      message: resolvedMessage,
      linkUrl: "/accounts",
    });

    // Fresh breakage only (past the dedupe guard) -> also email the tenant.
    await emailSocialConnectionFailed(tenantId, platform, label, resolvedMessage);
  } catch (err) {
    logger.error(
      { err, tenantId, platform },
      "Failed to record social connection notification",
    );
  }
}
