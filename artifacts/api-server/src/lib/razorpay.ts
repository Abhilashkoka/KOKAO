import { createHmac, timingSafeEqual } from "crypto";
import { db, appCredentialsTable, razorpayAppCredentialsSchema } from "@workspace/db";
import type { RazorpayAppCredentials } from "@workspace/db";
import { eq } from "drizzle-orm";
import { decryptJson } from "./secretCrypto";
import { platformFetch } from "./platformFetch";

/**
 * Minimal Razorpay REST client. Uses fetch with HTTP basic auth (Key ID /
 * Key Secret) instead of the SDK so calls are easy to bound with timeouts
 * and to mock in tests. All amounts are integers in paise (INR * 100).
 *
 * Credentials live in the encrypted app_credentials row "razorpay"
 * (superadmin-managed; no env fallback for the keys themselves). The API
 * base URL may be overridden outside production for a local mock server.
 */
export const RAZORPAY_PROVIDER = "razorpay";

function apiBase(): string {
  if (process.env.NODE_ENV !== "production" && process.env.RAZORPAY_API_BASE_URL) {
    return process.env.RAZORPAY_API_BASE_URL;
  }
  return "https://api.razorpay.com/v1";
}

export class RazorpayNotConfiguredError extends Error {
  constructor() {
    super("Razorpay is not configured. A superadmin must add API keys first.");
    this.name = "RazorpayNotConfiguredError";
  }
}

export class RazorpayApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "RazorpayApiError";
    this.status = status;
  }
}

/** Load and decrypt the stored Razorpay credentials, or null when unset. */
export async function getRazorpayCredentials(): Promise<RazorpayAppCredentials | null> {
  const row = (
    await db
      .select()
      .from(appCredentialsTable)
      .where(eq(appCredentialsTable.provider, RAZORPAY_PROVIDER))
      .limit(1)
  )[0];
  if (!row) return null;
  try {
    return razorpayAppCredentialsSchema.parse(
      decryptJson(row.encryptedCredentials),
    );
  } catch {
    return null;
  }
}

async function requireCredentials(): Promise<RazorpayAppCredentials> {
  const creds = await getRazorpayCredentials();
  if (!creds) throw new RazorpayNotConfiguredError();
  return creds;
}

