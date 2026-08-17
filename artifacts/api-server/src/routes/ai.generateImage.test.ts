/**
 * Billing tests for POST /ai/generate-image.
 *
 * Mirrors the harness in ai.carouselJson.test.ts: mocked wallet/usage rails
 * and a stubbed performImageGeneration, so the tests cover the funding
 * settle/refund ordering in the route itself without running the full
 * image-generation pipeline.
 *
 * Key invariants under test:
 *  - When the image succeeds but settleWallet rejects: the route still
 *    returns 200, refundWallet is never called, and the failure is logged.
 *  - When recordUsage rejects after a wallet settle: still 200, no refund.
 *  - The image-generation failure path refunds exactly once (sanity check
 *    that releaseFunding is correctly called on provider errors).
 */
import { describe, it, expect, afterAll, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

// ---------------------------------------------------------------------------
// Plan limits: images=0 forces credit funding, a high value gives quota.
// ---------------------------------------------------------------------------
const planState = { images: 0 };
vi.mock("../lib/plans", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/plans")>();
  return {
    ...actual,
    getPlanLimits: vi.fn(async () => ({
      captions: 0,
      images: planState.images,
      videos: 0,
      teamSeats: 0,
    })),
  };
});

// ---------------------------------------------------------------------------
// Wallet rail: controllable so tests can assert on reserve/settle/refund
// counts without touching the platform kill switch or tenant billingMode.
// ---------------------------------------------------------------------------
const walletState = { enabled: false, settleFails: false };
const walletCalls = {
  reserve: [] as unknown[],
  settle: [] as unknown[],
  refund: [] as unknown[],
};
vi.mock("../lib/wallet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/wallet")>();
  return {
    ...actual,
    isWalletFunded: vi.fn(async () => walletState.enabled),
    reserveWallet: vi.fn(async (tenantId: number, kind: string) => {
      walletCalls.reserve.push({ tenantId, kind });
      return { id: 99001, amountPaise: 1000, units: 1 };
    }),
    settleWallet: vi.fn(async (tenantId: number, reservation: unknown, meta: unknown) => {
      walletCalls.settle.push({ tenantId, reservation, meta });
      if (walletState.settleFails) throw new Error("settle exploded");
      return { chargedPaise: 1000, estimated: false, balancePaise: 0 };
    }),
    refundWallet: vi.fn(async (tenantId: number, reservation: unknown, note?: string) => {
      walletCalls.refund.push({ tenantId, reservation, note });
    }),
  };
});

// ---------------------------------------------------------------------------
// Usage metering: passes through to real recordUsage unless recordFails=true.
// ---------------------------------------------------------------------------
const usageState = { recordFails: false };
vi.mock("../lib/usage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/usage")>();
  return {
    ...actual,
    recordUsage: vi.fn(async (...args: Parameters<typeof actual.recordUsage>) => {
      if (usageState.recordFails) throw new Error("usage write exploded");
      return actual.recordUsage(...args);
    }),
  };
});

// ---------------------------------------------------------------------------
// Image generation pipeline: controllable success/failure without running
// the real provider call, prompt assembly, or storage upload.
// ---------------------------------------------------------------------------
type ImageOutcome = {
  imagePath: string;
  b64Json: string;
  meta: Record<string, unknown>;
};
let imageGenScript: () => Promise<ImageOutcome>;

vi.mock("../lib/imageGeneration", () => ({
  performImageGeneration: vi.fn(async () => imageGenScript()),
}));

// ---------------------------------------------------------------------------
// Feature flags and Prompt Kit: keep the route happy without hitting the DB.
// ---------------------------------------------------------------------------
vi.mock("../lib/featureFlags", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/featureFlags")>();
  return {
    ...actual,
    isFeatureEnabled: vi.fn(async () => false),
    requireFeature: actual.requireFeature,
  };
});

vi.mock("../lib/promptKit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/promptKit")>();
  return {
    ...actual,
    getGovernedPrompt: vi.fn(async () => null),
    logCompiledPrompt: vi.fn(async () => undefined),
  };
});

