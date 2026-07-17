import { db, notificationsTable, tenantsTable } from "@workspace/db";
import { and, eq, isNotNull, isNull, or } from "drizzle-orm";
import { logger } from "./logger";
import { fetchVerifiedEmail } from "./clerkUser";
import { sendEmail } from "./email";
import { getEffectiveSetting } from "./notificationSettings";
import { isSuperadminEmail } from "./superadmins";

export const SOCIAL_CONNECTION_FAILED = "social_connection_failed";
export const PUBLISH_INTERRUPTED = "publish_interrupted";
export const SEAT_REQUEST_DECIDED = "seat_request_decided";
export const SEAT_REQUEST_SUBMITTED = "seat_request_submitted";

/**
 * Tell a workspace that a superadmin decided their seat request. In-app
 * (plus email when the tenant opted in / policy forces it). Best-effort —
 * never throws, so a notification failure cannot fail the admin decision.
 */
export async function notifySeatRequestDecided(
  tenantId: number,
  outcome: { approved: boolean; grantedSeats: number | null },
): Promise<void> {
  try {
    const effective = await getEffectiveSetting(tenantId, SEAT_REQUEST_DECIDED);
    if (!effective.enabled) return;

    const title = outcome.approved
      ? "Your seat request was approved"
      : "Your seat request was denied";
    const message = outcome.approved
      ? `Your workspace now has ${outcome.grantedSeats} team seats. Invite people from Settings > Team.`
      : "A platform admin denied your request for more team seats. You can submit a new request from Settings > Team.";

    await db.insert(notificationsTable).values({
      tenantId,
      type: SEAT_REQUEST_DECIDED,
      platform: null,
      title,
      message,
      linkUrl: "/settings",
      inApp: effective.inApp,
    });

    if (effective.email) {
      const tenant = (
        await db
          .select()
          .from(tenantsTable)
          .where(eq(tenantsTable.id, tenantId))
          .limit(1)
      )[0];
      if (tenant) {
        const email = await fetchVerifiedEmail(tenant.clerkUserId);
        if (email) {
          await sendEmail({
            to: email,
            subject: title,
            text: message,
          });
        }
      }
    }
  } catch (err) {
    logger.error(
      { err, tenantId },
      "Failed to record seat-request-decided notification",
    );
  }
}
export const SWEEP_STALLED = "sweep_stalled";
export const TEAM_MEMBER_LEFT = "team_member_left";

/**
 * Tell the workspace owner that a teammate removed themselves from the team
 * (POST /team/leave), naming who left and noting the seat was freed. Follows
 * the catalog/policy pattern: the OWNER tenant's effective settings for
 * `team_member_left` decide the channels. Best-effort — never throws, so a
 * notification failure cannot fail the leave itself.
 */
export async function notifyTeamMemberLeft(
  tenantId: number,
  leaver: { email: string | null; role: string },
): Promise<void> {
  try {
    const effective = await getEffectiveSetting(tenantId, TEAM_MEMBER_LEFT);
    if (!effective.enabled) return;

    const who = leaver.email ?? "A teammate";
    const title = "A teammate left your workspace";
    const message =
      `${who} left your workspace, so their seat is free again. ` +
      `You can invite someone else from Settings > Team.`;

    await db.insert(notificationsTable).values({
      tenantId,
      type: TEAM_MEMBER_LEFT,
      platform: null,
      title,
      message,
      linkUrl: "/settings",
      inApp: effective.inApp,
    });

    if (effective.email) {
      const tenant = (
        await db
          .select({ clerkUserId: tenantsTable.clerkUserId })
          .from(tenantsTable)
          .where(eq(tenantsTable.id, tenantId))
          .limit(1)
      )[0];
      if (tenant) {
        const email = await fetchVerifiedEmail(tenant.clerkUserId);
        if (email) {
          await sendEmail({
            to: email,
            subject: title,
            text: message,
            html: `<p>${escapeHtml(message)}</p>`,
          });
        }
      }
    }
  } catch (err) {
    logger.error(
      { err, tenantId },
      "Failed to record team-member-left notification",
    );
  }
}

/**
 * Alert every platform admin (superadmin) that a workspace has submitted a
 * new seat request awaiting a decision. Recipients are tenants with the
 * grantable `isSuperadmin` DB flag OR whose cached email is on the
 * SUPERADMIN_EMAILS allowlist (routing hint only — the notification grants
 * nothing). Each recipient's own effective notification settings for
 * `seat_request_submitted` decide the channels (in-app / email), so admins
 * can tune or disable it like any other catalog type. Best-effort — never
 * throws, so a notification failure cannot fail the seat request itself.
 */
