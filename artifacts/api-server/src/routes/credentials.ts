import { Router, type IRouter, type Request, type Response } from "express";
import { db, appCredentialsTable, connectedAccountsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import {
  AdminSaveMetaCredentialsBody,
  SaveFacebookCredentialsBody,
  SaveInstagramCredentialsBody,
  AdminSaveTwitterCredentialsBody,
  AdminSaveLinkedinCredentialsBody,
  AdminSaveYoutubeCredentialsBody,
  AdminSaveThreadsCredentialsBody,
  AdminSaveTiktokCredentialsBody,
  AdminSaveRazorpayCredentialsBody,
} from "@workspace/api-zod";
import type {
  MetaAppCredentials,
  TwitterAppCredentials,
  LinkedinAppCredentials,
  YoutubeAppCredentials,
  ThreadsAppCredentials,
  TiktokAppCredentials,
  RazorpayAppCredentials,
} from "@workspace/db";
import { testRazorpayCredentials } from "../lib/razorpay";
import { requireSuperadmin } from "../middlewares/requireSuperadmin";
import {
  encryptJson,
  decryptJson,
  maskSecret,
  isEncryptionConfigured,
} from "../lib/secretCrypto";
import {
  testMetaAppCredentials,
  testFacebookCredentials,
  testInstagramCredentials,
  isMetaAppConfigured,
  getTenantCredentials,
  type FacebookCredentials,
  type InstagramCredentials,
} from "../lib/metaApi";
import { reverifyFacebook, reverifyInstagram } from "../lib/socialReverify";
import { resolveSocialConnectionNotifications } from "../lib/notifications";
import { recordAdminAction } from "../lib/adminAudit";

const router: IRouter = Router();

/**
 * Best-effort audit of an app-level platform credential save/replace. Called
 * AFTER the primary write has succeeded; a logging failure never fails the
 * save. Values carry only the provider and a MASKED public identifier — no
 * secret material ever reaches the audit table.
 */
async function auditCredentialChange(
  req: Request,
  provider: string,
  oldIdMasked: string | null,
  newIdMasked: string | null,
): Promise<void> {
  try {
    await recordAdminAction({
      action: "credential_change",
      actorTenantId: req.tenantId,
      actorEmail: req.tenantEmail,
      targetTenantId: null,
      targetEmail: null,
      oldValue: oldIdMasked
        ? JSON.stringify({ provider, idMasked: oldIdMasked })
        : null,
      newValue: JSON.stringify({ provider, idMasked: newIdMasked }),
    });
  } catch (error) {
    req.log.error(
      { err: error, provider },
      "Failed to write credential-change audit log",
    );
  }
}

// ---------------------------------------------------------------------------
// Admin: app-level Meta credentials (superadmin only)
// ---------------------------------------------------------------------------

async function loadMetaRow() {
  return (
    await db
      .select()
      .from(appCredentialsTable)
      .where(eq(appCredentialsTable.provider, "meta"))
      .limit(1)
  )[0];
}

function serializeMetaStatus(
  row: Awaited<ReturnType<typeof loadMetaRow>> | undefined,
) {
  if (!row) {
    return {
      configured: false,
      appIdMasked: null,
      appSecretMasked: null,
      testStatus: null,
      testedAt: null,
      testError: null,
    };
  }
  let creds: MetaAppCredentials | null = null;
  try {
    creds = decryptJson<MetaAppCredentials>(row.encryptedCredentials);
  } catch {
    creds = null;
  }
  return {
    configured: true,
    // The App ID is not a secret but we still lightly mask it for consistency.
    appIdMasked: maskSecret(creds?.appId, 4),
    appSecretMasked: maskSecret(creds?.appSecret, 4),
    testStatus: row.lastTestStatus ?? null,
    testedAt: row.lastTestedAt ? row.lastTestedAt.toISOString() : null,
    testError: row.lastTestError ?? null,
  };
}

router.get(
  "/admin/platform-credentials/meta",
  requireSuperadmin,
  async (_req: Request, res: Response) => {
    const row = await loadMetaRow();
    res.json(serializeMetaStatus(row));
  },
);

router.put(
  "/admin/platform-credentials/meta",
  requireSuperadmin,
  async (req: Request, res: Response) => {
    if (!isEncryptionConfigured()) {
      res
        .status(400)
        .json({ error: "Server is missing SESSION_SECRET; cannot store secrets." });
      return;
    }
    const parsed = AdminSaveMetaCredentialsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }

    const { appId, appSecret } = parsed.data;
    const test = await testMetaAppCredentials(appId, appSecret);
    const now = new Date();
    const encrypted = encryptJson({ appId, appSecret });

    const existing = await loadMetaRow();
    let oldAppIdMasked: string | null = null;
    if (existing) {
      try {
        const oldCreds = decryptJson<MetaAppCredentials>(
          existing.encryptedCredentials,
        );
        oldAppIdMasked = maskSecret(oldCreds.appId, 4);
      } catch {
        oldAppIdMasked = null;
      }
    }
    if (existing) {
      await db
        .update(appCredentialsTable)
        .set({
          encryptedCredentials: encrypted,
          lastTestStatus: test.ok ? "verified" : "failed",
          lastTestedAt: now,
          lastTestError: test.ok ? null : test.error ?? "Verification failed",
          updatedAt: now,
        })
        .where(eq(appCredentialsTable.id, existing.id));
    } else {
      await db.insert(appCredentialsTable).values({
        provider: "meta",
        encryptedCredentials: encrypted,
        lastTestStatus: test.ok ? "verified" : "failed",
        lastTestedAt: now,
        lastTestError: test.ok ? null : test.error ?? "Verification failed",
      });
    }

    await auditCredentialChange(
      req,
      "meta",
      oldAppIdMasked,
      maskSecret(appId, 4),
    );

    const row = await loadMetaRow();
    res.json(serializeMetaStatus(row));
  },
);

