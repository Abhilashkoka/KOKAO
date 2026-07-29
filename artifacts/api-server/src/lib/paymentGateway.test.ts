import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { pool } from "@workspace/db";
import {
  getActiveGateway,
  setActiveGateway,
  invalidateGatewayCache,
} from "./paymentGateway";
import {
  snapshotPaymentGatewaySettings,
  restorePaymentGatewaySettings,
  setPaymentGatewaySettings,
} from "../test/dbHelpers";

let snapshot: Awaited<ReturnType<typeof snapshotPaymentGatewaySettings>>;

beforeEach(async () => {
  // The singleton row is GLOBAL and shared across concurrent runs; re-seed a
  // known baseline in beforeEach, not just once.
  snapshot = await snapshotPaymentGatewaySettings();
  invalidateGatewayCache();
});

afterAll(async () => {
  await restorePaymentGatewaySettings(snapshot);
  invalidateGatewayCache();
  await pool.end();
});

describe("active payment gateway", () => {
  it("defaults to razorpay when no row exists", async () => {
    await restorePaymentGatewaySettings(null);
    invalidateGatewayCache();
    expect(await getActiveGateway()).toBe("razorpay");
  });

  it("reads a persisted cashfree selection", async () => {
    await setPaymentGatewaySettings("cashfree");
    invalidateGatewayCache();
    expect(await getActiveGateway()).toBe("cashfree");
  });

  it("setActiveGateway persists and invalidates the cache", async () => {
    await setActiveGateway("cashfree");
    expect(await getActiveGateway()).toBe("cashfree");
    await setActiveGateway("razorpay");
    expect(await getActiveGateway()).toBe("razorpay");
  });

  it("caches the value until invalidated", async () => {
    await setActiveGateway("razorpay");
    expect(await getActiveGateway()).toBe("razorpay");
    // Change the row underneath WITHOUT going through setActiveGateway: the
    // cached value should persist until we invalidate.
    await setPaymentGatewaySettings("cashfree");
    expect(await getActiveGateway()).toBe("razorpay");
    invalidateGatewayCache();
    expect(await getActiveGateway()).toBe("cashfree");
  });
});
