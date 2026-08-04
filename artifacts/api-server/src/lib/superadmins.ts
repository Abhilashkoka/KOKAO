/**
 * Cross-tenant superadmin allowlist.
 *
 * Superadmin status is determined by the authenticated user's verified email
 * address, NOT by a per-tenant column. This keeps the designation stable even
 * if a tenant row is recreated, and avoids granting elevated access by editing
 * tenant data.
 *
 * Emails come exclusively from the SUPERADMIN_EMAILS env var (comma-separated),
 * so the privileged accounts are deployment configuration — ownership can change
 * without a code change, and a source/export leak never names the admin.
 */
function normalize(email: string): string {
  return email.trim().toLowerCase();
}

const allowlist: Set<string> = new Set(
  (process.env.SUPERADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean)
    .map(normalize),
);

export function isSuperadminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return allowlist.has(normalize(email));
}

/**
 * Whether at least one OTHER allowlisted superadmin exists besides the given
 * email. Used by four-eyes checks (e.g. prompt version self-approval): when the
 * platform genuinely has a second admin, an author should not approve their
 * own change. Granted-in-app superadmins are checked separately by callers.
 */
export function otherAllowlistedSuperadminExists(
  email: string | null | undefined,
): boolean {
  const self = email ? normalize(email) : null;
  for (const e of allowlist) {
    if (e !== self) return true;
  }
  return false;
}
