import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

vi.mock("../middlewares/requireSuperadmin", () => ({
  requireSuperadmin: (_req: unknown, res: express.Response) =>
    res.status(403).json({ error: "Forbidden" }),
}));
vi.mock("../lib/adminAudit", () => ({ recordAdminAction: vi.fn() }));

import router from "./videoTemplatesAdmin";

describe("video template admin permission scope", () => {
  const app = express();
  app.use("/api", router);
  app.get("/api/credits", (_req, res) => res.json({ total: 42 }));
  app.get("/api/notifications", (_req, res) => res.json([]));

  it("allows ordinary tenant requests to reach downstream routers", async () => {
    const credits = await request(app).get("/api/credits");
    expect(credits.status).toBe(200);
    expect(credits.body.total).toBe(42);
    expect((await request(app).get("/api/notifications")).status).toBe(200);
  });

  it("still rejects ordinary users on template admin endpoints", async () => {
    expect((await request(app).get("/api/admin/video-templates")).status).toBe(403);
    expect((await request(app).post("/api/admin/video-templates")).status).toBe(403);
    expect((await request(app).patch("/api/admin/video-templates/1")).status).toBe(403);
    expect((await request(app).delete("/api/admin/video-templates/1")).status).toBe(403);
  });
});