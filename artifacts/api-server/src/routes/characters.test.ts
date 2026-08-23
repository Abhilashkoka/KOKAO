import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";

vi.mock("@clerk/express", async () => {
  const { authState } = await import("../test/authState");
  return {
    getAuth: () =>
      authState.userId
        ? {
            userId: authState.userId,
            sessionClaims: { userId: authState.userId },
          }
        : {},
    clerkClient: {
      users: {
        getUser: async (id: string) => {
          const u = authState.users[id];
          if (!u) throw new Error("user not found");
          return u;
        },
      },
    },
    clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) =>
      next(),
  };
});

const billingState = vi.hoisted(() => ({
  walletEnabled: false,
  settleFails: false,
  recordFails: false,
  reserveCalls: [] as unknown[],
  settleCalls: [] as unknown[],
  refundCalls: [] as unknown[],
}));

vi.mock("../lib/wallet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/wallet")>();
  return {
    ...actual,
    isWalletFunded: vi.fn(async () => billingState.walletEnabled),
    reserveWallet: vi.fn(async (tenantId: number, kind: string) => {
      billingState.reserveCalls.push({ tenantId, kind });
      return { id: 97401, amountPaise: 1000, units: 1 };
    }),
    settleWallet: vi.fn(async (tenantId: number, reservation: unknown, meta: unknown) => {
      billingState.settleCalls.push({ tenantId, reservation, meta });
      if (billingState.settleFails) throw new Error("settle exploded");
      return { chargedPaise: 1000, estimated: false, balancePaise: 0 };
    }),
    refundWallet: vi.fn(async (tenantId: number, reservation: unknown, note?: string) => {
      billingState.refundCalls.push({ tenantId, reservation, note });
    }),
  };
});

vi.mock("../lib/usage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/usage")>();
  return {
    ...actual,
    recordUsage: vi.fn(async (...args: Parameters<typeof actual.recordUsage>) => {
      if (billingState.recordFails) throw new Error("usage write exploded");
      return actual.recordUsage(...args);
    }),
  };
});

// AI image generation and storage I/O are exercised by their own layers; here
// they are captured so route behavior (validation, funding, tenancy) is
// deterministic.
const genState = vi.hoisted(() => ({
  referenceCalls: [] as string[],
  variantCalls: [] as string[],
  loadedPaths: [] as string[],
  failNext: null as null | { kind: "notConfigured" | "provider" },
}));
vi.mock("../lib/characters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/characters")>();
  const { ImageGenNotConfiguredError, ImageGenProviderError } = await import(
    "../lib/imageGen/types"
  );
  const maybeFail = () => {
    if (genState.failNext?.kind === "notConfigured") {
      genState.failNext = null;
      throw new ImageGenNotConfiguredError("no provider");
    }
    if (genState.failNext?.kind === "provider") {
      genState.failNext = null;
      throw new ImageGenProviderError("upstream rejected");
    }
  };
  return {
    ...actual,
    loadReferenceImage: vi.fn(async (path: string) => {
      genState.loadedPaths.push(path);
      return { buffer: Buffer.from("img"), mimeType: "image/png" };
    }),
    generateCharacterReference: vi.fn(async (description: string) => {
      maybeFail();
      genState.referenceCalls.push(description);
      return { buffer: Buffer.from("ref-png"), provider: "openai", model: "gpt-image-1" };
    }),
    generateOutfitVariant: vi.fn(async (_c: unknown, description: string) => {
      maybeFail();
      genState.variantCalls.push(description);
      return { buffer: Buffer.from("outfit-png"), provider: "openai", model: "gpt-image-1" };
    }),
  };
});
vi.mock("../lib/storageUpload", () => ({
  uploadBufferToStorage: vi.fn(
    async (tenantId: number) => `/objects/${tenantId}/uploads/generated-${Math.random()}`,
  ),
}));

import {
  db,
  charactersTable,
  characterOutfitsTable,
  tenantsTable,
  creditBalancesTable,
  creditLedgerTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireTenant } from "../middlewares/requireTenant";
import charactersRouter from "./characters";
import { actAs, resetAuthState } from "../test/authState";
import { createTenant, deleteTenant, type TestTenant } from "../test/dbHelpers";
import { grantCredits, getCreditBalances } from "../lib/credits";

const logMock = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
};

function createCharactersTestApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: typeof logMock }).log = logMock;
    next();
  });
  app.use("/api", requireTenant, charactersRouter);
  return app;
}

const app = createCharactersTestApp();
const createdTenants: TestTenant[] = [];

async function newTenant(plan = "free"): Promise<TestTenant> {
  const tenant = await createTenant();
  if (plan !== "free") {
    await db.update(tenantsTable).set({ plan }).where(eq(tenantsTable.id, tenant.tenantId));
  }
  createdTenants.push(tenant);
  actAs(tenant.clerkUserId);
  return tenant;
}