// ---------------------------------------------------------------------------
// Admin: app-level X (Twitter) credentials (superadmin only)
// ---------------------------------------------------------------------------

async function loadTwitterRow() {
  return (
    await db
      .select()
      .from(appCredentialsTable)
      .where(eq(appCredentialsTable.provider, "twitter"))
      .limit(1)
  )[0];
}

function twitterRedirectUri(req: Request): string {
  const proto =
    (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0] ||
    req.protocol ||
    "https";
  const host =
    (req.headers["x-forwarded-host"] as string | undefined) || req.headers.host;
  return `${proto}://${host}/api/twitter/auth/callback`;
}

function serializeTwitterStatus(
  req: Request,
  row: Awaited<ReturnType<typeof loadTwitterRow>> | undefined,
) {
  const redirectUri = twitterRedirectUri(req);
  if (!row) {
    return {
      configured: false,
      clientIdMasked: null,
      clientSecretMasked: null,
      redirectUri,
      savedAt: null,
    };
  }
  let creds: TwitterAppCredentials | null = null;
  try {
    creds = decryptJson<TwitterAppCredentials>(row.encryptedCredentials);
  } catch {
    creds = null;
  }
  return {
    configured: true,
    clientIdMasked: maskSecret(creds?.clientId, 4),
    clientSecretMasked: maskSecret(creds?.clientSecret, 4),
    redirectUri,
    savedAt: row.updatedAt
      ? row.updatedAt.toISOString()
      : row.lastTestedAt
        ? row.lastTestedAt.toISOString()
        : null,
  };
}

router.get(
  "/admin/platform-credentials/twitter",
  requireSuperadmin,
  async (req: Request, res: Response) => {
    const row = await loadTwitterRow();
    res.json(serializeTwitterStatus(req, row));
  },
);

router.put(
  "/admin/platform-credentials/twitter",
  requireSuperadmin,
  async (req: Request, res: Response) => {
    if (!isEncryptionConfigured()) {
      res
        .status(400)
        .json({ error: "Server is missing SESSION_SECRET; cannot store secrets." });
      return;
    }
    const parsed = AdminSaveTwitterCredentialsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }

    const { clientId, clientSecret } = parsed.data;
    const now = new Date();
    // Confidential OAuth 2.0 client credentials cannot be validated without a
    // full user authorization, so there is no live pre-test — we store them and
    // treat the row's presence as "configured".
    const encrypted = encryptJson({ clientId, clientSecret });

    const existing = await loadTwitterRow();
    let oldClientIdMasked: string | null = null;
    if (existing) {
      try {
        const oldCreds = decryptJson<TwitterAppCredentials>(
          existing.encryptedCredentials,
        );
        oldClientIdMasked = maskSecret(oldCreds.clientId, 4);
      } catch {
        oldClientIdMasked = null;
      }
    }
    if (existing) {
      await db
        .update(appCredentialsTable)
        .set({
          encryptedCredentials: encrypted,
          lastTestStatus: null,
          lastTestedAt: null,
          lastTestError: null,
          updatedAt: now,
        })
        .where(eq(appCredentialsTable.id, existing.id));
    } else {
      await db.insert(appCredentialsTable).values({
        provider: "twitter",
        encryptedCredentials: encrypted,
      });
    }

    await auditCredentialChange(
      req,
      "twitter",
      oldClientIdMasked,
      maskSecret(clientId, 4),
    );

    const row = await loadTwitterRow();
    res.json(serializeTwitterStatus(req, row));
  },
);

