import {
  db,
  tenantsTable,
  connectedAccountsTable,
  contentItemsTable,
  appCredentialsTable,
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

export async function deleteTenant(tenantId: number): Promise<void> {
  await db
    .delete(connectedAccountsTable)
    .where(eq(connectedAccountsTable.tenantId, tenantId));
  await db
    .delete(contentItemsTable)
    .where(eq(contentItemsTable.tenantId, tenantId));
  await db.delete(tenantsTable).where(eq(tenantsTable.id, tenantId));
}

export async function insertConnectedAccount(
  tenantId: number,
  platform: string,
  creds: unknown,
  verifyStatus: string,
): Promise<void> {
  await db.insert(connectedAccountsTable).values({
    tenantId,
    platform,
    accountName: "Test Account",
    status: verifyStatus === "verified" ? "connected" : "error",
    encryptedCredentials: encryptJson(creds),
    verifyStatus,
    verifiedAt: new Date(),
    verifyError: verifyStatus === "verified" ? null : "verification failed",
  });
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
  opts: { imagePath?: string | null } = {},
): Promise<number> {
  const [row] = await db
    .insert(contentItemsTable)
    .values({
      tenantId,
      title: "Test post",
      caption: "hello world",
      imagePath: opts.imagePath ?? null,
    })
    .returning();
  return row.id;
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
