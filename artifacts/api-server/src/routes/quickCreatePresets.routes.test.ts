import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { db, quickCreatePresetsTable } from "@workspace/db";

let superadmin = false;
vi.mock("../middlewares/requireSuperadmin", () => ({
  requireSuperadmin: (_req: unknown, res: express.Response, next: () => void) =>
    superadmin ? next() : res.status(403).json({ error: "Forbidden" }),
}));
vi.mock("../lib/adminAudit", () => ({ recordAdminAction: vi.fn(async () => undefined) }));

const { default: router } = await import("./quickCreatePresets");

function app() {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    (req as unknown as { log: { error: () => void } }).log = { error: () => undefined };
    next();
  });
  server.use("/api", router);
  return server;
}

const starter = {
  label: "Saree Showcase",
  vertical: "fashion",
  prompt: "A model sways gently to the music",
  durationSec: 10,
  aspect: "9:16",
};

describe("Quick Create starters", () => {
  afterEach(async () => {
    superadmin = false;
    await db.delete(quickCreatePresetsTable);
  });

  it("keeps the admin endpoints closed to ordinary users", async () => {
    const server = app();
    expect((await request(server).get("/api/admin/quick-create-presets")).status).toBe(403);
    expect((await request(server).post("/api/admin/quick-create-presets").send(starter)).status).toBe(403);
    expect((await request(server).patch("/api/admin/quick-create-presets/1").send(starter)).status).toBe(403);
    expect((await request(server).delete("/api/admin/quick-create-presets/1")).status).toBe(403);
  });

  it("lets a superadmin manage starters and shows tenants only published ones", async () => {
    const server = app();
    superadmin = true;

    const draft = await request(server).post("/api/admin/quick-create-presets").send(starter);
    expect(draft.status).toBe(201);
    expect(draft.body).toMatchObject({ label: "Saree Showcase", published: false, photoHint: null });

    const live = await request(server)
      .post("/api/admin/quick-create-presets")
      .send({ ...starter, label: "Product Hero", vertical: "product", published: true, sortOrder: 1 });
    expect(live.status).toBe(201);

    superadmin = false;
    const visible = await request(server).get("/api/quick-create/presets");
    expect(visible.status).toBe(200);
    expect(visible.body.map((p: { label: string }) => p.label)).toEqual(["Product Hero"]);

    superadmin = true;
    const published = await request(server)
      .patch(`/api/admin/quick-create-presets/${draft.body.id}`)
      .send({ ...starter, published: true, musicPrompt: " sitar " });
    expect(published.status).toBe(200);
    expect(published.body.musicPrompt).toBe("sitar");

    const all = await request(server).get("/api/quick-create/presets");
    expect(all.body.map((p: { label: string }) => p.label)).toEqual(["Saree Showcase", "Product Hero"]);

    expect((await request(server).delete(`/api/admin/quick-create-presets/${live.body.id}`)).status).toBe(204);
    expect((await request(server).delete(`/api/admin/quick-create-presets/${live.body.id}`)).status).toBe(404);
  });

  it("rejects input outside the allowed lengths and shapes", async () => {
    const server = app();
    superadmin = true;
    const bad = await request(server)
      .post("/api/admin/quick-create-presets")
      .send({ ...starter, durationSec: 7, aspect: "4:3" });
    expect(bad.status).toBe(400);
  });
});
