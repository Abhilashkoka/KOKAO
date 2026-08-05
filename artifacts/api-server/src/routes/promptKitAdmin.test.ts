import { describe, it, expect, afterAll, afterEach, beforeEach, vi } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import { randomUUID } from "crypto";

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

// The playground route calls the real text-gen client, which would hit a live
// model. Mock it so we assert routing + persistence without a real call.
const createMock = vi.fn(async () => ({
  choices: [{ message: { content: "MOCK_OUTPUT" } }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
}));
vi.mock("../lib/textGen", () => {
  class TextGenNotConfiguredError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "TextGenNotConfiguredError";
    }
  }
  return {
    TextGenNotConfiguredError,
    getTextGenClient: vi.fn(async () => ({
      client: { chat: { completions: { create: createMock } } },
      provider: "builtin",
      model: "mock-model",
    })),
  };
});

import { pool, db } from "@workspace/db";
import {
  promptCaseTypesTable,
  promptTemplatesTable,
  promptTemplateVersionsTable,
  promptReviewsTable,
  promptTestCasesTable,
  promptTestRunsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { requireTenant } from "../middlewares/requireTenant";
import promptKitAdminRouter from "./promptKitAdmin";
import { resetAuthState, actAs } from "../test/authState";
import { createTenant, deleteTenant } from "../test/dbHelpers";

const OWNER_EMAIL = "abhilash.koka1@gmail.com";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
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

// Everything we create is tracked and torn down; seeded rows (real slugs) are
// never touched because our slugs are always `test-…` with a random suffix.
const createdCaseIds = new Set<number>();
const createdTemplateIds = new Set<number>();

async function cleanupCases(): Promise<void> {
  const caseIds = [...createdCaseIds];
  const templateIds = [...createdTemplateIds];
  const allTemplateIds = new Set(templateIds);
  if (caseIds.length) {
    const tpls = await db
      .select({ id: promptTemplatesTable.id })
      .from(promptTemplatesTable)
      .where(inArray(promptTemplatesTable.caseTypeId, caseIds));
    for (const t of tpls) allTemplateIds.add(t.id);
  }
  const tIds = [...allTemplateIds];
  if (tIds.length) {
    const versions = await db
      .select({ id: promptTemplateVersionsTable.id })
      .from(promptTemplateVersionsTable)
      .where(inArray(promptTemplateVersionsTable.templateId, tIds));
    const vIds = versions.map((v) => v.id);
    if (vIds.length) {
      await db
        .delete(promptTestRunsTable)
        .where(inArray(promptTestRunsTable.promptVersionId, vIds));
      await db
        .delete(promptReviewsTable)
        .where(inArray(promptReviewsTable.promptVersionId, vIds));
    }
    // Break the FK-ish pointer before deleting versions.
    await db
      .update(promptTemplatesTable)
      .set({ activeProductionVersionId: null, activeStagingVersionId: null })
      .where(inArray(promptTemplatesTable.id, tIds));
    await db
      .delete(promptTemplateVersionsTable)
      .where(inArray(promptTemplateVersionsTable.templateId, tIds));
    await db.delete(promptTemplatesTable).where(inArray(promptTemplatesTable.id, tIds));
  }
  if (caseIds.length) {
    await db
      .delete(promptTestCasesTable)
      .where(inArray(promptTestCasesTable.caseTypeId, caseIds));
    await db
      .delete(promptCaseTypesTable)
      .where(inArray(promptCaseTypesTable.id, caseIds));
  }
  createdCaseIds.clear();
  createdTemplateIds.clear();
}

/** Create a superadmin actor and act as them; returns the tenant for cleanup. */
async function actAsSuperadmin() {
  const actor = await createTenant({
    isSuperadmin: true,
    email: `granted-${randomUUID()}@example.com`,
  });
  actAs(actor.clerkUserId, actor.email);
  return actor;
}

const testSlug = (p = "test") => `${p}-${randomUUID()}`;

const mandatoryBlocks = (content = "Follow brand voice.") => [
  { id: "blk_mand", title: "Rules", content, mandatory: true, order: 1 },
];

beforeEach(() => {
  resetAuthState();
  createMock.mockClear();
});

afterEach(async () => {
  await cleanupCases();
});

afterAll(async () => {
  await pool.end();
});

// ---------------------------------------------------------------------------
// RBAC
// ---------------------------------------------------------------------------

describe("RBAC — /admin/prompt-kit/* is superadmin-only", () => {
  it("returns 401 to an unauthenticated caller", async () => {
    resetAuthState();
    const res = await request(app).get("/api/admin/prompt-kit/cases");
    expect(res.status).toBe(401);
  });

  it("returns 403 to an authenticated non-superadmin", async () => {
    const actor = await createTenant({ email: `plain-${randomUUID()}@example.com` });
    try {
      actAs(actor.clerkUserId, actor.email);
      const res = await request(app).get("/api/admin/prompt-kit/cases");
      expect(res.status).toBe(403);
    } finally {
      await deleteTenant(actor.tenantId);
    }
  });

  it("blocks a non-superadmin from creating case types (403, nothing written)", async () => {
    const actor = await createTenant({ email: `plain-${randomUUID()}@example.com` });
    try {
      actAs(actor.clerkUserId, actor.email);
      const slug = testSlug();
      const res = await request(app)
        .post("/api/admin/prompt-kit/cases")
        .send({ name: "Nope", slug });
      expect(res.status).toBe(403);
      const rows = await db
        .select()
        .from(promptCaseTypesTable)
        .where(eq(promptCaseTypesTable.slug, slug));
      expect(rows).toHaveLength(0);
    } finally {
      await deleteTenant(actor.tenantId);
    }
  });
});

// ---------------------------------------------------------------------------
// Versioning
// ---------------------------------------------------------------------------

describe("Versioning — immutable, monotonically increasing", () => {
  it("creating a template seeds v1; each new version increments versionNo; there is no update route", async () => {
    const actor = await actAsSuperadmin();
    try {
      const caseRes = await request(app)
        .post("/api/admin/prompt-kit/cases")
        .send({ name: "Ver", slug: testSlug() });
      expect(caseRes.status).toBe(200);
      createdCaseIds.add(caseRes.body.id);

      const tplRes = await request(app)
        .post("/api/admin/prompt-kit/templates")
        .send({ caseTypeId: caseRes.body.id, title: "T", blocks: mandatoryBlocks() });
      expect(tplRes.status).toBe(200);
      createdTemplateIds.add(tplRes.body.id);
      expect(tplRes.body.latestVersionNo).toBe(1);

      const v2 = await request(app)
        .post(`/api/admin/prompt-kit/templates/${tplRes.body.id}/versions`)
        .send({ blocks: mandatoryBlocks("v2") });
      expect(v2.status).toBe(200);
      expect(v2.body.versionNo).toBe(2);

      const v3 = await request(app)
        .post(`/api/admin/prompt-kit/templates/${tplRes.body.id}/versions`)
        .send({ blocks: mandatoryBlocks("v3") });
      expect(v3.status).toBe(200);
      expect(v3.body.versionNo).toBe(3);

      // Versions are immutable: no PATCH/PUT route exists on a version.
      const patchRes = await request(app)
        .patch(`/api/admin/prompt-kit/versions/${v2.body.id}`)
        .send({ blocks: mandatoryBlocks("hacked") });
      expect(patchRes.status).toBe(404);

      // Listing returns them newest-first, all distinct version numbers.
      const list = await request(app).get(
        `/api/admin/prompt-kit/templates/${tplRes.body.id}/versions`,
      );
      expect(list.status).toBe(200);
      expect(list.body.map((v: { versionNo: number }) => v.versionNo)).toEqual([3, 2, 1]);
    } finally {
      await deleteTenant(actor.tenantId);
    }
  });

  it("rejects a version with no non-empty mandatory block (400)", async () => {
    const actor = await actAsSuperadmin();
    try {
      const caseRes = await request(app)
        .post("/api/admin/prompt-kit/cases")
        .send({ name: "Ver2", slug: testSlug() });
      createdCaseIds.add(caseRes.body.id);
      const res = await request(app)
        .post("/api/admin/prompt-kit/templates")
        .send({
          caseTypeId: caseRes.body.id,
          title: "T",
          blocks: [{ id: "b", title: "b", content: "", mandatory: true, order: 1 }],
        });
      expect(res.status).toBe(400);
    } finally {
      await deleteTenant(actor.tenantId);
    }
  });
});

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

async function seedTemplate(
  caseBody: Record<string, unknown> = {},
): Promise<{ caseId: number; templateId: number; versionId: number }> {
  const caseRes = await request(app)
    .post("/api/admin/prompt-kit/cases")
    .send({ name: "Case", slug: testSlug(), ...caseBody });
  createdCaseIds.add(caseRes.body.id);
  const tplRes = await request(app)
    .post("/api/admin/prompt-kit/templates")
    .send({ caseTypeId: caseRes.body.id, title: "T", blocks: mandatoryBlocks() });
  createdTemplateIds.add(tplRes.body.id);
  const list = await request(app).get(
    `/api/admin/prompt-kit/templates/${tplRes.body.id}/versions`,
  );
  return {
    caseId: caseRes.body.id,
    templateId: tplRes.body.id,
    versionId: list.body[0].id,
  };
}

async function transition(versionId: number, to: string, comments?: string) {
  return request(app)
    .post(`/api/admin/prompt-kit/versions/${versionId}/transition`)
    .send({ to, ...(comments ? { comments } : {}) });
}

describe("Version deletion — draft/staging only", () => {
  it("deletes a draft version and its rows", async () => {
    await actAsSuperadmin();
    const { versionId, templateId } = await seedTemplate();
    const res = await request(app).delete(
      `/api/admin/prompt-kit/versions/${versionId}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const list = await request(app).get(
      `/api/admin/prompt-kit/templates/${templateId}/versions`,
    );
    expect(list.body.map((v: { id: number }) => v.id)).not.toContain(versionId);
  });

  it("deletes a staging version and clears the staging pointer", async () => {
    await actAsSuperadmin();
    const { versionId, templateId } = await seedTemplate();
    await transition(versionId, "staging");
    const res = await request(app).delete(
      `/api/admin/prompt-kit/versions/${versionId}`,
    );
    expect(res.status).toBe(200);
    const tpl = (
      await request(app).get("/api/admin/prompt-kit/templates")
    ).body.find((t: { id: number }) => t.id === templateId);
    expect(tpl.activeStagingVersionId ?? null).toBeNull();
  });

  it("refuses to delete a production version", async () => {
    await actAsSuperadmin();
    const { versionId } = await seedTemplate();
    await transition(versionId, "staging");
    await transition(versionId, "production");
    const res = await request(app).delete(
      `/api/admin/prompt-kit/versions/${versionId}`,
    );
    expect(res.status).toBe(400);
  });

  it("rejects delete for non-superadmins", async () => {
    await actAsSuperadmin();
    const { versionId } = await seedTemplate();
    const plain = await createTenant({
      email: `plain-${randomUUID()}@example.com`,
    });
    try {
      actAs(plain.clerkUserId, plain.email);
      const res = await request(app).delete(
        `/api/admin/prompt-kit/versions/${versionId}`,
      );
      expect(res.status).toBe(403);
    } finally {
      await deleteTenant(plain.tenantId);
    }
  });

  it("removes reviews and detaches child versions", async () => {
    await actAsSuperadmin();
    const { versionId, templateId } = await seedTemplate();
    // A review comment on the version to delete.
    await request(app)
      .post(`/api/admin/prompt-kit/versions/${versionId}/reviews`)
      .send({ comments: "note" });
    // A child version whose parent is the one we delete.
    const child = await request(app)
      .post(`/api/admin/prompt-kit/templates/${templateId}/versions`)
      .send({ blocks: mandatoryBlocks(), parentVersionId: versionId });
    expect(child.status).toBe(200);
    const res = await request(app).delete(
      `/api/admin/prompt-kit/versions/${versionId}`,
    );
    expect(res.status).toBe(200);
    const list = await request(app).get(
      `/api/admin/prompt-kit/templates/${templateId}/versions`,
    );
    const kid = list.body.find((v: { id: number }) => v.id === child.body.id);
    expect(kid.parentVersionId ?? null).toBeNull();
  });

  it("refuses to delete a pending_review version", async () => {
    await actAsSuperadmin();
    const { versionId } = await seedTemplate();
    await transition(versionId, "pending_review");
    const res = await request(app).delete(
      `/api/admin/prompt-kit/versions/${versionId}`,
    );
    expect(res.status).toBe(400);
  });
});

describe("Template deletion — blocked while live in production", () => {
  it("deletes a template with all its versions and reviews", async () => {
    await actAsSuperadmin();
    const { versionId, templateId } = await seedTemplate();
    await request(app)
      .post(`/api/admin/prompt-kit/versions/${versionId}/reviews`)
      .send({ comments: "note" });
    const res = await request(app).delete(
      `/api/admin/prompt-kit/templates/${templateId}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const list = await request(app).get(
      "/api/admin/prompt-kit/templates?includeArchived=true",
    );
    expect(
      list.body.find((t: { id: number }) => t.id === templateId),
    ).toBeUndefined();
    const versions = await db
      .select({ id: promptTemplateVersionsTable.id })
      .from(promptTemplateVersionsTable)
      .where(eq(promptTemplateVersionsTable.templateId, templateId));
    expect(versions).toHaveLength(0);
  });

  it("refuses to delete a template that is live in production", async () => {
    await actAsSuperadmin();
    const { versionId, templateId } = await seedTemplate();
    await transition(versionId, "staging");
    await transition(versionId, "production");
    const res = await request(app).delete(
      `/api/admin/prompt-kit/templates/${templateId}`,
    );
    expect(res.status).toBe(400);
  });

  it("rejects template delete for non-superadmins", async () => {
    await actAsSuperadmin();
    const { templateId } = await seedTemplate();
    const plain = await createTenant({
      email: `plain-${randomUUID()}@example.com`,
    });
    try {
      actAs(plain.clerkUserId, plain.email);
      const res = await request(app).delete(
        `/api/admin/prompt-kit/templates/${templateId}`,
      );
      expect(res.status).toBe(403);
    } finally {
      await deleteTenant(plain.tenantId);
    }
  });
});

describe("Transitions — lifecycle + promotion/rollback", () => {
  it("moves a low-risk version draft → staging → production", async () => {
    const actor = await actAsSuperadmin();
    try {
      const { versionId } = await seedTemplate();
      expect((await transition(versionId, "staging")).status).toBe(200);
      const prod = await transition(versionId, "production");
      expect(prod.status).toBe(200);
      expect(prod.body.lifecycleState).toBe("production");
    } finally {
      await deleteTenant(actor.tenantId);
    }
  });

  it("rejects an invalid transition (draft → production) with 400", async () => {
    const actor = await actAsSuperadmin();
    try {
      const { versionId } = await seedTemplate();
      const res = await transition(versionId, "production");
      expect(res.status).toBe(400);
    } finally {
      await deleteTenant(actor.tenantId);
    }
  });

  it("promoting a new version demotes the previous production version and repoints the pointer", async () => {
    const actor = await actAsSuperadmin();
    try {
      const { templateId, versionId: v1 } = await seedTemplate();
      await transition(v1, "staging");
      await transition(v1, "production");

      // Create v2, promote it.
      const v2res = await request(app)
        .post(`/api/admin/prompt-kit/templates/${templateId}/versions`)
        .send({ blocks: mandatoryBlocks("v2") });
      const v2 = v2res.body.id;
      await transition(v2, "staging");
      const prod2 = await transition(v2, "production");
      expect(prod2.status).toBe(200);

      // Pointer repointed to v2, old v1 demoted to deprecated.
      const tpl = (
        await db
          .select()
          .from(promptTemplatesTable)
          .where(eq(promptTemplatesTable.id, templateId))
      )[0]!;
      expect(tpl.activeProductionVersionId).toBe(v2);
      const v1row = (
        await db
          .select()
          .from(promptTemplateVersionsTable)
          .where(eq(promptTemplateVersionsTable.id, v1))
      )[0]!;
      expect(v1row.lifecycleState).toBe("deprecated");
    } finally {
      await deleteTenant(actor.tenantId);
    }
  });

  it("rollback: promoting an OLDER versionNo to production audits prompt_rollback", async () => {
    const actor = await actAsSuperadmin();
    const { db: realDb, adminAuditLogsTable } = await import("@workspace/db");
    const { desc } = await import("drizzle-orm");
    try {
      const { templateId, versionId: v1 } = await seedTemplate();
      await transition(v1, "staging");
      await transition(v1, "production");

      const v2res = await request(app)
        .post(`/api/admin/prompt-kit/templates/${templateId}/versions`)
        .send({ blocks: mandatoryBlocks("v2") });
      const v2 = v2res.body.id;
      await transition(v2, "staging");
      await transition(v2, "production");

      // Now roll back: v1 is deprecated → promote it again (older versionNo).
      await transition(v1, "staging");
      const rollback = await transition(v1, "production");
      expect(rollback.status).toBe(200);

      const logs = await realDb
        .select()
        .from(adminAuditLogsTable)
        .where(eq(adminAuditLogsTable.actorTenantId, actor.tenantId))
        .orderBy(desc(adminAuditLogsTable.id));
      const actions = logs.map((l) => l.action);
      expect(actions).toContain("prompt_rollback");
    } finally {
      await deleteTenant(actor.tenantId);
    }
  });
});

// ---------------------------------------------------------------------------
// Single active template per case type
// ---------------------------------------------------------------------------

describe("Single active template per case type", () => {
  it("creating a second active template for the same case type returns 400 and writes nothing", async () => {
    const actor = await actAsSuperadmin();
    try {
      const caseRes = await request(app)
        .post("/api/admin/prompt-kit/cases")
        .send({ name: "Uniq", slug: testSlug() });
      expect(caseRes.status).toBe(200);
      createdCaseIds.add(caseRes.body.id);

      const first = await request(app)
        .post("/api/admin/prompt-kit/templates")
        .send({ caseTypeId: caseRes.body.id, title: "First", blocks: mandatoryBlocks() });
      expect(first.status).toBe(200);
      createdTemplateIds.add(first.body.id);

      const second = await request(app)
        .post("/api/admin/prompt-kit/templates")
        .send({ caseTypeId: caseRes.body.id, title: "Second", blocks: mandatoryBlocks() });
      expect(second.status).toBe(400);
      expect(String(second.body.error)).toMatch(/active template already exists/i);

      const rows = await db
        .select({ id: promptTemplatesTable.id })
        .from(promptTemplatesTable)
        .where(eq(promptTemplatesTable.caseTypeId, caseRes.body.id));
      expect(rows).toHaveLength(1);
    } finally {
      await deleteTenant(actor.tenantId);
    }
  });

  it("reactivating an archived template while another is active returns 400", async () => {
    const actor = await actAsSuperadmin();
    try {
      const caseRes = await request(app)
        .post("/api/admin/prompt-kit/cases")
        .send({ name: "Uniq2", slug: testSlug() });
      createdCaseIds.add(caseRes.body.id);

      const first = await request(app)
        .post("/api/admin/prompt-kit/templates")
        .send({ caseTypeId: caseRes.body.id, title: "First", blocks: mandatoryBlocks() });
      expect(first.status).toBe(200);
      createdTemplateIds.add(first.body.id);

      // Archive the first (not in production, so allowed)...
      const archive = await request(app)
        .patch(`/api/admin/prompt-kit/templates/${first.body.id}`)
        .send({ status: "archived" });
      expect(archive.status).toBe(200);

      // ...create a second active template...
      const second = await request(app)
        .post("/api/admin/prompt-kit/templates")
        .send({ caseTypeId: caseRes.body.id, title: "Second", blocks: mandatoryBlocks() });
      expect(second.status).toBe(200);
      createdTemplateIds.add(second.body.id);

      // ...then reactivating the archived one must be refused.
      const reactivate = await request(app)
        .patch(`/api/admin/prompt-kit/templates/${first.body.id}`)
        .send({ status: "active" });
      expect(reactivate.status).toBe(400);
      expect(String(reactivate.body.error)).toMatch(/another active template/i);

      const firstRow = (
        await db
          .select()
          .from(promptTemplatesTable)
          .where(eq(promptTemplatesTable.id, first.body.id))
      )[0]!;
      expect(firstRow.status).toBe("archived");
    } finally {
      await deleteTenant(actor.tenantId);
    }
  });
});

// ---------------------------------------------------------------------------
// Review flow
// ---------------------------------------------------------------------------

describe("Review flow — approval gate", () => {
  it("blocks production promotion of a high-risk case until an approval exists (clear message)", async () => {
    const actor = await actAsSuperadmin();
    try {
      const { versionId } = await seedTemplate({ riskLevel: "high" });
      // Reach a state from which production is a VALID transition (staging),
      // so the 400 comes from the approval gate — not the state machine.
      await transition(versionId, "staging");
      const res = await transition(versionId, "production");
      expect(res.status).toBe(400);
      expect(String(res.body.error)).toMatch(/approval/i);
      // The template pointer was not repointed.
      const tpl = (
        await db
          .select()
          .from(promptTemplatesTable)
          .where(eq(promptTemplatesTable.id, (await db
            .select({ templateId: promptTemplateVersionsTable.templateId })
            .from(promptTemplateVersionsTable)
            .where(eq(promptTemplateVersionsTable.id, versionId)))[0]!.templateId))
      )[0]!;
      expect(tpl.activeProductionVersionId).toBeNull();
    } finally {
      await deleteTenant(actor.tenantId);
    }
  });

  it("high-risk: approving then promoting to production succeeds once approvedAt is set", async () => {
    // Use the allowlisted OWNER as the author and a different granted
    // superadmin as the approver.
    const author = await createTenant({ email: OWNER_EMAIL });
    const approver = await createTenant({
      isSuperadmin: true,
      email: `approver-${randomUUID()}@example.com`,
    });
    try {
      actAs(author.clerkUserId, OWNER_EMAIL);
      const { versionId } = await seedTemplate({ riskLevel: "high" });
      await transition(versionId, "pending_review");

      // Approver (a different superadmin) approves.
      actAs(approver.clerkUserId, approver.email);
      const approve = await transition(versionId, "approved", "looks good");
      expect(approve.status).toBe(200);

      const prod = await transition(versionId, "production");
      expect(prod.status).toBe(200);
      expect(prod.body.lifecycleState).toBe("production");
    } finally {
      await deleteTenant(author.tenantId);
      await deleteTenant(approver.tenantId);
    }
  });

  it("a superadmin's approve is immediate — even for their own version, with other superadmins present", async () => {
    const author = await createTenant({ email: OWNER_EMAIL });
    // Another granted superadmin exists — self-approval must still succeed.
    const other = await createTenant({
      isSuperadmin: true,
      email: `other-${randomUUID()}@example.com`,
    });
    try {
      actAs(author.clerkUserId, OWNER_EMAIL);
      const { versionId } = await seedTemplate({ riskLevel: "high" });
      await transition(versionId, "pending_review");
      const selfApprove = await transition(versionId, "approved");
      expect(selfApprove.status).toBe(200);
      expect(selfApprove.body.lifecycleState).toBe("approved");
      expect(selfApprove.body.approvedBy).toBe(OWNER_EMAIL);
    } finally {
      await deleteTenant(author.tenantId);
      await deleteTenant(other.tenantId);
    }
  });
});

// ---------------------------------------------------------------------------
// Playground (mocked text-gen)
// ---------------------------------------------------------------------------

describe("Playground — mocked text-gen client", () => {
  it("runs a version against a mocked model and persists the run", async () => {
    const actor = await actAsSuperadmin();
    try {
      const { versionId } = await seedTemplate();
      const res = await request(app)
        .post("/api/admin/prompt-kit/playground/run")
        .send({
          versionId,
          input: { userInput: "Announce our launch", placeholders: {} },
          customizationText: "Keep it playful",
        });
      expect(res.status).toBe(200);
      expect(res.body.outputText).toBe("MOCK_OUTPUT");
      expect(createMock).toHaveBeenCalledTimes(1);
      // The compiled prompt (not a real model round-trip) carries our layers.
      expect(res.body.compiledPrompt).toContain("Keep it playful");
      expect(res.body.compiledPrompt).toContain("Announce our launch");
    } finally {
      await deleteTenant(actor.tenantId);
    }
  });
});
