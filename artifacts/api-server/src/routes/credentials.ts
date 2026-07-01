import { Router, type IRouter, type Request, type Response } from "express";
import { db, appCredentialsTable, connectedAccountsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import {
  AdminSaveMetaCredentialsBody,
  SaveFacebookCredentialsBody,
  SaveInstagramCredentialsBody,
} from "@workspace/api-zod";
import type { MetaAppCredentials } from "@workspace/db";
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

const router: IRouter = Router();

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

    const row = await loadMetaRow();
    res.json(serializeMetaStatus(row));
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
    const [appConfigured, row] = await Promise.all([
      isMetaAppConfigured(),
      loadAccountRow(req.tenantId, "facebook"),
    ]);
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
      encryptedCredentials: encryptJson(creds),
      verifyStatus: test.ok ? "verified" : "failed",
      verifiedAt: now,
      verifyError: test.ok ? null : test.error ?? "Verification failed",
    });

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
      encryptedCredentials: existing.encryptedCredentials,
      verifyStatus: test.ok ? "verified" : "failed",
      verifiedAt: now,
      verifyError: test.ok ? null : test.error ?? "Verification failed",
    });

    const row = await loadAccountRow(req.tenantId, "facebook");
    res.json(serializeSocialStatus("facebook", true, row));
  },
);

router.get(
  "/social-credentials/instagram",
  async (req: Request, res: Response) => {
    const [appConfigured, row] = await Promise.all([
      isMetaAppConfigured(),
      loadAccountRow(req.tenantId, "instagram"),
    ]);
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

    const row = await loadAccountRow(req.tenantId, "instagram");
    res.json(serializeSocialStatus("instagram", true, row));
  },
);

export default router;
