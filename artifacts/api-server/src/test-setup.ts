// The superadmin allowlist (lib/superadmins.ts) is built from SUPERADMIN_EMAILS
// at module-load time. Ensure a deterministic owner is present for tests before
// any app module imports the allowlist.
const OWNER = "abhilash.koka1@gmail.com";
const existing = process.env.SUPERADMIN_EMAILS ?? "";
process.env.SUPERADMIN_EMAILS = existing ? `${existing},${OWNER}` : OWNER;