beforeEach(() => {
  resetAuthState();
  billingState.walletEnabled = false;
  billingState.settleFails = false;
  billingState.recordFails = false;
  billingState.reserveCalls.length = 0;
  billingState.settleCalls.length = 0;
  billingState.refundCalls.length = 0;
  logMock.info.mockClear();
  logMock.error.mockClear();
  logMock.warn.mockClear();
  logMock.debug.mockClear();
  genState.referenceCalls.length = 0;
  genState.variantCalls.length = 0;
  genState.loadedPaths.length = 0;
  genState.failNext = null;
});

function errorLogged(substring: string): boolean {
  return (logMock.error.mock.calls as unknown[][]).some(
    (args) => typeof args[1] === "string" && args[1].includes(substring),
  );
}

afterAll(async () => {
  for (const tenant of createdTenants) {
    await db
      .delete(characterOutfitsTable)
      .where(eq(characterOutfitsTable.tenantId, tenant.tenantId));
    await db.delete(charactersTable).where(eq(charactersTable.tenantId, tenant.tenantId));
    await db
      .delete(creditBalancesTable)
      .where(eq(creditBalancesTable.tenantId, tenant.tenantId));
    await db
      .delete(creditLedgerTable)
      .where(eq(creditLedgerTable.tenantId, tenant.tenantId));
    await deleteTenant(tenant.tenantId);
  }
});

