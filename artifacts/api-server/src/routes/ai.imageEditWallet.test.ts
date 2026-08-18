/**
 * Wallet settle/refund ordering tests for POST /ai/edit-image and
 * POST /ai/image-op.
 *
 * Mirrors the harness in ai.generateImage.test.ts: mocked wallet/usage rails
 * and stubbed performImageEdit / runImageOp, so the tests cover the funding
 * settle/refund ordering in the routes themselves without running the real
 * providers or storage.
 *
 * Key invariants under test (per route):
 *  - When the work succeeds but settleWallet rejects: the route still
 *    returns 200, refundWallet is never called, and the failure is logged.
 *  - When recordUsage rejects after a wallet settle: still 200, no refund.
 *  - The provider-failure path refunds exactly once (sanity check that
 *    releaseFunding is correctly called on errors).
 */
import { describe, it, expect, afterAll, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

// ---------------------------------------------------------------------------
// Plan limits: images=0 forces credit/wallet funding, a high value = quota.
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
// Image edit pipeline: source loading + mask validation are stubbed to always
// pass (they run BEFORE funding, so they are out of scope here), and the
// actual edit is scriptable per test.
// ---------------------------------------------------------------------------
type EditOutcome = {
  imagePath: string;
  b64Json: string;
  meta: Record<string, unknown>;
};
let editScript: () => Promise<EditOutcome>;

vi.mock("../lib/imageEdit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/imageEdit")>();
  return {
    ...actual,
    loadSourceImage: vi.fn(async () => ({
      buffer: Buffer.from("fake-source-image"),
      mimeType: "image/png",
    })),
    decodeMask: vi.fn(() => Buffer.from("fake-mask")),
    assertMaskMatchesSource: vi.fn(async () => undefined),
    performImageEdit: vi.fn(async () => editScript()),
  };
});

// ---------------------------------------------------------------------------
// Editor ops: runImageOp scriptable; OP_UNITS pinned so `cutout` costs one
// unit (funded path) regardless of the real table.
// ---------------------------------------------------------------------------
type OpOutcome = EditOutcome & {
  width: number;
  height: number;
  sourceBox: null;
  layers: null;
  units: number;
};
let imageOpScript: () => Promise<OpOutcome>;

vi.mock("../lib/imageEditor/ops", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/imageEditor/ops")>();
  return {
    ...actual,
    OP_UNITS: { ...actual.OP_UNITS, cutout: 1 },
    runImageOp: vi.fn(async () => imageOpScript()),
  };
});

