import { describe, it, expect, afterAll, afterEach, beforeEach } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { randomUUID } from "crypto";
import { vi } from "vitest";

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

import { pool, db, adminAuditLogsTable } from "@workspace/db";
import {
  promptCaseTypesTable,
  promptTemplatesTable,
  promptTemplateVersionsTable,
} from "@workspace/db";
import { desc, eq, inArray } from "drizzle-orm";
import { requireTenant } from "../middlewares/requireTenant";
import promptKitAdminRouter from "./promptKitAdmin";
import { resetAuthState, actAs } from "../test/authState";
import { createTenant, deleteTenant } from "../test/dbHelpers";

function makeApp(): Express {
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use((req, _res, next) => {
    (req as unknown as { log: Record<string, () => void> }).log = {
      info() {},
      error() {},
      warn() {},
      debug() {},
    };
    next();
  });
  app.use("/api", requireTenant, promptKitAdminRouter);
  return app;
}

const app = makeApp();

const createdCaseSlugs = new Set<string>();

async function cleanupCases(): Promise<void> {
  const slugs = [...createdCaseSlugs];
  if (!slugs.length) return;
  const cases = await db
    .select({ id: promptCaseTypesTable.id })
    .from(promptCaseTypesTable)
    .where(inArray(promptCaseTypesTable.slug, slugs));
  const caseIds = cases.map((c) => c.id);
  if (caseIds.length) {
    const tpls = await db
      .select({ id: promptTemplatesTable.id })
      .from(promptTemplatesTable)
      .where(inArray(promptTemplatesTable.caseTypeId, caseIds));
    const tIds = tpls.map((t) => t.id);
    if (tIds.length) {
      await db
        .update(promptTemplatesTable)
        .set({ activeProductionVersionId: null, activeStagingVersionId: null })
        .where(inArray(promptTemplatesTable.id, tIds));
      await db
        .delete(promptTemplateVersionsTable)
        .where(inArray(promptTemplateVersionsTable.templateId, tIds));
      await db
        .delete(promptTemplatesTable)
        .where(inArray(promptTemplatesTable.id, tIds));
    }
    await db
      .delete(promptCaseTypesTable)
      .where(inArray(promptCaseTypesTable.id, caseIds));
  }
  createdCaseSlugs.clear();
}

async function actAsSuperadmin() {
  const actor = await createTenant({
    isSuperadmin: true,
    email: `granted-${randomUUID()}@example.com`,
  });
  actAs(actor.clerkUserId, actor.email);
  return actor;
}

const testSlug = () => {
  const slug = `test-transfer-${randomUUID()}`;
  createdCaseSlugs.add(slug);
  return slug;
};

const blocks = (content = "Follow brand voice.") => [
  { id: "blk_mand", title: "Rules", content, mandatory: true, order: 1 },
];

function makeBundle(slug: string) {
  return {
    format: "kokao-prompt-kit",
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    cases: [
      {
        slug,
        name: "Transfer case",
        description: "moved between environments",
        riskLevel: "low",
        approvalRequired: false,
        flowKey: null,
        tags: ["transfer"],
        status: "active",
        templates: [
          {
            title: "Transfer template",
            description: null,
            status: "active",
            productionVersionNo: 2 as number | null,
            stagingVersionNo: null as number | null,
            createdBy: "origin@example.com",
            versions: [
              {
                versionNo: 1,
                parentVersionNo: null,
                blocks: blocks("v1 rules"),
                config: { tone: "warm" } as Record<string, unknown>,
                changeNotes: "Initial version",
                lifecycleState: "deprecated",
                evalStatus: "none",
              },
              {
                versionNo: 2,
                parentVersionNo: 1,
                blocks: blocks("v2 rules"),
                config: { tone: "warm" } as Record<string, unknown>,
                changeNotes: "Tightened rules",
                lifecycleState: "production",
                evalStatus: "passed",
              },
            ],
          },
        ],
      },
    ],
  };
}

beforeEach(() => {
  resetAuthState();
});

afterEach(async () => {
  await cleanupCases();
});

afterAll(async () => {
  await pool.end();
});

describe("RBAC — export/import are superadmin-only", () => {
  it("401 unauthenticated, 403 non-superadmin", async () => {
    expect((await request(app).get("/api/admin/prompt-kit/export")).status).toBe(401);
    const plain = await createTenant({
      email: `plain-${randomUUID()}@example.com`,
    });
    try {
      actAs(plain.clerkUserId, plain.email);
      expect((await request(app).get("/api/admin/prompt-kit/export")).status).toBe(403);
      expect(
        (
          await request(app)
            .post("/api/admin/prompt-kit/import")
            .send(makeBundle(testSlug()))
        ).status,
      ).toBe(403);
    } finally {
      await deleteTenant(plain.tenantId);
    }
  });
});

