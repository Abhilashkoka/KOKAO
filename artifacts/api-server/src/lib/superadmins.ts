/**
 * Cross-tenant superadmin allowlist.
 *
 * Superadmin status is determined by the authenticated user's verified email
 * address, NOT by a per-tenant column. This keeps the designation stable even
 * if a tenant row is recreated, and avoids granting elevated access by editing
 * tenant data.
 *
 * Emails may also be supplied via the SUPERADMIN_EMAILS env var (comma-separated)
 * and are merged with the built-in list below.
 */
const BUILT_IN_SUPERADMIN_EMAILS = ["abhilash.koka1@gmail.com"];

function normalize(email: string): string {
  return email.trim().toLowerCase();
}

const allowlist: Set<string> = new Set(
  [
    ...BUILT_IN_SUPERADMIN_EMAILS,
    ...(process.env.SUPERADMIN_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim())
      .filter(Boolean),
  ].map(normalize),
);

export function isSuperadminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return allowlist.has(normalize(email));
}