// ---------------------------------------------------------------------------
// Imports — after all vi.mock() calls so Vitest hoists correctly.
// ---------------------------------------------------------------------------
import { db, pool, usageEventsTable, creditLedgerTable, creditBalancesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import aiRouter from "./ai";
import { grantCredits, getCreditBalances } from "../lib/credits";
import { createTenant, deleteTenant, type TestTenant } from "../test/dbHelpers";

let server: http.Server;
let port: number;
let tenant: TestTenant;
let logMock: { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> };

beforeEach(async () => {
  tenant = await createTenant();
  planState.images = 0;
  walletState.enabled = false;
  walletState.settleFails = false;
  usageState.recordFails = false;
  walletCalls.reserve.length = 0;
  walletCalls.settle.length = 0;
  walletCalls.refund.length = 0;

  // Default: generation succeeds with minimal meta.
  imageGenScript = async () => ({
    imagePath: "tenant/1/images/test.png",
    b64Json: "aGVsbG8=",
    meta: { provider: "builtin", model: "dall-e-3", costPaise: 800 },
  });

  logMock = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { tenantId: number }).tenantId = tenant.tenantId;
    (req as unknown as { log: unknown }).log = logMock;
    next();
  });
  app.use(aiRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      port = (server.address() as AddressInfo).port;
      resolve();
    });
  });
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.delete(usageEventsTable).where(eq(usageEventsTable.tenantId, tenant.tenantId));
  await db.delete(creditLedgerTable).where(eq(creditLedgerTable.tenantId, tenant.tenantId));
  await db.delete(creditBalancesTable).where(eq(creditBalancesTable.tenantId, tenant.tenantId));
  await deleteTenant(tenant.tenantId);
});

afterAll(async () => {
  await pool.end();
});

function postImage(): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/ai/generate-image",
        headers: { "Content-Type": "application/json" },
      },
      (res) => {
        let buf = "";
        res.on("data", (c: Buffer) => (buf += c.toString()));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: JSON.parse(buf || "{}") as Record<string, unknown>,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify({ prompt: "A mountain at sunset" }));
  });
}

async function usageRows() {
  return db.select().from(usageEventsTable).where(eq(usageEventsTable.tenantId, tenant.tenantId));
}

async function ledgerRows() {
  return db.select().from(creditLedgerTable).where(eq(creditLedgerTable.tenantId, tenant.tenantId));
}