// ---------------------------------------------------------------------------
// Admin: app-level LinkedIn credentials (superadmin only)
// ---------------------------------------------------------------------------

async function loadLinkedinRow() {
  return (
    await db
      .select()
      .from(appCredentialsTable)
      .where(eq(appCredentialsTable.provider, "linkedin"))
      .limit(1)
  )[0];
}

function linkedinRedirectUri(req: Request): string {
  const proto =
    (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0] ||
    req.protocol ||
    "https";
  const host =
    (req.headers["x-forwarded-host"] as string | undefined) || req.headers.host;
  return `${proto}://${host}/api/linkedin/auth/callback`;
}

function serializeLinkedinStatus(
  req: Request,
  row: Awaited<ReturnType<typeof loadLinkedinRow>> | undefined,
) {
  const redirectUri = linkedinRedirectUri(req);
  if (!row) {
    // Env vars remain a fallback so an already-working env-based setup still
    // reads as configured.
    const envConfigured =
      !!process.env.LINKEDIN_CLIENT_ID && !!process.env.LINKEDIN_CLIENT_SECRET;
    return {
      configured: envConfigured,
      clientIdMasked: envConfigured
        ? maskSecret(process.env.LINKEDIN_CLIENT_ID, 4)
        : null,
      clientSecretMasked: envConfigured ? "********" : null,
      redirectUri,
      savedAt: null,
    };
  }
  let creds: LinkedinAppCredentials | null = null;
  try {
    creds = decryptJson<LinkedinAppCredentials>(row.encryptedCredentials);
  } catch {
    creds = null;
  }
  return {
    configured: true,
    clientIdMasked: maskSecret(creds?.clientId, 4),
    clientSecretMasked: maskSecret(creds?.clientSecret, 4),
    redirectUri,
    savedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
  };
}

router.get(
  "/admin/platform-credentials/linkedin",
  requireSuperadmin,
  async (req: Request, res: Response) => {
    const row = await loadLinkedinRow();
    res.json(serializeLinkedinStatus(req, row));
  },
);

router.put(
  "/admin/platform-credentials/linkedin",
  requireSuperadmin,
  async (req: Request, res: Response) => {
    if (!isEncryptionConfigured()) {
      res
        .status(400)
        .json({ error: "Server is missing SESSION_SECRET; cannot store secrets." });
      return;
    }
    const parsed = AdminSaveLinkedinCredentialsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }

    const { clientId, clientSecret } = parsed.data;
    const now = new Date();
    // LinkedIn confidential-client credentials cannot be validated without a
    // full user authorization, so there is no live pre-test — we store them and
    // treat the row's presence as "configured".
    const encrypted = encryptJson({
      clientId: clientId.trim(),
      clientSecret: clientSecret.trim(),
    });

    const existing = await loadLinkedinRow();
    let oldClientIdMasked: string | null = null;
    if (existing) {
      try {
        const oldCreds = decryptJson<LinkedinAppCredentials>(
          existing.encryptedCredentials,
        );
        oldClientIdMasked = maskSecret(oldCreds.clientId, 4);
      } catch {
        oldClientIdMasked = null;
      }
    }
    if (existing) {
      await db
        .update(appCredentialsTable)
        .set({
          encryptedCredentials: encrypted,
          lastTestStatus: null,
          lastTestedAt: null,
          lastTestError: null,
          updatedAt: now,
        })
        .where(eq(appCredentialsTable.id, existing.id));
    } else {
      await db.insert(appCredentialsTable).values({
        provider: "linkedin",
        encryptedCredentials: encrypted,
      });
    }

    await auditCredentialChange(
      req,
      "linkedin",
      oldClientIdMasked,
      maskSecret(clientId.trim(), 4),
    );

    const row = await loadLinkedinRow();
    res.json(serializeLinkedinStatus(req, row));
  },
);

// ---------------------------------------------------------------------------
// Admin: app-level YouTube (Google OAuth) credentials (superadmin only)
// ---------------------------------------------------------------------------

async function loadYoutubeRow() {
  return (
    await db
      .select()
      .from(appCredentialsTable)
      .where(eq(appCredentialsTable.provider, "youtube"))
      .limit(1)
  )[0];
}

function youtubeRedirectUri(req: Request): string {
  const proto =
    (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0] ||
    req.protocol ||
    "https";
  const host =
    (req.headers["x-forwarded-host"] as string | undefined) || req.headers.host;
  return `${proto}://${host}/api/youtube/auth/callback`;
}

