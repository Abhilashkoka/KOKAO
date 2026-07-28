import {
  db,
  tenantsTable,
  appBrandSettingsTable,
  type AppBrandSettings,
  connectedAccountsTable,
  adAccountConnectionsTable,
  contentItemsTable,
  appCredentialsTable,
  notificationsTable,
  notificationPreferencesTable,
  notificationPoliciesTable,
  adminAuditLogsTable,
  emailSettingsTable,
  planSettingsTable,
  type AppCredential,
  type CarouselSlide,
  type NotificationPolicy,
  type EmailSettings,
} from "@workspace/db";
import type { EmailPolicy } from "../lib/notificationCatalog";
import { and, eq, gte, or } from "drizzle-orm";
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

export async function setTenantSuperadmin(
  tenantId: number,
  isSuperadmin: boolean,
): Promise<void> {
  await db
    .update(tenantsTable)
    .set({ isSuperadmin })
    .where(eq(tenantsTable.id, tenantId));
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
    .delete(adAccountConnectionsTable)
    .where(eq(adAccountConnectionsTable.tenantId, tenantId));
  await db
    .delete(contentItemsTable)
    .where(eq(contentItemsTable.tenantId, tenantId));
  await db
    .delete(notificationsTable)
    .where(eq(notificationsTable.tenantId, tenantId));
  await db
    .delete(notificationPreferencesTable)
    .where(eq(notificationPreferencesTable.tenantId, tenantId));
  await db
    .delete(adminAuditLogsTable)
    .where(
      or(
        eq(adminAuditLogsTable.actorTenantId, tenantId),
        eq(adminAuditLogsTable.targetTenantId, tenantId),
      ),
    );
  await db.delete(tenantsTable).where(eq(tenantsTable.id, tenantId));
}

export async function getAuditLogsForTarget(targetTenantId: number) {
  return db
    .select()
    .from(adminAuditLogsTable)
    .where(eq(adminAuditLogsTable.targetTenantId, targetTenantId));
}

/** Audit rows written BY an actor (platform-wide actions have no target). */
export async function getAuditLogsForActor(actorTenantId: number) {
  return db
    .select()
    .from(adminAuditLogsTable)
    .where(eq(adminAuditLogsTable.actorTenantId, actorTenantId))
    .orderBy(adminAuditLogsTable.id);
}

export async function getNotifications(tenantId: number) {
  return db
    .select()
    .from(notificationsTable)
    .where(eq(notificationsTable.tenantId, tenantId));
}

/**
 * Delete every notification of a given type created at or after `since`.
 * Needed because some notifications (e.g. seat_request_submitted) fan out to
 * PRE-EXISTING superadmin tenants in the dev DB, which per-tenant cleanup in
 * deleteTenant never touches — without this, test runs leave unread
 * notifications on the real admin account.
 */
export async function purgeNotificationsByTypeSince(
  type: string,
  since: Date,
): Promise<void> {
  await db
    .delete(notificationsTable)
    .where(
      and(
        eq(notificationsTable.type, type),
        gte(notificationsTable.createdAt, since),
      ),
    );
}

/** Seed an UNREAD social_connection_failed notification for a platform. */
export async function insertConnectionFailedNotification(
  tenantId: number,
  platform: string,
): Promise<void> {
  await db.insert(notificationsTable).values({
    tenantId,
    type: "social_connection_failed",
    platform,
    title: `${platform} disconnected`,
    message: `Your ${platform} connection is no longer valid.`,
    linkUrl: "/accounts",
    inApp: true,
  });
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

export async function insertTwitterAccount(
  tenantId: number,
  opts: {
    accessToken?: string;
    refreshToken?: string;
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
    platform: "twitter",
    accountName: opts.accountName ?? "@testuser",
    status: opts.status ?? "connected",
    encryptedCredentials: encryptJson({
      accessToken: opts.accessToken ?? "tw_access_token",
      refreshToken: opts.refreshToken ?? "tw_refresh_token",
    }),
    providerUserId:
      opts.providerUserId === undefined ? "tw_user_123" : opts.providerUserId,
    // Far enough out by default that no token refresh is due.
    tokenExpiresAt:
      opts.tokenExpiresAt === undefined
        ? new Date(Date.now() + 60 * 60 * 1000)
        : opts.tokenExpiresAt,
    verifyStatus: opts.verifyStatus ?? "verified",
    verifyError: opts.verifyError ?? null,
    verifiedAt: opts.verifiedAt ?? new Date(),
  });
}