describe("Import — creates, promotes, and is idempotent", () => {
  it("imports a fresh bundle: case + template + versions + production pointer", async () => {
    const actor = await actAsSuperadmin();
    try {
      const slug = testSlug();
      const res = await request(app)
        .post("/api/admin/prompt-kit/import")
        .send(makeBundle(slug));
      expect(res.status).toBe(200);
      expect(res.body.casesCreated).toBe(1);
      expect(res.body.templatesCreated).toBe(1);
      expect(res.body.versionsCreated).toBe(2);
      expect(res.body.promotionsApplied).toBe(1);
      expect(res.body.warnings).toEqual([]);

      const caseRow = (
        await db
          .select()
          .from(promptCaseTypesTable)
          .where(eq(promptCaseTypesTable.slug, slug))
      )[0]!;
      const tpl = (
        await db
          .select()
          .from(promptTemplatesTable)
          .where(eq(promptTemplatesTable.caseTypeId, caseRow.id))
      )[0]!;
      const versions = await db
        .select()
        .from(promptTemplateVersionsTable)
        .where(eq(promptTemplateVersionsTable.templateId, tpl.id));
      const v2 = versions.find((v) => v.versionNo === 2)!;
      const v1 = versions.find((v) => v.versionNo === 1)!;
      expect(tpl.activeProductionVersionId).toBe(v2.id);
      expect(v2.lifecycleState).toBe("production");
      expect(v1.lifecycleState).toBe("deprecated");
      expect(v2.parentVersionId).toBe(v1.id);

      // Audit trail records the import.
      const logs = await db
        .select()
        .from(adminAuditLogsTable)
        .where(eq(adminAuditLogsTable.actorTenantId, actor.tenantId))
        .orderBy(desc(adminAuditLogsTable.id));
      expect(logs.map((l) => l.action)).toContain("prompt_kit_import");
    } finally {
      await deleteTenant(actor.tenantId);
    }
  });

  it("re-import updates in place — no duplicates, content refreshed", async () => {
    const actor = await actAsSuperadmin();
    try {
      const slug = testSlug();
      await request(app).post("/api/admin/prompt-kit/import").send(makeBundle(slug));

      const again = makeBundle(slug);
      again.cases[0]!.name = "Transfer case renamed";
      again.cases[0]!.templates[0]!.versions[1]!.blocks = blocks("v2 rules edited");
      const res = await request(app)
        .post("/api/admin/prompt-kit/import")
        .send(again);
      expect(res.status).toBe(200);
      expect(res.body.casesCreated).toBe(0);
      expect(res.body.casesUpdated).toBe(1);
      expect(res.body.templatesCreated).toBe(0);
      expect(res.body.versionsCreated).toBe(0);
      expect(res.body.versionsUpdated).toBe(2);

      const caseRows = await db
        .select()
        .from(promptCaseTypesTable)
        .where(eq(promptCaseTypesTable.slug, slug));
      expect(caseRows).toHaveLength(1);
      expect(caseRows[0]!.name).toBe("Transfer case renamed");
      const tpls = await db
        .select()
        .from(promptTemplatesTable)
        .where(eq(promptTemplatesTable.caseTypeId, caseRows[0]!.id));
      expect(tpls).toHaveLength(1);
      const versions = await db
        .select()
        .from(promptTemplateVersionsTable)
        .where(eq(promptTemplateVersionsTable.templateId, tpls[0]!.id));
      expect(versions).toHaveLength(2);
      expect(
        versions.find((v) => v.versionNo === 2)!.contentSnapshot[0]!.content,
      ).toBe("v2 rules edited");
    } finally {
      await deleteTenant(actor.tenantId);
    }
  });

  it("rejects malformed bundles and inconsistent promotions", async () => {
    const actor = await actAsSuperadmin();
    try {
      expect(
        (
          await request(app)
            .post("/api/admin/prompt-kit/import")
            .send({ format: "something-else", formatVersion: 1, cases: [] })
        ).status,
      ).toBe(400);

      const bad = makeBundle(testSlug());
      bad.cases[0]!.templates[0]!.productionVersionNo = 99;
      const res = await request(app)
        .post("/api/admin/prompt-kit/import")
        .send(bad);
      expect(res.status).toBe(400);
      expect(String(res.body.error)).toMatch(/missing version/i);
    } finally {
      await deleteTenant(actor.tenantId);
    }
  });

  it("staging pointer round-trips with lifecycle consistency; missing staging version is a 400", async () => {
    const actor = await actAsSuperadmin();
    try {
      const slug = testSlug();
      const bundle = makeBundle(slug);
      bundle.cases[0]!.templates[0]!.versions.push({
        versionNo: 3,
        parentVersionNo: 2,
        blocks: blocks("v3 rules"),
        config: {},
        changeNotes: "Staged candidate",
        lifecycleState: "staging",
        evalStatus: "none",
      });
      bundle.cases[0]!.templates[0]!.stagingVersionNo = 3;
      const res = await request(app)
        .post("/api/admin/prompt-kit/import")
        .send(bundle);
      expect(res.status).toBe(200);

      const caseRow = (
        await db
          .select()
          .from(promptCaseTypesTable)
          .where(eq(promptCaseTypesTable.slug, slug))
      )[0]!;
      const tpl = (
        await db
          .select()
          .from(promptTemplatesTable)
          .where(eq(promptTemplatesTable.caseTypeId, caseRow.id))
      )[0]!;
      const versions = await db
        .select()
        .from(promptTemplateVersionsTable)
        .where(eq(promptTemplateVersionsTable.templateId, tpl.id));
      const v3 = versions.find((v) => v.versionNo === 3)!;
      expect(tpl.activeStagingVersionId).toBe(v3.id);
      expect(v3.lifecycleState).toBe("staging");

      // Re-import moving the staging pointer to v1: v1 becomes staging, the
      // former staging version (v3) never lingers in "staging".
      bundle.cases[0]!.templates[0]!.stagingVersionNo = 1;
      bundle.cases[0]!.templates[0]!.versions[2]!.lifecycleState = "deprecated";
      await request(app).post("/api/admin/prompt-kit/import").send(bundle);
      const after = await db
        .select()
        .from(promptTemplateVersionsTable)
        .where(eq(promptTemplateVersionsTable.templateId, tpl.id));
      expect(after.find((v) => v.versionNo === 1)!.lifecycleState).toBe("staging");
      expect(after.find((v) => v.versionNo === 3)!.lifecycleState).not.toBe("staging");

      // Staging pointer to a version not in the bundle is rejected like production.
      const bad = makeBundle(testSlug());
      bad.cases[0]!.templates[0]!.stagingVersionNo = 42;
      const badRes = await request(app)
        .post("/api/admin/prompt-kit/import")
        .send(bad);
      expect(badRes.status).toBe(400);
      expect(String(badRes.body.error)).toMatch(/stages missing version/i);
    } finally {
      await deleteTenant(actor.tenantId);
    }
  });

  it("flow-key clash with another active case imports WITHOUT the binding and warns", async () => {
    const actor = await actAsSuperadmin();
    try {
      // An existing active case already bound to "caption".
      const holderSlug = testSlug();
      await db.insert(promptCaseTypesTable).values({
        name: "Holder",
        slug: holderSlug,
        flowKey: "caption",
        status: "active",
      });

      const bundle = makeBundle(testSlug());
      bundle.cases[0]!.flowKey = "caption" as never;
      const res = await request(app)
        .post("/api/admin/prompt-kit/import")
        .send(bundle);
      expect(res.status).toBe(200);
      expect(res.body.warnings.join(" ")).toMatch(/already bound/i);
      const imported = (
        await db
          .select()
          .from(promptCaseTypesTable)
          .where(eq(promptCaseTypesTable.slug, bundle.cases[0]!.slug))
      )[0]!;
      expect(imported.flowKey).toBeNull();

      // Regression: an EXISTING case with a different prior flow key must
      // also end up unbound when its requested flow is contested — never
      // silently keep the stale binding.
      await db
        .update(promptCaseTypesTable)
        .set({ flowKey: "image" })
        .where(eq(promptCaseTypesTable.slug, bundle.cases[0]!.slug));
      const res2 = await request(app)
        .post("/api/admin/prompt-kit/import")
        .send(bundle);
      expect(res2.status).toBe(200);
      expect(res2.body.warnings.join(" ")).toMatch(/already bound/i);
      const reimported = (
        await db
          .select()
          .from(promptCaseTypesTable)
          .where(eq(promptCaseTypesTable.slug, bundle.cases[0]!.slug))
      )[0]!;
      expect(reimported.flowKey).toBeNull();
    } finally {
      await deleteTenant(actor.tenantId);
    }
  });
});

