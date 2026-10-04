import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import express from "express";
import sharp from "sharp";
vi.mock("@clerk/express", async () => {
  const { authState } = await import("../test/authState");
  return {
    getAuth: () => authState.userId ? { userId: authState.userId, sessionClaims: { userId: authState.userId } } : {},
    clerkClient: { users: { getUser: async (id: string) => {
      const u = authState.users[id]; if (!u) throw new Error("user not found"); return u;
    } } },
    clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  };
});
const chatCreate = vi.fn(), loadReferenceImageMock = vi.fn(), uploadMock = vi.fn(), matteMock = vi.fn();
vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: { images: { edit: vi.fn(), generate: vi.fn() },
    chat: { completions: { create: (...args: unknown[]) => chatCreate(...args) } }, responses: { create: vi.fn() } },
  toFile: async (buf: Buffer) => buf,
}));
vi.mock("../lib/referenceGuide", async importOriginal => ({
  ...await importOriginal<typeof import("../lib/referenceGuide")>(),
  loadReferenceImage: (...args: unknown[]) => loadReferenceImageMock(...args),
}));
vi.mock("../lib/storageUpload", () => ({ uploadBufferToStorage: (...args: unknown[]) => uploadMock(...args) }));
vi.mock("../lib/cover/matte", async importOriginal => ({
  ...await importOriginal<typeof import("../lib/cover/matte")>(),
  extractSubjectMatte: (...args: unknown[]) => matteMock(...args),
}));
import { ReferenceImageError } from "../lib/referenceGuide";
import { requireTenant } from "../middlewares/requireTenant";
import aiRouter from "./ai";
import { actAs, resetAuthState } from "../test/authState";
import { createTenant, deleteTenant, type TestTenant } from "../test/dbHelpers";
import { getUsage } from "../lib/usage";
const app = express();
app.use(express.json({ limit: "25mb" }));
app.use((req, _res, next) => {
  (req as unknown as { log: Record<string, () => void> }).log = { info() {}, error() {}, warn() {}, debug() {} }; next();
});
app.use("/api", requireTenant, aiRouter);
const created: TestTenant[] = [];
async function newTenant() { const tenant = await createTenant(); created.push(tenant); return tenant; }
let uploadSeq = 0;
const shapes = (fill: string) => `<circle cx="512" cy="420" r="110" fill="${fill}"/><rect x="270" y="520" width="484" height="1100" rx="110" fill="${fill}"/>`;
const PHOTO = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1536"><rect width="100%" height="100%" fill="#2b2f36"/>${shapes("#c9a48a")}</svg>`)).png().toBuffer();
const MATTE = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1536"><rect width="100%" height="100%" fill="#000"/>${shapes("#fff")}</svg>`)).greyscale().png().toBuffer();
const COVER_BASE = await sharp({ create: { width: 1080, height: 1350, channels: 3, background: "#2b2f36" } }).png().toBuffer();
const COVER_SUBJECT = await sharp({ create: { width: 1080, height: 1350, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
const freshBody = (id: number, extra = {}) => ({
  imagePath: `/objects/${id}/uploads/photo.png`, copy: { kicker: "My", headline: "Skin Routine", subline: "what a dermatologist uses" }, ...extra,
});
beforeEach(() => {
  resetAuthState(); chatCreate.mockReset(); matteMock.mockReset(); uploadMock.mockReset(); loadReferenceImageMock.mockReset();
  loadReferenceImageMock.mockResolvedValue({ buffer: PHOTO, mimeType: "image/png" });
  matteMock.mockResolvedValue({ matte: MATTE, provider: "replicate", meta: { model: "851-labs/background-remover", provider: "replicate", durationMs: 5 } });
  uploadMock.mockImplementation(async (id: number) => `/objects/${id}/uploads/u${++uploadSeq}.png`);
});
afterAll(async () => { for (const t of created) await deleteTenant(t.tenantId); });
describe("POST /ai/cover", () => {
  it("requires authentication", async () => { expect((await request(app).post("/api/ai/cover").send(freshBody(1))).status).toBe(401); });
  it("returns ordered layers and bills one successful image operation", async () => {
    const t = await newTenant(); actAs(t.clerkUserId);
    const before = await getUsage(t.tenantId);
    const res = await request(app).post("/api/ai/cover").send(freshBody(t.tenantId));
    expect(res.status).toBe(200); expect(res.body.layout).toBe("behind"); expect(res.body.units).toBe(1);
    expect(res.body.subjectPath).toMatch(new RegExp(`^/objects/${t.tenantId}/`));
    const ids = res.body.layers.layers.map((l: { id: string }) => l.id);
    expect(ids.indexOf("cover_headline")).toBeLessThan(ids.indexOf("cover_subject"));
    expect(ids).toEqual(expect.arrayContaining(["cover_kicker", "cover_subline", "cover_accent"]));
    expect(await sharp(Buffer.from(res.body.b64Json, "base64")).metadata()).toMatchObject({ width: 1080, height: 1350 });
    expect((await getUsage(t.tenantId)).images).toBe(before.images + 1);
  });
  it("releases the reservation when no matte is available", async () => {
    const t = await newTenant(); actAs(t.clerkUserId); matteMock.mockResolvedValue(null);
    const before = await getUsage(t.tenantId);
    const res = await request(app).post("/api/ai/cover").send(freshBody(t.tenantId));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ layout: "over", units: 0, subjectPath: null });
    expect(res.body.notice).toMatch(/Couldn't separate/);
    expect((await getUsage(t.tenantId)).images).toBe(before.images);
  });
  it("never calls a provider or charges for text-over", async () => {
    const t = await newTenant(); actAs(t.clerkUserId);
    const before = await getUsage(t.tenantId);
    const res = await request(app).post("/api/ai/cover").send(freshBody(t.tenantId, { layout: "over", headlineStyle: "grotesk", accent: "arrow" }));
    expect(res.status).toBe(200); expect(res.body.units).toBe(0); expect(matteMock).not.toHaveBeenCalled();
    expect((await getUsage(t.tenantId)).images).toBe(before.images);
  });
  it("re-typesets a stored canvas for free", async () => {
    const t = await newTenant(); actAs(t.clerkUserId);
    loadReferenceImageMock.mockImplementation(async (path: string) => ({ buffer: path.endsWith("subject.png") ? COVER_SUBJECT : COVER_BASE, mimeType: "image/png" }));
    const before = await getUsage(t.tenantId);
    const basePath = `/objects/${t.tenantId}/uploads/base.png`, subjectPath = `/objects/${t.tenantId}/uploads/subject.png`;
    const res = await request(app).post("/api/ai/cover").send({ reuse: { basePath, subjectPath }, copy: { headline: "New Words" } });
    expect(res.status).toBe(200); expect(res.body).toMatchObject({ units: 0, basePath, subjectPath });
    expect(matteMock).not.toHaveBeenCalled(); expect((await getUsage(t.tenantId)).images).toBe(before.images);
  });
  it("rejects invalid reusable canvases", async () => {
    const t = await newTenant(); actAs(t.clerkUserId);
    const res = await request(app).post("/api/ai/cover").send({ reuse: { basePath: `/objects/${t.tenantId}/uploads/photo.png` }, copy: { headline: "Hi" } });
    expect(res.status).toBe(400); expect(res.body.error).toMatch(/not a cover canvas/);
  });
  it("validates blank copy and missing or foreign paths before charging", async () => {
    const t = await newTenant(); actAs(t.clerkUserId);
    const before = await getUsage(t.tenantId);
    expect((await request(app).post("/api/ai/cover").send({ copy: { headline: "Hi" } })).status).toBe(400);
    expect((await request(app).post("/api/ai/cover").send({ ...freshBody(t.tenantId), copy: { headline: " " } })).status).toBe(400);
    loadReferenceImageMock.mockRejectedValue(new ReferenceImageError("Reference image not found."));
    expect((await request(app).post("/api/ai/cover").send(freshBody(t.tenantId, { imagePath: "/objects/999/uploads/theirs.png" }))).status).toBe(400);
    expect(matteMock).not.toHaveBeenCalled(); expect((await getUsage(t.tenantId)).images).toBe(before.images);
  });
});
describe("POST /ai/cover-copy", () => {
  it("returns model copy", async () => {
    const t = await newTenant(); actAs(t.clerkUserId);
    chatCreate.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ kicker: "My", headline: "Skin Routine", subline: "that actually works" }) } }] });
    const res = await request(app).post("/api/ai/cover-copy").send({ topic: "my morning skincare routine" });
    expect(res.status).toBe(200); expect(res.body).toMatchObject({ kicker: "My", headline: "Skin Routine", source: "ai" });
  });
  it("labels its deterministic fallback", async () => {
    const t = await newTenant(); actAs(t.clerkUserId); chatCreate.mockRejectedValue(new Error("model down"));
    const res = await request(app).post("/api/ai/cover-copy").send({ topic: "skin routine for oily skin" });
    expect(res.status).toBe(200); expect(res.body).toMatchObject({ source: "fallback", headline: "Skin Routine" });
  });
  it("rejects blank topics", async () => {
    const t = await newTenant(); actAs(t.clerkUserId);
    expect((await request(app).post("/api/ai/cover-copy").send({ topic: "" })).status).toBe(400);
  });
});