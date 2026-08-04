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

import { pool, db } from "@workspace/db";
import {
  promptCaseTypesTable,
  promptTemplatesTable,
  promptTemplateVersionsTable,
  userPromptCustomizationsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { requireTenant } from "../middlewares/requireTenant";
import promptKitRouter from "./promptKit";
import { resetAuthState, actAs } from "../test/authState";
import { createTenant, deleteTenant } from "../test/dbHelpers";

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
  app.use("/api", requireTenant, promptKitRouter);
  return app;
}

const app = makeApp();

const createdCaseIds = new Set<number>();
const createdCustomizationIds = new Set<number>();

const testSlug = () => `test-${randomUUID()}`;

/** Create a case type + active template with a production version. */
async function seedLiveCase(over: Record<string, unknown> = {}) {
  const caseRow = (
    await db
      .insert(promptCaseTypesTable)
      .values({ name: "Case", slug: testSlug(), status: "active", ...over })
      .returning()
  )[0]!;
  createdCaseIds.add(caseRow.id);
  const template = (
    await db
      .insert(promptTemplatesTable)
      .values({ caseTypeId: caseRow.id, title: "T", status: "active" })
      .returning()
  )[0]!;
  const version = (
    await db
      .insert(promptTemplateVersionsTable)
      .values({
        templateId: template.id,
        caseTypeId: caseRow.id,
        versionNo: 1,
        contentSnapshot: [
          { id: "m", title: "Rules", content: "Stay on brand", mandatory: true, order: 1 },
        ],
        lifecycleState: "production",
      })
      .returning()
  )[0]!;
  await db
    .update(promptTemplatesTable)
    .set({ activeProductionVersionId: version.id })
    .where(eq(promptTemplatesTable.id, template.id));
  return { caseId: caseRow.id, templateId: template.id, versionId: version.id };
}

async function cleanup(): Promise<void> {
  const custIds = [...createdCustomizationIds];
  if (custIds.length) {
    await db
      .delete(userPromptCustomizationsTable)
      .where(inArray(userPromptCustomizationsTable.id, custIds));
  }
  const caseIds = [...createdCaseIds];
  if (caseIds.length) {
    // Also clean any customizations keyed to these cases (defensive).
    await db
      .delete(userPromptCustomizationsTable)
      .where(inArray(userPromptCustomizationsTable.caseTypeId, caseIds));
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
      await db.delete(promptTemplatesTable).where(inArray(promptTemplatesTable.id, tIds));
    }
    await db.delete(promptCaseTypesTable).where(inArray(promptCaseTypesTable.id, caseIds));
  }
  createdCustomizationIds.clear();
  createdCaseIds.clear();
}

beforeEach(() => {
  resetAuthState();
});

afterEach(async () => {
  await cleanup();
});