// ---------------------------------------------------------------------------
// Feature flags: keep the route happy without hitting the DB flag rows.
// ---------------------------------------------------------------------------
vi.mock("../lib/featureFlags", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/featureFlags")>();
  return {
    ...actual,
    isFeatureEnabled: vi.fn(async () => false),
    requireFeature: actual.requireFeature,
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
let logMock: {
  info: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
};

beforeEach(async () => {
  tenant = await createTenant();
  planState.images = 0;
  walletState.enabled = false;
  walletState.settleFails = false;
  usageState.recordFails = false;
  walletCalls.reserve.length = 0;
  walletCalls.settle.length = 0;
  walletCalls.refund.length = 0;

  editScript = async () => ({
    imagePath: "tenant/1/images/edited.png",
    b64Json: "aGVsbG8=",
    meta: { provider: "builtin", model: "gpt-image-1", costPaise: 800 },
  });
  imageOpScript = async () => ({
    imagePath: "tenant/1/images/op-result.png",
    b64Json: "d29ybGQ=",
    meta: { provider: "builtin", model: "gpt-image-1", costPaise: 600 },
    width: 512,
    height: 512,
    sourceBox: null,
    layers: null,
    units: 1,
  });

  logMock = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };

  const app = express();
  app.use(express.json({ limit: "25mb" }));
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

function postJson(
  path: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path,
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
    req.end(JSON.stringify(payload));
  });
}

function postEditImage() {
  return postJson("/ai/edit-image", {
    imagePath: `/objects/${tenant.tenantId}/uploads/source.png`,
    maskB64: Buffer.from("fake-mask-png").toString("base64"),
    prompt: "replace the sky with stars",
  });
}

// `cutout` is a maskless, funded op (OP_UNITS pinned to 1 in the mock).
function postImageOp() {
  return postJson("/ai/image-op", {
    imagePath: `/objects/${tenant.tenantId}/uploads/source.png`,
    op: "cutout",
  });
}

function errorLogged(substring: string): boolean {
  return (logMock.error.mock.calls as unknown[][]).some(
    (args) => typeof args[1] === "string" && args[1].includes(substring),
  );
}

async function usageRows() {
  return db.select().from(usageEventsTable).where(eq(usageEventsTable.tenantId, tenant.tenantId));
}

async function ledgerRows() {
  return db.select().from(creditLedgerTable).where(eq(creditLedgerTable.tenantId, tenant.tenantId));
}

// ---------------------------------------------------------------------------
// POST /ai/edit-image — wallet settle and refund ordering
// ---------------------------------------------------------------------------
describe("edit-image wallet billing", () => {
  it("wallet-funded success: settled exactly once, never refunded", async () => {
    walletState.enabled = true;

    const res = await postEditImage();
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

    const rows = await usageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].funding).toBe("wallet");
    expect(await ledgerRows()).toHaveLength(0);
  });

  it("wallet-funded failure: refunded exactly once, never settled", async () => {
    walletState.enabled = true;
    editScript = async () => {
      throw new Error("provider exploded");
    };

    const res = await postEditImage();
    expect(res.status).toBe(500);

    expect(walletCalls.reserve).toHaveLength(1);
    expect(walletCalls.settle).toHaveLength(0);
    expect(walletCalls.refund).toHaveLength(1);
    expect(await usageRows()).toHaveLength(0);
  });

  it("settleWallet rejection after a successful edit: returns 200, never refunds, logs the error", async () => {
    // Core regression guard: a settle failure must stay inside settleFunding's
    // catch — if it ever bubbled into the route's catch, releaseFunding would
    // refund a charge that actually went through.
    walletState.enabled = true;
    walletState.settleFails = true;

    const res = await postEditImage();

    expect(res.status).toBe(200);
    expect(res.body.imagePath).toBeTruthy();

    expect(walletCalls.reserve).toHaveLength(1);
    expect(walletCalls.settle).toHaveLength(1);
    expect(walletCalls.refund).toHaveLength(0);
    expect(errorLogged("Failed to settle wallet charge")).toBe(true);
  });

  it("recordUsage rejection after a wallet settle: returns 200, no refund, logs the error", async () => {
    walletState.enabled = true;
    usageState.recordFails = true;

    const res = await postEditImage();

    expect(res.status).toBe(200);
    expect(res.body.imagePath).toBeTruthy();

    expect(walletCalls.settle).toHaveLength(1);
    expect(walletCalls.refund).toHaveLength(0);
    expect(errorLogged("Failed to record usage after settling")).toBe(true);
    expect(await usageRows()).toHaveLength(0);
  });

  it("credit-funded: a recordUsage failure after success never refunds the spent credit", async () => {
    await grantCredits({
      tenantId: tenant.tenantId,
      captionCredits: 0,
      imageCredits: 1,
      kind: "admin_grant",
    });
    usageState.recordFails = true;

    const res = await postEditImage();
    expect(res.status).toBe(200);

    expect((await getCreditBalances(tenant.tenantId)).imageCredits).toBe(0);
    const kinds = (await ledgerRows()).map((r) => r.kind).sort();
    expect(kinds).toEqual(["admin_grant", "spend"]); // no refund
  });
});

// ---------------------------------------------------------------------------
// POST /ai/image-op — wallet settle and refund ordering
// ---------------------------------------------------------------------------
describe("image-op wallet billing", () => {
  it("wallet-funded success: settled exactly once, never refunded", async () => {
    walletState.enabled = true;

    const res = await postImageOp();
    expect(res.status).toBe(200);
    expect(res.body.imagePath).toBeTruthy();

    expect(walletCalls.reserve).toHaveLength(1);
    expect(walletCalls.settle).toHaveLength(1);
    expect(walletCalls.refund).toHaveLength(0);

    const rows = await usageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].funding).toBe("wallet");
  });

  it("wallet-funded failure: refunded exactly once, never settled", async () => {
    walletState.enabled = true;
    imageOpScript = async () => {
      throw new Error("provider exploded");
    };

    const res = await postImageOp();
    expect(res.status).toBe(500);

    expect(walletCalls.reserve).toHaveLength(1);
    expect(walletCalls.settle).toHaveLength(0);
    expect(walletCalls.refund).toHaveLength(1);
    expect(await usageRows()).toHaveLength(0);
  });

  it("settleWallet rejection after a successful op: returns 200, never refunds, logs the error", async () => {
    walletState.enabled = true;
    walletState.settleFails = true;

    const res = await postImageOp();

    expect(res.status).toBe(200);
    expect(res.body.imagePath).toBeTruthy();

    expect(walletCalls.reserve).toHaveLength(1);
    expect(walletCalls.settle).toHaveLength(1);
    expect(walletCalls.refund).toHaveLength(0);
    expect(errorLogged("Failed to settle wallet charge")).toBe(true);
  });

  it("recordUsage rejection after a wallet settle: returns 200, no refund, logs the error", async () => {
    walletState.enabled = true;
    usageState.recordFails = true;

    const res = await postImageOp();

    expect(res.status).toBe(200);
    expect(res.body.imagePath).toBeTruthy();

    expect(walletCalls.settle).toHaveLength(1);
    expect(walletCalls.refund).toHaveLength(0);
    expect(errorLogged("Failed to record usage after settling")).toBe(true);
    expect(await usageRows()).toHaveLength(0);
  });
});
