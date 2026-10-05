import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import express from "express";
import sharp from "sharp";
import { Readable } from "node:stream";

vi.mock("@clerk/express", async () => {
  const { authState } = await import("../test/authState");
  return {
    getAuth: () =>
      authState.userId
        ? { userId: authState.userId, sessionClaims: { userId: authState.userId } }
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
    clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  };
});

const visionState = vi.hoisted(() => ({
  reply: '{"description":"A frosted dropper bottle with a lavender NIGHT SERUM label."}' as string | Error,
  calls: [] as unknown[],
}));

/** Only the product-description calls; kit creation may use text-gen too. */
function productCalls() {
  return visionState.calls.filter((call) =>
    String((call as { meter?: { operationKey?: string } }).meter?.operationKey ?? "").includes(":product:"),
  );
}

vi.mock("../lib/textGen", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/textGen")>();
  return {
    ...actual,
    getTextGenClient: vi.fn(async (_model: string, meter: unknown, opts: unknown) => ({
      provider: "builtin",
      model: "vision-test",
      client: {
        chat: {
          completions: {
            create: async (body: unknown) => {
              visionState.calls.push({ body, meter, opts });
              if (visionState.reply instanceof Error) throw visionState.reply;
              return { choices: [{ message: { content: visionState.reply } }] };
            },
          },
        },
      },
    })),
  };
});

import { pool, db, brandKitsTable, brandAssetsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireTenant } from "../middlewares/requireTenant";
import brandKitsRouter from "./brandKits";
import { resetAuthState, actAs } from "../test/authState";
import { createTenant, deleteTenant, type TestTenant } from "../test/dbHelpers";
import { createKit } from "../lib/brandKit/service";
import { ObjectStorageService } from "../lib/objectStorage";
import {
  GuidedProductSelectionError,
  assertGuidedProductsUnchanged,
  resolveGuidedSetupProducts,
} from "../lib/videoGen/guidedProducts";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: Record<string, () => void> }).log = {
      info() {},
      error() {},
      warn() {},
      debug() {},
    };
    next();
  });
  app.use("/api", requireTenant, brandKitsRouter);
  return app;
}

const app = buildApp();
let tenant: TestTenant;
let png: Buffer;

function fakeImageFile(bytes: Buffer) {
  return {
    getMetadata: async () => [{ contentType: "image/png", size: bytes.length }],
    createReadStream: () => Readable.from([bytes]),
  };
}

async function newKit() {
  const detail = await createKit({
    tenantId: tenant.tenantId,
    plan: "pro",
    createdBy: tenant.clerkUserId,
    name: `Products ${Date.now()}-${Math.random()}`,
  });
  return detail!.id as number;
}

beforeAll(async () => {
  tenant = await createTenant();
  png = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#a78bfa" } })
    .png()
    .toBuffer();
});

afterAll(async () => {
  await db.delete(brandAssetsTable).where(eq(brandAssetsTable.tenantId, tenant.tenantId));
  await deleteTenant(tenant.tenantId);
  await pool.end();
});

beforeEach(async () => {
  await db.delete(brandAssetsTable).where(eq(brandAssetsTable.tenantId, tenant.tenantId));
  await db.delete(brandKitsTable).where(eq(brandKitsTable.tenantId, tenant.tenantId));
  resetAuthState();
  actAs(tenant.clerkUserId, "products-test@example.com");
  visionState.reply = '{"description":"A frosted dropper bottle with a lavender NIGHT SERUM label."}';
  visionState.calls.length = 0;
  vi.spyOn(ObjectStorageService.prototype, "getObjectEntityFile").mockResolvedValue(
    fakeImageFile(png) as never,
  );
});

