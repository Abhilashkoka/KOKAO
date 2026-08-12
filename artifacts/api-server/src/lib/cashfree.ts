import { createHmac, randomUUID, timingSafeEqual } from "crypto";
import { z } from "zod/v4";
import { db, appCredentialsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { decryptJson } from "./secretCrypto";
import { platformFetch } from "./platformFetch";

/**
 * Minimal Cashfree Payment Gateway REST client. Uses `platformFetch` (bounded
 * timeout, terminal on timeout — never retried) with header auth so calls are
 * easy to mock in tests. Secrets NEVER appear in URLs.
 *
 * Credentials live in the encrypted app_credentials row "cashfree"
 * (superadmin-managed; no env fallback). The stored JSON is
 * {appId, secretKey, mode} where mode is "sandbox" | "production".
 *
 * All money is integer PAISE internally; Cashfree wants rupee decimals, so
 * amounts are converted with (paise/100).toFixed(2) at the boundary only.
 */
export const CASHFREE_PROVIDER = "cashfree";

export const cashfreeAppCredentialsSchema = z.object({
  appId: z.string(),
  secretKey: z.string(),
  mode: z.enum(["sandbox", "production"]),
});
export type CashfreeAppCredentials = z.infer<typeof cashfreeAppCredentialsSchema>;

const CASHFREE_API_VERSION = "2023-08-01";

function apiBase(mode: CashfreeAppCredentials["mode"]): string {
  if (process.env.NODE_ENV !== "production" && process.env.CASHFREE_API_BASE_URL) {
    return process.env.CASHFREE_API_BASE_URL;
  }
  return mode === "production"
    ? "https://api.cashfree.com/pg"
    : "https://sandbox.cashfree.com/pg";
}

export class CashfreeNotConfiguredError extends Error {
  constructor() {
    super("Cashfree is not configured. A superadmin must add API keys first.");
    this.name = "CashfreeNotConfiguredError";
  }
}

export class CashfreeApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "CashfreeApiError";
    this.status = status;
  }
}

/** Load and decrypt the stored Cashfree credentials, or null when unset. */
export async function getCashfreeCredentials(): Promise<CashfreeAppCredentials | null> {
  const row = (
    await db
      .select()
      .from(appCredentialsTable)
      .where(eq(appCredentialsTable.provider, CASHFREE_PROVIDER))
      .limit(1)
  )[0];
  if (!row) return null;
  try {
    return cashfreeAppCredentialsSchema.parse(decryptJson(row.encryptedCredentials));
  } catch {
    return null;
  }
}

async function requireCredentials(): Promise<CashfreeAppCredentials> {
  const creds = await getCashfreeCredentials();
  if (!creds) throw new CashfreeNotConfiguredError();
  return creds;
}

/** True when Cashfree API keys are saved. */
export async function isCashfreeConfigured(): Promise<boolean> {
  return (await getCashfreeCredentials()) !== null;
}

function authHeaders(creds: CashfreeAppCredentials): Record<string, string> {
  return {
    "x-client-id": creds.appId,
    "x-client-secret": creds.secretKey,
    "x-api-version": CASHFREE_API_VERSION,
    "Content-Type": "application/json",
  };
}

/** Authenticated JSON request against the Cashfree PG API. */
async function cashfreeRequest<T>(
  creds: CashfreeAppCredentials,
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await platformFetch(`${apiBase(creds.mode)}${path}`, {
    method: options.method ?? "GET",
    headers: authHeaders(creds),
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON error body; fall through with raw text.
  }
  if (!res.ok) {
    const message =
      (json as { message?: string } | null)?.message ??
      text.slice(0, 200) ??
      "Cashfree request failed";
    throw new CashfreeApiError(res.status, message);
  }
  return json as T;
}

/**
 * Live credential test. Cashfree has no cheap read-only "list" endpoint, so we
 * fetch a deliberately-nonexistent order: valid keys answer 404 with a proper
 * error body, bad keys answer 401/403. Anything else surfaces as a failure.
 */
export async function testCashfreeCredentials(
  creds: CashfreeAppCredentials,
): Promise<{ ok: boolean; error: string | null }> {
  try {
    const probe = `kokao_cred_test_${randomUUID().replace(/-/g, "")}`;
    const res = await platformFetch(
      `${apiBase(creds.mode)}/orders/${encodeURIComponent(probe)}`,
      { headers: authHeaders(creds) },
    );
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: `Cashfree rejected the keys (status ${res.status})` };
    }
    // 404 (order not found) or 2xx both mean the keys authenticated.
    if (res.status === 404 || res.ok) {
      return { ok: true, error: null };
    }
    return { ok: false, error: `Cashfree returned an unexpected status ${res.status}` };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Connection failed",
    };
  }
}