export async function insertYoutubeAccount(
  tenantId: number,
  opts: {
    accessToken?: string | null;
    refreshToken?: string | null;
    providerUserId?: string | null;
    tokenExpiresAt?: Date | null;
    status?: string;
    accountName?: string;
    verifyStatus?: string | null;
    verifyError?: string | null;
    verifiedAt?: Date | null;
  } = {},
): Promise<void> {
  const refreshToken =
    opts.refreshToken === undefined ? "yt_refresh_secret" : opts.refreshToken;
  await db.insert(connectedAccountsTable).values({
    tenantId,
    platform: "youtube",
    accountName: opts.accountName ?? "Test Channel",
    status: opts.status ?? "connected",
    accessToken:
      opts.accessToken === undefined ? "yt_tok_secret" : opts.accessToken,
    providerUserId:
      opts.providerUserId === undefined ? "yt_channel_123" : opts.providerUserId,
    tokenExpiresAt: opts.tokenExpiresAt ?? null,
    encryptedCredentials: refreshToken
      ? encryptJson({ refreshToken })
      : null,
    verifyStatus: opts.verifyStatus ?? "verified",
    verifyError: opts.verifyError ?? null,
    verifiedAt: opts.verifiedAt ?? new Date(),
  });
}

export async function insertThreadsAccount(
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
    platform: "threads",
    accountName: opts.accountName ?? "@threadsuser",
    status: opts.status ?? "connected",
    accessToken:
      opts.accessToken === undefined ? "th_tok_secret" : opts.accessToken,
    providerUserId:
      opts.providerUserId === undefined ? "th_user_123" : opts.providerUserId,
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
  opts: {
    imagePath?: string | null;
    caption?: string;
    title?: string;
    carouselSlides?: CarouselSlide[] | null;
  } = {},
): Promise<number> {
  const [row] = await db
    .insert(contentItemsTable)
    .values({
      tenantId,
      title: opts.title ?? "",
      caption: opts.caption ?? "hello world",
      imagePath: opts.imagePath ?? null,
      carouselSlides: opts.carouselSlides ?? null,
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
  clientId: string,
  clientSecret: string,
): Promise<void> {
  await db
    .delete(appCredentialsTable)
    .where(eq(appCredentialsTable.provider, "twitter"));
  await db.insert(appCredentialsTable).values({
    provider: "twitter",
    encryptedCredentials: encryptJson({ clientId, clientSecret }),
  });
}

export async function setVerifiedTwitterRow(): Promise<void> {
  await setTwitterRow("x-client-id-default", "x-client-secret-default");
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

// ---------------------------------------------------------------------------
// Generic app-level credential row helpers (global, unique on provider).
// Snapshot/restore so tests never destroy real dev configuration.
// ---------------------------------------------------------------------------

export async function snapshotAppCredentialRow(
  provider: string,
): Promise<AppCredential | null> {
  const row = (
    await db
      .select()
      .from(appCredentialsTable)
      .where(eq(appCredentialsTable.provider, provider))
      .limit(1)
  )[0];
  return row ?? null;
}

export async function setAppCredentialRow(
  provider: string,
  creds: unknown,
): Promise<void> {
  await db
    .delete(appCredentialsTable)
    .where(eq(appCredentialsTable.provider, provider));
  await db.insert(appCredentialsTable).values({
    provider,
    encryptedCredentials: encryptJson(creds),
  });
}

export async function restoreAppCredentialRow(
  provider: string,
  snapshot: AppCredential | null,
): Promise<void> {
  await db
    .delete(appCredentialsTable)
    .where(eq(appCredentialsTable.provider, provider));
  if (snapshot) {
    await db.insert(appCredentialsTable).values({
      provider,
      encryptedCredentials: snapshot.encryptedCredentials,
      lastTestStatus: snapshot.lastTestStatus,
      lastTestedAt: snapshot.lastTestedAt,
      lastTestError: snapshot.lastTestError,
    });
  }
}

// ---------------------------------------------------------------------------
// App-level email delivery settings (singleton row). Snapshot/restore so tests
// never destroy real dev configuration.
// ---------------------------------------------------------------------------

export async function snapshotEmailSettings(): Promise<EmailSettings | null> {
  const row = (await db.select().from(emailSettingsTable).limit(1))[0];
  return row ?? null;
}

export async function clearEmailSettings(): Promise<void> {
  await db.delete(emailSettingsTable);
}

export async function getEmailSettingsRow(): Promise<
  EmailSettings | undefined
> {
  return (await db.select().from(emailSettingsTable).limit(1))[0];
}

export async function restoreEmailSettings(
  snapshot: EmailSettings | null,
): Promise<void> {
  await db.delete(emailSettingsTable);
  if (snapshot) {
    await db.insert(emailSettingsTable).values({
      sendingEnabled: snapshot.sendingEnabled,
      fromEmail: snapshot.fromEmail,
      encryptedApiKey: snapshot.encryptedApiKey,
      lastTestStatus: snapshot.lastTestStatus,
      lastTestedAt: snapshot.lastTestedAt,
      lastTestError: snapshot.lastTestError,
      updatedAt: snapshot.updatedAt,
    });
  }
}

// ---------------------------------------------------------------------------
// App branding settings (singleton row, id=1). Snapshot/restore so tests never
// destroy real white-label configuration.
// ---------------------------------------------------------------------------

export async function snapshotAppBrand(): Promise<AppBrandSettings | null> {
  const row = (
    await db
      .select()
      .from(appBrandSettingsTable)
      .where(eq(appBrandSettingsTable.id, 1))
      .limit(1)
  )[0];
  return row ?? null;
}

export async function clearAppBrand(): Promise<void> {
  await db.delete(appBrandSettingsTable);
}

export async function getAppBrandRow(): Promise<AppBrandSettings | undefined> {
  return (
    await db
      .select()
      .from(appBrandSettingsTable)
      .where(eq(appBrandSettingsTable.id, 1))
      .limit(1)
  )[0];
}

export async function restoreAppBrand(
  snapshot: AppBrandSettings | null,
): Promise<void> {
  await db.delete(appBrandSettingsTable);
  if (snapshot) {
    await db.insert(appBrandSettingsTable).values({
      id: 1,
      appName: snapshot.appName,
      logoUrl: snapshot.logoUrl,
      iconUrl: snapshot.iconUrl,
      primaryColor: snapshot.primaryColor,
      backgroundColor: snapshot.backgroundColor,
    });
  }
}

// ---------------------------------------------------------------------------
// Plan catalog overrides (plan_settings). Tests that only assert a write was
// REJECTED just need to confirm no row exists for a unique custom plan id.
// ---------------------------------------------------------------------------

export async function getPlanSettingsRow(planId: string) {
  return (
    await db
      .select()
      .from(planSettingsTable)
      .where(eq(planSettingsTable.id, planId))
      .limit(1)
  )[0];
}

export async function deletePlanSettingsRow(planId: string): Promise<void> {
  await db.delete(planSettingsTable).where(eq(planSettingsTable.id, planId));
}

// ---------------------------------------------------------------------------
// Per-tenant notification preferences (opt-out model). A missing row means the
// defaults (in-app on, email on) apply, so tests only insert a row when they
// want to override a channel.
// ---------------------------------------------------------------------------

export async function setNotificationPreference(
  tenantId: number,
  type: string,
  values: { inApp: boolean; email: boolean },
): Promise<void> {
  await db
    .insert(notificationPreferencesTable)
    .values({
      tenantId,
      type,
      inApp: values.inApp,
      email: values.email,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [
        notificationPreferencesTable.tenantId,
        notificationPreferencesTable.type,
      ],
      set: { inApp: values.inApp, email: values.email, updatedAt: new Date() },
    });
}

export async function getNotificationPreference(tenantId: number, type: string) {
  return (
    await db
      .select()
      .from(notificationPreferencesTable)
      .where(
        and(
          eq(notificationPreferencesTable.tenantId, tenantId),
          eq(notificationPreferencesTable.type, type),
        ),
      )
      .limit(1)
  )[0];
}

// ---------------------------------------------------------------------------
// Global (platform-wide) notification policy, one row per type (unique on
// `type`). Snapshot/restore around tests so the shared dev row is never left
// mutated; a missing row means the built-in defaults (enabled, "optional").
// ---------------------------------------------------------------------------

export async function snapshotNotificationPolicy(
  type: string,
): Promise<NotificationPolicy | null> {
  const row = (
    await db
      .select()
      .from(notificationPoliciesTable)
      .where(eq(notificationPoliciesTable.type, type))
      .limit(1)
  )[0];
  return row ?? null;
}

export async function setNotificationPolicy(
  type: string,
  values: { enabled: boolean; emailPolicy: EmailPolicy },
): Promise<void> {
  await db
    .insert(notificationPoliciesTable)
    .values({
      type,
      enabled: values.enabled,
      emailPolicy: values.emailPolicy,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: notificationPoliciesTable.type,
      set: {
        enabled: values.enabled,
        emailPolicy: values.emailPolicy,
        updatedAt: new Date(),
      },
    });
}

export async function clearNotificationPolicy(type: string): Promise<void> {
  await db
    .delete(notificationPoliciesTable)
    .where(eq(notificationPoliciesTable.type, type));
}

export async function restoreNotificationPolicy(
  type: string,
  snapshot: NotificationPolicy | null,
): Promise<void> {
  await db
    .delete(notificationPoliciesTable)
    .where(eq(notificationPoliciesTable.type, type));
  if (snapshot) {
    await db.insert(notificationPoliciesTable).values({
      type: snapshot.type,
      enabled: snapshot.enabled,
      emailPolicy: snapshot.emailPolicy,
      updatedAt: snapshot.updatedAt,
    });
  }
}