describe("Brand Kit products & services", () => {
  it("stores a product, describes its image once, and lists it", async () => {
    const kitId = await newKit();
    const created = await request(app)
      .post(`/api/brand-kits/${kitId}/products`)
      .send({
        imagePath: `/objects/${tenant.tenantId}/uploads/serum`,
        name: "Night Serum",
        description: "Niacinamide serum that evens skin tone.",
        displayMode: "exact",
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({
      name: "Night Serum",
      kind: "product",
      displayMode: "exact",
      mimeType: "image/png",
      aiDescriptionStatus: "ready",
      aiDescription: "A frosted dropper bottle with a lavender NIGHT SERUM label.",
    });
    expect(productCalls()).toHaveLength(1);
    const call = productCalls()[0] as {
      body: { messages: Array<{ content: unknown }> };
      meter: { funding: { mode: string } };
      opts: { capability: string };
    };
    expect(call.opts.capability).toBe("multimodal");
    expect(call.meter.funding.mode).toBe("shadow");
    expect(JSON.stringify(call.body.messages[1]!.content)).toContain("data:image/png;base64,");

    const list = await request(app).get(`/api/brand-kits/${kitId}/products`);
    expect(list.status).toBe(200);
    expect(list.body.map((item: { id: number }) => item.id)).toEqual([created.body.id]);
  });

  it("keeps the upload when the vision call fails and lets the user retry", async () => {
    const kitId = await newKit();
    visionState.reply = new Error("vision down");
    const created = await request(app)
      .post(`/api/brand-kits/${kitId}/products`)
      .send({
        imagePath: `/objects/${tenant.tenantId}/uploads/clinic`,
        name: "Skin consult",
        kind: "service",
        description: "Same-day dermatology consult.",
      });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ kind: "service", aiDescriptionStatus: "failed", aiDescription: null });

    visionState.reply = '{"description":"A bright clinic room with a treatment chair and ring light."}';
    const retried = await request(app).post(
      `/api/brand-kits/${kitId}/products/${created.body.id}/describe`,
    );
    expect(retried.status).toBe(200);
    expect(retried.body).toMatchObject({ aiDescriptionStatus: "ready" });
  });

  it("edits catalog fields without touching the AI description", async () => {
    const kitId = await newKit();
    const created = await request(app)
      .post(`/api/brand-kits/${kitId}/products`)
      .send({ imagePath: `/objects/${tenant.tenantId}/uploads/a`, name: "Serum", description: "Evens tone." });
    const patched = await request(app)
      .patch(`/api/brand-kits/${kitId}/products/${created.body.id}`)
      .send({ name: "Night Serum 30ml", displayMode: "exact" });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({
      name: "Night Serum 30ml",
      displayMode: "exact",
      description: "Evens tone.",
      aiDescriptionStatus: "ready",
    });
  });

  it("refuses another workspace's upload path and non-image bytes", async () => {
    const kitId = await newKit();
    const foreign = await request(app)
      .post(`/api/brand-kits/${kitId}/products`)
      .send({ imagePath: `/objects/${tenant.tenantId + 999}/uploads/x`, name: "Serum", description: "Evens tone." });
    expect(foreign.status).toBe(400);

    vi.spyOn(ObjectStorageService.prototype, "getObjectEntityFile").mockResolvedValue(
      fakeImageFile(Buffer.from("not an image")) as never,
    );
    const garbage = await request(app)
      .post(`/api/brand-kits/${kitId}/products`)
      .send({ imagePath: `/objects/${tenant.tenantId}/uploads/y`, name: "Serum", description: "Evens tone." });
    expect(garbage.status).toBe(400);
    expect(productCalls()).toHaveLength(0);
  });

  it("keeps product rows out of the generic asset endpoint", async () => {
    const kitId = await newKit();
    const res = await request(app)
      .post(`/api/brand-kits/${kitId}/assets`)
      .send({ assetType: "product", fileUrl: `/objects/${tenant.tenantId}/uploads/z` });
    expect(res.status).toBe(400);
  });
});

