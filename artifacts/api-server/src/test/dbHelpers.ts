import {
  db,
  tenantsTable,
  connectedAccountsTable,
  contentItemsTable,
  appCredentialsTable,
  notificationsTable,
  type AppCredential,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import { encryptJson } from "../lib/secretCrypto";

export interface TestTenant {
  tenantId: number;
  clerkUserId: string;
  email: string | null;
}

export async function createTenant(
  opts: { isSuperadmin?: boolean; email?: string | null } = {},
): Promise<TestTenant> {
  const clerkUserId = `test_${randomUUID()}`;
  const email = opts.email ?? null;
  const [row] = await db
    .insert(tenantsTable)
    .values({
      clerkUserId,
      email,
      name: "Test Workspace",
      isSuperadmin: opts.isSuperadmin ?? false,
    })
    .returning();
  return { tenantId: row.id, clerkUserId, email };
}

export async function getTenant(tenantId: number) {
  return (
    await db
      .select()
      .from(tenantsTable)
      .where(eq(tenantsTable.id, tenantId))
      .limit(1)
  )[0];
}

export async function deleteTenant(tenantId: number): Promise<void> {
  await db
    .delete(connectedAccountsTable)
    .where(eq(connectedAccountsTable.tenantId, tenantId));
  await db
    .delete(contentItemsTable)
    .where(eq(contentItemsTable.tenantId, tenantId));
  await db
    .delete(notificationsTable)
    .where(eq(notificationsTable.tenantId, tenantId));
  await db.delete(tenantsTable).where(eq(tenantsTable.id, tenantId));
}

export async function getNotifications(tenantId: number) {
  return db
    .select()
    .from(notificationsTable)
    .where(eq(notificationsTable.tenantId, tenantId));
}

export async function insertConnectedAccount(
  tenantId: number,
  platform: string,
  creds: unknown,
  verifyStatus: string,
  accountName = "Test Account",
): Promise<void> {
  await db.insert(connectedAccountsTable).values({
    tenantId,
    platform,
    accountName,
    status: verifyStatus === "verified" ? "connected" : "error",
    encryptedCredentials: encryptJson(creds),
    verifyStatus,
    verifiedAt: new Date(),
    verifyError: verifyStatus === "verified" ? null : "verification failed",
  });
}

export async function insertLinkedinAccount(
  tenantId: number,
  opts: {
    accessToken?: string | null;
    providerUserId?: string | null;
    tokenExpiresAt?: Date | null;
    status?: string;
    accountName?: string;
    verifyStatus?: string | null;
    verifyError?: string | null;
    verifiedAt?: Date | null;
  } = {},
): Promise<void> {
  await db.insert(connectedAccountsTable).values({
    tenantId,
    platform: "linkedin",
    accountName: opts.accountName ?? "LinkedIn User",
    status: opts.status ?? "connected",
    accessToken:
      opts.accessToken === undefined ? "li_tok_secret" : opts.accessToken,
    providerUserId:
      opts.providerUserId === undefined ? "li_person_123" : opts.providerUserId,
    tokenExpiresAt: opts.tokenExpiresAt ?? null,
    verifyStatus: opts.verifyStatus ?? "verified",
    verifyError: opts.verifyError ?? null,
    verifiedAt: opts.verifiedAt ?? new Date(),
  });
}

/**
 * Adjust the stored check-state fields on an existing connected account row.
 * Used by re-verification tests to simulate a stale check clock, a prior
 * failed/verified state, or a stored OAuth token/expiry.
 */
export async function setAccountState(
  tenantId: number,
  platform: string,
  values: Partial<{
    verifiedAt: Date | null;
    verifyStatus: string | null;
    verifyError: string | null;
    status: string;
    accessToken: string | null;
    tokenExpiresAt: Date | null;
    providerUserId: string | null;
    accountName: string;
  }>,
): Promise<void> {
  await db
    .update(connectedAccountsTable)
    .set(values)
    .where(
      and(
        eq(connectedAccountsTable.tenantId, tenantId),
        eq(connectedAccountsTable.platform, platform),
      ),
    );
}

export async function getConnectedAccount(tenantId: number, platform: string) {
  return (
    await db
      .select()
      .from(connectedAccountsTable)
      .where(
        and(
          eq(connectedAccountsTable.tenantId, tenantId),
          eq(connectedAccountsTable.platform, platform),
        ),
      )
      .limit(1)
  )[0];
}

export async function insertContentItem(
  tenantId: number,
  opts: { imagePath?: string | null; caption?: string } = {},
): Promise<number> {
  const [row] = await db
    .insert(contentItemsTable)
    .values({
      tenantId,
      title: "Test post",
      caption: opts.caption ?? "hello world",
      imagePath: opts.imagePath ?? null,
    })
    .returning();
  return row.id;
}

export async function getContentItem(id: number, tenantId: number) {
  return (
    await db
      .select()
      .from(contentItemsTable)
      .where(
        and(
          eq(contentItemsTable.id, id),
          eq(contentItemsTable.tenantId, tenantId),
        ),
      )
      .limit(1)
  )[0];
}

// ---------------------------------------------------------------------------
// App-level Meta credential row (global, unique on provider="meta"). Snapshot
// and restore it so tests never destroy real dev configuration.
// ---------------------------------------------------------------------------

export async function snapshotMetaRow(): Promise<AppCredential | null> {
  const row = (
    await db
      .select()
      .from(appCredentialsTable)
      .where(eq(appCredentialsTable.provider, "meta"))
      .limit(1)
  )[0];
  return row ?? null;
}

export async function setMetaRow(
  appId: string,
  appSecret: string,
  status = "verified",
): Promise<void> {
  await db
    .delete(appCredentialsTable)
    .where(eq(appCredentialsTable.provider, "meta"));
  await db.insert(appCredentialsTable).values({
    provider: "meta",
    encryptedCredentials: encryptJson({ appId, appSecret }),
    lastTestStatus: status,
    lastTestedAt: new Date(),
    lastTestError: null,
  });
}

export async function setVerifiedMetaRow(): Promise<void> {
  await setMetaRow("app-id-default", "app-secret-default", "verified");
}

export async function restoreMetaRow(
  snapshot: AppCredential | null,
): Promise<void> {
  await db
    .delete(appCredentialsTable)
    .where(eq(appCredentialsTable.provider, "meta"));
  if (snapshot) {
    await db.insert(appCredentialsTable).values({
      provider: "meta",
      encryptedCredentials: snapshot.encryptedCredentials,
      lastTestStatus: snapshot.lastTestStatus,
      lastTestedAt: snapshot.lastTestedAt,
      lastTestError: snapshot.lastTestError,
    });
  }
}

// ---------------------------------------------------------------------------
// App-level X (Twitter) credential row (global, unique on provider="twitter").
// Snapshot/restore so tests never destroy real dev configuration.
// ---------------------------------------------------------------------------

export async function snapshotTwitterRow(): Promise<AppCredential | null> {
  const row = (
    await db
      .select()
      .from(appCredentialsTable)
      .where(eq(appCredentialsTable.provider, "twitter"))
      .limit(1)
  )[0];
  return row ?? null;
}

export async function setTwitterRow(
  apiKey: string,
  apiSecret: string,
  status = "verified",
): Promise<void> {
  await db
    .delete(appCredentialsTable)
    .where(eq(appCredentialsTable.provider, "twitter"));
  await db.insert(appCredentialsTable).values({
    provider: "twitter",
    encryptedCredentials: encryptJson({ apiKey, apiSecret }),
    lastTestStatus: status,
    lastTestedAt: new Date(),
    lastTestError: null,
  });
}

export async function setVerifiedTwitterRow(): Promise<void> {
  await setTwitterRow("x-api-key-default", "x-api-secret-default", "verified");
}

export async function clearTwitterRow(): Promise<void> {
  await db
    .delete(appCredentialsTable)
    .where(eq(appCredentialsTable.provider, "twitter"));
}

export async function restoreTwitterRow(
  snapshot: AppCredential | null,
): Promise<void> {
  await db
    .delete(appCredentialsTable)
    .where(eq(appCredentialsTable.provider, "twitter"));
  if (snapshot) {
    await db.insert(appCredentialsTable).values({
      provider: "twitter",
      encryptedCredentials: snapshot.encryptedCredentials,
      lastTestStatus: snapshot.lastTestStatus,
      lastTestedAt: snapshot.lastTestedAt,
      lastTestError: snapshot.lastTestError,
    });
  }
}