// ---------------------------------------------------------------------------
// Core billing invariants
// ---------------------------------------------------------------------------
describe("image generation endpoint billing", () => {
  it("records exactly one quota-funded usage event on success", async () => {
    planState.images = 100; // quota funding

    const res = await postImage();
    expect(res.status).toBe(200);
    expect(res.body.imagePath).toBeTruthy();

    const rows = await usageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("image");
    expect(rows[0].funding).toBe("quota");
    expect(await ledgerRows()).toHaveLength(0);
  });

  it("records exactly one credit-funded usage event on success (credit stays spent)", async () => {
    await grantCredits({
      tenantId: tenant.tenantId,
      captionCredits: 0,
      imageCredits: 1,
      kind: "admin_grant",
    });

    const res = await postImage();
    expect(res.status).toBe(200);

    const rows = await usageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("image");
    expect(rows[0].funding).toBe("credit");
    expect((await getCreditBalances(tenant.tenantId)).imageCredits).toBe(0);
    const kinds = (await ledgerRows()).map((r) => r.kind).sort();
    expect(kinds).toEqual(["admin_grant", "spend"]); // no refund
  });

  it("refunds the reserved credit when the image provider throws", async () => {
    await grantCredits({
      tenantId: tenant.tenantId,
      captionCredits: 0,
      imageCredits: 1,
      kind: "admin_grant",
    });

    imageGenScript = async () => {
      throw new Error("provider exploded");
    };

    const res = await postImage();
    expect(res.status).toBe(500);

    // Reservation must be returned: balance restored, spend+refund in ledger.
    expect((await getCreditBalances(tenant.tenantId)).imageCredits).toBe(1);
    const kinds = (await ledgerRows()).map((r) => r.kind).sort();
    expect(kinds).toEqual(["admin_grant", "refund", "spend"]);
    const refund = (await ledgerRows()).find((r) => r.kind === "refund")!;
    expect(refund.imageDelta).toBe(1);
    expect(await usageRows()).toHaveLength(0);
  });

  it("returns 402 and spends nothing when quota and credits are both exhausted", async () => {
    // planState.images = 0 and no image credits granted.
    imageGenScript = async () => {
      throw new Error("must not be called");
    };

    const res = await postImage();
    expect(res.status).toBe(402);

    expect(await usageRows()).toHaveLength(0);
    expect(await ledgerRows()).toHaveLength(0);
    expect((await getCreditBalances(tenant.tenantId)).imageCredits).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Wallet rail: settle and refund ordering
// ---------------------------------------------------------------------------
describe("image generation wallet billing", () => {
  it("wallet-funded success: settled exactly once, never refunded", async () => {
    walletState.enabled = true;

    const res = await postImage();
    expect(res.status).toBe(200);
    expect(res.body.imagePath).toBeTruthy();

    expect(walletCalls.reserve).toHaveLength(1);
    expect(walletCalls.settle).toHaveLength(1);
    expect(walletCalls.refund).toHaveLength(0);
    expect(walletCalls.settle[0]).toMatchObject({
      tenantId: tenant.tenantId,
      reservation: { id: 99001, amountPaise: 1000, units: 1 },
      meta: { kind: "image" },
    });

    // Wallet-funded: one usage row, credit ledger untouched.
    const rows = await usageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].funding).toBe("wallet");
    expect(await ledgerRows()).toHaveLength(0);
  });

  it("wallet-funded failure: refunded exactly once, never settled", async () => {
    walletState.enabled = true;
    imageGenScript = async () => {
      throw new Error("provider down");
    };

    const res = await postImage();
    expect(res.status).toBe(500);

    expect(walletCalls.reserve).toHaveLength(1);
    expect(walletCalls.settle).toHaveLength(0);
    expect(walletCalls.refund).toHaveLength(1);
    expect(walletCalls.refund[0]).toMatchObject({
      tenantId: tenant.tenantId,
      reservation: { id: 99001, amountPaise: 1000, units: 1 },
    });

    // Nothing charged anywhere.
    expect(await usageRows()).toHaveLength(0);
    expect(await ledgerRows()).toHaveLength(0);
  });

  it("settleWallet rejection after a successful image: returns 200, never refunds, logs the error", async () => {
    // This is the core regression guard: if settleFunding's internal catch
    // were removed or broken, a settle failure could bubble into the route's
    // catch block where releaseFunding would refund a charge that actually
    // went through (because funding.resolved is set before the settle attempt).
    walletState.enabled = true;
    walletState.settleFails = true;

    const res = await postImage();

    // The image was produced and stored — the client must receive it.
    expect(res.status).toBe(200);
    expect(res.body.imagePath).toBeTruthy();

    // Settle was attempted (and failed), but refund must NEVER follow.
    expect(walletCalls.reserve).toHaveLength(1);
    expect(walletCalls.settle).toHaveLength(1);
    expect(walletCalls.refund).toHaveLength(0);

    // The failure must be surfaced in the logs so it is observable.
    const errorCalls: unknown[][] = logMock.error.mock.calls;
    const settleErrorLogged = errorCalls.some(
      (args) =>
        typeof args[1] === "string" && args[1].includes("Failed to settle wallet charge"),
    );
    expect(settleErrorLogged).toBe(true);
  });

  it("recordUsage rejection after a wallet settle: returns 200, no refund, logs the error", async () => {
    // A recordUsage failure inside settleFunding must not be re-thrown into
    // the route's catch block — doing so would trigger a refund of an already-
    // settled charge.
    walletState.enabled = true;
    usageState.recordFails = true;

    const res = await postImage();

    // Image was delivered; the missing usage row is acceptable (best-effort).
    expect(res.status).toBe(200);
    expect(res.body.imagePath).toBeTruthy();

    // Settled (successful), never refunded.
    expect(walletCalls.settle).toHaveLength(1);
    expect(walletCalls.refund).toHaveLength(0);

    // recordUsage failure must appear in the logs.
    const errorCalls: unknown[][] = logMock.error.mock.calls;
    const usageErrorLogged = errorCalls.some(
      (args) =>
        typeof args[1] === "string" && args[1].includes("Failed to record usage after settling"),
    );
    expect(usageErrorLogged).toBe(true);

    // No usage row was written (the write threw).
    expect(await usageRows()).toHaveLength(0);
    // Credit ledger is untouched (wallet path).
    expect(await ledgerRows()).toHaveLength(0);
  });
});