describe("Guided Story product selection", () => {
  const baseSetup = {
    genre: "drama" as const,
    platform: "instagram_reels" as const,
    aspectRatio: "9:16" as const,
    width: 1080,
    height: 1920,
    safeArea: "center",
    durationSeconds: 30,
    locale: "en" as const,
    topic: "A night routine",
  };

  async function product(kitId: number, name: string) {
    const res = await request(app)
      .post(`/api/brand-kits/${kitId}/products`)
      .send({ imagePath: `/objects/${tenant.tenantId}/uploads/${name}`, name, description: "Evens tone." });
    expect(res.status).toBe(201);
    return res.body.id as number;
  }

  it("freezes products with hashes, keeps them on omitted updates, and drops them on kit change", async () => {
    const kitId = await newKit();
    const a = await product(kitId, "serum");
    const setup = { ...baseSetup, brandKitId: kitId };
    const frozen = await resolveGuidedSetupProducts({
      tenantId: tenant.tenantId,
      setup,
      selection: { promotion: "featured", assetIds: [a, a] },
      previous: null,
    });
    expect(frozen).toMatchObject({ version: 1, promotion: "featured" });
    expect(frozen!.items).toHaveLength(1);
    expect(frozen!.items[0]).toMatchObject({
      id: `p${a}`,
      assetId: a,
      name: "serum",
      imageSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      aiDescription: expect.stringContaining("NIGHT SERUM"),
    });
    const previous = { ...setup, products: frozen };
    await expect(
      resolveGuidedSetupProducts({ tenantId: tenant.tenantId, setup, selection: undefined, previous }),
    ).resolves.toBe(frozen);
    const otherKit = await newKit();
    await expect(
      resolveGuidedSetupProducts({
        tenantId: tenant.tenantId,
        setup: { ...setup, brandKitId: otherKit },
        selection: undefined,
        previous,
      }),
    ).resolves.toBeNull();
    await expect(
      resolveGuidedSetupProducts({
        tenantId: tenant.tenantId,
        setup,
        selection: { promotion: "subtle", assetIds: [] },
        previous,
      }),
    ).resolves.toBeNull();
    await expect(assertGuidedProductsUnchanged(frozen, tenant.tenantId)).resolves.toBeNull();
  });

  it("rejects products from another kit, missing kits and oversize selections", async () => {
    const kitId = await newKit();
    const otherKit = await newKit();
    const foreign = await product(otherKit, "box");
    const setup = { ...baseSetup, brandKitId: kitId };
    await expect(
      resolveGuidedSetupProducts({
        tenantId: tenant.tenantId,
        setup,
        selection: { promotion: "featured", assetIds: [foreign] },
        previous: null,
      }),
    ).rejects.toBeInstanceOf(GuidedProductSelectionError);
    await expect(
      resolveGuidedSetupProducts({
        tenantId: tenant.tenantId,
        setup: { ...setup, brandKitId: null },
        selection: { promotion: "featured", assetIds: [foreign] },
        previous: null,
      }),
    ).rejects.toThrow(/Choose a Brand Kit/);
    await expect(
      resolveGuidedSetupProducts({
        tenantId: tenant.tenantId,
        setup,
        selection: { promotion: "featured", assetIds: [1, 2, 3, 4, 5] },
        previous: null,
      }),
    ).rejects.toThrow(/at most 4/);
  });

  it("flags a product image that changed after setup", async () => {
    const kitId = await newKit();
    const a = await product(kitId, "serum");
    const frozen = await resolveGuidedSetupProducts({
      tenantId: tenant.tenantId,
      setup: { ...baseSetup, brandKitId: kitId },
      selection: { promotion: "subtle", assetIds: [a] },
      previous: null,
    });
    const changed = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#000000" } })
      .png()
      .toBuffer();
    vi.spyOn(ObjectStorageService.prototype, "getObjectEntityFile").mockResolvedValue(
      fakeImageFile(changed) as never,
    );
    await expect(assertGuidedProductsUnchanged(frozen, tenant.tenantId)).resolves.toMatch(
      /changed or was removed/,
    );
  });
});
