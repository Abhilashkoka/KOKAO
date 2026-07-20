import {
  db,
  notificationPoliciesTable,
  notificationsTable,
  seatRequestsTable,
  tenantMembersTable,
  tenantsTable,
} from "@workspace/db";
import { and, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { logger } from "./logger";
import { fetchVerifiedEmail } from "./clerkUser";
import { sendEmail } from "./email";
import {
  defaultPolicy,
  defaultPreference,
  getEffectiveSetting,
  getMemberEmailSetting,
  getPolicyState,
  resolveEffective,
} from "./notificationSettings";
import type { EmailPolicy } from "./notificationCatalog";
import { isSuperadminEmail } from "./superadmins";
import { sendTenantPush } from "./push";
import type { SweepFailure } from "@workspace/db";

export const SOCIAL_CONNECTION_FAILED = "social_connection_failed";
export const PUBLISH_INTERRUPTED = "publish_interrupted";
export const ADS_CONNECTION_FAILED = "ads_connection_failed";
export const ADS_DRAFT_PENDING = "ads_draft_pending";
export const ADS_CHANGE_APPLIED = "ads_change_applied";
export const ADS_CHANGE_FAILED = "ads_change_failed";
export const SCHEDULED_POST_PUBLISHED = "scheduled_post_published";
export const SCHEDULED_PUBLISH_FAILED = "scheduled_publish_failed";
export const SEAT_REQUEST_DECIDED = "seat_request_decided";
export const SEAT_REQUEST_SUBMITTED = "seat_request_submitted";

/**
 * Resolve the "workspace email recipients" for team-management alerts: the
 * workspace OWNER plus every ADMIN member (admins run the team day-to-day, so
 * they get the same heads-up; plain members do not). Returns deduped,
 * lowercase-deduped verified Clerk email addresses. An optional
 * `excludeClerkUserId` (the actor — e.g. the leaver or the admin who
 * performed the action) is never included. Each Clerk lookup is best-effort
 * and isolated: one bad account cannot block the others. Never throws.
 *
 * Recipient policy by notification type:
 * - owner + admins (this helper): team_member_left, team_member_removed,
 *   seat_request_decided — team-management alerts admins act on.
 * - OWNER-ONLY (deliberately not this helper): social_connection_failed
 *   (account/credential health belongs to the workspace owner), and the
 *   team-invite email itself (goes to the invitee, not the team).
 * - superadmins: seat_request_submitted, sweep_stalled, sweep_fail_streak
 *   (platform-operator alerts, outside the workspace entirely; each admin's
 *   own effective settings decide the channels).
 * - in-app only: publish_interrupted.
 */
export async function fetchWorkspaceEmailRecipients(
  tenantId: number,
  // memberOptOutType is deliberately REQUIRED (pass `null` to explicitly
  // declare "no per-member opt-out applies"): every admin-fanout email must
  // state which notification type governs an individual admin's personal
  // "email off" choice, or a new type would silently ignore it.
  opts: { excludeClerkUserId?: string; memberOptOutType: string | null },
): Promise<string[]> {
  const tenant = (
    await db
      .select({ clerkUserId: tenantsTable.clerkUserId })
      .from(tenantsTable)
      .where(eq(tenantsTable.id, tenantId))
      .limit(1)
  )[0];
  const admins = await db
    .select({ clerkUserId: tenantMembersTable.clerkUserId })
    .from(tenantMembersTable)
    .where(
      and(
        eq(tenantMembersTable.tenantId, tenantId),
        eq(tenantMembersTable.role, "admin"),
      ),
    );

  const recipientIds = new Set<string>();
  if (tenant) recipientIds.add(tenant.clerkUserId);
  for (const admin of admins) recipientIds.add(admin.clerkUserId);
  if (opts.excludeClerkUserId) recipientIds.delete(opts.excludeClerkUserId);

  // When a notification type supports per-member opt-out, individual ADMIN
  // members can turn its email off for THEMSELVES (member-scoped preference)
  // without silencing the owner or other admins. The owner's channel is
  // governed by the workspace's tenant-scoped preference (folded into the
  // caller's `effective` gate), and a "forced" email policy overrides member
  // opt-outs.
  const adminIds = new Set(admins.map((a) => a.clerkUserId));
  const optOutPolicy = opts.memberOptOutType
    ? await getPolicyState(opts.memberOptOutType)
    : null;

  const emails: string[] = [];
  const seen = new Set<string>();
  for (const clerkUserId of recipientIds) {
    try {
      if (
        opts.memberOptOutType &&
        adminIds.has(clerkUserId) &&
        clerkUserId !== tenant?.clerkUserId &&
        optOutPolicy?.emailPolicy !== "forced"
      ) {
        const memberEmailPref = await getMemberEmailSetting(
          tenantId,
          clerkUserId,
          opts.memberOptOutType,
        );
        if (memberEmailPref === false) continue;
      }
      const email = await fetchVerifiedEmail(clerkUserId);
      if (!email || seen.has(email.toLowerCase())) continue;
      seen.add(email.toLowerCase());
      emails.push(email);
    } catch (err) {
      logger.error(
        { err, tenantId, clerkUserId },
        "Failed to resolve a workspace email recipient",
      );
    }
  }
  return emails;
}

/**
 * Best-effort fan-out of one message to all workspace email recipients
 * (owner + admins via fetchWorkspaceEmailRecipients). Each send is isolated —
 * one bad address cannot block the others. Never throws.
 */
async function emailWorkspaceRecipients(
  tenantId: number,
  message: { subject: string; text: string; html?: string },
  opts: { excludeClerkUserId?: string; memberOptOutType: string | null },
): Promise<void> {
  const emails = await fetchWorkspaceEmailRecipients(tenantId, opts);
  for (const to of emails) {
    try {
      await sendEmail({
        to,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
    } catch (err) {
      logger.error(
        { err, tenantId },
        "Failed to email a workspace recipient",
      );
    }
  }
}

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

    await sendTenantPush(tenantId, SEAT_REQUEST_DECIDED, {
      title,
      message,
      linkUrl: "/settings",
    });

    if (effective.email) {
      // Owner + admin members: admins manage the team day-to-day, so a seat
      // decision (which changes how many people they can invite) reaches
      // them too, not just the owner.
      await emailWorkspaceRecipients(
        tenantId,
        {
          subject: title,
          text: message,
          html: `<p>${escapeHtml(message)}</p>`,
        },
        { memberOptOutType: SEAT_REQUEST_DECIDED },
      );
    }
  } catch (err) {
    logger.error(
      { err, tenantId },
      "Failed to record seat-request-decided notification",
    );
  }
}
export const SWEEP_STALLED = "sweep_stalled";
export const TEAM_MEMBER_JOINED = "team_member_joined";
export const TEAM_MEMBER_LEFT = "team_member_left";
export const TEAM_MEMBER_REMOVED = "team_member_removed";
export const REMOVED_FROM_WORKSPACE = "removed_from_workspace";

/**
 * Tell the workspace owner AND its admin members that an invited teammate
 * signed in and actually JOINED the workspace (invite auto-accepted in
 * requireTenant), naming who joined. Follows the catalog/policy pattern: the
 * workspace tenant's effective settings for `team_member_joined` decide the
 * channels — one in-app row lands on the shared tenant feed, and when the
 * email channel is on, the owner plus every ADMIN member's verified Clerk
 * address is emailed, EXCLUDING the joiner themselves and any admin who opted
 * their own email off for this type (member-scoped preference; a "forced"
 * email policy overrides opt-outs). Best-effort — never throws, so a
 * notification failure cannot fail the join itself.
 */
export async function notifyTeamMemberJoined(
  tenantId: number,
  joiner: { email: string | null; role: string; clerkUserId?: string },
): Promise<void> {
  try {
    const effective = await getEffectiveSetting(tenantId, TEAM_MEMBER_JOINED);
    if (!effective.enabled) return;

    const who = joiner.email ?? "A teammate";
    const roleLabel = joiner.role === "admin" ? "an admin" : "a member";
    const title = "A teammate joined your workspace";
    const message =
      `${who} accepted their invite and joined your workspace as ${roleLabel}. ` +
      `You can manage your team from Settings > Team.`;

    await db.insert(notificationsTable).values({
      tenantId,
      type: TEAM_MEMBER_JOINED,
      platform: null,
      title,
      message,
      linkUrl: "/settings",
      inApp: effective.inApp,
    });

    await sendTenantPush(tenantId, TEAM_MEMBER_JOINED, {
      title,
      message,
      linkUrl: "/settings",
    });

    if (effective.email) {
      // Owner + admins, excluding the joiner themselves.
      await emailWorkspaceRecipients(
        tenantId,
        {
          subject: title,
          text: message,
          html: `<p>${escapeHtml(message)}</p>`,
        },
        {
          excludeClerkUserId: joiner.clerkUserId,
          memberOptOutType: TEAM_MEMBER_JOINED,
        },
      );
    }
  } catch (err) {
    logger.error(
      { err, tenantId },
      "Failed to record team-member-joined notification",
    );
  }
}

/**
 * Tell the workspace owner AND its admin members that a teammate removed
 * themselves from the team (POST /team/leave), naming who left and noting the
 * seat was freed. Follows the catalog/policy pattern: the workspace tenant's
 * effective settings for `team_member_left` decide the channels — one in-app
 * row lands on the shared tenant feed (visible to everyone in the workspace),
 * and when the email channel is on, the owner's verified address AND each
 * ADMIN member's verified Clerk address are emailed (admins manage the team
 * day-to-day, so they get the same heads-up). The leaver themselves is never
 * emailed, and plain members are not. Each email is best-effort and isolated —
 * one bad address cannot block the others. Never throws, so a notification
 * failure cannot fail the leave itself.
 */
export async function notifyTeamMemberLeft(
  tenantId: number,
  leaver: { email: string | null; role: string; clerkUserId?: string },
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

    await sendTenantPush(tenantId, TEAM_MEMBER_LEFT, {
      title,
      message,
      linkUrl: "/settings",
    });

    if (effective.email) {
      // Recipients: the owner plus every ADMIN member, excluding the leaver.
      await emailWorkspaceRecipients(
        tenantId,
        {
          subject: title,
          text: message,
          html: `<p>${escapeHtml(message)}</p>`,
        },
        {
          excludeClerkUserId: leaver.clerkUserId,
          memberOptOutType: TEAM_MEMBER_LEFT,
        },
      );
    }
  } catch (err) {
    logger.error(
      { err, tenantId },
      "Failed to record team-member-left notification",
    );
  }
}