describe("Export → import round trip", () => {
  it("export excludes logs/customizations and re-imports cleanly elsewhere", async () => {
    const actor = await actAsSuperadmin();
    try {
      const slug = testSlug();
      await request(app).post("/api/admin/prompt-kit/import").send(makeBundle(slug));

      const exported = await request(app).get("/api/admin/prompt-kit/export");
      expect(exported.status).toBe(200);
      expect(exported.body.format).toBe("kokao-prompt-kit");
      expect(exported.body.formatVersion).toBe(1);
      const c = exported.body.cases.find(
        (x: { slug: string }) => x.slug === slug,
      );
      expect(c).toBeTruthy();
      expect(c.templates[0].productionVersionNo).toBe(2);
      expect(c.templates[0].versions).toHaveLength(2);
      // Explicitly excluded content never appears in the bundle (scoped to
      // our own case: other real cases' prompt TEXT may mention anything).
      expect(JSON.stringify(c)).not.toMatch(/compiledPrompt|customization/i);
      expect(Object.keys(c)).not.toContain("customizations");
      expect(Object.keys(c.templates[0])).not.toContain("logs");

      // Re-import the exported bundle (simulating the other environment):
      // idempotent — updates only, no duplicates.
      const res = await request(app)
        .post("/api/admin/prompt-kit/import")
        .send(exported.body);
      expect(res.status).toBe(200);
      expect(res.body.casesCreated).toBe(0);
      expect(res.body.templatesCreated).toBe(0);
      expect(res.body.versionsCreated).toBe(0);
    } finally {
      await deleteTenant(actor.tenantId);
    }
  });
});
