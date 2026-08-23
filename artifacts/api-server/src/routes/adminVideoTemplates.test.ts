import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";

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
          const user = authState.users[id];
          if (!user) throw new Error("user not found");
          return user;
        },
      },
    },
    clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  };
});

import { db, pool, videoStyleProfilesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireTenant } from "../middlewares/requireTenant";
import adminVideoTemplatesRouter from "./adminVideoTemplates";
import { actAs, resetAuthState } from "../test/authState";
import { createTenant, deleteTenant, type TestTenant } from "../test/dbHelpers";

const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
const createdTenantIds: number[] = [];
const createdTemplateIds: number[] = [];

function createApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { log: typeof log }).log = log;
    next();
  });
  app.use("/api", requireTenant, adminVideoTemplatesRouter);
  return app;
}

const app = createApp();

async function newTenant(isSuperadmin = false): Promise<TestTenant> {
  const tenant = await createTenant({
    isSuperadmin,
    email: `template-admin-${crypto.randomUUID()}@example.com`,
  });
  createdTenantIds.push(tenant.tenantId);
  actAs(tenant.clerkUserId, tenant.email);
  return tenant;
}

beforeEach(() => {
  resetAuthState();
  log.info.mockClear();
  log.error.mockClear();
});

afterEach(async () => {
  for (const id of createdTemplateIds.splice(0)) {
    await db.delete(videoStyleProfilesTable).where(eq(videoStyleProfilesTable.id, id));
  }
  for (const id of createdTenantIds.splice(0)) {
    await deleteTenant(id);
  }
});

afterAll(async () => {
  await pool.end();
});

describe("admin video templates", () => {
  it("rejects a non-superadmin before a template is written", async () => {
    await newTenant(false);
    const response = await request(app).post("/api/admin/video-templates").send({
      name: "Not allowed",
    });

    expect(response.status).toBe(403);
    const rows = await db
      .select()
      .from(videoStyleProfilesTable)
      .where(eq(videoStyleProfilesTable.name, "Not allowed"));
    expect(rows).toHaveLength(0);
  });

  it("creates, lists, and deletes a published tenant-safe template", async () => {
    await newTenant(true);
    const created = await request(app).post("/api/admin/video-templates").send({
      name: "Quick B-roll explainer",
      summary: "A clear vertical explainer with stock footage.",
      slots: [],
      jobDefaults: {
        aspectRatio: "9:16",
        shotCount: 3,
        subtitles: true,
        captionStyle: "dynamic",
        paragraphCount: 1,
        visualsSource: "stock",
        stockSource: "auto",
      },
    });

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      name: "Quick B-roll explainer",
      scope: "platform",
      sourceKind: "curated",
      sourceVideoPath: null,
    });
    createdTemplateIds.push(created.body.id);

    const listed = await request(app).get("/api/admin/video-templates");
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: created.body.id })]),
    );

    const deleted = await request(app).delete(`/api/admin/video-templates/${created.body.id}`);
    expect(deleted.status).toBe(204);
    createdTemplateIds.splice(createdTemplateIds.indexOf(created.body.id), 1);

    const gone = await request(app).get("/api/admin/video-templates");
    expect(gone.body).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: created.body.id })]),
    );
  });

  it("rejects tenant-scoped defaults instead of accepting private workspace data", async () => {
    await newTenant(true);
    const response = await request(app).post("/api/admin/video-templates").send({
      name: "Unsafe",
      jobDefaults: { brandKitId: 42 },
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("brandKitId");
  });
});