/**
 * Tell the workspace owner AND its admin members that a workspace ADMIN (not
 * the owner) removed a teammate (DELETE /team/members/:id), naming who was
 * removed and by whom. Callers must NOT invoke this when the owner performed
 * the removal — no self-notification. Follows the catalog/policy pattern:
 * the workspace tenant's effective settings for `team_member_removed` decide
 * the channels — one in-app row on the shared tenant feed, and when the email
 * channel is on, the owner plus every ADMIN member's verified Clerk address
 * is emailed, EXCLUDING the admin who performed the removal (they already
 * know) and any admin who opted their own email off for this type
 * (member-scoped preference; a "forced" email policy overrides opt-outs). The removed member was deleted before this runs, so they naturally
 * drop out of the recipient set. Best-effort — never throws, so a
 * notification failure cannot fail the removal itself.
 */
export async function notifyTeamMemberRemoved(
  tenantId: number,
  removed: { email: string | null; role: string },
  removedBy: { email: string | null; clerkUserId?: string },
): Promise<void> {
  try {
    const effective = await getEffectiveSetting(tenantId, TEAM_MEMBER_REMOVED);
    if (!effective.enabled) return;

    const who = removed.email ?? "A teammate";
    const by = removedBy.email ?? "a workspace admin";
    const title = "A teammate was removed from your workspace";
    const message =
      `${who} was removed from your workspace by ${by}, so their seat is free again. ` +
      `You can invite someone else from Settings > Team.`;

    await db.insert(notificationsTable).values({
      tenantId,
      type: TEAM_MEMBER_REMOVED,
      platform: null,
      title,
      message,
      linkUrl: "/settings",
      inApp: effective.inApp,
    });

    await sendTenantPush(tenantId, TEAM_MEMBER_REMOVED, {
      title,
      message,
      linkUrl: "/settings",
    });

    if (effective.email) {
      // Owner + admins, excluding the admin who performed the removal.
      await emailWorkspaceRecipients(
        tenantId,
        {
          subject: title,
          text: message,
          html: `<p>${escapeHtml(message)}</p>`,
        },
        {
          excludeClerkUserId: removedBy.clerkUserId,
          memberOptOutType: TEAM_MEMBER_REMOVED,
        },
      );
    }
  } catch (err) {
    logger.error(
      { err, tenantId },
      "Failed to record team-member-removed notification",
    );
  }
}