/** Authenticated JSON request against the Razorpay API. */
export async function razorpayRequest<T>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const creds = await requireCredentials();
  const auth = Buffer.from(`${creds.keyId}:${creds.keySecret}`).toString("base64");
  const res = await platformFetch(`${apiBase()}${path}`, {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Basic ${auth}`,
      ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON error body; fall through with the raw text.
  }
  if (!res.ok) {
    const description =
      (json as { error?: { description?: string } } | null)?.error?.description ??
      text.slice(0, 200) ??
      "Razorpay request failed";
    throw new RazorpayApiError(res.status, description);
  }
  return json as T;
}

/** True when API keys are saved (webhook secret included). */
export async function isRazorpayConfigured(): Promise<boolean> {
  return (await getRazorpayCredentials()) !== null;
}

/** The publishable Key ID (safe for the browser Checkout widget). */
export async function getRazorpayKeyId(): Promise<string | null> {
  return (await getRazorpayCredentials())?.keyId ?? null;
}

/** Live credential test: list one payment (read-only, cheap). */
export async function testRazorpayCredentials(
  creds: RazorpayAppCredentials,
): Promise<{ ok: boolean; error: string | null }> {
  const auth = Buffer.from(`${creds.keyId}:${creds.keySecret}`).toString("base64");
  try {
    const res = await platformFetch(`${apiBase()}/payments?count=1`, {
      headers: { Authorization: `Basic ${auth}` },
    });
    if (!res.ok) {
      return { ok: false, error: `Razorpay rejected the keys (status ${res.status})` };
    }
    return { ok: true, error: null };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Connection failed",
    };
  }
}

function safeEqualHex(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(actual, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Verify the signature Razorpay Checkout returns after a one-time order
 * payment: HMAC-SHA256(order_id + "|" + payment_id, keySecret).
 */
export async function verifyPaymentSignature(params: {
  orderId: string;
  paymentId: string;
  signature: string;
}): Promise<boolean> {
  const creds = await requireCredentials();
  const expected = createHmac("sha256", creds.keySecret)
    .update(`${params.orderId}|${params.paymentId}`)
    .digest("hex");
  return safeEqualHex(expected, params.signature);
}

/**
 * Verify the signature Razorpay Checkout returns after a subscription
 * authorization: HMAC-SHA256(payment_id + "|" + subscription_id, keySecret).
 */
export async function verifySubscriptionSignature(params: {
  subscriptionId: string;
  paymentId: string;
  signature: string;
}): Promise<boolean> {
  const creds = await requireCredentials();
  const expected = createHmac("sha256", creds.keySecret)
    .update(`${params.paymentId}|${params.subscriptionId}`)
    .digest("hex");
  return safeEqualHex(expected, params.signature);
}

/** Verify a webhook payload against the configured webhook secret. */
export async function verifyWebhookSignature(
  rawBody: string,
  signature: string,
): Promise<boolean> {
  const creds = await getRazorpayCredentials();
  if (!creds || !signature) return false;
  const expected = createHmac("sha256", creds.webhookSecret)
    .update(rawBody)
    .digest("hex");
  return safeEqualHex(expected, signature);
}

// ---------- Typed API calls ----------

export interface RazorpayPlanEntity {
  id: string;
  item: { name: string; amount: number; currency: string };
}

export interface RazorpaySubscriptionEntity {
  id: string;
  plan_id: string;
  status: string;
  current_end: number | null;
  short_url?: string;
}

export interface RazorpayOrderEntity {
  id: string;
  amount: number;
  currency: string;
  status: string;
  notes?: Record<string, string>;
}

/**
 * Create a Razorpay Plan for a catalog plan's INR price. For yearly plans the
 * amount is the FULL 12-month price charged once per year.
 */
export async function createRazorpayPlan(
  name: string,
  pricePaise: number,
  period: "monthly" | "yearly" = "monthly",
): Promise<RazorpayPlanEntity> {
  return razorpayRequest<RazorpayPlanEntity>("/plans", {
    method: "POST",
    body: {
      period,
      interval: 1,
      item: {
        name: `${name} (${period})`,
        amount: pricePaise,
        currency: "INR",
      },
    },
  });
}

/** Create a subscription on a Razorpay Plan (charges via hosted Checkout). */
export async function createRazorpaySubscription(
  razorpayPlanId: string,
  notes: Record<string, string>,
  cycle: "monthly" | "yearly" = "monthly",
): Promise<RazorpaySubscriptionEntity> {
  return razorpayRequest<RazorpaySubscriptionEntity>("/subscriptions", {
    method: "POST",
    body: {
      plan_id: razorpayPlanId,
      // Effectively "until cancelled": 10 years of cycles either way.
      total_count: cycle === "yearly" ? 10 : 120,
      customer_notify: 0,
      notes,
    },
  });
}

export async function fetchRazorpaySubscription(
  subscriptionId: string,
): Promise<RazorpaySubscriptionEntity> {
  return razorpayRequest<RazorpaySubscriptionEntity>(
    `/subscriptions/${encodeURIComponent(subscriptionId)}`,
  );
}

/** Cancel a subscription (at cycle end by default so paid time is kept). */
export async function cancelRazorpaySubscription(
  subscriptionId: string,
  atCycleEnd = true,
): Promise<RazorpaySubscriptionEntity> {
  return razorpayRequest<RazorpaySubscriptionEntity>(
    `/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`,
    { method: "POST", body: { cancel_at_cycle_end: atCycleEnd ? 1 : 0 } },
  );
}

/** Create a one-time order (credit pack purchase). */
export async function createRazorpayOrder(params: {
  amountPaise: number;
  receipt: string;
  notes: Record<string, string>;
}): Promise<RazorpayOrderEntity> {
  return razorpayRequest<RazorpayOrderEntity>("/orders", {
    method: "POST",
    body: {
      amount: params.amountPaise,
      currency: "INR",
      receipt: params.receipt,
      notes: params.notes,
    },
  });
}

/** Fetch an order (used to cross-check amount/status before crediting). */
export async function fetchRazorpayOrder(
  orderId: string,
): Promise<RazorpayOrderEntity> {
  return razorpayRequest<RazorpayOrderEntity>(
    `/orders/${encodeURIComponent(orderId)}`,
  );
}
