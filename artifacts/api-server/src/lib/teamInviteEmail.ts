import { db, appBrandSettingsTable, teamInvitesTable, tenantsTable } from "@workspace/db";
import { and, eq, sql, inArray } from "drizzle-orm";
import { sendEmail } from "./email";
import { logger } from "./logger";
import { fetchVerifiedEmails } from "./clerkUser";

/**
 * Team invite email + pending-invite hint.
 *
 * Invites are accepted ONLY when the invitee signs in with the exact VERIFIED
 * email that was invited (matched in requireTenant). This module closes the
 * "signed in with a different email and silently got an empty workspace" gap
 * from two sides:
 *  - `sendTeamInviteEmail` emails the invitee a sign-in link plus the exact
 *    address they must use (best-effort; no-op when SendGrid isn't connected).
 *  - `getPendingInviteHint` lets /me tell an already-signed-in workspace owner
 *    that one of their verified emails has a pending invite elsewhere.
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Absolute sign-in URL from the app's public domain; relative fallback. */
function signInUrl(): string {
  const domain = (process.env.REPLIT_DOMAINS ?? "")
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean)[0];
  return domain ? `https://${domain}/` : "/";
}

/** White-label app name, falling back to the bundled default. */
async function getAppName(): Promise<string> {
  try {
    const [row] = await db
      .select({ appName: appBrandSettingsTable.appName })
      .from(appBrandSettingsTable)
      .where(eq(appBrandSettingsTable.id, 1))
      .limit(1);
    return row?.appName?.trim() || "KOKAO";
  } catch {
    return "KOKAO";
  }
}

/**
 * Best-effort invite email. Emphasizes the EXACT address the invitee must
 * sign in with, since invite acceptance is matched on the verified sign-in
 * email. Never throws; returns whether the email was actually sent.
 */
export async function sendTeamInviteEmail(params: {
  to: string;
  workspaceName: string;
}): Promise<boolean> {
  try {
    const appName = await getAppName();
    const link = signInUrl();
    const subject = `You're invited to join ${params.workspaceName} on ${appName}`;
    const text =
      `You've been invited to join the workspace "${params.workspaceName}" on ${appName}.\n\n` +
      `Sign in here: ${link}\n\n` +
      `Important: sign in with exactly this email address: ${params.to}\n` +
      `The invite is matched to that address. If you sign in with a different ` +
      `email (for example a Google account under another address), you won't ` +
      `join the team.`;
    const html =
      `<p>You've been invited to join the workspace <strong>${escapeHtml(params.workspaceName)}</strong> on ${escapeHtml(appName)}.</p>` +
      `<p><a href="${escapeHtml(link)}">Sign in to accept the invite</a></p>` +
      `<p><strong>Important:</strong> sign in with exactly this email address: <strong>${escapeHtml(params.to)}</strong>.<br/>` +
      `The invite is matched to that address. If you sign in with a different email (for example a Google account under another address), you won't join the team.</p>`;
    return await sendEmail({ to: params.to, subject, text, html });
  } catch (err) {
    logger.error({ err, to: params.to }, "Failed to send team invite email");
    return false;
  }
}

export interface PendingInviteHint {
  email: string;
  workspaceName: string;
}

// Small TTL cache so the /me hot path doesn't hit the Clerk API on every
// request. A hint appearing/disappearing up to a minute late is fine.
const HINT_CACHE_TTL_MS = 60_000;
const hintCache = new Map<
  string,
  { at: number; value: PendingInviteHint | null }
>();

/** Test-only: clear the hint cache. */
export function clearPendingInviteHintCache(): void {
  hintCache.clear();
}

/**
 * Whether any of the signed-in user's VERIFIED emails has a pending team
 * invite to a workspace other than their own. Used by /me so the UI can tell
 * the user their invite is waiting under a different sign-in address.
 * Best-effort: returns null on any failure and caches results briefly.
 */
export async function getPendingInviteHint(
  clerkUserId: string,
  ownTenantId: number,
): Promise<PendingInviteHint | null> {
  const cached = hintCache.get(clerkUserId);
  if (cached && Date.now() - cached.at < HINT_CACHE_TTL_MS) {
    return cached.value;
  }
  let value: PendingInviteHint | null = null;
  try {
    const emails = (await fetchVerifiedEmails(clerkUserId)).map((e) =>
      e.toLowerCase(),
    );
    if (emails.length > 0) {
      const invite = (
        await db
          .select({
            email: teamInvitesTable.email,
            tenantId: teamInvitesTable.tenantId,
          })
          .from(teamInvitesTable)
          .where(
            and(
              inArray(sql`lower(${teamInvitesTable.email})`, emails),
              eq(teamInvitesTable.status, "pending"),
            ),
          )
          .orderBy(teamInvitesTable.createdAt)
          .limit(5)
      ).find((i) => i.tenantId !== ownTenantId);
      if (invite) {
        const [workspace] = await db
          .select({ name: tenantsTable.name })
          .from(tenantsTable)
          .where(eq(tenantsTable.id, invite.tenantId))
          .limit(1);
        if (workspace) {
          value = { email: invite.email, workspaceName: workspace.name };
        }
      }
    }
  } catch (err) {
    logger.error({ err, clerkUserId }, "Failed to compute pending invite hint");
    value = null;
  }
  hintCache.set(clerkUserId, { at: Date.now(), value });
  return value;
}
