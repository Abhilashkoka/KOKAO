import { logger } from "./logger";

/**
 * Transactional email via the Replit-managed SendGrid connector.
 *
 * Credentials are never hardcoded: the SendGrid API key and verified sender
 * address are fetched at request time from the Replit connectors proxy using
 * the repl/deployment identity token that Replit injects automatically. If the
 * connector has not been set up (no identity token, no connection, or missing
 * settings), every send is a safe no-op that returns `false` — sending email
 * must never be a hard dependency of the code paths that call it.
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
 * null (never throws) whenever email is not configured so callers can no-op.
 */
async function getSendGridConfig(): Promise<SendGridConfig | null> {
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const token = replitIdentityToken();
  if (!hostname || !token) return null;

  try {
    const res = await fetch(
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
 * Whether transactional email is currently deliverable (SendGrid connected with
 * valid settings). Never throws. The notification settings UI uses this to show
 * whether the email channel will actually send yet.
 */
export async function isEmailConfigured(): Promise<boolean> {
  return (await getSendGridConfig()) !== null;
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * Send a single transactional email. Returns `true` only when SendGrid
 * accepted the message. Returns `false` (and never throws) when email is not
 * configured or the send fails, so notification code can treat email as a
 * best-effort side channel.
 */
export async function sendEmail(msg: EmailMessage): Promise<boolean> {
  const config = await getSendGridConfig();
  if (!config) {
    logger.info("Email not configured (SendGrid not connected); skipping send");
    return false;
  }

  const content: Array<{ type: string; value: string }> = [
    { type: "text/plain", value: msg.text },
  ];
  // SendGrid requires text/plain to precede text/html in the content array.
  if (msg.html) content.push({ type: "text/html", value: msg.html });

  try {
    const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
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
      return false;
    }
    return true;
  } catch (err) {
    logger.error({ err }, "SendGrid email send threw");
    return false;
  }
}
