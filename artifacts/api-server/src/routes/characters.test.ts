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
  successPersistenceFails: false,
  recordFails: false,
  reserveCalls: [] as unknown[],
  operationCalls: [] as unknown[],
  settleCalls: [] as unknown[],
  refundCalls: [] as unknown[],
  events: [] as string[],
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
    executeWalletProviderOperation: vi.fn(
      async (
        params: unknown,
        perform: (
          confirmSuccess: (meta?: unknown) => Promise<void>,
          recordReceipt: (meta: unknown) => Promise<void>,
        ) => Promise<unknown>,
      ) => {
        let confirmed = false;
        const confirmSuccess = async () => {
          confirmed = true;
          if (billingState.successPersistenceFails) {
            throw new actual.WalletProviderSuccessPersistenceError(
              "provider work succeeded but receipt persistence failed",
              97402,
            );
          }
          billingState.operationCalls.push(params);
          billingState.events.push("provider-success-receipt");
        };
        try {
          const value = await perform(confirmSuccess, async () => undefined);
          if (!confirmed) await confirmSuccess();
          return { value, operationId: 97402 };
        } catch (error) {
          if (
            confirmed &&
            !(error instanceof actual.WalletProviderSuccessPersistenceError)
          ) {
            throw new actual.WalletProviderPostSuccessError(97402, error);
          }
          throw error;
        }
      },
    ),
    settleWalletProviderOperationDurably: vi.fn(async (operationId: number) => {
      billingState.settleCalls.push({ operationId });
      billingState.events.push("settlement-attempt");
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
  failPreservationAfterProvider: false,
}));
const storageState = vi.hoisted(() => ({
  failNext: false,
}));
const protectedRegion = { x: 0.2, y: 0.04, width: 0.6, height: 0.38 };
vi.mock("../lib/characters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/characters")>();
  const {
    ImageGenNotConfiguredError,
    ImageGenProviderError,
    ImagePreservationError,
  } = await import("../lib/imageGen/types");
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
    generateOutfitVariant: vi.fn(async (
      _c: unknown,
      description: string,
      _base: unknown,
      _edit: unknown,
      onProviderSuccess?: (meta: { provider: string; model: string }) => Promise<void>,
    ) => {
      maybeFail();
      genState.variantCalls.push(description);
      if (genState.failPreservationAfterProvider) {
        genState.failPreservationAfterProvider = false;
        await onProviderSuccess?.({ provider: "openai", model: "gpt-image-1" });
        throw new ImagePreservationError(
          "provider output could not be aligned",
          true,
        );
      }
      return { buffer: Buffer.from("outfit-png"), provider: "openai", model: "gpt-image-1" };
    }),
    createOutfitMaskedEdit: vi.fn(async () => ({
      mask: { buffer: Buffer.from("mask"), mimeType: "image/png" },
      protectedRectangle: { x: 0.2, y: 0.04, width: 0.6, height: 0.38 },
    })),
  };
});
vi.mock("../lib/storageUpload", () => ({
  uploadBufferToStorage: vi.fn(
    async (tenantId: number) => {
      if (storageState.failNext) {
        storageState.failNext = false;
        throw new Error("object storage unavailable");
      }
      return `/objects/${tenantId}/uploads/generated-${Math.random()}`;
    },
  ),
}));

import {
  db,
  charactersTable,
  characterOutfitsTable,
  tenantsTable,
  creditBalancesTable,
  creditLedgerTable,
  presetCharactersTable,
  presetOutfitDerivativesTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireTenant } from "../middlewares/requireTenant";
