/**
 * Whole-flow billing coverage for POST /ai/generate-image.
 *
 * The image pipeline, route funding, provider meter, and billing ledgers are
 * real. Only the provider SDK call and object-storage PUT are replaced.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";

const planState = { images: 5 };
const featureState = { wallet: false };
const providerState: { beforeReturn: (() => Promise<void>) | null } = {
  beforeReturn: null,
};
type TasteBarrier = {
  entered: Promise<void>;
  released: Promise<void>;
  markEntered: () => void;
  release: () => void;
};
const tasteBarrierState: { current: TasteBarrier | null } = { current: null };

const imageGenerate = vi.fn(async (..._args: unknown[]) => {
  await providerState.beforeReturn?.();
  return {
    data: [{ b64_json: Buffer.from("generated-image").toString("base64") }],
    usage: { input_tokens: 11, output_tokens: 22 },
  };
});

// Keep the real OpenAI image adapter and meter; this is the SDK/HTTP boundary.
vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: {
    images: {
      generate: (...args: unknown[]) => imageGenerate(...args),
      edit: vi.fn(),
    },
    chat: { completions: { create: vi.fn() } },
    responses: { create: vi.fn() },
  },
  toFile: async (buffer: Buffer, name: string, options: { type: string }) => ({
    buffer,
    name,
    type: options.type,
  }),
}));

// The sidecar signs the upload in production. Keep generation's upload and
// path normalization real while replacing that external boundary.
vi.mock("../lib/objectStorage", () => ({
  ObjectStorageService: class {
    async getObjectEntityUploadURL(tenantId: number): Promise<string> {
      return `https://upload.test/${tenantId}/uploads/generated.png`;
    }

    normalizeObjectEntityPath(rawPath: string): string {
      const match = rawPath.match(/^https:\/\/upload\.test\/(\d+)\/(.+)$/);
      return match ? `/objects/${match[1]}/${match[2]}` : rawPath;
    }
  },
}));

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

// The production gate is intentionally no-go until reconciliation. This file
// exercises the real enforce path behind an explicit test-only go decision.
vi.mock("../lib/creditReconciliationGate", () => ({
  CREDIT_RECONCILIATION_GATE: {
    verdict: "go",
    reason: "whole-flow billing test",
  },
}));

vi.mock("../lib/featureFlags", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/featureFlags")>();
  return {
    ...actual,
    isFeatureEnabled: vi.fn(async (key: string) =>
      key === "wallet" ? featureState.wallet : false,
    ),
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

// This keeps the real prompt pipeline but provides a deterministic point after
// route funding and before the provider meter dispatch.
vi.mock("../lib/brandKit/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/brandKit/service")>();
  return {
    ...actual,
    loadActivePayload: vi.fn(async (...args: unknown[]) => {
      const barrier = tasteBarrierState.current;
      if (barrier) {
        barrier.markEntered();
        await barrier.released;
      }
      return actual.loadActivePayload(...(args as Parameters<typeof actual.loadActivePayload>));
    }),
  };
});

import {
  db,
  creditAccountLedgerTable,
  creditAccountsTable,
  creditMeterEventsTable,
  creditRatesTable,
  imageGenSettingsTable,
  pool,
  tenantsTable,
  usageEventsTable,
  walletBalancesTable,
  walletLedgerTable,
  walletProviderOperationsTable,
  walletSettlementRetriesTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import aiRouter from "./ai";
import { grantCredits, getCreditBalance } from "../lib/creditAccounts";
import {
  adminAdjustWallet,
  estimateChargePaise,
  getWalletBalancePaise,
} from "../lib/wallet";
import {
  deleteCreditRate,
  getMeterMode,
  setMeterMode,
  upsertCreditRate,
  type MeterMode,
} from "../lib/creditRates";
import { setImageGenSelection } from "../lib/imageGen";
import { createTenant, deleteTenant, type TestTenant } from "../test/dbHelpers";

let tenant: TestTenant;
let originalMeterMode: MeterMode;
let originalImageSelection: typeof imageGenSettingsTable.$inferSelect | null;
let originalImageRate: typeof creditRatesTable.$inferSelect | null;
const uploadFetch = vi.fn(async () => new Response(null, { status: 200 }));

function makeTasteBarrier(): TasteBarrier {
  let enteredResolve!: () => void;
  let releaseResolve!: () => void;
  const entered = new Promise<void>((resolve) => {
    enteredResolve = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseResolve = resolve;
  });
  const barrier = {
    entered,
    released,
    release: releaseResolve,
    markEntered: enteredResolve,
  };
  tasteBarrierState.current = barrier;
  return barrier;
}

function createApp(tenantId: number, clerkUserId: string): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { tenantId: number }).tenantId = tenantId;
    (req as unknown as { clerkUserId: string }).clerkUserId = clerkUserId;
    (req as unknown as { log: Record<string, () => void> }).log = {
      info() {},
      error() {},
      warn() {},
      debug() {},
    };
    next();
  });
  app.use(aiRouter);
  return app;
}

async function setBillingMode(mode: "quota" | "wallet" | "credits"): Promise<void> {
  await db
    .update(tenantsTable)
    .set({ billingMode: mode })
    .where(eq(tenantsTable.id, tenant.tenantId));
}

async function cleanupTenantRows(tenantId: number): Promise<void> {
  await db.delete(usageEventsTable).where(eq(usageEventsTable.tenantId, tenantId));
  await db.delete(creditMeterEventsTable).where(eq(creditMeterEventsTable.tenantId, tenantId));
  await db.delete(creditAccountLedgerTable).where(eq(creditAccountLedgerTable.tenantId, tenantId));
  await db.delete(creditAccountsTable).where(eq(creditAccountsTable.tenantId, tenantId));
  await db.delete(walletProviderOperationsTable).where(eq(walletProviderOperationsTable.tenantId, tenantId));
  await db.delete(walletSettlementRetriesTable).where(eq(walletSettlementRetriesTable.tenantId, tenantId));
  await db.delete(walletLedgerTable).where(eq(walletLedgerTable.tenantId, tenantId));
  await db.delete(walletBalancesTable).where(eq(walletBalancesTable.tenantId, tenantId));
}

beforeAll(async () => {
  originalMeterMode = await getMeterMode();
  originalImageSelection =
    (await db.select().from(imageGenSettingsTable).limit(1))[0] ?? null;
  originalImageRate =
    (await db
      .select()
      .from(creditRatesTable)
      .where(eq(creditRatesTable.key, "image"))
      .limit(1))[0] ?? null;
  await upsertCreditRate({
    key: "image",
    label: "Image generation (billing fixture)",
    unit: "item",
    credits: 3,
    active: true,
    sortOrder: 30,
    notes: "whole-flow billing test",
  });
  await setImageGenSelection({
    provider: "openai",
    model: null,
    customBaseUrl: null,
    fallbackEnabled: false,
  });
  vi.stubGlobal("fetch", uploadFetch);
});

beforeEach(async () => {
  tenant = await createTenant();
  planState.images = 5;
  featureState.wallet = false;
  providerState.beforeReturn = null;
  imageGenerate.mockClear();
  uploadFetch.mockClear();
  await db
    .update(tenantsTable)
    .set({ designSkillEnabled: false })
    .where(eq(tenantsTable.id, tenant.tenantId));
  await setMeterMode("shadow");
});

afterEach(async () => {
  tasteBarrierState.current?.release();
  tasteBarrierState.current = null;
  await setMeterMode("shadow");
  await cleanupTenantRows(tenant.tenantId);
  await deleteTenant(tenant.tenantId);
  providerState.beforeReturn = null;
  featureState.wallet = false;
});

afterAll(async () => {
  await setMeterMode(originalMeterMode);
  await db.delete(imageGenSettingsTable);
  if (originalImageSelection) {
    await db.insert(imageGenSettingsTable).values(originalImageSelection);
  }
  if (originalImageRate) {
    await upsertCreditRate({
      key: originalImageRate.key,
      label: originalImageRate.label,
      unit: originalImageRate.unit === "second" ? "second" : "item",
      credits: originalImageRate.creditsMilli / 1000,
      active: originalImageRate.active,
      sortOrder: originalImageRate.sortOrder,
      notes: originalImageRate.notes,
    });
  } else {
    await deleteCreditRate("image");
  }
  vi.unstubAllGlobals();
  await pool.end();
});

describe("POST /ai/generate-image billing rails", () => {
  it("uses the real quota reservation and records one successful metered image", async () => {
    await setBillingMode("quota");
    const app = createApp(tenant.tenantId, tenant.clerkUserId);

    const response = await request(app)
      .post("/ai/generate-image")
      .send({ prompt: "A mountain at sunset" });

    expect(response.status).toBe(200);
    expect(response.body.imagePath).toBe(
      `/objects/${tenant.tenantId}/uploads/generated.png`,
    );
    expect(imageGenerate).toHaveBeenCalledTimes(1);

    const usage = await db
      .select()
      .from(usageEventsTable)
      .where(eq(usageEventsTable.tenantId, tenant.tenantId));
    expect(usage).toHaveLength(1);
    expect(usage[0].funding).toBe("quota");

    const meterEvents = await db
      .select()
      .from(creditMeterEventsTable)
      .where(eq(creditMeterEventsTable.tenantId, tenant.tenantId));
    expect(meterEvents).toHaveLength(1);
    expect(meterEvents[0]).toMatchObject({
      rateKey: "image",
      quantityMilli: 1000,
      creditsMilli: 3000,
      outcome: "ok",
      mode: "shadow",
    });
    expect(await getCreditBalance(tenant.tenantId)).toMatchObject({ total: 0 });
  });

  it("reserves and settles the real wallet ledger without charging credits", async () => {
    featureState.wallet = true;
    await setBillingMode("wallet");
    const estimate = await estimateChargePaise("image");
    await adminAdjustWallet({
      tenantId: tenant.tenantId,
      amountPaise: Math.max(estimate * 2, 10_000),
      note: "whole-flow billing fixture",
    });
    const before = await getWalletBalancePaise(tenant.tenantId);
    const app = createApp(tenant.tenantId, tenant.clerkUserId);

    const response = await request(app)
      .post("/ai/generate-image")
      .send({ prompt: "A wallet-funded mountain" });

    expect(response.status).toBe(200);
    expect(imageGenerate).toHaveBeenCalledTimes(1);
    const walletRows = await db
      .select()
      .from(walletLedgerTable)
      .where(eq(walletLedgerTable.tenantId, tenant.tenantId));
    expect(walletRows.filter((row) => row.kind === "admin_credit")).toHaveLength(1);
    expect(walletRows.filter((row) => row.kind === "reserve")).toHaveLength(1);
    expect(walletRows.filter((row) => row.kind === "settle")).toHaveLength(1);
    expect(walletRows.filter((row) => row.kind === "refund")).toHaveLength(0);
    expect(await getWalletBalancePaise(tenant.tenantId)).toBeLessThanOrEqual(before);

    const usage = await db
      .select()
      .from(usageEventsTable)
      .where(eq(usageEventsTable.tenantId, tenant.tenantId));
    expect(usage[0].funding).toBe("wallet");
    const creditLedger = await db
      .select()
      .from(creditAccountLedgerTable)
      .where(eq(creditAccountLedgerTable.tenantId, tenant.tenantId));
    expect(creditLedger.filter((row) => row.kind === "spend")).toHaveLength(0);
  });

  it("keeps a wallet reservation when the tenant rail flips before provider dispatch", async () => {
    featureState.wallet = true;
    await setBillingMode("wallet");
    const estimate = await estimateChargePaise("image");
    await adminAdjustWallet({
      tenantId: tenant.tenantId,
      amountPaise: Math.max(estimate * 2, 10_000),
      note: "billing-mode flip fixture",
    });
    providerState.beforeReturn = async () => {
      await db
        .update(tenantsTable)
        .set({ billingMode: "quota" })
        .where(eq(tenantsTable.id, tenant.tenantId));
    };
    const app = createApp(tenant.tenantId, tenant.clerkUserId);

    const response = await request(app)
      .post("/ai/generate-image")
      .send({ prompt: "Wallet reservation survives a rail flip" });

    expect(response.status).toBe(200);
    expect(imageGenerate).toHaveBeenCalledTimes(1);
    const walletRows = await db
      .select()
      .from(walletLedgerTable)
      .where(eq(walletLedgerTable.tenantId, tenant.tenantId));
    expect(walletRows.filter((row) => row.kind === "reserve")).toHaveLength(1);
    expect(walletRows.filter((row) => row.kind === "settle")).toHaveLength(1);
    expect(walletRows.filter((row) => row.kind === "refund")).toHaveLength(0);
    const usage = await db
      .select()
      .from(usageEventsTable)
      .where(eq(usageEventsTable.tenantId, tenant.tenantId));
    expect(usage[0].funding).toBe("wallet");
    const creditLedger = await db
      .select()
      .from(creditAccountLedgerTable)
      .where(eq(creditAccountLedgerTable.tenantId, tenant.tenantId));
    expect(creditLedger.filter((row) => row.kind === "spend")).toHaveLength(0);
  });

  it("debits one real credit-account ledger receipt at provider dispatch", async () => {
    await setBillingMode("credits");
    await grantCredits({
      tenantId: tenant.tenantId,
      credits: 3,
      kind: "purchase",
      idempotencyKey: `billing-test:${tenant.tenantId}`,
    });
    await setMeterMode("enforce");
    expect(await getMeterMode()).toBe("enforce");
    const app = createApp(tenant.tenantId, tenant.clerkUserId);

    const response = await request(app)
      .post("/ai/generate-image")
      .send({ prompt: "An enforce-funded mountain" });

    expect(response.status).toBe(200);
    expect(imageGenerate).toHaveBeenCalledTimes(1);
    expect(await getCreditBalance(tenant.tenantId)).toMatchObject({
      purchased: 0,
      granted: 0,
      total: 0,
    });
    const ledger = await db
      .select()
      .from(creditAccountLedgerTable)
      .where(eq(creditAccountLedgerTable.tenantId, tenant.tenantId));
    expect(ledger.filter((row) => row.kind === "spend")).toHaveLength(1);
    expect(ledger.filter((row) => row.kind === "refund")).toHaveLength(0);
    expect(ledger.find((row) => row.kind === "spend")).toMatchObject({
      purchasedDeltaMilli: -3000,
      rateKey: "image",
    });

    const meterEvents = await db
      .select()
      .from(creditMeterEventsTable)
      .where(eq(creditMeterEventsTable.tenantId, tenant.tenantId));
    expect(meterEvents).toHaveLength(1);
    expect(meterEvents[0]).toMatchObject({
      creditsMilli: 3000,
      outcome: "ok",
      mode: "enforce",
    });
  });

  it("refuses an unfunded enforced credit dispatch before the provider call", async () => {
    await setBillingMode("credits");
    await setMeterMode("enforce");
    const app = createApp(tenant.tenantId, tenant.clerkUserId);

    const response = await request(app)
      .post("/ai/generate-image")
      .send({ prompt: "This must not run" });

    expect(response.status).toBe(500);
    expect(imageGenerate).not.toHaveBeenCalled();
    expect(await getCreditBalance(tenant.tenantId)).toMatchObject({ total: 0 });
    const ledger = await db
      .select()
      .from(creditAccountLedgerTable)
      .where(eq(creditAccountLedgerTable.tenantId, tenant.tenantId));
    expect(ledger.filter((row) => row.kind === "spend")).toHaveLength(0);
    const events = await db
      .select()
      .from(creditMeterEventsTable)
      .where(eq(creditMeterEventsTable.tenantId, tenant.tenantId));
    expect(events).toHaveLength(0);
  });

  it("freezes credits funding across a tenant billing-mode flip during dispatch", async () => {
    await setBillingMode("credits");
    await grantCredits({
      tenantId: tenant.tenantId,
      credits: 3,
      kind: "purchase",
      idempotencyKey: `flip-test:${tenant.tenantId}`,
    });
    await setMeterMode("enforce");
    providerState.beforeReturn = async () => {
      await db
        .update(tenantsTable)
        .set({ billingMode: "quota" })
        .where(eq(tenantsTable.id, tenant.tenantId));
    };
    const app = createApp(tenant.tenantId, tenant.clerkUserId);

    const response = await request(app)
      .post("/ai/generate-image")
      .send({ prompt: "Billing mode changes while provider is running" });

    expect(response.status).toBe(200);
    expect(imageGenerate).toHaveBeenCalledTimes(1);
    expect(await getCreditBalance(tenant.tenantId)).toMatchObject({ total: 0 });
    const usage = await db
      .select()
      .from(usageEventsTable)
      .where(eq(usageEventsTable.tenantId, tenant.tenantId));
    expect(usage).toHaveLength(1);
    expect(usage[0].funding).toBe("credits");
    expect(
      (await db
        .select()
        .from(creditAccountLedgerTable)
        .where(eq(creditAccountLedgerTable.tenantId, tenant.tenantId)))
        .filter((row) => row.kind === "spend"),
    ).toHaveLength(1);
  });

  const reservationDispatchRaces = [
    {
      name: "enforced credits remain enforced when global mode switches to shadow",
      billingMode: "credits" as const,
      initialMode: "enforce" as const,
      switchedMode: "shadow" as const,
      expectedFunding: "credits",
      expectedMeterMode: "enforce",
      expectedSpend: 1,
    },
    {
      name: "enforced credits remain enforced when global mode switches off",
      billingMode: "credits" as const,
      initialMode: "enforce" as const,
      switchedMode: "off" as const,
      expectedFunding: "credits",
      expectedMeterMode: "enforce",
      expectedSpend: 1,
    },
    {
      name: "quota reservation stays legacy when global mode switches to enforce",
      billingMode: "quota" as const,
      initialMode: "shadow" as const,
      switchedMode: "enforce" as const,
      expectedFunding: "quota",
      expectedMeterMode: "shadow",
      expectedSpend: 0,
    },
  ];

  it.each(reservationDispatchRaces)(
    "freezes the funding decision $name",
    async ({
      billingMode,
      initialMode,
      switchedMode,
      expectedFunding,
      expectedMeterMode,
      expectedSpend,
    }) => {
      await setBillingMode(billingMode);
      if (billingMode === "credits") {
        await grantCredits({
          tenantId: tenant.tenantId,
          credits: 3,
          kind: "purchase",
          idempotencyKey: `race-test:${tenant.tenantId}`,
        });
      }
      await setMeterMode(initialMode);
      const barrier = makeTasteBarrier();
      const app = createApp(tenant.tenantId, tenant.clerkUserId);
      const responsePromise = request(app)
        .post("/ai/generate-image")
        .send({ prompt: `reservation race: ${billingMode}` })
        .then((response) => response);

      try {
        await Promise.race([
          barrier.entered,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("reservation barrier was not reached")), 5_000),
          ),
        ]);
        await setMeterMode(switchedMode);
        barrier.release();
        const response = await responsePromise;

        expect(response.status).toBe(200);
        expect(imageGenerate).toHaveBeenCalledTimes(1);

        const usage = await db
          .select()
          .from(usageEventsTable)
          .where(eq(usageEventsTable.tenantId, tenant.tenantId));
        expect(usage).toHaveLength(1);
        expect(usage[0].funding).toBe(expectedFunding);

        const ledger = await db
          .select()
          .from(creditAccountLedgerTable)
          .where(eq(creditAccountLedgerTable.tenantId, tenant.tenantId));
        expect(ledger.filter((row) => row.kind === "spend")).toHaveLength(expectedSpend);

        const meterEvents = await db
          .select()
          .from(creditMeterEventsTable)
          .where(eq(creditMeterEventsTable.tenantId, tenant.tenantId));
        expect(meterEvents).toHaveLength(1);
        expect(meterEvents[0].mode).toBe(expectedMeterMode);
      } finally {
        barrier.release();
        tasteBarrierState.current = null;
        await responsePromise.catch(() => undefined);
      }
    },
  );

  it("uses the snapshotted route rail while transitioning enforce, shadow, and off", async () => {
    await setBillingMode("credits");
    await grantCredits({
      tenantId: tenant.tenantId,
      credits: 3,
      kind: "purchase",
      idempotencyKey: `transition-test:${tenant.tenantId}`,
    });
    await setMeterMode("enforce");
    const app = createApp(tenant.tenantId, tenant.clerkUserId);

    const enforced = await request(app)
      .post("/ai/generate-image")
      .send({ prompt: "enforced image" });
    expect(enforced.status).toBe(200);

    await setMeterMode("shadow");
    const shadow = await request(app)
      .post("/ai/generate-image")
      .send({ prompt: "shadow image" });
    expect(shadow.status).toBe(200);

    await setMeterMode("off");
    const off = await request(app)
      .post("/ai/generate-image")
      .send({ prompt: "off image" });
    expect(off.status).toBe(200);
    expect(imageGenerate).toHaveBeenCalledTimes(3);

    const usage = await db
      .select()
      .from(usageEventsTable)
      .where(eq(usageEventsTable.tenantId, tenant.tenantId));
    expect(usage).toHaveLength(3);
    expect(usage.filter((row) => row.funding === "credits")).toHaveLength(1);
    expect(usage.filter((row) => row.funding === "quota")).toHaveLength(2);

    const ledger = await db
      .select()
      .from(creditAccountLedgerTable)
      .where(eq(creditAccountLedgerTable.tenantId, tenant.tenantId));
    expect(ledger.filter((row) => row.kind === "spend")).toHaveLength(1);

    const meterEvents = await db
      .select()
      .from(creditMeterEventsTable)
      .where(eq(creditMeterEventsTable.tenantId, tenant.tenantId));
    expect(meterEvents).toHaveLength(2);
    expect(meterEvents.filter((row) => row.mode === "enforce")).toHaveLength(1);
    expect(meterEvents.filter((row) => row.mode === "shadow")).toHaveLength(1);
  });
});