// ---------- amount helpers ----------

/** Paise → Cashfree rupee decimal (2dp). 100_000 paise → 1000.00 */
export function paiseToRupees(paise: number): number {
  return Number((paise / 100).toFixed(2));
}

/** Cashfree rupee decimal → paise. 1000.00 → 100_000 */
export function rupeesToPaise(rupees: number | string): number {
  return Math.round(Number(rupees) * 100);
}

// ---------- typed entities ----------

export interface CashfreeOrderResult {
  orderId: string;
  paymentSessionId: string;
}

export interface CashfreeOrderEntity {
  order_id: string;
  order_amount: number;
  order_currency: string;
  order_status: string;
  order_tags?: Record<string, string> | null;
  order_note?: string | null;
}

export interface CashfreePlanEntity {
  plan_id: string;
  plan_status?: string;
}

export interface CashfreeSubscriptionResult {
  subscriptionId: string;
  subscriptionSessionId: string;
}

export interface CashfreeSubscriptionEntity {
  subscription_id: string;
  subscription_status: string;
  plan_details?: { plan_id?: string };
  current_cycle?: { cycle_end_time?: string } | null;
}

/** A stable Cashfree id namespaced to KOKAO. */
function newId(prefix: string): string {
  return `kokao_${prefix}_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

// ---------- orders (one-time: wallet top-ups + credit packs) ----------

/**
 * Create a one-time order. `order_tags` carry purpose/tenantId + the amount
 * split exactly like Razorpay order notes, so verification/backstop credit the
 * canonical amount. Cashfree requires a customer phone; a placeholder is used
 * when the tenant has none.
 */
export async function createCashfreeOrder(params: {
  amountPaise: number;
  orderId?: string;
  customer: { id: string; email?: string | null; phone?: string | null };
  tags: Record<string, string>;
  note?: string;
}): Promise<CashfreeOrderResult> {
  const creds = await requireCredentials();
  const orderId = params.orderId ?? newId("w");
  const res = await cashfreeRequest<{ order_id: string; payment_session_id: string }>(
    creds,
    "/orders",
    {
      method: "POST",
      body: {
        order_id: orderId,
        order_amount: paiseToRupees(params.amountPaise),
        order_currency: "INR",
        customer_details: {
          customer_id: params.customer.id,
          customer_email: params.customer.email || "noreply@kokao.in",
          customer_phone: params.customer.phone || "9999999999",
        },
        order_note: params.note ?? params.tags.purpose ?? "KOKAO",
        order_tags: params.tags,
      },
    },
  );
  return { orderId: res.order_id, paymentSessionId: res.payment_session_id };
}

/**
 * Fetch the canonical order. PAID is the only success status; callers must
 * re-fetch and require PAID before crediting (never trust client/webhook).
 */
export async function getCashfreeOrder(
  orderId: string,
): Promise<CashfreeOrderEntity> {
  const creds = await requireCredentials();
  return cashfreeRequest<CashfreeOrderEntity>(
    creds,
    `/orders/${encodeURIComponent(orderId)}`,
  );
}

// ---------- plans + subscriptions ----------

/** Create a periodic plan for a catalog plan's INR price. */
export async function createCashfreePlan(params: {
  planId: string;
  name: string;
  amountPaise: number;
  intervalType: "MONTH" | "YEAR";
}): Promise<CashfreePlanEntity> {
  const creds = await requireCredentials();
  const cyclePlanId = `kokao_${params.planId}_${
    params.intervalType === "YEAR" ? "yearly" : "monthly"
  }_${Date.now()}`;
  const rupees = paiseToRupees(params.amountPaise);
  return cashfreeRequest<CashfreePlanEntity>(creds, "/plans", {
    method: "POST",
    body: {
      plan_id: cyclePlanId,
      // Cashfree rejects most punctuation in plan names ("allows only alpha
      // numerics & few special characters") — parentheses are not allowed,
      // so sanitize the admin-entered name and join with a plain hyphen.
      plan_name: `${params.name.replace(/[^\w ]/g, " ").replace(/\s+/g, " ").trim() || "Plan"} - ${
        params.intervalType === "YEAR" ? "yearly" : "monthly"
      }`,
      plan_type: "PERIODIC",
      plan_currency: "INR",
      plan_recurring_amount: rupees,
      plan_max_amount: rupees,
      plan_max_cycles: params.intervalType === "YEAR" ? 10 : 120,
      plan_intervals: 1,
      plan_interval_type: params.intervalType,
    },
  });
}

/** Create a subscription on a Cashfree plan (charges via the JS SDK checkout). */
export async function createCashfreeSubscription(params: {
  subscriptionId?: string;
  planId: string;
  customer: { id: string; email?: string | null; phone?: string | null };
  tags?: Record<string, string>;
  expiryTime?: string;
}): Promise<CashfreeSubscriptionResult> {
  const creds = await requireCredentials();
  const subscriptionId = params.subscriptionId ?? newId("sub");
  // Default expiry: ~10 years out (effectively "until cancelled").
  const expiry =
    params.expiryTime ??
    new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000).toISOString();
  const res = await cashfreeRequest<{
    subscription_id: string;
    subscription_session_id: string;
  }>(creds, "/subscriptions", {
    method: "POST",
    body: {
      subscription_id: subscriptionId,
      plan_details: { plan_id: params.planId },
      customer_details: {
        customer_id: params.customer.id,
        customer_email: params.customer.email || "noreply@kokao.in",
        customer_phone: params.customer.phone || "9999999999",
      },
      subscription_expiry_time: expiry,
      ...(params.tags ? { subscription_tags: params.tags } : {}),
    },
  });
  return {
    subscriptionId: res.subscription_id,
    subscriptionSessionId: res.subscription_session_id,
  };
}

export async function getCashfreeSubscription(
  subscriptionId: string,
): Promise<CashfreeSubscriptionEntity> {
  const creds = await requireCredentials();
  return cashfreeRequest<CashfreeSubscriptionEntity>(
    creds,
    `/subscriptions/${encodeURIComponent(subscriptionId)}`,
  );
}

export async function cancelCashfreeSubscription(
  subscriptionId: string,
): Promise<CashfreeSubscriptionEntity> {
  const creds = await requireCredentials();
  return cashfreeRequest<CashfreeSubscriptionEntity>(
    creds,
    `/subscriptions/${encodeURIComponent(subscriptionId)}/manage`,
    { method: "POST", body: { action: "CANCEL" } },
  );
}

// ---------- subscription status mapping ----------

/** ACTIVE (and BANK_APPROVAL_PENDING eMandate) map to entitlement. */
export function isCashfreeEntitledStatus(status: string): boolean {
  return status === "ACTIVE";
}

/** Statuses that are still in-flight (not yet paid, not yet failed). */
export function isCashfreePendingStatus(status: string): boolean {
  return status === "INITIALIZED" || status === "BANK_APPROVAL_PENDING";
}

// ---------- webhook signature ----------

function safeEqualB64(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(actual, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Verify a Cashfree webhook signature: the x-webhook-signature header is
 * base64(HMAC-SHA256(timestamp + rawBody, secretKey)). Compared timing-safe.
 */
export async function verifyCashfreeWebhookSignature(params: {
  rawBody: string;
  timestamp: string;
  signature: string;
}): Promise<boolean> {
  const creds = await getCashfreeCredentials();
  if (!creds || !params.signature || !params.timestamp) return false;
  const expected = createHmac("sha256", creds.secretKey)
    .update(params.timestamp + params.rawBody)
    .digest("base64");
  return safeEqualB64(expected, params.signature);
}