import charactersRouter from "./characters";
import { actAs, resetAuthState } from "../test/authState";
import { createTenant, deleteTenant, type TestTenant } from "../test/dbHelpers";
import { grantCredits, getCreditBalances } from "../lib/credits";
import { PRESET_CHARACTER_SEEDS } from "../lib/presetCharacters";

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
  billingState.successPersistenceFails = false;
  billingState.recordFails = false;
  billingState.reserveCalls.length = 0;
  billingState.operationCalls.length = 0;
  billingState.settleCalls.length = 0;
  billingState.refundCalls.length = 0;
  billingState.events.length = 0;
  logMock.info.mockClear();
  logMock.error.mockClear();
  logMock.warn.mockClear();
  logMock.debug.mockClear();
  genState.referenceCalls.length = 0;
  genState.variantCalls.length = 0;
  genState.loadedPaths.length = 0;
  genState.failNext = null;
  genState.failPreservationAfterProvider = false;
  storageState.failNext = false;
});

function errorLogged(substring: string): boolean {
  return (logMock.error.mock.calls as unknown[][]).some(
    (args) => typeof args[1] === "string" && args[1].includes(substring),
  );
}

afterAll(async () => {
  for (const tenant of createdTenants) {
    await db
      .delete(presetOutfitDerivativesTable)
      .where(eq(presetOutfitDerivativesTable.tenantId, tenant.tenantId));
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

describe("preset character security", () => {
  it("ships exactly ten stable, fully described fictional identities", () => {
    expect(PRESET_CHARACTER_SEEDS).toHaveLength(10);
    expect(new Set(PRESET_CHARACTER_SEEDS.map((item) => item.stableId)).size).toBe(10);
    for (const preset of PRESET_CHARACTER_SEEDS) {
      expect(preset.referenceImagePath).toBe(`/preset-assets/${preset.stableId}/identity.svg`);
      expect(preset.supportedLanguages.length).toBeGreaterThan(0);
      expect(preset.voices.length).toBeGreaterThan(0);
      expect(preset.genreTags.length).toBeGreaterThan(0);
      expect(preset.usageGuidance).toBeTruthy();
    }
  });

  it("does not let a normal tenant create, edit, reorder, or delete the central catalog", async () => {
    await newTenant();
    const [create, edit, reorder, remove] = await Promise.all([
      request(app)
        .post("/api/admin/preset-characters")
        .send({ stableId: "unauthorized-preset" }),
      request(app)
        .patch("/api/admin/preset-characters/amara-sen")
        .send({ isActive: false }),
      request(app)
        .put("/api/admin/preset-characters/order")
        .send({ stableIds: PRESET_CHARACTER_SEEDS.map((preset) => preset.stableId).reverse() }),
      request(app).delete("/api/admin/preset-characters/amara-sen"),
    ]);
    expect(create.status).not.toBeLessThan(400);
    expect(edit.status).toBe(403);
    expect(reorder.status).toBe(403);
    expect(remove.status).not.toBeLessThan(400);
    const [amara] = await db
      .select({ isActive: presetCharactersTable.isActive })
      .from(presetCharactersTable)
      .where(eq(presetCharactersTable.stableId, "amara-sen"));
    // The route's superadmin gate runs before its bootstrap/write handler.
    if (amara) expect(amara.isActive).toBe(true);
  });

  it("hides another tenant's preset outfit preview", async () => {
    const owner = await newTenant();
    const generated = await request(app)
      .post("/api/preset-characters/amara-sen/outfit-derivatives")
      .send({
        name: "Rain coat",
        description: "a bright yellow rain coat and boots",
        protectedRegion,
      });
    expect(generated.status).toBe(201);

    await newTenant();
    const foreignUpdate = await request(app)
      .patch(
        `/api/preset-characters/amara-sen/outfit-derivatives/${generated.body.id}`,
      )
      .send({ status: "approved" });
    expect(foreignUpdate.status).toBe(404);

    const [stillOwnerScoped] = await db
      .select()
      .from(presetOutfitDerivativesTable)
      .where(eq(presetOutfitDerivativesTable.id, generated.body.id));
    expect(stillOwnerScoped?.tenantId).toBe(owner.tenantId);
    expect(stillOwnerScoped?.status).toBe("preview");
  });
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

  it("does not refund successful generation when wallet settlement fails", async () => {
    billingState.walletEnabled = true;
    billingState.settleFails = true;
    await newTenant();

    const res = await request(app)
      .post("/api/characters")
      .send({ name: "Maya", description: "a cheerful woman" });

    expect(res.status).toBe(500);
    expect(billingState.settleCalls).toHaveLength(1);
    expect(billingState.refundCalls).toHaveLength(0);
    expect(billingState.events).toEqual(["provider-success-receipt", "settlement-attempt"]);
    expect(billingState.operationCalls[0]).toMatchObject({
      operationKind: "character_reference",
      operationKey: expect.stringContaining("character-reference:"),
      settlement: { kind: "image", costPaise: null, refKind: "character", refId: "Maya" },
    });
  });

  it("never refunds or repeats generated work when its wallet success receipt cannot persist", async () => {
    billingState.walletEnabled = true;
    billingState.successPersistenceFails = true;
    await newTenant();

    const res = await request(app)
      .post("/api/characters")
      .send({ name: "Maya", description: "a cheerful woman" });

    expect(res.status).toBe(500);
    expect(genState.referenceCalls).toEqual(["a cheerful woman"]);
    expect(billingState.settleCalls).toHaveLength(0);
    expect(billingState.refundCalls).toHaveLength(0);
  });

  it("does not refund confirmed provider work when storing the generated reference fails", async () => {
    billingState.walletEnabled = true;
    storageState.failNext = true;
    await newTenant();

    const res = await request(app)
      .post("/api/characters")
      .send({ name: "Maya", description: "a cheerful woman" });

    expect(res.status).toBe(500);
    expect(genState.referenceCalls).toEqual(["a cheerful woman"]);
    expect(billingState.events).toEqual(["provider-success-receipt", "settlement-attempt"]);
    expect(billingState.settleCalls).toHaveLength(1);
    expect(billingState.refundCalls).toHaveLength(0);
  });

  it("never refunds queued successful work when the atomic cap recheck rejects the save", async () => {
    billingState.walletEnabled = true;
    await newTenant();
    const transactionSpy = vi.spyOn(db, "transaction").mockResolvedValueOnce(null as never);

    let res;
    try {
      res = await request(app)
        .post("/api/characters")
        .send({ name: "Maya", description: "a cheerful woman" });
    } finally {
      transactionSpy.mockRestore();
    }

    expect(res.status).toBe(400);
    expect(billingState.settleCalls).toHaveLength(1);
    expect(billingState.refundCalls).toHaveLength(0);
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

  it("keeps a spent image credit when usage recording fails after character generation", async () => {
    const tenant = await newTenant("payg");
    await grantCredits({
      tenantId: tenant.tenantId,
      captionCredits: 0,
      imageCredits: 1,
      videoCredits: 0,
      kind: "admin_grant",
      note: "test",
    });
    billingState.recordFails = true;

    const res = await request(app)
      .post("/api/characters")
      .send({ name: "Maya", description: "a cheerful woman" });

    expect(res.status).toBe(201);
    expect(res.body.referenceImagePath).toMatch(/^\/objects\/\d+\/uploads\//);
    expect((await getCreditBalances(tenant.tenantId)).imageCredits).toBe(0);
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
      .send({ name: "Gym wear", description: "black leggings, teal top", protectedRegion });
    expect(res.status).toBe(201);
    expect(genState.variantCalls).toEqual(["black leggings, teal top"]);
    expect(res.body.outfits).toHaveLength(2);
    const gym = res.body.outfits.find((o: { name: string }) => o.name === "Gym wear");
    expect(gym.isDefault).toBe(false);
    expect(gym).toMatchObject({
      status: "preview",
      identityVerified: true,
      canonicalReferenceImagePath: `/objects/${tenant.tenantId}/uploads/me.png`,
      protectedRegion,
    });
  });

  it("persists the protected region and requires explicit approval", async () => {
    const tenant = await newTenant();
    const created = await request(app)
      .post("/api/characters")
      .send({
        name: "Maya",
        sourceImagePath: `/objects/${tenant.tenantId}/uploads/me.png`,
      });

    const protectedUpdate = await request(app)
      .patch(`/api/characters/${created.body.id}`)
      .send({ protectedRegion });
    expect(protectedUpdate.status).toBe(200);
    expect(protectedUpdate.body.protectedRegion).toEqual(protectedRegion);

    const generated = await request(app)
      .post(`/api/characters/${created.body.id}/outfits`)
      .send({
        name: "Gym wear",
        description: "black leggings, teal top",
        protectedRegion,
      });
    const preview = generated.body.outfits.find(
      (outfit: { name: string }) => outfit.name === "Gym wear",
    );

    const approved = await request(app)
      .patch(`/api/characters/${created.body.id}/outfits/${preview.id}`)
      .send({ name: "Training look", status: "approved" });
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({
      name: "Training look",
      status: "approved",
      identityVerified: true,
    });
  });

  it("keeps rejected previews unapproved and tenant-scoped", async () => {
    const tenant = await newTenant();
    const created = await request(app)
      .post("/api/characters")
      .send({
        name: "Maya",
        sourceImagePath: `/objects/${tenant.tenantId}/uploads/me.png`,
      });
    const generated = await request(app)
      .post(`/api/characters/${created.body.id}/outfits`)
      .send({
        name: "Gym wear",
        description: "black leggings",
        protectedRegion,
      });
    const preview = generated.body.outfits.find(
      (outfit: { name: string }) => outfit.name === "Gym wear",
    );

    await newTenant();
    const foreignReject = await request(app)
      .patch(`/api/characters/${created.body.id}/outfits/${preview.id}`)
      .send({ status: "rejected" });
    expect(foreignReject.status).toBe(404);

    actAs(tenant.clerkUserId);
    const rejected = await request(app)
      .patch(`/api/characters/${created.body.id}/outfits/${preview.id}`)
      .send({ status: "rejected" });
    expect(rejected.status).toBe(200);
    expect(rejected.body.status).toBe("rejected");

    const reapprove = await request(app)
      .patch(`/api/characters/${created.body.id}/outfits/${preview.id}`)
      .send({ status: "approved" });
    expect(reapprove.status).toBe(400);
  });

  it("does not refund successful outfit generation when wallet settlement fails", async () => {
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
      .send({ name: "Gym wear", description: "black leggings, teal top", protectedRegion });

    expect(res.status).toBe(500);
    expect(billingState.settleCalls).toHaveLength(1);
    expect(billingState.refundCalls).toHaveLength(0);
    expect(billingState.events).toEqual(["provider-success-receipt", "settlement-attempt"]);
    expect(billingState.operationCalls[0]).toMatchObject({
      operationKind: "character_outfit",
      operationKey: expect.stringContaining(`character-outfit:${created.body.id}:`),
      settlement: {
        kind: "image",
        costPaise: null,
        refKind: "character",
        refId: String(created.body.id),
      },
    });
  });

  it("settles once and never refunds when preservation fails after paid provider success", async () => {
    const tenant = await newTenant();
    const created = await request(app)
      .post("/api/characters")
      .send({
        name: "Maya",
        sourceImagePath: `/objects/${tenant.tenantId}/uploads/me.png`,
      });
    billingState.walletEnabled = true;
    genState.failPreservationAfterProvider = true;

    const res = await request(app)
      .post(`/api/characters/${created.body.id}/outfits`)
      .send({
        name: "Gym wear",
        description: "black leggings, teal top",
        protectedRegion,
      });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/keeping the protected identity unchanged/i);
    expect(genState.variantCalls).toEqual(["black leggings, teal top"]);
    expect(billingState.events).toEqual([
      "provider-success-receipt",
      "settlement-attempt",
    ]);
    expect(billingState.settleCalls).toHaveLength(1);
    expect(billingState.refundCalls).toHaveLength(0);
  });

  it("never refunds or repeats generated outfit work when its wallet success receipt cannot persist", async () => {
    const tenant = await newTenant();
    const created = await request(app)
      .post("/api/characters")
      .send({
        name: "Maya",
        sourceImagePath: `/objects/${tenant.tenantId}/uploads/me.png`,
      });
    billingState.walletEnabled = true;
    billingState.successPersistenceFails = true;

    const res = await request(app)
      .post(`/api/characters/${created.body.id}/outfits`)
      .send({ name: "Gym wear", description: "black leggings, teal top", protectedRegion });

    expect(res.status).toBe(500);
    expect(genState.variantCalls).toEqual(["black leggings, teal top"]);
    expect(billingState.settleCalls).toHaveLength(0);
    expect(billingState.refundCalls).toHaveLength(0);
  });

  it("does not refund confirmed outfit generation when storing its image fails", async () => {
    const tenant = await newTenant();
    const created = await request(app)
      .post("/api/characters")
      .send({
        name: "Maya",
        sourceImagePath: `/objects/${tenant.tenantId}/uploads/me.png`,
      });
    billingState.walletEnabled = true;
    storageState.failNext = true;

    const res = await request(app)
      .post(`/api/characters/${created.body.id}/outfits`)
      .send({ name: "Gym wear", description: "black leggings, teal top", protectedRegion });

    expect(res.status).toBe(500);
    expect(genState.variantCalls).toEqual(["black leggings, teal top"]);
    expect(billingState.events).toEqual(["provider-success-receipt", "settlement-attempt"]);
    expect(billingState.settleCalls).toHaveLength(1);
    expect(billingState.refundCalls).toHaveLength(0);
  });

  it("never refunds queued successful outfit work when saving the outfit fails", async () => {
    const tenant = await newTenant();
    const created = await request(app)
      .post("/api/characters")
      .send({
        name: "Maya",
        sourceImagePath: `/objects/${tenant.tenantId}/uploads/me.png`,
      });
    billingState.walletEnabled = true;
    billingState.settleFails = true;
    const realInsert = db.insert.bind(db);
    const insertSpy = vi.spyOn(db, "insert").mockImplementation(((table) => {
      if ((table as unknown) === characterOutfitsTable) {
        throw new Error("outfit persistence unavailable");
      }
      return realInsert(table);
    }) as typeof db.insert);

    let res;
    try {
      res = await request(app)
        .post(`/api/characters/${created.body.id}/outfits`)
        .send({
          name: "Gym wear",
          description: "black leggings, teal top",
          protectedRegion,
        });
    } finally {
      insertSpy.mockRestore();
    }

    expect(res.status).toBe(500);
    expect(billingState.settleCalls).toHaveLength(1);
    expect(billingState.refundCalls).toHaveLength(0);
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
      .send({ name: "Gym wear", description: "black leggings, teal top", protectedRegion });

    expect(res.status).toBe(201);
    expect(billingState.settleCalls).toHaveLength(1);
    expect(billingState.refundCalls).toHaveLength(0);
    expect(errorLogged("Failed to record character image usage after successful work")).toBe(true);
  });

  it("keeps a spent image credit when usage recording fails after outfit generation", async () => {
    const tenant = await newTenant("payg");
    const created = await request(app)
      .post("/api/characters")
      .send({
        name: "Maya",
        sourceImagePath: `/objects/${tenant.tenantId}/uploads/me.png`,
      });
    await grantCredits({
      tenantId: tenant.tenantId,
      captionCredits: 0,
      imageCredits: 1,
      videoCredits: 0,
      kind: "admin_grant",
      note: "test",
    });
    billingState.recordFails = true;

    const res = await request(app)
      .post(`/api/characters/${created.body.id}/outfits`)
      .send({ name: "Gym wear", description: "black leggings, teal top", protectedRegion });

    expect(res.status).toBe(201);
    expect(res.body.outfits).toHaveLength(2);
    expect((await getCreditBalances(tenant.tenantId)).imageCredits).toBe(0);
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
      .send({ name: "Gym wear", description: "black leggings", protectedRegion });
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
    expect(list.body.map((c: { name: string }) => c.name)).toEqual([
      ...PRESET_CHARACTER_SEEDS.map((preset) => preset.name),
      "Mine",
    ]);

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
