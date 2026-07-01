import { db, emailSettingsTable, type EmailSettings } from "@workspace/db";
import { decryptJson } from "./secretCrypto";
import { logger } from "./logger";

/**
 * App-level email delivery settings live in a single `email_settings` row and
 * are managed by superadmins. This module is the one place that reads/decrypts
 * that row so both the send path (`email.ts`) and the admin routes agree on how
 * the pause switch and stored SendGrid credentials are resolved.
 */

export interface EmailManualConfig {
  apiKey: string;
  fromEmail: string;
}

/** Load the singleton settings row (undefined when never configured). */
export async function loadEmailSettingsRow(): Promise<EmailSettings | undefined> {
  return (await db.select().from(emailSettingsTable).limit(1))[0];
}

export interface EmailDeliveryState {
  /** Whether outbound email is allowed to send (the global pause switch). */
  enabled: boolean;
  /** Manually-entered SendGrid credentials, when present (take precedence). */
  manual: EmailManualConfig | null;
}

/**
 * Resolve the effective delivery state. Email is PAUSED by default (fail-closed)
 * until a superadmin explicitly enables it from the admin settings, so newly
 * deployed environments never send mail before delivery is configured and
 * verified. Decrypt failures fail safe to "no manual creds" so the connector
 * fallback still applies.
 */
export async function getEmailDeliveryState(): Promise<EmailDeliveryState> {
  const row = await loadEmailSettingsRow();
  if (!row) return { enabled: false, manual: null };

  let manual: EmailManualConfig | null = null;
  if (row.encryptedApiKey && row.fromEmail) {
    try {
      const { apiKey } = decryptJson<{ apiKey: string }>(row.encryptedApiKey);
      if (apiKey) manual = { apiKey, fromEmail: row.fromEmail };
    } catch (err) {
      logger.error({ err }, "Failed to decrypt stored email API key");
    }
  }

  return { enabled: row.sendingEnabled, manual };
}