/**
 * Tell the REMOVED person themselves that they no longer have access to the
 * named workspace (DELETE /team/members/:id), so they are not confused when
 * they next sign in and land in their own personal workspace with none of the
 * team's content. The in-app row is written to the removed person's OWN
 * personal tenant (the tenants row keyed by their clerkUserId) when it exists;
 * their verified Clerk email gets a best-effort heads-up either way. Follows
 * the catalog/policy pattern under `removed_from_workspace`: when the removed
 * person has a personal tenant, their own effective settings decide the
 * channels; when they have no tenant yet (auto-provisioned on next sign-in),
 * the global policy alone decides whether the email fires (defaults apply for
 * the missing preference). Never throws — a notification failure cannot fail
 * the removal itself.
 */
export async function notifyRemovedMember(
  workspaceName: string,
  removed: { clerkUserId: string },
): Promise<void> {
  try {
    const title = `You were removed from "${workspaceName}"`;
    const message =
      `You no longer have access to the "${workspaceName}" workspace or its content. ` +
      `You are now in your own personal workspace. If you think this was a mistake, ` +
      `contact the workspace owner — rejoining requires a new invite.`;

    const personalTenant = (
      await db
        .select({ id: tenantsTable.id })
        .from(tenantsTable)
        .where(eq(tenantsTable.clerkUserId, removed.clerkUserId))
        .limit(1)
    )[0];

    let effective;
    if (personalTenant) {
      effective = await getEffectiveSetting(
        personalTenant.id,
        REMOVED_FROM_WORKSPACE,
      );
    } else {
      // No personal tenant yet — only the global policy applies.
      const [policyRow] = await db
        .select()
        .from(notificationPoliciesTable)
        .where(eq(notificationPoliciesTable.type, REMOVED_FROM_WORKSPACE))
        .limit(1);
      const policy = policyRow
        ? {
            enabled: policyRow.enabled,
            emailPolicy: policyRow.emailPolicy as EmailPolicy,
          }
        : defaultPolicy();
      effective = resolveEffective(policy, defaultPreference());
    }
    if (!effective.enabled) return;

    if (personalTenant) {
      await db.insert(notificationsTable).values({
        tenantId: personalTenant.id,
        type: REMOVED_FROM_WORKSPACE,
        platform: null,
        title,
        message,
        inApp: effective.inApp,
      });

      await sendTenantPush(personalTenant.id, REMOVED_FROM_WORKSPACE, {
        title,
        message,
      });
    }

    if (effective.email) {
      const email = await fetchVerifiedEmail(removed.clerkUserId);
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
      { err, removedClerkUserId: removed.clerkUserId },
      "Failed to notify removed member about losing workspace access",
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
 * can tune or disable it like any other catalog type. Deduped per recipient
 * AND per requesting workspace on an existing UNREAD row of this type (the
 * requesting tenant id is carried in the `platform` column as a scope key),
 * so a workspace that resubmits while its previous alert is still unread does
 * not stack an identical banner or re-email admins — instead the existing
 * unread row's title/message are updated in place so the banner always shows
 * the latest requested seat count and note — while requests from
 * OTHER workspaces still each produce a fresh alert. The dedupe re-arms when
 * the admin reads/dismisses the alert. Best-effort — never throws, so a
 * notification failure cannot fail the seat request itself.
 */
export async function notifySeatRequestSubmitted(details: {
  seatRequestId: number;
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

    // Scope key: dedupe unread alerts per requesting workspace, carried in
    // the (otherwise unused for this type) `platform` column.
    const scopeKey = `tenant:${details.requestingTenantId}`;

    const title = "New seat request awaiting review";
    const noteText = details.note ? ` Note: "${details.note}"` : "";
    const message =
      `Workspace "${details.requestingTenantName}" requested ` +
      `${details.requestedSeats} team seats.${noteText} ` +
      `Review it on the admin dashboard.`;

    for (const recipient of recipients) {
      try {
        // If this admin already has an UNREAD alert for the SAME requesting
        // workspace, a resubmit must not stack banners or re-email — but the
        // banner should reflect the LATEST request, so update the existing
        // row's title/message in place. Alerts about other workspaces are
        // unaffected.
        const existing = await db
          .select({ id: notificationsTable.id })
          .from(notificationsTable)
          .where(
            and(
              eq(notificationsTable.tenantId, recipient.id),
              eq(notificationsTable.type, SEAT_REQUEST_SUBMITTED),
              eq(notificationsTable.platform, scopeKey),
              isNull(notificationsTable.readAt),
            ),
          )
          .limit(1);
        if (existing.length > 0) {
          await db
            .update(notificationsTable)
            .set({ title, message, createdAt: new Date() })
            .where(eq(notificationsTable.id, existing[0].id));
          continue;
        }

        const effective = await getEffectiveSetting(
          recipient.id,
          SEAT_REQUEST_SUBMITTED,
        );
        if (!effective.enabled) continue;

        await db.insert(notificationsTable).values({
          tenantId: recipient.id,
          type: SEAT_REQUEST_SUBMITTED,
          platform: scopeKey,
          referenceId: details.seatRequestId,
          title,
          message,
          linkUrl: "/admin",
          inApp: effective.inApp,
        });

        await sendTenantPush(recipient.id, SEAT_REQUEST_SUBMITTED, {
          title,
          message,
          linkUrl: "/admin",
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

/**
 * Auto-dismiss stale "seat request awaiting review" admin alerts once a
 * request is decided. New notifications carry the seat request id in
 * `referenceId`, so deciding a request immediately marks exactly ITS unread
 * alerts read (across all admin recipients) — even while other workspaces'
 * requests remain pending, whose alerts stay put. Legacy rows written before
 * `referenceId` existed have a null reference; those are swept with the old
 * conservative rule: only once NOTHING is left pending. Marking rows read
 * also re-arms the per-workspace dedupe so the next request inserts a fresh
 * alert. Never throws — cleanup must not fail the admin's decision.
 */
export async function resolveSeatRequestSubmittedNotifications(
  seatRequestId?: number,
): Promise<void> {
  try {
    if (seatRequestId !== undefined) {
      await db
        .update(notificationsTable)
        .set({ readAt: new Date() })
        .where(
          and(
            eq(notificationsTable.type, SEAT_REQUEST_SUBMITTED),
            eq(notificationsTable.referenceId, seatRequestId),
            isNull(notificationsTable.readAt),
          ),
        );
    }

    // Legacy sweep for rows without a referenceId: only stale once the whole
    // pending queue is empty.
    const pending = await db
      .select({ id: seatRequestsTable.id })
      .from(seatRequestsTable)
      .where(eq(seatRequestsTable.status, "pending"))
      .limit(1);
    if (pending.length > 0) return;

    await db
      .update(notificationsTable)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notificationsTable.type, SEAT_REQUEST_SUBMITTED),
          isNull(notificationsTable.referenceId),
          isNull(notificationsTable.readAt),
        ),
      );
  } catch (err) {
    logger.error(
      { err },
      "Failed to resolve seat-request-submitted notifications",
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
  // Ad-platform sweep pseudo-keys ("<platform>-ads", see connectionSweep.ts)
  // so fail-streak alerts read as real names instead of raw keys.
  "meta-ads": "Meta Ads account",
  "google-ads": "Google Ads account",
  "linkedin-ads": "LinkedIn Ads account",
  "tiktok-ads": "TikTok Ads account",
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

    const title =
      count === 1
        ? "A publish was interrupted"
        : `${count} publishes were interrupted`;
    await db.insert(notificationsTable).values({
      tenantId,
      type: PUBLISH_INTERRUPTED,
      platform: null,
      title,
      message,
      linkUrl: "/library",
      inApp: effective.inApp,
    });

    await sendTenantPush(tenantId, PUBLISH_INTERRUPTED, {
      title,
      message,
      linkUrl: "/library",
    });
  } catch (err) {
    logger.error(
      { err, tenantId },
      "Failed to record publish-interrupted notification",
    );
  }
}

/**
 * Tell a tenant their scheduled post went out. In-app only (routine good
 * news; the effective settings for the type still apply). Never throws.
 */
export async function notifyScheduledPostPublished(
  tenantId: number,
  title: string,
  platform: string,
): Promise<void> {
  try {
    const effective = await getEffectiveSetting(
      tenantId,
      SCHEDULED_POST_PUBLISHED,
    );
    if (!effective.enabled) return;
    const message = `"${title}" was published to ${platformLabel(platform)} as scheduled.`;
    await db.insert(notificationsTable).values({
      tenantId,
      type: SCHEDULED_POST_PUBLISHED,
      platform,
      title: "Scheduled post published",
      message,
      linkUrl: "/library",
      inApp: effective.inApp,
    });

    await sendTenantPush(tenantId, SCHEDULED_POST_PUBLISHED, {
      title: "Scheduled post published",
      message,
      linkUrl: "/library",
    });
  } catch (err) {
    logger.error(
      { err, tenantId },
      "Failed to record scheduled-post-published notification",
    );
  }
}

/**
 * Tell a tenant a scheduled publish failed and needs their attention. In-app
 * plus best-effort email (per the tenant's effective settings) — the whole
 * point of scheduling is that the user is away when it runs, so a silent
 * in-app-only failure could go unseen for days. Never throws.
 */
export async function notifyScheduledPublishFailed(
  tenantId: number,
  clerkUserId: string | null,
  title: string,
  platform: string,
  reason: string,
): Promise<void> {
  try {
    const effective = await getEffectiveSetting(
      tenantId,
      SCHEDULED_PUBLISH_FAILED,
    );
    if (!effective.enabled) return;

    const message = `"${title}" could not be published to ${platformLabel(platform)} as scheduled. ${reason}`;
    await db.insert(notificationsTable).values({
      tenantId,
      type: SCHEDULED_PUBLISH_FAILED,
      platform,
      title: "Scheduled publish failed",
      message,
      linkUrl: "/library",
      inApp: effective.inApp,
    });

    await sendTenantPush(tenantId, SCHEDULED_PUBLISH_FAILED, {
      title: "Scheduled publish failed",
      message,
      linkUrl: "/library",
    });

    if (effective.email && clerkUserId) {
      try {
        const email = await fetchVerifiedEmail(clerkUserId);
        if (email) {
          await sendEmail({
            to: email,
            subject: "A scheduled post could not be published",
            text: message,
            html: `<p>${escapeHtml(message)}</p>`,
          });
        }
      } catch (err) {
        logger.error(
          { err, tenantId },
          "Failed to email scheduled-publish-failed alert",
        );
      }
    }
  } catch (err) {
    logger.error(
      { err, tenantId },
      "Failed to record scheduled-publish-failed notification",
    );
  }
}

/**
 * Alert every superadmin that the background connection sweep has stopped
 * running (its last recorded run is older than the stale threshold). This is
 * an operational alert for platform admins, NOT a tenant-facing notification.
 * It IS part of the notification catalog: each superadmin's own effective
 * settings for `sweep_stalled` decide the channels, so an admin can turn off
 * the email channel while keeping the in-app banner. Defaults keep the
 * historical behavior (in-app + best-effort email).
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

      const effective = await getEffectiveSetting(tenant.id, SWEEP_STALLED);
      if (!effective.enabled) continue;

      // Insert is race-free: a partial unique index allows at most one
      // unread sweep_stalled row per tenant, so a concurrent watchdog check
      // simply no-ops here instead of double-alerting.
      const inserted = await db
        .insert(notificationsTable)
        .values({
          tenantId: tenant.id,
          type: SWEEP_STALLED,
          platform: null,
          title: "Background safety check stalled",
          message,
          linkUrl: "/admin",
          inApp: effective.inApp,
        })
        .onConflictDoNothing()
        .returning({ id: notificationsTable.id });
      if (inserted.length === 0) continue;

      await sendTenantPush(tenant.id, SWEEP_STALLED, {
        title: "Background safety check stalled",
        message,
        linkUrl: "/admin",
      });

      // Fresh alert only (past the dedupe guard) -> best-effort email,
      // gated on this admin's own email-channel choice.
      try {
        if (effective.email) {
          const email = await fetchVerifiedEmail(tenant.clerkUserId);
          if (email) {
            await sendEmail({
              to: email,
              subject: "Background safety check stalled",
              text: message,
              html: `<p>${escapeHtml(message)}</p>`,
            });
          }
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

export const SWEEP_FAIL_STREAK = "sweep_fail_streak";

/**
 * Alert every superadmin that one tenant's connection check has now failed
 * many sweeps IN A ROW (a chronic breakage, not a one-off blip). Like
 * sweep_stalled this is an operational platform-admin alert that is part of
 * the notification catalog: each superadmin's own effective settings for
 * `sweep_fail_streak` decide the channels, so an admin can turn off the email
 * channel while keeping the in-app banner. Defaults keep the historical
 * behavior (in-app + best-effort email to the verified address).
 *
 * Deduped per recipient AND per offending tenant+platform: the streak key
 * (`streak:<tenantId>:<platform>`) is carried in the `platform` column, and a
 * new row is only inserted when there is no existing UNREAD row for the same
 * key — so the alert fires once when the streak crosses the threshold. While
 * the streak continues, the existing unread row's title/message are updated
 * in place (no new rows, no re-emails) so the banner always shows the latest
 * count and duration. The dedupe re-arms when the streak resets
 * (see resolveSweepFailStreakNotifications) or when the admin dismisses the
 * banner. Never throws.
 *
 * Returns the number of recipients whose alert could NOT be written (DB
 * error, schema drift, etc.) so the sweep can surface the failure instead of
 * reporting a clean run while a critical alert silently vanished.
 */
export async function notifySweepFailStreak(offender: {
  tenantId: number;
  platform: string;
  count: number;
  firstFailedAt: string;
  lastError: string | null;
}): Promise<number> {
  let failedDeliveries = 0;
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
    if (recipients.length === 0) return failedDeliveries;

    // Best-effort workspace name for a readable message; the id is the
    // authoritative pointer either way.
    const offenderTenant = (
      await db
        .select({ name: tenantsTable.name })
        .from(tenantsTable)
        .where(eq(tenantsTable.id, offender.tenantId))
        .limit(1)
    )[0];
    const workspace = offenderTenant?.name
      ? `Workspace "${offenderTenant.name}" (id ${offender.tenantId})`
      : `Workspace id ${offender.tenantId}`;

    const scopeKey = `streak:${offender.tenantId}:${offender.platform}`;
    const label = platformLabel(offender.platform);
    const errorText = offender.lastError
      ? ` Last error: ${offender.lastError}`
      : "";
    const title = "A connection keeps failing its safety checks";
    const message =
      `${workspace}'s ${label} check has failed ${offender.count} sweeps in a row ` +
      `(since ${offender.firstFailedAt}).${errorText} ` +
      `This looks like a chronic breakage — review it on the admin dashboard.`;

    for (const recipient of recipients) {
      try {
        const existing = await db
          .select({ id: notificationsTable.id })
          .from(notificationsTable)
          .where(
            and(
              eq(notificationsTable.tenantId, recipient.id),
              eq(notificationsTable.type, SWEEP_FAIL_STREAK),
              eq(notificationsTable.platform, scopeKey),
              isNull(notificationsTable.readAt),
            ),
          )
          .limit(1);
        if (existing.length > 0) {
          // The streak is still running — don't stack banners or re-email,
          // but refresh the unread row so the banner shows the LATEST count
          // and duration instead of the stale threshold-crossing snapshot.
          await db
            .update(notificationsTable)
            .set({ title, message, createdAt: new Date() })
            .where(eq(notificationsTable.id, existing[0].id));
          continue;
        }

        const effective = await getEffectiveSetting(
          recipient.id,
          SWEEP_FAIL_STREAK,
        );
        if (!effective.enabled) continue;

        await db.insert(notificationsTable).values({
          tenantId: recipient.id,
          type: SWEEP_FAIL_STREAK,
          platform: scopeKey,
          referenceId: offender.tenantId,
          title,
          message,
          linkUrl: "/admin",
          inApp: effective.inApp,
        });

        await sendTenantPush(recipient.id, SWEEP_FAIL_STREAK, {
          title,
          message,
          linkUrl: "/admin",
        });

        // Fresh alert only (past the dedupe guard) -> best-effort email,
        // gated on this admin's own email-channel choice.
        try {
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
            "Failed to email sweep-fail-streak alert",
          );
        }
      } catch (err) {
        failedDeliveries += 1;
        logger.error(
          { err, recipientTenantId: recipient.id },
          "Failed to notify a superadmin about a fail streak",
        );
      }
    }
  } catch (err) {
    failedDeliveries += 1;
    logger.error(
      { err, offenderTenantId: offender.tenantId, platform: offender.platform },
      "Failed to record sweep-fail-streak notifications",
    );
  }
  return failedDeliveries;
}

/**
 * Mark unread sweep_fail_streak alerts read for every streak that is NO
 * LONGER active at/above the alert threshold (the check recovered, or the
 * offending row was removed). Clearing the row both hides the banner and
 * re-arms the per-streak dedupe so a NEW streak on the same tenant+platform
 * produces a fresh alert. `activeKeys` holds the scope keys
 * (`streak:<tenantId>:<platform>`) that must stay unread. Never throws.
 */
export async function resolveSweepFailStreakNotifications(
  activeKeys: string[],
): Promise<void> {
  try {
    const active = new Set(activeKeys);
    const open = await db
      .select({
        id: notificationsTable.id,
        platform: notificationsTable.platform,
      })
      .from(notificationsTable)
      .where(
        and(
          eq(notificationsTable.type, SWEEP_FAIL_STREAK),
          isNull(notificationsTable.readAt),
        ),
      );
    const staleIds = open
      .filter((row) => !row.platform || !active.has(row.platform))
      .map((row) => row.id);
    if (staleIds.length === 0) return;

    await db
      .update(notificationsTable)
      .set({ readAt: new Date() })
      .where(inArray(notificationsTable.id, staleIds));
  } catch (err) {
    logger.error({ err }, "Failed to resolve sweep-fail-streak notifications");
  }
}

export const SWEEP_HISTORY_TRIMMED = "sweep_history_trimmed";

/**
 * Alert every superadmin that a sweep run recorded so many simultaneous
 * connection failures that the persisted fail-streak history overflowed its
 * cap and was trimmed (droppedStreaks > 0). A trim almost always means a
 * platform-wide outage, so this surfaces proactively instead of waiting for
 * an admin to open the dashboard. Like the other sweep alerts this is an
 * operational platform-admin alert in the notification catalog: each
 * superadmin's own effective settings for `sweep_history_trimmed` decide the
 * channels (defaults: in-app + best-effort email).
 *
 * Deduped per recipient on an existing UNREAD sweep_history_trimmed row —
 * while trimming continues run after run, the unread row's message is
 * refreshed in place (no stacked banners, no re-emails). The dedupe re-arms
 * once a run completes with no trimming
 * (see resolveSweepHistoryTrimmedNotifications). Never throws.
 *
 * Returns the number of recipients whose alert could NOT be written (DB
 * error, schema drift, etc.) so the sweep can surface the failure instead of
 * reporting a clean run while a critical alert silently vanished.
 */
export async function notifySweepHistoryTrimmed(
  droppedStreaks: number,
  cap: number,
): Promise<number> {
  let failedDeliveries = 0;
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
    if (recipients.length === 0) return failedDeliveries;

    const title = "Mass connection outage suspected";
    const message =
      `The latest connection safety sweep recorded more failing connections ` +
      `than the failure history can hold: ${droppedStreaks} failure ` +
      `record(s) beyond the ${cap}-entry cap were trimmed. This usually ` +
      `means a platform-wide outage is breaking many workspaces' ` +
      `connections at once. The admin dashboard's failure history is ` +
      `incomplete — review it now.`;

    for (const recipient of recipients) {
      try {
        const existing = await db
          .select({ id: notificationsTable.id })
          .from(notificationsTable)
          .where(
            and(
              eq(notificationsTable.tenantId, recipient.id),
              eq(notificationsTable.type, SWEEP_HISTORY_TRIMMED),
              isNull(notificationsTable.readAt),
            ),
          )
          .limit(1);
        if (existing.length > 0) {
          // Still overflowing — refresh the unread banner with the latest
          // dropped count instead of stacking rows or re-emailing.
          await db
            .update(notificationsTable)
            .set({ title, message, createdAt: new Date() })
            .where(eq(notificationsTable.id, existing[0].id));
          continue;
        }

        const effective = await getEffectiveSetting(
          recipient.id,
          SWEEP_HISTORY_TRIMMED,
        );
        if (!effective.enabled) continue;

        await db.insert(notificationsTable).values({
          tenantId: recipient.id,
          type: SWEEP_HISTORY_TRIMMED,
          platform: null,
          title,
          message,
          linkUrl: "/admin",
          inApp: effective.inApp,
        });

        await sendTenantPush(recipient.id, SWEEP_HISTORY_TRIMMED, {
          title,
          message,
          linkUrl: "/admin",
        });

        // Fresh alert only (past the dedupe guard) -> best-effort email,
        // gated on this admin's own email-channel choice.
        try {
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
            "Failed to email sweep-history-trimmed alert",
          );
        }
      } catch (err) {
        failedDeliveries += 1;
        logger.error(
          { err, recipientTenantId: recipient.id },
          "Failed to notify a superadmin about trimmed sweep history",
        );
      }
    }
  } catch (err) {
    failedDeliveries += 1;
    logger.error(
      { err },
      "Failed to record sweep-history-trimmed notifications",
    );
  }
  return failedDeliveries;
}

export const SWEEP_FAIL_RATIO = "sweep_fail_ratio";

/** How many individual failing connections the mass-outage message lists
 * before collapsing the rest into "+N more". */
const SWEEP_FAIL_RATIO_LIST_CAP = 8;

/**
 * Turn a sweep run's recorded failures into a human-readable suffix for the
 * mass-outage alert: a per-platform tally plus up to a handful of the
 * affected workspaces (identified by cached tenant email when available,
 * falling back to the workspace id). Best-effort — any lookup error returns
 * an empty string so the alert itself is never blocked. Note the failure
 * list is capped upstream, so it may not cover every failing check.
 */
async function describeSweepFailures(
  failures: SweepFailure[],
): Promise<string> {
  try {
    if (failures.length === 0) return "";

    const platformCounts = new Map<string, number>();
    for (const f of failures) {
      platformCounts.set(f.platform, (platformCounts.get(f.platform) ?? 0) + 1);
    }
    const platformSummary = [...platformCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([platform, count]) => `${platform} (${count})`)
      .join(", ");

    const tenantIds = [...new Set(failures.map((f) => f.tenantId))];
    const tenants = await db
      .select({ id: tenantsTable.id, email: tenantsTable.email })
      .from(tenantsTable)
      .where(inArray(tenantsTable.id, tenantIds));
    const emailById = new Map(tenants.map((t) => [t.id, t.email]));

    const listed = failures
      .slice(0, SWEEP_FAIL_RATIO_LIST_CAP)
      .map((f) => {
        const who = emailById.get(f.tenantId) || `workspace #${f.tenantId}`;
        return `${who} — ${f.platform}`;
      })
      .join("; ");
    const extra = failures.length - SWEEP_FAIL_RATIO_LIST_CAP;
    const more = extra > 0 ? `; +${extra} more` : "";

    return (
      ` Failing platforms: ${platformSummary}.` +
      ` Disconnected: ${listed}${more}.`
    );
  } catch (err) {
    logger.error({ err }, "Failed to build sweep failure breakdown");
    return "";
  }
}

/**
 * Alert every superadmin that a completed sweep run's failure ratio
 * (errorCount / accountsChecked) crossed the mass-outage threshold. Unlike
 * sweep_history_trimmed this catches platform-wide outages of ANY size —
 * e.g. 50 of 60 checks failing on a modest install never overflows the
 * fail-streak cap, yet is clearly a mass outage. Like the other sweep alerts
 * this is an operational platform-admin alert in the notification catalog:
 * each superadmin's own effective settings for `sweep_fail_ratio` decide the
 * channels (defaults: in-app + best-effort email).
 *
 * Deduped per recipient on an existing UNREAD sweep_fail_ratio row — while
 * the outage continues run after run, the unread row's message is refreshed
 * in place (no stacked banners, no re-emails). The dedupe re-arms once a run
 * completes below the threshold (see resolveSweepFailRatioNotifications).
 * Never throws.
 *
 * Returns the number of recipients whose alert could NOT be written (DB
 * error, schema drift, etc.) so the sweep can surface the failure instead of
 * reporting a clean run while a critical alert silently vanished.
 */
export async function notifySweepFailRatio(
  errorCount: number,
  accountsChecked: number,
  thresholdPercent: number,
  failures: SweepFailure[] = [],
): Promise<number> {
  let failedDeliveries = 0;
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
    if (recipients.length === 0) return failedDeliveries;

    const percent =
      accountsChecked > 0
        ? Math.round((errorCount / accountsChecked) * 100)
        : 0;
    const title = "Mass connection outage suspected";
    const message =
      `The latest connection safety sweep saw ${errorCount} of ` +
      `${accountsChecked} connection checks fail (${percent}%), above the ` +
      `${thresholdPercent}% mass-outage threshold. This usually means a ` +
      `platform-wide outage is breaking many workspaces' connections at ` +
      `once — review the admin dashboard now.` +
      (await describeSweepFailures(failures));

    for (const recipient of recipients) {
      try {
        const existing = await db
          .select({ id: notificationsTable.id })
          .from(notificationsTable)
          .where(
            and(
              eq(notificationsTable.tenantId, recipient.id),
              eq(notificationsTable.type, SWEEP_FAIL_RATIO),
              isNull(notificationsTable.readAt),
            ),
          )
          .limit(1);
        if (existing.length > 0) {
          // Outage continues — refresh the unread banner with the latest
          // counts instead of stacking rows or re-emailing.
          await db
            .update(notificationsTable)
            .set({ title, message, createdAt: new Date() })
            .where(eq(notificationsTable.id, existing[0].id));
          continue;
        }

        const effective = await getEffectiveSetting(
          recipient.id,
          SWEEP_FAIL_RATIO,
        );
        if (!effective.enabled) continue;

        await db.insert(notificationsTable).values({
          tenantId: recipient.id,
          type: SWEEP_FAIL_RATIO,
          platform: null,
          title,
          message,
          linkUrl: "/admin",
          inApp: effective.inApp,
        });

        await sendTenantPush(recipient.id, SWEEP_FAIL_RATIO, {
          title,
          message,
          linkUrl: "/admin",
        });

        // Fresh alert only (past the dedupe guard) -> best-effort email,
        // gated on this admin's own email-channel choice.
        try {
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
            "Failed to email sweep-fail-ratio alert",
          );
        }
      } catch (err) {
        failedDeliveries += 1;
        logger.error(
          { err, recipientTenantId: recipient.id },
          "Failed to notify a superadmin about a sweep failure-ratio outage",
        );
      }
    }
  } catch (err) {
    failedDeliveries += 1;
    logger.error({ err }, "Failed to record sweep-fail-ratio notifications");
  }
  return failedDeliveries;
}

/**
 * Mark every unread sweep_fail_ratio notification read once a sweep run
 * completes below the failure-ratio threshold. This both clears the banner
 * and re-arms the dedupe so a future mass outage produces a fresh alert.
 * Never throws.
 */
export async function resolveSweepFailRatioNotifications(): Promise<void> {
  try {
    await db
      .update(notificationsTable)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notificationsTable.type, SWEEP_FAIL_RATIO),
          isNull(notificationsTable.readAt),
        ),
      );
  } catch (err) {
    logger.error({ err }, "Failed to resolve sweep-fail-ratio notifications");
  }
}