export async function notifySeatRequestSubmitted(details: {
  requestingTenantId: number;
  requestingTenantName: string;
  requestedSeats: number;
  note: string | null;
}): Promise<void> {
  try {
    const candidates = await db
      .select({
        id: tenantsTable.id,
        clerkUserId: tenantsTable.clerkUserId,
        email: tenantsTable.email,
        isSuperadmin: tenantsTable.isSuperadmin,
      })
      .from(tenantsTable)
      .where(
        or(eq(tenantsTable.isSuperadmin, true), isNotNull(tenantsTable.email)),
      );
    const recipients = candidates.filter(
      (t) => t.isSuperadmin || isSuperadminEmail(t.email),
    );
    if (recipients.length === 0) return;

    const title = "New seat request awaiting review";
    const noteText = details.note ? ` Note: "${details.note}"` : "";
    const message =
      `Workspace "${details.requestingTenantName}" requested ` +
      `${details.requestedSeats} team seats.${noteText} ` +
      `Review it on the admin dashboard.`;

    for (const recipient of recipients) {
      try {
        const effective = await getEffectiveSetting(
          recipient.id,
          SEAT_REQUEST_SUBMITTED,
        );
        if (!effective.enabled) continue;

        await db.insert(notificationsTable).values({
          tenantId: recipient.id,
          type: SEAT_REQUEST_SUBMITTED,
          platform: null,
          title,
          message,
          linkUrl: "/admin",
          inApp: effective.inApp,
        });

        if (effective.email) {
          const email = await fetchVerifiedEmail(recipient.clerkUserId);
          if (email) {
            await sendEmail({
              to: email,
              subject: title,
              text: message,
              html: `<p>${escapeHtml(message)}</p>`,
            });
          }
        }
      } catch (err) {
        logger.error(
          { err, recipientTenantId: recipient.id },
          "Failed to notify a superadmin about a seat request",
        );
      }
    }
  } catch (err) {
    logger.error(
      { err, requestingTenantId: details.requestingTenantId },
      "Failed to record seat-request-submitted notifications",
    );
  }
}

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
 * Alert every superadmin that the background connection sweep has stopped
 * running (its last recorded run is older than the stale threshold). This is
 * an operational alert for platform admins, NOT a tenant-facing notification,
 * so it deliberately bypasses the tenant notification-preference catalog:
 * it is always recorded in-app and best-effort emailed to each superadmin's
 * verified address.
 *
 * Recipients are tenants with the grantable `isSuperadmin` DB flag OR whose
 * cached email is on the SUPERADMIN_EMAILS allowlist (the cached email is a
 * routing hint here, not an authorization boundary — the notification grants
 * nothing). Deduped per recipient on an existing UNREAD sweep_stalled row, so
 * repeated staleness checks never stack banners or re-email; the dedupe
 * re-arms when the sweep recovers (see resolveSweepStalledNotifications).
 * Never throws.
 */
export async function notifySweepStalled(
  lastRunAt: Date | null,
  thresholdMinutes: number,
): Promise<void> {
  try {
    // Recipients: the grantable DB flag OR a cached email on the env
    // allowlist. Fetch flagged rows plus any rows with an email (the
    // allowlist match happens in JS since it lives in process env).
    const candidates = await db
      .select({
        id: tenantsTable.id,
        clerkUserId: tenantsTable.clerkUserId,
        email: tenantsTable.email,
        isSuperadmin: tenantsTable.isSuperadmin,
      })
      .from(tenantsTable)
      .where(
        or(eq(tenantsTable.isSuperadmin, true), isNotNull(tenantsTable.email)),
      );
    const recipients = candidates.filter(
      (t) => t.isSuperadmin || isSuperadminEmail(t.email),
    );
    if (recipients.length === 0) return;

    const lastRunText = lastRunAt
      ? `Its last recorded run was at ${lastRunAt.toISOString()}.`
      : "It has no recorded run yet.";
    const message =
      `The background connection safety check has not completed a run in over ` +
      `${thresholdMinutes} minutes. ${lastRunText} Expired social connections ` +
      `will not be detected until it recovers. Check the server logs and ` +
      `restart the API server if needed.`;

    for (const tenant of recipients) {
      const existing = await db
        .select({ id: notificationsTable.id })
        .from(notificationsTable)
        .where(
          and(
            eq(notificationsTable.tenantId, tenant.id),
            eq(notificationsTable.type, SWEEP_STALLED),
            isNull(notificationsTable.readAt),
          ),
        )
        .limit(1);
      if (existing.length > 0) continue;

      await db.insert(notificationsTable).values({
        tenantId: tenant.id,
        type: SWEEP_STALLED,
        platform: null,
        title: "Background safety check stalled",
        message,
        linkUrl: "/admin",
        inApp: true,
      });

      // Fresh alert only (past the dedupe guard) -> best-effort email.
      try {
        const email = await fetchVerifiedEmail(tenant.clerkUserId);
        if (email) {
          await sendEmail({
            to: email,
            subject: "Background safety check stalled",
            text: message,
            html: `<p>${escapeHtml(message)}</p>`,
          });
        }
      } catch (err) {
        logger.error(
          { err, tenantId: tenant.id },
          "Failed to email sweep-stalled alert",
        );
      }
    }
  } catch (err) {
    logger.error({ err }, "Failed to record sweep-stalled notifications");
  }
}

/**
 * Mark every unread sweep_stalled notification read once the sweep completes
 * a run again. This both clears the banner and re-arms the dedupe so a future
 * stall produces a fresh alert. Never throws.
 */
export async function resolveSweepStalledNotifications(): Promise<void> {
  try {
    await db
      .update(notificationsTable)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notificationsTable.type, SWEEP_STALLED),
          isNull(notificationsTable.readAt),
        ),
      );
  } catch (err) {
    logger.error({ err }, "Failed to resolve sweep-stalled notifications");
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