afterAll(async () => {
  await pool.end();
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe("User routes — require a tenant", () => {
  it("returns 401 to an unauthenticated caller", async () => {
    resetAuthState();
    const res = await request(app).get("/api/prompt-kit/customizations");
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Customization isolation (PRD §18.8)
// ---------------------------------------------------------------------------

describe("Customization isolation — user A cannot read/update user B's variant", () => {
  it("user A patching user B's customization gets 404 and B's row is untouched", async () => {
    const { caseId } = await seedLiveCase();
    const userA = await createTenant({ email: `a-${randomUUID()}@example.com` });
    const userB = await createTenant({ email: `b-${randomUUID()}@example.com` });
    try {
      // User B creates a customization.
      actAs(userB.clerkUserId, userB.email);
      const created = await request(app)
        .post("/api/prompt-kit/customizations")
        .send({ caseTypeId: caseId, title: "B private", instructionBlock: "B secret" });
      expect(created.status).toBe(200);
      const bId = created.body.id;
      createdCustomizationIds.add(bId);

      // User A cannot see it in their own list.
      actAs(userA.clerkUserId, userA.email);
      const list = await request(app).get("/api/prompt-kit/customizations");
      expect(list.status).toBe(200);
      expect(list.body.map((c: { id: number }) => c.id)).not.toContain(bId);

      // User A cannot patch it — strict owner scoping 404s.
      const patch = await request(app)
        .patch(`/api/prompt-kit/customizations/${bId}`)
        .send({ instructionBlock: "hijacked" });
      expect(patch.status).toBe(404);

      // B's row is unchanged.
      const row = (
        await db
          .select()
          .from(userPromptCustomizationsTable)
          .where(eq(userPromptCustomizationsTable.id, bId))
      )[0]!;
      expect(row.instructionBlock).toBe("B secret");
    } finally {
      await deleteTenant(userA.tenantId);
      await deleteTenant(userB.tenantId);
    }
  });

  it("owner can update their OWN customization (200) and toggle status", async () => {
    const { caseId } = await seedLiveCase();
    const user = await createTenant({ email: `u-${randomUUID()}@example.com` });
    try {
      actAs(user.clerkUserId, user.email);
      const created = await request(app)
        .post("/api/prompt-kit/customizations")
        .send({ caseTypeId: caseId, title: "mine", instructionBlock: "hello" });
      createdCustomizationIds.add(created.body.id);
      const patch = await request(app)
        .patch(`/api/prompt-kit/customizations/${created.body.id}`)
        .send({ instructionBlock: "updated", status: "disabled" });
      expect(patch.status).toBe(200);
      expect(patch.body.instructionBlock).toBe("updated");
      expect(patch.body.status).toBe("disabled");
    } finally {
      await deleteTenant(user.tenantId);
    }
  });
});

// ---------------------------------------------------------------------------
// Preview (placeholders + amendment layering)
// ---------------------------------------------------------------------------

describe("Preview — merged layers with the caller's amendment", () => {
  it("shows the admin layer summary + mandatory titles + the user's amendment (after admin layers)", async () => {
    const { caseId } = await seedLiveCase();
    const user = await createTenant({ email: `u-${randomUUID()}@example.com` });
    try {
      actAs(user.clerkUserId, user.email);
      const res = await request(app)
        .post("/api/prompt-kit/preview")
        .send({
          caseTypeId: caseId,
          instructionBlock: "MY_AMENDMENT",
          sampleInput: "MY_REQUEST",
        });
      expect(res.status).toBe(200);
      const preview: string = res.body.preview;
      // The user amendment is placed AFTER the admin template section.
      expect(preview.indexOf("Admin template")).toBeLessThan(
        preview.indexOf("Your customization"),
      );
      expect(preview).toContain("MY_AMENDMENT");
      // Mandatory block TITLE is surfaced (not its full internals).
      expect(preview).toContain("Rules");
      expect(preview).not.toContain("Stay on brand");
      expect(res.body.missingPlaceholders).toEqual([]);
    } finally {
      await deleteTenant(user.tenantId);
    }
  });

  it("returns 404 for a case type that is not active/does not exist", async () => {
    const user = await createTenant({ email: `u-${randomUUID()}@example.com` });
    try {
      actAs(user.clerkUserId, user.email);
      const res = await request(app)
        .post("/api/prompt-kit/preview")
        .send({ caseTypeId: 2000000000, instructionBlock: "x" });
      expect(res.status).toBe(404);
    } finally {
      await deleteTenant(user.tenantId);
    }
  });

  it("cannot preview another user's customization by id (amendment resolves to none)", async () => {
    const { caseId } = await seedLiveCase();
    const userA = await createTenant({ email: `a-${randomUUID()}@example.com` });
    const userB = await createTenant({ email: `b-${randomUUID()}@example.com` });
    try {
      actAs(userB.clerkUserId, userB.email);
      const created = await request(app)
        .post("/api/prompt-kit/customizations")
        .send({ caseTypeId: caseId, title: "B", instructionBlock: "B_SECRET" });
      createdCustomizationIds.add(created.body.id);

      actAs(userA.clerkUserId, userA.email);
      const res = await request(app)
        .post("/api/prompt-kit/preview")
        .send({ caseTypeId: caseId, customizationId: created.body.id });
      expect(res.status).toBe(200);
      // A cannot see B's secret amendment; it resolves to "(none selected)".
      expect(res.body.preview).not.toContain("B_SECRET");
      expect(res.body.preview).toContain("(none selected)");
    } finally {
      await deleteTenant(userA.tenantId);
      await deleteTenant(userB.tenantId);
    }
  });
});

// ---------------------------------------------------------------------------
// Cases listing (only active with live-template indicator)
// ---------------------------------------------------------------------------

describe("GET /prompt-kit/cases — active cases with a live-template indicator", () => {
  it("lists our active case and flags it as having a live template", async () => {
    const { caseId } = await seedLiveCase();
    const user = await createTenant({ email: `u-${randomUUID()}@example.com` });
    try {
      actAs(user.clerkUserId, user.email);
      const res = await request(app).get("/api/prompt-kit/cases");
      expect(res.status).toBe(200);
      const ours = (res.body as Array<{ id: number; hasLiveTemplate: boolean }>).find(
        (c) => c.id === caseId,
      );
      expect(ours).toBeDefined();
      expect(ours!.hasLiveTemplate).toBe(true);
    } finally {
      await deleteTenant(user.tenantId);
    }
  });

  it("rejects creating a customization for a non-active case (400)", async () => {
    const user = await createTenant({ email: `u-${randomUUID()}@example.com` });
    try {
      actAs(user.clerkUserId, user.email);
      const res = await request(app)
        .post("/api/prompt-kit/customizations")
        .send({ caseTypeId: 2000000000, title: "x", instructionBlock: "y" });
      expect(res.status).toBe(400);
    } finally {
      await deleteTenant(user.tenantId);
    }
  });
});
