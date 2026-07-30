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

// OpenAI built-in provider: images.edit is the only call the edit path makes.
const imagesEdit = vi.fn();
vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: {
    images: {
      edit: (...args: unknown[]) => imagesEdit(...args),
      generate: vi.fn(),
    },
    chat: { completions: { create: vi.fn() } },
    responses: { create: vi.fn() },
  },
  toFile: async (buf: Buffer, name: string, opts: { type: string }) => ({
    buffer: buf,
    name,
    type: opts.type,
  }),
}));

// Tenant-scoped source loading: real implementation hits object storage.
const loadReferenceImageMock = vi.fn();
vi.mock("../lib/referenceGuide", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/referenceGuide")>();
  return {
    ...actual,
    loadReferenceImage: (...args: unknown[]) => loadReferenceImageMock(...args),
  };
});

// Storage upload of the edited result.
const uploadMock = vi.fn();
vi.mock("../lib/storageUpload", () => ({
  uploadBufferToStorage: (...args: unknown[]) => uploadMock(...args),
}));

import { ReferenceImageError } from "../lib/referenceGuide";
import { requireTenant } from "../middlewares/requireTenant";
import aiRouter from "./ai";
import { actAs, resetAuthState } from "../test/authState";
import { createTenant, deleteTenant, type TestTenant } from "../test/dbHelpers";
import { getUsage } from "../lib/usage";

function createApp(): Express {
  const app = express();
  app.use(express.json({ limit: "25mb" }));
  app.use((req, _res, next) => {
    (req as unknown as { log: Record<string, () => void> }).log = {
      info() {},
      error() {},
      warn() {},
      debug() {},
    };
    next();
  });
  app.use("/api", requireTenant, aiRouter);
  return app;
}

const app = createApp();
const createdTenants: TestTenant[] = [];

async function newTenant(): Promise<TestTenant> {
  const tenant = await createTenant();
  createdTenants.push(tenant);
  return tenant;
}

