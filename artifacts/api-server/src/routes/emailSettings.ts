import { Router, type IRouter, type Request, type Response } from "express";
import { db, emailSettingsTable, type EmailSettings } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  AdminUpdateEmailSettingsBody,
  AdminSendTestEmailBody,
} from "@workspace/api-zod";
import { requireSuperadmin } from "../middlewares/requireSuperadmin";
import {
  encryptJson,
  decryptJson,
  maskSecret,
  isEncryptionConfigured,
} from "../lib/secretCrypto";
import { isConnectorEmailAvailable, sendTestEmail } from "../lib/email";

const router: IRouter = Router();

async function loadRow(): Promise<EmailSettings | undefined> {
  return (await db.select().from(emailSettingsTable).limit(1))[0];
}

async function serializeStatus(row: EmailSettings | undefined) {
  const connectorAvailable = await isConnectorEmailAvailable();
  let apiKeyMasked: string | null = null;
  if (row?.encryptedApiKey) {
    try {
      const { apiKey } = decryptJson<{ apiKey: string }>(row.encryptedApiKey);
      apiKeyMasked = maskSecret(apiKey, 4);
    } catch {
      apiKeyMasked = null;
    }
  }
  const hasManual = !!(row?.encryptedApiKey && row?.fromEmail);
  return {
    // No row yet -> email is paused by default (fail-closed) until enabled.
    sendingEnabled: row ? row.sendingEnabled : false,
    fromEmail: row?.fromEmail ?? null,
    apiKeyMasked,
    connectorAvailable,
    configured: hasManual || connectorAvailable,
    testStatus: row?.lastTestStatus ?? null,
    testedAt: row?.lastTestedAt ? row.lastTestedAt.toISOString() : null,
    testError: row?.lastTestError ?? null,
  };
}

router.get(
  "/admin/email-settings",
  requireSuperadmin,
  async (_req: Request, res: Response) => {
    const row = await loadRow();
    res.json(await serializeStatus(row));
  },
);

router.put(
  "/admin/email-settings",
  requireSuperadmin,
  async (req: Request, res: Response) => {
    const parsed = AdminUpdateEmailSettingsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    const { sendingEnabled, fromEmail, apiKey } = parsed.data;

    // Only require encryption when a new secret is actually being stored.
    if (apiKey && apiKey.trim() && !isEncryptionConfigured()) {
      res
        .status(400)
        .json({ error: "Server is missing SESSION_SECRET; cannot store secrets." });
      return;
    }

    const now = new Date();
    const existing = await loadRow();

    const nextFromEmail =
      fromEmail !== undefined ? fromEmail.trim() || null : existing?.fromEmail ?? null;
    // apiKey is write-only: provided -> replace; omitted/blank -> keep stored.
    const nextEncryptedApiKey =
      apiKey && apiKey.trim()
        ? encryptJson({ apiKey: apiKey.trim() })
        : existing?.encryptedApiKey ?? null;

    if (existing) {
      await db
        .update(emailSettingsTable)
        .set({
          sendingEnabled,
          fromEmail: nextFromEmail,
          encryptedApiKey: nextEncryptedApiKey,
          updatedAt: now,
        })
        .where(eq(emailSettingsTable.id, existing.id));
    } else {
      await db.insert(emailSettingsTable).values({
        sendingEnabled,
        fromEmail: nextFromEmail,
        encryptedApiKey: nextEncryptedApiKey,
      });
    }

    res.json(await serializeStatus(await loadRow()));
  },
);

router.post(
  "/admin/email-settings/test",
  requireSuperadmin,
  async (req: Request, res: Response) => {
    const parsed = AdminSendTestEmailBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    const to = parsed.data.to.trim();

    const result = await sendTestEmail({
      to,
      subject: "SocialForge test email",
      text: "This is a test email from SocialForge confirming email delivery is working.",
      html: "<p>This is a test email from <strong>SocialForge</strong> confirming email delivery is working.</p>",
    });

    // Record the outcome so the admin card reflects the last test.
    const now = new Date();
    const existing = await loadRow();
    const testFields = {
      lastTestStatus: result.ok ? "verified" : "failed",
      lastTestedAt: now,
      lastTestError: result.ok ? null : result.error ?? "Test send failed",
    };
    if (existing) {
      await db
        .update(emailSettingsTable)
        .set({ ...testFields, updatedAt: now })
        .where(eq(emailSettingsTable.id, existing.id));
    } else {
      await db.insert(emailSettingsTable).values(testFields);
    }

    res.json({ ok: result.ok, error: result.ok ? null : result.error ?? null });
  },
);

export default router;