function serializeYoutubeStatus(
  req: Request,
  row: Awaited<ReturnType<typeof loadYoutubeRow>> | undefined,
) {
  const redirectUri = youtubeRedirectUri(req);
  if (!row) {
    // Env vars remain a fallback so an already-working env-based setup still
    // reads as configured.
    const envConfigured =
      !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET;
    return {
      configured: envConfigured,
      clientIdMasked: envConfigured
        ? maskSecret(process.env.GOOGLE_CLIENT_ID, 4)
        : null,
      clientSecretMasked: envConfigured ? "********" : null,
      redirectUri,
      savedAt: null,
    };
  }
  let creds: YoutubeAppCredentials | null = null;
  try {
    creds = decryptJson<YoutubeAppCredentials>(row.encryptedCredentials);
  } catch {
    creds = null;
  }
  return {
    configured: true,
    clientIdMasked: maskSecret(creds?.clientId, 4),
    clientSecretMasked: maskSecret(creds?.clientSecret, 4),
    redirectUri,
    savedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
  };
}

router.get(
  "/admin/platform-credentials/youtube",
  requireSuperadmin,
  async (req: Request, res: Response) => {
    const row = await loadYoutubeRow();
    res.json(serializeYoutubeStatus(req, row));
  },
);

router.put(
  "/admin/platform-credentials/youtube",
  requireSuperadmin,
  async (req: Request, res: Response) => {
    if (!isEncryptionConfigured()) {
      res
        .status(400)
        .json({ error: "Server is missing SESSION_SECRET; cannot store secrets." });
      return;
    }
    const parsed = AdminSaveYoutubeCredentialsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }

    const { clientId, clientSecret } = parsed.data;
    const now = new Date();
    // Google confidential-client credentials cannot be validated without a
    // full user authorization, so there is no live pre-test — we store them and
    // treat the row's presence as "configured".
    const encrypted = encryptJson({
      clientId: clientId.trim(),
      clientSecret: clientSecret.trim(),
    });

    const existing = await loadYoutubeRow();
    let oldClientIdMasked: string | null = null;
    if (existing) {
      try {
        const oldCreds = decryptJson<YoutubeAppCredentials>(
          existing.encryptedCredentials,
        );
        oldClientIdMasked = maskSecret(oldCreds.clientId, 4);
      } catch {
        oldClientIdMasked = null;
      }
    }
    if (existing) {
      await db
        .update(appCredentialsTable)
        .set({
          encryptedCredentials: encrypted,
          lastTestStatus: null,
          lastTestedAt: null,
          lastTestError: null,
          updatedAt: now,
        })
        .where(eq(appCredentialsTable.id, existing.id));
    } else {
      await db.insert(appCredentialsTable).values({
        provider: "youtube",
        encryptedCredentials: encrypted,
      });
    }

    await auditCredentialChange(
      req,
      "youtube",
      oldClientIdMasked,
      maskSecret(clientId.trim(), 4),
    );

    const row = await loadYoutubeRow();
    res.json(serializeYoutubeStatus(req, row));
  },
);

// ---------------------------------------------------------------------------
// Admin: app-level Threads (by Meta) credentials (superadmin only)
// ---------------------------------------------------------------------------

async function loadThreadsRow() {
  return (
    await db
      .select()
      .from(appCredentialsTable)
      .where(eq(appCredentialsTable.provider, "threads"))
      .limit(1)
  )[0];
}

function threadsRedirectUri(req: Request): string {
  const proto =
    (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0] ||
    req.protocol ||
    "https";
  const host =
    (req.headers["x-forwarded-host"] as string | undefined) || req.headers.host;
  return `${proto}://${host}/api/threads/auth/callback`;
}

function serializeThreadsStatus(
  req: Request,
  row: Awaited<ReturnType<typeof loadThreadsRow>> | undefined,
) {
  const redirectUri = threadsRedirectUri(req);
  if (!row) {
    return {
      configured: false,
      appIdMasked: null,
      appSecretMasked: null,
      redirectUri,
      savedAt: null,
    };
  }
  let creds: ThreadsAppCredentials | null = null;
  try {
    creds = decryptJson<ThreadsAppCredentials>(row.encryptedCredentials);
  } catch {
    creds = null;
  }
  return {
    configured: true,
    appIdMasked: maskSecret(creds?.appId, 4),
    appSecretMasked: maskSecret(creds?.appSecret, 4),
    redirectUri,
    savedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
  };
}

router.get(
  "/admin/platform-credentials/threads",
  requireSuperadmin,
  async (req: Request, res: Response) => {
    const row = await loadThreadsRow();
    res.json(serializeThreadsStatus(req, row));
  },
);

