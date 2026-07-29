import { db, paymentGatewaySettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

/**
 * Platform-wide active payment gateway selection ("razorpay" | "cashfree").
 *
 * A single superadmin-managed row in payment_gateway_settings decides which
 * gateway serves wallet top-ups, credit-pack purchases, and plan
 * subscriptions. When no row exists the default is "razorpay" so an existing
 * install keeps working untouched.
 *
 * Cached briefly (like the plan cache) so the hot billing paths don't hit the
 * DB on every request; the cache is invalidated whenever the setting is saved.
 */
export type PaymentGateway = "razorpay" | "cashfree";

const DEFAULT_GATEWAY: PaymentGateway = "razorpay";
const CACHE_TTL_MS = 30_000;

let cache: { gateway: PaymentGateway; expiresAt: number } | null = null;

export function invalidateGatewayCache(): void {
  cache = null;
}

function normalize(value: string | null | undefined): PaymentGateway {
  return value === "cashfree" ? "cashfree" : "razorpay";
}

/**
 * The active gateway. Falls back to "razorpay" if the row is missing or the
 * lookup fails — a broken settings read must never take down billing.
 */
export async function getActiveGateway(): Promise<PaymentGateway> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.gateway;

  let gateway: PaymentGateway = DEFAULT_GATEWAY;
  try {
    const [row] = await db.select().from(paymentGatewaySettingsTable).limit(1);
    gateway = normalize(row?.activeGateway);
  } catch (error) {
    logger.error(
      { err: error },
      "Failed to read payment_gateway_settings; defaulting to razorpay",
    );
    // Do NOT cache the degraded result so a recovered DB is picked up at once.
    return DEFAULT_GATEWAY;
  }

  cache = { gateway, expiresAt: now + CACHE_TTL_MS };
  return gateway;
}

/** Persist the active gateway (singleton row) and invalidate the cache. */
export async function setActiveGateway(
  gateway: PaymentGateway,
): Promise<PaymentGateway> {
  const [existing] = await db
    .select()
    .from(paymentGatewaySettingsTable)
    .limit(1);
  if (existing) {
    await db
      .update(paymentGatewaySettingsTable)
      .set({ activeGateway: gateway, updatedAt: new Date() })
      .where(eq(paymentGatewaySettingsTable.id, existing.id));
  } else {
    await db.insert(paymentGatewaySettingsTable).values({ activeGateway: gateway });
  }
  invalidateGatewayCache();
  return getActiveGateway();
}

/** Helper for routes: the active gateway, always resolved to a concrete value. */
export async function requireActiveGateway(): Promise<PaymentGateway> {
  return getActiveGateway();
}
