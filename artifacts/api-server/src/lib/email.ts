import { logger } from "./logger";
import { getEmailDeliveryState } from "./emailSettings";
import { platformFetch } from "./platformFetch";

/**
 * Transactional email via the Replit-managed SendGrid connector OR admin-entered
 * SendGrid credentials, whichever is configured (manual creds win).
 *
 * Connector credentials are never hardcoded: the SendGrid API key and verified
 * sender are fetched at request time from the Replit connectors proxy using the
 * repl/deployment identity token Replit injects automatically. If neither manual
 * creds nor the connector are set up, every send is a safe no-op that returns
 * `false` — sending email must never be a hard dependency of the callers.
 *
 * A global pause switch (`email_settings.sendingEnabled`) can disable all sends
 * regardless of credentials; `sendEmail` respects it, while `sendTestEmail`
 * deliberately bypasses it so an admin can verify delivery while still paused.
 */

interface SendGridConfig {
  apiKey: string;
  fromEmail: string;
}

function replitIdentityToken(): string | null {
  if (process.env.REPL_IDENTITY) return `repl ${process.env.REPL_IDENTITY}`;
  if (process.env.WEB_REPL_RENEWAL)
    return `depl ${process.env.WEB_REPL_RENEWAL}`;
  return null;
}

/**
 * Resolve the live SendGrid credentials from the connectors proxy. Returns
 * null (never throws) whenever the connector is not configured.
 */
async function getConnectorConfig(): Promise<SendGridConfig | null> {
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const token = replitIdentityToken();
  if (!hostname || !token) return null;

  try {
    const res = await platformFetch(
      `https://${hostname}/api/v2/connection?include_secrets=true&connector_names=sendgrid`,
      { headers: { Accept: "application/json", X_REPLIT_TOKEN: token } },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      items?: Array<{ settings?: { api_key?: string; from_email?: string } }>;
    };
    const settings = data.items?.[0]?.settings;
    const apiKey = settings?.api_key;
    const fromEmail = settings?.from_email;
    if (!apiKey || !fromEmail) return null;
    return { apiKey, fromEmail };
  } catch (err) {
    logger.error({ err }, "Failed to load SendGrid connection settings");
    return null;
  }
}

/**
 * Resolve the credentials to send with: admin-entered manual creds take
 * precedence over the connector. Returns null when nothing is configured.
 */
async function resolveConfig(): Promise<SendGridConfig | null> {
  const state = await getEmailDeliveryState();
  if (state.manual) return state.manual;
  return getConnectorConfig();
}

/** Whether the Replit-managed SendGrid connector alone is currently available. */
export async function isConnectorEmailAvailable(): Promise<boolean> {
  return (await getConnectorConfig()) !== null;
}

/**
 * Whether transactional email will actually send right now: not paused AND some
 * credentials (manual or connector) are available. The notification settings UI
 * uses this to show whether the email channel is live.
 */
export async function isEmailConfigured(): Promise<boolean> {
  const state = await getEmailDeliveryState();
  if (!state.enabled) return false;
  if (state.manual) return true;
  return (await getConnectorConfig()) !== null;
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface SendResult {
  ok: boolean;
  error?: string;
}

/**
 * Low-level SendGrid POST. Returns a structured result with a human-readable
 * error on failure. Never throws.
 */
async function postToSendGrid(
  msg: EmailMessage,
  config: SendGridConfig,
): Promise<SendResult> {
  const content: Array<{ type: string; value: string }> = [
    { type: "text/plain", value: msg.text },
  ];
  // SendGrid requires text/plain to precede text/html in the content array.
  if (msg.html) content.push({ type: "text/html", value: msg.html });

  try {
    const res = await platformFetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: msg.to }] }],
        from: { email: config.fromEmail },
        subject: msg.subject,
        content,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.error(
        { status: res.status, body },
        "SendGrid rejected the email send",
      );
      return {
        ok: false,
        error: `SendGrid responded ${res.status}${body ? `: ${body.slice(0, 300)}` : ""}`,
      };
    }
    return { ok: true };
  } catch (err) {
    logger.error({ err }, "SendGrid email send threw");
    return { ok: false, error: "Network error contacting SendGrid" };
  }
}

/**
 * Send a single transactional email. Returns `true` only when SendGrid accepted
 * the message. Returns `false` (and never throws) when email is paused, not
 * configured, or the send fails, so notification code can treat email as a
 * best-effort side channel.
 */
export async function sendEmail(msg: EmailMessage): Promise<boolean> {
  const state = await getEmailDeliveryState();
  if (!state.enabled) {
    logger.info("Email sending is paused; skipping send");
    return false;
  }

  const config = state.manual ?? (await getConnectorConfig());
  if (!config) {
    logger.info("Email not configured (no SendGrid creds); skipping send");
    return false;
  }

  const result = await postToSendGrid(msg, config);
  return result.ok;
}

/**
 * Send a test email to verify delivery. Unlike `sendEmail`, this deliberately
 * IGNORES the pause switch so an admin can confirm credentials work while email
 * is still paused for tenants. Returns a structured result for the admin UI.
 */
export async function sendTestEmail(msg: EmailMessage): Promise<SendResult> {
  const config = await resolveConfig();
  if (!config) {
    return {
      ok: false,
      error:
        "No SendGrid credentials configured. Enter an API key and sender address, or connect the SendGrid integration.",
    };
  }
  return postToSendGrid(msg, config);
}
