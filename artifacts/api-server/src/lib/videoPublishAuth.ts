import { db, connectedAccountsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { decryptJson } from "./secretCrypto";
import { getTenantCredentials, getMetaAppCredentials, GRAPH_BASE, type FacebookCredentials, type InstagramCredentials } from "./metaApi";
import { ensureFreshYoutubeAccessToken, getYoutubeAppCredentials } from "./socialReverify";
import { platformFetch } from "./platformFetch";

export async function videoPublishAuth(tenantId: number, platform: string): Promise<{ token: string; accountId: string }> {
  if (platform === "youtube") {
    const app = await getYoutubeAppCredentials();
    if (!app) throw new Error("Ask an administrator to configure Google OAuth and enable the YouTube Data API.");
    const [account] = await db.select().from(connectedAccountsTable).where(and(eq(connectedAccountsTable.tenantId, tenantId), eq(connectedAccountsTable.platform, "youtube"))).limit(1);
    if (!account?.encryptedCredentials || account.verifyStatus === "failed" || account.status !== "connected") throw new Error("Reconnect YouTube on Accounts before uploading.");
    const stored = decryptJson<{ scopes?: string[] }>(account.encryptedCredentials);
    if (!stored.scopes?.includes("https://www.googleapis.com/auth/youtube.upload")) throw new Error("Reconnect YouTube and grant video upload permission. This connection has read-only or unverified permissions.");
    const fresh = await ensureFreshYoutubeAccessToken(account, app);
    if (!fresh.ok || !account.providerUserId) throw new Error("YouTube authorization expired or was revoked. Reconnect on Accounts.");
    return { token: fresh.accessToken, accountId: account.providerUserId };
  }
  if (platform !== "facebook" && platform !== "instagram") throw new Error("This destination does not support native video publishing.");
  const fb = await getTenantCredentials<FacebookCredentials>(tenantId, "facebook");
  const app = await getMetaAppCredentials();
  if (!app) throw new Error("Ask an administrator to configure the Meta app and obtain publishing permission approval.");
  if (!fb?.verified) throw new Error("Connect and verify your Facebook Page on Accounts before publishing video.");
  const response = await platformFetch(`${GRAPH_BASE}/debug_token`, {
    method: "POST", body: new URLSearchParams({ input_token: fb.creds.pageAccessToken, method: "get" }),
    headers: { Authorization: `Bearer ${app.appId}|${app.appSecret}` },
  });
  const result = await response.json() as { data?: { is_valid?: boolean; scopes?: string[]; app_id?: string } };
  const required = platform === "instagram" ? ["instagram_basic", "instagram_content_publish", "pages_read_engagement"] : ["pages_manage_posts", "pages_read_engagement", "pages_show_list"];
  if (!response.ok || !result.data?.is_valid || result.data.app_id !== app.appId || !required.every(scope => result.data?.scopes?.includes(scope))) {
    throw new Error(`Publishing authorization could not be verified. Reconnect with ${required.join(", ")} granted under the configured Meta app; app review may be required.`);
  }
  if (platform === "instagram") {
    const ig = await getTenantCredentials<InstagramCredentials>(tenantId, "instagram");
    if (!ig?.verified) throw new Error("Connect and verify an Instagram professional account on Accounts.");
    return { token: fb.creds.pageAccessToken, accountId: ig.creds.igUserId };
  }
  return { token: fb.creds.pageAccessToken, accountId: fb.creds.pageId };
}