// Real decodable PNGs: the route now compares mask vs source dimensions.
async function makePng(width: number, height: number): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  return sharp({
    create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .png()
    .toBuffer();
}
const PNG_BYTES = await makePng(8, 8);
const MASK_B64 = PNG_BYTES.toString("base64");

function validBody(tenantId: number) {
  return {
    imagePath: `/objects/${tenantId}/uploads/source.png`,
    maskB64: MASK_B64,
    prompt: "replace the sky with a sunset",
  };
}

beforeEach(() => {
  resetAuthState();
  imagesEdit.mockReset();
  uploadMock.mockReset();
  loadReferenceImageMock.mockReset();
  loadReferenceImageMock.mockResolvedValue({
    buffer: PNG_BYTES,
    mimeType: "image/png",
  });
  imagesEdit.mockResolvedValue({
    data: [{ b64_json: PNG_BYTES.toString("base64") }],
    usage: { input_tokens: 10, output_tokens: 100 },
  });
  uploadMock.mockResolvedValue("/objects/1/uploads/edited.png");
});

afterAll(async () => {
  for (const t of createdTenants) {
    await deleteTenant(t.tenantId);
  }
});

describe("POST /ai/edit-image", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await request(app)
      .post("/api/ai/edit-image")
      .send({ imagePath: "/objects/1/x.png", maskB64: MASK_B64, prompt: "p" });
    expect(res.status).toBe(401);
  });

  it("edits the image, uploads the result, and meters usage", async () => {
    const tenant = await newTenant();
    actAs(tenant.clerkUserId);
    uploadMock.mockResolvedValue(`/objects/${tenant.tenantId}/uploads/edited.png`);

    const before = await getUsage(tenant.tenantId);
    const res = await request(app)
      .post("/api/ai/edit-image")
      .send(validBody(tenant.tenantId));

    expect(res.status).toBe(200);
    expect(res.body.imagePath).toBe(`/objects/${tenant.tenantId}/uploads/edited.png`);
    expect(typeof res.body.b64Json).toBe("string");
    expect(imagesEdit).toHaveBeenCalledTimes(1);
    const call = imagesEdit.mock.calls[0][0] as Record<string, unknown>;
    expect(call.model).toBe("gpt-image-1");
    expect(call.mask).toBeTruthy();
    // Funding settled: one image consumed.
    const after = await getUsage(tenant.tenantId);
    expect(after.images).toBe(before.images + 1);
  });

  it("releases funding when the provider fails", async () => {
    const tenant = await newTenant();
    actAs(tenant.clerkUserId);
    imagesEdit.mockRejectedValue(new Error("provider exploded"));

    const before = await getUsage(tenant.tenantId);
    const res = await request(app)
      .post("/api/ai/edit-image")
      .send(validBody(tenant.tenantId));

    expect(res.status).toBe(500);
    const after = await getUsage(tenant.tenantId);
    expect(after.images).toBe(before.images);
  });

  it("returns 422 with a clear message and refunds when the safety filter blocks the edit", async () => {
    const tenant = await newTenant();
    actAs(tenant.clerkUserId);
    const err = Object.assign(
      new Error("400 Your request was rejected by the safety system."),
      { code: "moderation_blocked" },
    );
    imagesEdit.mockRejectedValue(err);

    const before = await getUsage(tenant.tenantId);
    const res = await request(app)
      .post("/api/ai/edit-image")
      .send(validBody(tenant.tenantId));

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("safety filter");
    const after = await getUsage(tenant.tenantId);
    expect(after.images).toBe(before.images);
  });

  it("rejects a foreign image path before charging anything", async () => {
    const tenant = await newTenant();
    actAs(tenant.clerkUserId);
    loadReferenceImageMock.mockRejectedValue(
      new ReferenceImageError("Reference image not found."),
    );

    const before = await getUsage(tenant.tenantId);
    const res = await request(app)
      .post("/api/ai/edit-image")
      .send({ ...validBody(tenant.tenantId), imagePath: "/objects/999999/uploads/theirs.png" });

    expect(res.status).toBe(400);
    expect(imagesEdit).not.toHaveBeenCalled();
    const after = await getUsage(tenant.tenantId);
    expect(after.images).toBe(before.images);
  });

  it("rejects a non-PNG mask with 400 and no provider call", async () => {
    const tenant = await newTenant();
    actAs(tenant.clerkUserId);

    const res = await request(app)
      .post("/api/ai/edit-image")
      .send({
        ...validBody(tenant.tenantId),
        maskB64: Buffer.from("definitely not a png").toString("base64"),
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/PNG/i);
    expect(imagesEdit).not.toHaveBeenCalled();
  });

  it("rejects a mask whose dimensions don't match the source image, before charging", async () => {
    const tenant = await newTenant();
    actAs(tenant.clerkUserId);
    const smallMask = await makePng(4, 4);

    const before = await getUsage(tenant.tenantId);
    const res = await request(app)
      .post("/api/ai/edit-image")
      .send({ ...validBody(tenant.tenantId), maskB64: smallMask.toString("base64") });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/same size/i);
    expect(res.body.error).toContain("8\u00d78");
    expect(res.body.error).toContain("4\u00d74");
    expect(imagesEdit).not.toHaveBeenCalled();
    const after = await getUsage(tenant.tenantId);
    expect(after.images).toBe(before.images);
  });

  it("rejects an undecodable PNG mask with 400 and no provider call", async () => {
    const tenant = await newTenant();
    actAs(tenant.clerkUserId);
    // Valid PNG magic but garbage body: passes decodeMask, fails full decode.
    const bogus = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(64),
    ]);

    const res = await request(app)
      .post("/api/ai/edit-image")
      .send({ ...validBody(tenant.tenantId), maskB64: bogus.toString("base64") });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/valid PNG/i);
    expect(imagesEdit).not.toHaveBeenCalled();
  });

  it("rejects invalid input", async () => {
    const tenant = await newTenant();
    actAs(tenant.clerkUserId);
    const res = await request(app)
      .post("/api/ai/edit-image")
      .send({ imagePath: "", maskB64: "", prompt: "" });
    expect(res.status).toBe(400);
  });
});