describe("POST /api/characters", () => {
  it("requires a description or an uploaded photo", async () => {
    await newTenant();
    const res = await request(app).post("/api/characters").send({ name: "Maya" });
    expect(res.status).toBe(400);
    expect(genState.referenceCalls).toHaveLength(0);
  });

  it("rejects an uploaded reference outside the caller's workspace", async () => {
    const tenant = await newTenant();
    const res = await request(app)
      .post("/api/characters")
      .send({
        name: "Maya",
        sourceImagePath: `/objects/${tenant.tenantId + 1}/uploads/stolen.png`,
      });
    expect(res.status).toBe(400);
  });

  it("creates a character from an uploaded photo with no AI cost", async () => {
    const tenant = await newTenant();
    const sourceImagePath = `/objects/${tenant.tenantId}/uploads/me.png`;
    const res = await request(app)
      .post("/api/characters")
      .send({ name: "Maya", description: "cheerful founder", sourceImagePath });
    expect(res.status).toBe(201);
    expect(res.body.referenceImagePath).toBe(sourceImagePath);
    expect(res.body.outfits).toHaveLength(1);
    expect(res.body.outfits[0].isDefault).toBe(true);
    expect(genState.referenceCalls).toHaveLength(0);
    expect(genState.loadedPaths).toContain(sourceImagePath);
  });

  it("generates the reference from a description, funded like an image", async () => {
    await newTenant(); // free plan has image quota
    const res = await request(app)
      .post("/api/characters")
      .send({ name: "Maya", description: "a cheerful woman, black hair" });
    expect(res.status).toBe(201);
    expect(genState.referenceCalls).toEqual(["a cheerful woman, black hair"]);
    expect(res.body.referenceImagePath).toMatch(/^\/objects\/\d+\/uploads\//);
    expect(res.body.outfits).toHaveLength(1);
  });

  it("402s when there is no image quota and no image credits", async () => {
    await newTenant("payg"); // 0 images/month, credit-funded only
    const res = await request(app)
      .post("/api/characters")
      .send({ name: "Maya", description: "a cheerful woman" });
    expect(res.status).toBe(402);
    expect(genState.referenceCalls).toHaveLength(0);
  });

  it("refunds the reserved image credit when generation fails", async () => {
    const tenant = await newTenant("payg");
    await grantCredits({
      tenantId: tenant.tenantId,
      captionCredits: 0,
      imageCredits: 1,
      videoCredits: 0,
      kind: "admin_grant",
      note: "test",
    });
    genState.failNext = { kind: "provider" };
    const res = await request(app)
      .post("/api/characters")
      .send({ name: "Maya", description: "a cheerful woman" });
    expect(res.status).toBe(502);
    expect((await getCreditBalances(tenant.tenantId)).imageCredits).toBe(1);
  });

  it("returns success without refunding when wallet settlement fails after generation", async () => {
    billingState.walletEnabled = true;
    billingState.settleFails = true;
    await newTenant();

    const res = await request(app)
      .post("/api/characters")
      .send({ name: "Maya", description: "a cheerful woman" });

    expect(res.status).toBe(201);
    expect(billingState.settleCalls).toHaveLength(1);
    expect(billingState.refundCalls).toHaveLength(0);
    expect(errorLogged("Failed to settle character image wallet charge")).toBe(true);
  });

  it("never refunds when usage recording fails after wallet settlement", async () => {
    billingState.walletEnabled = true;
    billingState.recordFails = true;
    await newTenant();

    const res = await request(app)
      .post("/api/characters")
      .send({ name: "Maya", description: "a cheerful woman" });

    expect(res.status).toBe(201);
    expect(billingState.settleCalls).toHaveLength(1);
    expect(billingState.refundCalls).toHaveLength(0);
    expect(errorLogged("Failed to record character image usage after successful work")).toBe(true);
  });
});

describe("outfits", () => {
  it("adds a costume variant and returns the updated character", async () => {
    const tenant = await newTenant();
    const created = await request(app)
      .post("/api/characters")
      .send({
        name: "Maya",
        sourceImagePath: `/objects/${tenant.tenantId}/uploads/me.png`,
      });
    const res = await request(app)
      .post(`/api/characters/${created.body.id}/outfits`)
      .send({ name: "Gym wear", description: "black leggings, teal top" });
    expect(res.status).toBe(201);
    expect(genState.variantCalls).toEqual(["black leggings, teal top"]);
    expect(res.body.outfits).toHaveLength(2);
    const gym = res.body.outfits.find((o: { name: string }) => o.name === "Gym wear");
    expect(gym.isDefault).toBe(false);
  });

  it("returns success without refunding when wallet settlement fails after outfit generation", async () => {
    const tenant = await newTenant();
    const created = await request(app)
      .post("/api/characters")
      .send({
        name: "Maya",
        sourceImagePath: `/objects/${tenant.tenantId}/uploads/me.png`,
      });
    billingState.walletEnabled = true;
    billingState.settleFails = true;

    const res = await request(app)
      .post(`/api/characters/${created.body.id}/outfits`)
      .send({ name: "Gym wear", description: "black leggings, teal top" });

    expect(res.status).toBe(201);
    expect(billingState.settleCalls).toHaveLength(1);
    expect(billingState.refundCalls).toHaveLength(0);
    expect(errorLogged("Failed to settle character image wallet charge")).toBe(true);
  });

  it("never refunds an outfit when usage recording fails after wallet settlement", async () => {
    const tenant = await newTenant();
    const created = await request(app)
      .post("/api/characters")
      .send({
        name: "Maya",
        sourceImagePath: `/objects/${tenant.tenantId}/uploads/me.png`,
      });
    billingState.walletEnabled = true;
    billingState.recordFails = true;

    const res = await request(app)
      .post(`/api/characters/${created.body.id}/outfits`)
      .send({ name: "Gym wear", description: "black leggings, teal top" });

    expect(res.status).toBe(201);
    expect(billingState.settleCalls).toHaveLength(1);
    expect(billingState.refundCalls).toHaveLength(0);
    expect(errorLogged("Failed to record character image usage after successful work")).toBe(true);
  });

  it("never removes the default outfit", async () => {
    const tenant = await newTenant();
    const created = await request(app)
      .post("/api/characters")
      .send({
        name: "Maya",
        sourceImagePath: `/objects/${tenant.tenantId}/uploads/me.png`,
      });
    const defaultOutfit = created.body.outfits[0];
    const res = await request(app).delete(
      `/api/characters/${created.body.id}/outfits/${defaultOutfit.id}`,
    );
    expect(res.status).toBe(400);
  });

  it("removes a non-default outfit", async () => {
    const tenant = await newTenant();
    const created = await request(app)
      .post("/api/characters")
      .send({
        name: "Maya",
        sourceImagePath: `/objects/${tenant.tenantId}/uploads/me.png`,
      });
    const withOutfit = await request(app)
      .post(`/api/characters/${created.body.id}/outfits`)
      .send({ name: "Gym wear", description: "black leggings" });
    const gym = withOutfit.body.outfits.find((o: { name: string }) => o.name === "Gym wear");
    const res = await request(app).delete(
      `/api/characters/${created.body.id}/outfits/${gym.id}`,
    );
    expect(res.status).toBe(204);
  });
});

describe("list + delete", () => {
  it("lists only the caller's characters and 404s cross-tenant deletes", async () => {
    const other = await newTenant();
    const otherChar = await request(app)
      .post("/api/characters")
      .send({
        name: "Other",
        sourceImagePath: `/objects/${other.tenantId}/uploads/o.png`,
      });

    const mine = await newTenant();
    await request(app)
      .post("/api/characters")
      .send({
        name: "Mine",
        sourceImagePath: `/objects/${mine.tenantId}/uploads/m.png`,
      });

    const list = await request(app).get("/api/characters");
    expect(list.status).toBe(200);
    expect(list.body.map((c: { name: string }) => c.name)).toEqual(["Mine"]);

    const crossDelete = await request(app).delete(`/api/characters/${otherChar.body.id}`);
    expect(crossDelete.status).toBe(404);
  });

  it("deletes a character together with its outfits", async () => {
    const tenant = await newTenant();
    const created = await request(app)
      .post("/api/characters")
      .send({
        name: "Maya",
        sourceImagePath: `/objects/${tenant.tenantId}/uploads/me.png`,
      });
    const res = await request(app).delete(`/api/characters/${created.body.id}`);
    expect(res.status).toBe(204);
    const outfits = await db
      .select()
      .from(characterOutfitsTable)
      .where(eq(characterOutfitsTable.characterId, created.body.id));
    expect(outfits).toHaveLength(0);
  });
});