router.put(
  "/admin/platform-credentials/threads",
  requireSuperadmin,
  async (req: Request, res: Response) => {
    if (!isEncryptionConfigured()) {
      res
        .status(400)
        .json({ error: "Server is missing SESSION_SECRET; cannot store secrets." });
      return;
    }
    const parsed = AdminSaveThreadsCredentialsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }

    const { appId, appSecret } = parsed.data;
    // Threads OAuth app credentials cannot be validated without a full user
    // authorization, so there is no live pre-test — we store them and treat
    // the row's presence as "configured".
    const encrypted = encryptJson({
      appId: appId.trim(),
      appSecret: appSecret.trim(),
    });

    const existing = await loadThreadsRow();
    let oldAppIdMasked: string | null = null;
    if (existing) {
      try {
        const oldCreds = decryptJson<ThreadsAppCredentials>(
          existing.encryptedCredentials,
        );
        oldAppIdMasked = maskSecret(oldCreds.appId, 4);
      } catch {
        oldAppIdMasked = null;
      }
    }
    if (existing) {
      await db
        .update(appCredentialsTable)
        .set({
          encryptedCredentials: encrypted,
          lastTestStatus: null,
          lastTestedAt: null,
          lastTestError: null,
          updatedAt: new Date(),
        })
        .where(eq(appCredentialsTable.id, existing.id));
    } else {
      await db.insert(appCredentialsTable).values({
        provider: "threads",
        encryptedCredentials: encrypted,
      });
    }

    await auditCredentialChange(
      req,
      "threads",
      oldAppIdMasked,
      maskSecret(appId.trim(), 4),
    );

    const row = await loadThreadsRow();
    res.json(serializeThreadsStatus(req, row));
  },
);

// ---------------------------------------------------------------------------
// Admin: app-level TikTok for Business credentials (superadmin only)
// ---------------------------------------------------------------------------

async function loadTiktokRow() {
  return (
    await db
      .select()
      .from(appCredentialsTable)
      .where(eq(appCredentialsTable.provider, "tiktok"))
      .limit(1)
  )[0];
}

function tiktokRedirectUri(req: Request): string {
  const proto =
    (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0] ||
    req.protocol ||
    "https";
  const host =
    (req.headers["x-forwarded-host"] as string | undefined) || req.headers.host;
  return `${proto}://${host}/api/ads/tiktok/auth/callback`;
}

function serializeTiktokStatus(
  req: Request,
  row: Awaited<ReturnType<typeof loadTiktokRow>> | undefined,
) {
  const redirectUri = tiktokRedirectUri(req);
  if (!row) {
    return {
      configured: false,
      appIdMasked: null,
      appSecretMasked: null,
      redirectUri,
      savedAt: null,
    };
  }
  let creds: TiktokAppCredentials | null = null;
  try {
    creds = decryptJson<TiktokAppCredentials>(row.encryptedCredentials);
  } catch {
    creds = null;
  }
  return {
    configured: true,
    appIdMasked: maskSecret(creds?.appId, 4),
    appSecretMasked: maskSecret(creds?.appSecret, 4),
    redirectUri,
    savedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
  };
}

router.get(
  "/admin/platform-credentials/tiktok",
  requireSuperadmin,
  async (req: Request, res: Response) => {
    const row = await loadTiktokRow();
    res.json(serializeTiktokStatus(req, row));
  },
);

router.put(
  "/admin/platform-credentials/tiktok",
  requireSuperadmin,
  async (req: Request, res: Response) => {
    if (!isEncryptionConfigured()) {
      res
        .status(400)
        .json({ error: "Server is missing SESSION_SECRET; cannot store secrets." });
      return;
    }
    const parsed = AdminSaveTiktokCredentialsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }

    const { appId, appSecret } = parsed.data;
    // TikTok app credentials cannot be validated without a full advertiser
    // authorization, so there is no live pre-test — we store them and treat
    // the row's presence as "configured".
    const encrypted = encryptJson({
      appId: appId.trim(),
      appSecret: appSecret.trim(),
    });

    const existing = await loadTiktokRow();
    let oldAppIdMasked: string | null = null;
    if (existing) {
      try {
        const oldCreds = decryptJson<TiktokAppCredentials>(
          existing.encryptedCredentials,
        );
        oldAppIdMasked = maskSecret(oldCreds.appId, 4);
      } catch {
        oldAppIdMasked = null;
      }
    }
    if (existing) {
      await db
        .update(appCredentialsTable)
        .set({
          encryptedCredentials: encrypted,
          lastTestStatus: null,
          lastTestedAt: null,
          lastTestError: null,
          updatedAt: new Date(),
        })
        .where(eq(appCredentialsTable.id, existing.id));
    } else {
      await db.insert(appCredentialsTable).values({
        provider: "tiktok",
        encryptedCredentials: encrypted,
      });
    }

    await auditCredentialChange(
      req,
      "tiktok",
      oldAppIdMasked,
      maskSecret(appId.trim(), 4),
    );

    const row = await loadTiktokRow();
    res.json(serializeTiktokStatus(req, row));
  },
);

