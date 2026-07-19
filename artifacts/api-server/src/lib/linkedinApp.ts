import { db, appCredentialsTable, type LinkedinAppCredentials } from "@workspace/db";
import { eq } from "drizzle-orm";
import { decryptJson } from "./secretCrypto";

/**
 * App-level LinkedIn OAuth credentials, shared by organic publishing and the
 * ads module. The superadmin-managed database row (saved from the admin page,
 * encrypted at rest) wins; the LINKEDIN_CLIENT_ID/LINKEDIN_CLIENT_SECRET env
 * vars remain a fallback for env-based setups. Returns null when neither
 * source is usable.
 */
export async function getLinkedinAppCredentials(): Promise<{
  clientId: string;
  clientSecret: string;
} | null> {
  try {
    const row = (
      await db
        .select()
        .from(appCredentialsTable)
        .where(eq(appCredentialsTable.provider, "linkedin"))
        .limit(1)
    )[0];
    if (row) {
      const creds = decryptJson<LinkedinAppCredentials>(row.encryptedCredentials);
      if (creds.clientId && creds.clientSecret) return creds;
    }
  } catch {
    // Fall through to the env fallback on read/decrypt failure.
  }
  const clientId = process.env.LINKEDIN_CLIENT_ID;
  const clientSecret = process.env.LINKEDIN_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export async function isLinkedinAppConfigured(): Promise<boolean> {
  return !!(await getLinkedinAppCredentials()) && !!process.env.SESSION_SECRET;
}

export const LINKEDIN_AUTH_BASE = "https://www.linkedin.com/oauth/v2/authorization";
export const LINKEDIN_TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