/**
 * Mark every unread sweep_history_trimmed notification read once a sweep run
 * completes with no trimming. This both clears the banner and re-arms the
 * dedupe so a future overflow produces a fresh alert. Never throws.
 */
export async function resolveSweepHistoryTrimmedNotifications(): Promise<void> {
  try {
    await db
      .update(notificationsTable)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notificationsTable.type, SWEEP_HISTORY_TRIMMED),
          isNull(notificationsTable.readAt),
        ),
      );
  } catch (err) {
    logger.error(
      { err },
      "Failed to resolve sweep-history-trimmed notifications",
    );
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

    await sendTenantPush(tenantId, SOCIAL_CONNECTION_FAILED, {
      title: `${label} disconnected`,
      message: resolvedMessage,
      linkUrl: "/accounts",
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

/**
 * Labels for paid-media (ads) platform values, distinct from the organic
 * social PLATFORM_LABELS above.
 */
const AD_PLATFORM_LABELS: Record<string, string> = {
  meta: "Meta ad account",
  tiktok: "TikTok ad account",
  linkedin: "LinkedIn ad account",
  google: "Google ad account",
};

function adPlatformLabel(platform: string): string {
  return AD_PLATFORM_LABELS[platform] ?? `${platform} ad account`;
}

/**
 * Proactive alert that a tenant's ad account connection is no longer valid
 * (token expired/revoked or the advertiser grant was removed), so the owner
 * can reconnect from the Ads page BEFORE a scheduled/approved change fails.
 * Deduped: while an unread alert for the same platform exists, re-checks that
 * are still broken stay silent. Never throws.
 */
export async function notifyAdsConnectionFailed(
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
          eq(notificationsTable.type, ADS_CONNECTION_FAILED),
          eq(notificationsTable.platform, platform),
          isNull(notificationsTable.readAt),
        ),
      )
      .limit(1);
    if (existing.length > 0) return;

    const effective = await getEffectiveSetting(tenantId, ADS_CONNECTION_FAILED);
    if (!effective.enabled) return;

    const label = adPlatformLabel(platform);
    const resolvedMessage =
      message ??
      `Your ${label} connection is no longer valid. Reconnect it before your next ad change.`;

    // Always record the row (dedupe + audit); `inApp` controls banner
    // visibility so an email-only tenant still gets deduped correctly.
    await db.insert(notificationsTable).values({
      tenantId,
      type: ADS_CONNECTION_FAILED,
      platform,
      title: `${label} disconnected`,
      message: resolvedMessage,
      linkUrl: "/ads",
      inApp: effective.inApp,
    });

    await sendTenantPush(tenantId, ADS_CONNECTION_FAILED, {
      title: `${label} disconnected`,
      message: resolvedMessage,
      linkUrl: "/ads",
    });

    if (effective.email) {
      const owner = await db
        .select({ clerkUserId: tenantsTable.clerkUserId })
        .from(tenantsTable)
        .where(eq(tenantsTable.id, tenantId))
        .limit(1);
      const ownerClerkUserId = owner[0]?.clerkUserId ?? null;
      if (ownerClerkUserId) {
        try {
          const email = await fetchVerifiedEmail(ownerClerkUserId);
          if (email) {
            await sendEmail({
              to: email,
              subject: `${label} disconnected - reconnect needed`,
              text: resolvedMessage,
              html: `<p>${escapeHtml(resolvedMessage)}</p>`,
            });
          }
        } catch (err) {
          logger.error(
            { err, tenantId, platform },
            "Failed to email ads connection breakage",
          );
        }
      }
    }
  } catch (err) {
    logger.error(
      { err, tenantId, platform },
      "Failed to record ads connection notification",
    );
  }
}