// ---------------------------------------------------------------------------
// Tenant: per-platform social credentials
// ---------------------------------------------------------------------------

async function loadAccountRow(tenantId: number, platform: string) {
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

async function upsertAccount(
  tenantId: number,
  platform: string,
  values: {
    accountName: string;
    encryptedCredentials: string;
    verifyStatus: string;
    verifiedAt: Date;
    verifyError: string | null;
  },
) {
  const existing = await loadAccountRow(tenantId, platform);
  if (existing) {
    await db
      .update(connectedAccountsTable)
      .set({
        accountName: values.accountName,
        status: values.verifyStatus === "verified" ? "connected" : "error",
        encryptedCredentials: values.encryptedCredentials,
        verifyStatus: values.verifyStatus,
        verifiedAt: values.verifiedAt,
        verifyError: values.verifyError,
      })
      .where(eq(connectedAccountsTable.id, existing.id));
  } else {
    await db.insert(connectedAccountsTable).values({
      tenantId,
      platform,
      accountName: values.accountName,
      status: values.verifyStatus === "verified" ? "connected" : "error",
      encryptedCredentials: values.encryptedCredentials,
      verifyStatus: values.verifyStatus,
      verifiedAt: values.verifiedAt,
      verifyError: values.verifyError,
    });
  }
}

function serializeSocialStatus(
  platform: string,
  appConfigured: boolean,
  row: Awaited<ReturnType<typeof loadAccountRow>> | undefined,
) {
  const base = {
    platform,
    appConfigured,
    saved: !!row?.encryptedCredentials,
    verifyStatus: row?.verifyStatus ?? null,
    verifiedAt: row?.verifiedAt ? row.verifiedAt.toISOString() : null,
    verifyError: row?.verifyError ?? null,
    accountName: row?.encryptedCredentials ? row.accountName : null,
    pageId: null as string | null,
    pageAccessTokenMasked: null as string | null,
    igUserId: null as string | null,
    accessTokenMasked: null as string | null,
  };
  if (row?.encryptedCredentials) {
    try {
      if (platform === "facebook") {
        const creds = decryptJson<FacebookCredentials>(row.encryptedCredentials);
        base.pageId = creds.pageId;
        base.pageAccessTokenMasked = maskSecret(creds.pageAccessToken, 4);
      } else if (platform === "instagram") {
        const creds = decryptJson<InstagramCredentials>(row.encryptedCredentials);
        base.igUserId = creds.igUserId;
      }
    } catch {
      // Ignore decrypt failures; masked fields stay null.
    }
  }
  return base;
}

router.get(
  "/social-credentials/facebook",
  async (req: Request, res: Response) => {
    const appConfigured = await isMetaAppConfigured();
    let row = await loadAccountRow(req.tenantId, "facebook");
    // Proactively re-check a stored token so an expired/revoked one flips to
    // "failed" the moment the page loads, without the user clicking "Re-test".
    if (appConfigured && row?.encryptedCredentials) {
      try {
        row = (await reverifyFacebook(req.tenantId)) ?? row;
      } catch (err) {
        req.log.error({ err }, "Facebook auto re-verify failed");
      }
    }
    res.json(serializeSocialStatus("facebook", appConfigured, row));
  },
);

router.put(
  "/social-credentials/facebook",
  async (req: Request, res: Response) => {
    if (!isEncryptionConfigured()) {
      res
        .status(400)
        .json({ error: "Server is missing SESSION_SECRET; cannot store secrets." });
      return;
    }
    const parsed = SaveFacebookCredentialsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    if (!(await isMetaAppConfigured())) {
      res.status(400).json({
        error:
          "Meta app credentials have not been configured by an administrator yet.",
      });
      return;
    }

    const creds: FacebookCredentials = {
      pageId: parsed.data.pageId.trim(),
      pageAccessToken: parsed.data.pageAccessToken.trim(),
    };
    const test = await testFacebookCredentials(creds);
    const now = new Date();

    await upsertAccount(req.tenantId, "facebook", {
      accountName: test.accountName || "Facebook Page",
      encryptedCredentials: encryptJson(test.correctedCredentials ?? creds),
      verifyStatus: test.ok ? "verified" : "failed",
      verifiedAt: now,
      verifyError: test.ok ? null : test.error ?? "Verification failed",
    });
    if (test.ok) {
      await resolveSocialConnectionNotifications(req.tenantId, "facebook");
    }

    const row = await loadAccountRow(req.tenantId, "facebook");
    res.json(serializeSocialStatus("facebook", true, row));
  },
);

router.delete(
  "/social-credentials/facebook",
  async (req: Request, res: Response) => {
    const existing = await loadAccountRow(req.tenantId, "facebook");
    if (existing) {
      await db
        .delete(connectedAccountsTable)
        .where(eq(connectedAccountsTable.id, existing.id));
    }
    const appConfigured = await isMetaAppConfigured();
    res.json(serializeSocialStatus("facebook", appConfigured, undefined));
  },
);

router.post(
  "/social-credentials/facebook/retest",
  async (req: Request, res: Response) => {
    if (!(await isMetaAppConfigured())) {
      res.status(400).json({
        error:
          "Meta app credentials have not been configured by an administrator yet.",
      });
      return;
    }
    const existing = await loadAccountRow(req.tenantId, "facebook");
    if (!existing?.encryptedCredentials) {
      res.status(400).json({ error: "No stored Facebook credentials to re-test." });
      return;
    }
    let creds: FacebookCredentials;
    try {
      creds = decryptJson<FacebookCredentials>(existing.encryptedCredentials);
    } catch {
      res.status(400).json({ error: "Stored credentials could not be read." });
      return;
    }

    const test = await testFacebookCredentials(creds);
    const now = new Date();
    await upsertAccount(req.tenantId, "facebook", {
      accountName: test.accountName || existing.accountName || "Facebook Page",
      encryptedCredentials: test.correctedCredentials
        ? encryptJson(test.correctedCredentials)
        : existing.encryptedCredentials,
      verifyStatus: test.ok ? "verified" : "failed",
      verifiedAt: now,
      verifyError: test.ok ? null : test.error ?? "Verification failed",
    });
    if (test.ok) {
      await resolveSocialConnectionNotifications(req.tenantId, "facebook");
    }

    const row = await loadAccountRow(req.tenantId, "facebook");
    res.json(serializeSocialStatus("facebook", true, row));
  },
);

router.get(
  "/social-credentials/instagram",
  async (req: Request, res: Response) => {
    const appConfigured = await isMetaAppConfigured();
    let row = await loadAccountRow(req.tenantId, "instagram");
    // Proactively re-check a stored account so a broken connection flips to
    // "failed" the moment the page loads, without the user clicking "Re-test".
    if (appConfigured && row?.encryptedCredentials) {
      try {
        row = (await reverifyInstagram(req.tenantId)) ?? row;
      } catch (err) {
        req.log.error({ err }, "Instagram auto re-verify failed");
      }
    }
    res.json(serializeSocialStatus("instagram", appConfigured, row));
  },
);

router.put(
  "/social-credentials/instagram",
  async (req: Request, res: Response) => {
    if (!isEncryptionConfigured()) {
      res
        .status(400)
        .json({ error: "Server is missing SESSION_SECRET; cannot store secrets." });
      return;
    }
    const parsed = SaveInstagramCredentialsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    if (!(await isMetaAppConfigured())) {
      res.status(400).json({
        error:
          "Meta app credentials have not been configured by an administrator yet.",
      });
      return;
    }

    // Instagram publishing rides on the Facebook Page token, so a verified
    // Facebook credential must exist first.
    const fb = await getTenantCredentials<FacebookCredentials>(
      req.tenantId,
      "facebook",
    );
    if (!fb || !fb.verified) {
      res.status(400).json({
        error:
          "Connect and verify your Facebook Page first — Instagram publishing uses its access token.",
      });
      return;
    }

    const creds: InstagramCredentials = {
      igUserId: parsed.data.igUserId.trim(),
    };
    const test = await testInstagramCredentials(creds, fb.creds.pageAccessToken);
    const now = new Date();

    await upsertAccount(req.tenantId, "instagram", {
      accountName: test.accountName || "Instagram account",
      encryptedCredentials: encryptJson(creds),
      verifyStatus: test.ok ? "verified" : "failed",
      verifiedAt: now,
      verifyError: test.ok ? null : test.error ?? "Verification failed",
    });
    if (test.ok) {
      await resolveSocialConnectionNotifications(req.tenantId, "instagram");
    }

    const row = await loadAccountRow(req.tenantId, "instagram");
    res.json(serializeSocialStatus("instagram", true, row));
  },
);

router.delete(
  "/social-credentials/instagram",
  async (req: Request, res: Response) => {
    const existing = await loadAccountRow(req.tenantId, "instagram");
    if (existing) {
      await db
        .delete(connectedAccountsTable)
        .where(eq(connectedAccountsTable.id, existing.id));
    }
    const appConfigured = await isMetaAppConfigured();
    res.json(serializeSocialStatus("instagram", appConfigured, undefined));
  },
);

router.post(
  "/social-credentials/instagram/retest",
  async (req: Request, res: Response) => {
    if (!(await isMetaAppConfigured())) {
      res.status(400).json({
        error:
          "Meta app credentials have not been configured by an administrator yet.",
      });
      return;
    }
    const existing = await loadAccountRow(req.tenantId, "instagram");
    if (!existing?.encryptedCredentials) {
      res.status(400).json({ error: "No stored Instagram credentials to re-test." });
      return;
    }
    let creds: InstagramCredentials;
    try {
      creds = decryptJson<InstagramCredentials>(existing.encryptedCredentials);
    } catch {
      res.status(400).json({ error: "Stored credentials could not be read." });
      return;
    }

    // Instagram publishing rides on the Facebook Page token, so a verified
    // Facebook credential must still exist.
    const fb = await getTenantCredentials<FacebookCredentials>(
      req.tenantId,
      "facebook",
    );
    if (!fb || !fb.verified) {
      res.status(400).json({
        error:
          "Connect and verify your Facebook Page first — Instagram publishing uses its access token.",
      });
      return;
    }

    const test = await testInstagramCredentials(creds, fb.creds.pageAccessToken);
    const now = new Date();
    await upsertAccount(req.tenantId, "instagram", {
      accountName: test.accountName || existing.accountName || "Instagram account",
      encryptedCredentials: existing.encryptedCredentials,
      verifyStatus: test.ok ? "verified" : "failed",
      verifiedAt: now,
      verifyError: test.ok ? null : test.error ?? "Verification failed",
    });
    if (test.ok) {
      await resolveSocialConnectionNotifications(req.tenantId, "instagram");
    }

    const row = await loadAccountRow(req.tenantId, "instagram");
    res.json(serializeSocialStatus("instagram", true, row));
  },
);


// ---------------------------------------------------------------------------
// Admin: Razorpay billing credentials (superadmin only)
// ---------------------------------------------------------------------------

async function loadRazorpayRow() {
  return (
    await db
      .select()
      .from(appCredentialsTable)
      .where(eq(appCredentialsTable.provider, "razorpay"))
      .limit(1)
  )[0];
}

function serializeRazorpayStatus(
  row: Awaited<ReturnType<typeof loadRazorpayRow>> | undefined,
) {
  if (!row) {
    return {
      configured: false,
      keyIdMasked: null,
      keySecretMasked: null,
      webhookSecretMasked: null,
      testStatus: null,
      testedAt: null,
      testError: null,
    };
  }
  let creds: RazorpayAppCredentials | null = null;
  try {
    creds = decryptJson<RazorpayAppCredentials>(row.encryptedCredentials);
  } catch {
    creds = null;
  }
  return {
    configured: true,
    keyIdMasked: maskSecret(creds?.keyId, 4),
    keySecretMasked: maskSecret(creds?.keySecret, 4),
    webhookSecretMasked: maskSecret(creds?.webhookSecret, 4),
    testStatus: row.lastTestStatus ?? null,
    testedAt: row.lastTestedAt ? row.lastTestedAt.toISOString() : null,
    testError: row.lastTestError ?? null,
  };
}

router.get(
  "/admin/platform-credentials/razorpay",
  requireSuperadmin,
  async (_req: Request, res: Response) => {
    res.json(serializeRazorpayStatus(await loadRazorpayRow()));
  },
);

router.put(
  "/admin/platform-credentials/razorpay",
  requireSuperadmin,
  async (req: Request, res: Response) => {
    if (!isEncryptionConfigured()) {
      res
        .status(400)
        .json({ error: "Server is missing SESSION_SECRET; cannot store secrets." });
      return;
    }
    const parsed = AdminSaveRazorpayCredentialsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }

    const { keyId, keySecret, webhookSecret } = parsed.data;
    const test = await testRazorpayCredentials({ keyId, keySecret, webhookSecret });
    const now = new Date();
    const encrypted = encryptJson({ keyId, keySecret, webhookSecret });

    const existing = await loadRazorpayRow();
    let oldKeyIdMasked: string | null = null;
    if (existing) {
      try {
        oldKeyIdMasked = maskSecret(
          decryptJson<RazorpayAppCredentials>(existing.encryptedCredentials).keyId,
          4,
        );
      } catch {
        oldKeyIdMasked = null;
      }
    }
    const values = {
      encryptedCredentials: encrypted,
      lastTestStatus: test.ok ? "verified" : "failed",
      lastTestedAt: now,
      lastTestError: test.ok ? null : test.error ?? "Verification failed",
      updatedAt: now,
    };
    if (existing) {
      await db
        .update(appCredentialsTable)
        .set(values)
        .where(eq(appCredentialsTable.id, existing.id));
    } else {
      await db.insert(appCredentialsTable).values({
        provider: "razorpay",
        ...values,
      });
    }

    await auditCredentialChange(req, "razorpay", oldKeyIdMasked, maskSecret(keyId, 4));

    res.json(serializeRazorpayStatus(await loadRazorpayRow()));
  },
);

export default router;
