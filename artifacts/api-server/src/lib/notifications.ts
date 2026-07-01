import { db, notificationsTable } from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";
import { logger } from "./logger";

export const SOCIAL_CONNECTION_FAILED = "social_connection_failed";

const PLATFORM_LABELS: Record<string, string> = {
  facebook: "Facebook Page",
  instagram: "Instagram account",
  linkedin: "LinkedIn account",
};

function platformLabel(platform: string): string {
  return PLATFORM_LABELS[platform] ?? platform;
}

/**
 * Record a one-time notification that a tenant's social connection has broken
 * (an expired/revoked token flipped from verified to failed). Deduped so a
 * single breakage produces a single notification even if the token is
 * re-checked repeatedly: it only inserts when there is no existing UNREAD
 * social-connection-failed notification for the same tenant + platform. When
 * the tenant reconnects and the connection later breaks again, that is a new
 * breakage and produces a fresh notification. Never throws — a failure to
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
    await db.insert(notificationsTable).values({
      tenantId,
      type: SOCIAL_CONNECTION_FAILED,
      platform,
      title: `${label} disconnected`,
      message:
        message ??
        `Your ${label} connection is no longer valid. Reconnect it to keep publishing.`,
      linkUrl: "/accounts",
    });
  } catch (err) {
    logger.error(
      { err, tenantId, platform },
      "Failed to record social connection notification",
    );
  }
}