/**
 * Auto-dismiss any unread "ad account disconnected" notification for a
 * platform the moment its connection verifies again, re-arming the dedupe
 * for a future breakage. Never throws.
 */
export async function resolveAdsConnectionNotifications(
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
          eq(notificationsTable.type, ADS_CONNECTION_FAILED),
          eq(notificationsTable.platform, platform),
          isNull(notificationsTable.readAt),
        ),
      );
  } catch (err) {
    logger.error(
      { err, tenantId, platform },
      "Failed to resolve ads connection notifications",
    );
  }
}

/**
 * Tell the workspace owner a teammate drafted an ads change that needs their
 * approval. In-app plus best-effort email per effective settings — approval
 * is a blocking step, so the owner should hear about it. Never throws.
 */
export async function notifyAdsDraftPending(
  tenantId: number,
  ownerClerkUserId: string | null,
  targetName: string,
  platform: string,
): Promise<void> {
  try {
    const effective = await getEffectiveSetting(tenantId, ADS_DRAFT_PENDING);
    if (!effective.enabled) return;
    const message = `An advertising change to "${targetName}" on ${platformLabel(platform)} is waiting for the workspace owner's approval.`;
    await db.insert(notificationsTable).values({
      tenantId,
      type: ADS_DRAFT_PENDING,
      platform,
      title: "Ad change awaiting approval",
      message,
      linkUrl: "/ads",
      inApp: effective.inApp,
    });

    await sendTenantPush(tenantId, ADS_DRAFT_PENDING, {
      title: "Ad change awaiting approval",
      message,
      linkUrl: "/ads",
    });
    if (effective.email && ownerClerkUserId) {
      try {
        const email = await fetchVerifiedEmail(ownerClerkUserId);
        if (email) {
          await sendEmail({
            to: email,
            subject: "An ad change is waiting for your approval",
            text: message,
            html: `<p>${escapeHtml(message)}</p>`,
          });
        }
      } catch (err) {
        logger.error({ err, tenantId }, "Failed to email ads-draft-pending alert");
      }
    }
  } catch (err) {
    logger.error({ err, tenantId }, "Failed to record ads-draft-pending notification");
  }
}

