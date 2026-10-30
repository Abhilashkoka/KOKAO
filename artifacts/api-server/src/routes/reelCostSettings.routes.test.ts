import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { adminAuditLogsTable, db, reelCostSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

let superadmin = false;
vi.mock("../middlewares/requireSuperadmin", () => ({
  requireSuperadmin: (_req: unknown, res: express.Response, next: () => void) =>
    superadmin ? next() : res.status(403).json({ error: "Forbidden" }),
}));

const { default: router } = await import("./reelCostSettings");

function app() {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    Object.assign(req, {
      tenantId: 1,
      tenantEmail: "admin@kokao.in",
      log: { error: () => undefined },
    });
    next();
  });
  server.use("/api", router);
  return server;
}

const settings = {
  tryOnImageQuality: "low",
  reelResolution: "480p",
  defaultBars: 2,
  heroModeEnabled: true,
  defaultReelStyle: "photo",
};

describe("reel cost settings", () => {
  afterEach(async () => {
    superadmin = false;
    await db.delete(reelCostSettingsTable);
    await db.delete(adminAuditLogsTable).where(eq(adminAuditLogsTable.action, "reel_cost_settings_change"));
  });

  it("starts on the cost-saving defaults and is readable by every workspace", async () => {
    const res = await request(app()).get("/api/quick-create/reel-settings");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      tryOnImageQuality: "medium",
      reelResolution: "720p",
      defaultBars: 1,
      heroModeEnabled: true,
      defaultReelStyle: "hero",
    });
  });

  it("only a superadmin can change them, and every change is tracked", async () => {
    const server = app();
    expect((await request(server).put("/api/admin/reel-cost-settings").send(settings)).status).toBe(403);

    superadmin = true;
    const saved = await request(server).put("/api/admin/reel-cost-settings").send(settings);
    expect(saved.status).toBe(200);
    expect(saved.body.settings).toMatchObject({ ...settings, updatedBy: "admin@kokao.in" });
    expect(saved.body.history).toHaveLength(1);
    expect(JSON.parse(saved.body.history[0].from)).toMatchObject({ reelResolution: "720p" });
    expect(JSON.parse(saved.body.history[0].to)).toMatchObject({ reelResolution: "480p" });

    superadmin = false;
    const read = await request(server).get("/api/quick-create/reel-settings");
    expect(read.body).toMatchObject(settings);
  });

  it("refuses hero as the default while hero reels are off", async () => {
    superadmin = true;
    const res = await request(app())
      .put("/api/admin/reel-cost-settings")
      .send({ ...settings, heroModeEnabled: false, defaultReelStyle: "hero" });
    expect(res.status).toBe(400);
  });
});