/**
 * Tell a tenant an approved ads change was applied. In-app only (routine
 * good news; effective settings still apply). Never throws.
 */
export async function notifyAdsChangeApplied(
  tenantId: number,
  targetName: string,
  platform: string,
): Promise<void> {
  try {
    const effective = await getEffectiveSetting(tenantId, ADS_CHANGE_APPLIED);
    if (!effective.enabled) return;
    const message = `The approved advertising change to "${targetName}" was applied on ${platformLabel(platform)}.`;
    await db.insert(notificationsTable).values({
      tenantId,
      type: ADS_CHANGE_APPLIED,
      platform,
      title: "Ad change applied",
      message,
      linkUrl: "/ads",
      inApp: effective.inApp,
    });

    await sendTenantPush(tenantId, ADS_CHANGE_APPLIED, {
      title: "Ad change applied",
      message,
      linkUrl: "/ads",
    });
  } catch (err) {
    logger.error({ err, tenantId }, "Failed to record ads-change-applied notification");
  }
}

/**
 * Tell a tenant an approved ads change could NOT be applied. In-app plus
 * best-effort email per effective settings. Never throws.
 */
export async function notifyAdsChangeFailed(
  tenantId: number,
  targetName: string,
  platform: string,
  reason: string,
): Promise<void> {
  try {
    const effective = await getEffectiveSetting(tenantId, ADS_CHANGE_FAILED);
    if (!effective.enabled) return;
    const message = `The approved advertising change to "${targetName}" could not be applied on ${platformLabel(platform)}. ${reason}`;
    await db.insert(notificationsTable).values({
      tenantId,
      type: ADS_CHANGE_FAILED,
      platform,
      title: "Ad change failed",
      message,
      linkUrl: "/ads",
      inApp: effective.inApp,
    });

    await sendTenantPush(tenantId, ADS_CHANGE_FAILED, {
      title: "Ad change failed",
      message,
      linkUrl: "/ads",
    });
    const owner = await db
      .select({ clerkUserId: tenantsTable.clerkUserId })
      .from(tenantsTable)
      .where(eq(tenantsTable.id, tenantId))
      .limit(1);
    const ownerClerkUserId = owner[0]?.clerkUserId ?? null;
    if (effective.email && ownerClerkUserId) {
      try {
        const email = await fetchVerifiedEmail(ownerClerkUserId);
        if (email) {
          await sendEmail({
            to: email,
            subject: "An approved ad change could not be applied",
            text: message,
            html: `<p>${escapeHtml(message)}</p>`,
          });
        }
      } catch (err) {
        logger.error({ err, tenantId }, "Failed to email ads-change-failed alert");
      }
    }
  } catch (err) {
    logger.error({ err, tenantId }, "Failed to record ads-change-failed notification");
  }
}
