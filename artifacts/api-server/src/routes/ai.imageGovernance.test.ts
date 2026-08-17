/**
 * Prompt-Kit governance tests for POST /ai/generate-image.
 *
 * Proves that an admin-published production template for the "image" flow
 * actually reaches generation:
 *  - the governed text replaces the raw user prompt passed to
 *    performImageGeneration (plain text — image providers never see JSON)
 *  - a compiled-prompt log row (flowKey "image") is written on success AND
 *    on generation failure
 *  - fail-open: with no production version the original user prompt is passed
 *    through unchanged and no compiled-prompt log row is written.
 *
 * Harness mirrors ai.carouselGovernance.test.ts: mocked ../lib/plans and
 * ../lib/imageGeneration, real dev DB.
 */
import { describe, it, expect, afterAll, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

// Enough image quota so funding never interferes.
vi.mock("../lib/plans", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/plans")>();
  return {
    ...actual,
    getPlanLimits: vi.fn(async () => ({
      captions: 0,
      images: 100,
      videos: 0,
      teamSeats: 0,
    })),
  };
});

// Capture the userPrompt that reaches performImageGeneration.
let capturedUserPrompts: string[] = [];
let imageGenScript: () => Promise<{
  imagePath: string;
  b64Json: string;
  meta: Record<string, unknown>;
}>;

vi.mock("../lib/imageGeneration", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/imageGeneration")>();
  return {
    ...actual,
    performImageGeneration: vi.fn(async (args: { userPrompt: string }) => {
      capturedUserPrompts.push(args.userPrompt);
      return imageGenScript();
    }),
  };
});

import { db, pool, usageEventsTable, creditLedgerTable, creditBalancesTable } from "@workspace/db";
import {
  promptCaseTypesTable,
  promptTemplatesTable,
  promptTemplateVersionsTable,
  compiledPromptLogsTable,
} from "@workspace/db";
import { and, eq, inArray, like } from "drizzle-orm";
import { randomUUID } from "crypto";
import aiRouter from "./ai";
import { createTenant, deleteTenant, type TestTenant } from "../test/dbHelpers";

let server: http.Server;
let port: number;
let tenant: TestTenant;
const clerkUserId = `user_test_${randomUUID().slice(0, 8)}`;

// ---------------------------------------------------------------------------
// Snapshot/restore: any real production case types for "image" that exist in
// the dev DB are temporarily deactivated so the test governs the flow.
// ---------------------------------------------------------------------------

let snapshotedActiveIds: number[] = [];
const IMAGE_SLUG_PREFIX = "test-image-gov-";
const GOVERNED_MARKER = `GOVERNED IMAGE RULES ${randomUUID()}`;
const USER_PROMPT = "a cup of specialty coffee on a marble table";

async function deactivateExistingImageCaseTypes(): Promise<void> {
  const rows = await db
    .select({ id: promptCaseTypesTable.id })
    .from(promptCaseTypesTable)
    .where(
      and(
        eq(promptCaseTypesTable.flowKey, "image"),
        eq(promptCaseTypesTable.status, "active"),
      ),
    );
  snapshotedActiveIds = rows.map((r) => r.id);
  if (snapshotedActiveIds.length === 0) return;
  await db
    .update(promptCaseTypesTable)
    .set({ status: "inactive" })
    .where(inArray(promptCaseTypesTable.id, snapshotedActiveIds));
}

async function restoreImageCaseTypes(): Promise<void> {
  // Delete all test-only rows (including ones seeded this run).
  const testRows = await db
    .select({ id: promptCaseTypesTable.id })
    .from(promptCaseTypesTable)
    .where(like(promptCaseTypesTable.slug, `${IMAGE_SLUG_PREFIX}%`));
  const testIds = testRows.map((r) => r.id);
  if (testIds.length > 0) {
    const tpls = await db
      .select({ id: promptTemplatesTable.id })
      .from(promptTemplatesTable)
      .where(inArray(promptTemplatesTable.caseTypeId, testIds));
    const tIds = tpls.map((t) => t.id);
    if (tIds.length > 0) {
      await db
        .update(promptTemplatesTable)
        .set({ activeProductionVersionId: null, activeStagingVersionId: null })
        .where(inArray(promptTemplatesTable.id, tIds));
      await db
        .delete(promptTemplateVersionsTable)
        .where(inArray(promptTemplateVersionsTable.templateId, tIds));
      await db.delete(promptTemplatesTable).where(inArray(promptTemplatesTable.id, tIds));
    }
    await db.delete(promptCaseTypesTable).where(inArray(promptCaseTypesTable.id, testIds));
  }
  // Re-activate the real ones.
  if (snapshotedActiveIds.length > 0) {
    await db
      .update(promptCaseTypesTable)
      .set({ status: "active" })
      .where(inArray(promptCaseTypesTable.id, snapshotedActiveIds));
    snapshotedActiveIds = [];
  }
}

async function seedProductionImageTemplate(): Promise<{
  caseId: number;
  templateId: number;
  versionId: number;
}> {
  const caseRow = (
    await db
      .insert(promptCaseTypesTable)
      .values({
        name: "Image (test)",
        slug: `${IMAGE_SLUG_PREFIX}${randomUUID()}`,
        status: "active",
        flowKey: "image",
      })
      .returning()
  )[0]!;
  const template = (
    await db
      .insert(promptTemplatesTable)
      .values({ caseTypeId: caseRow.id, title: "Governed image", status: "active" })
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
          {
            id: "m",
            title: "Style rules",
            content: `${GOVERNED_MARKER} — cinematic lighting, shallow depth of field`,
            mandatory: true,
            order: 1,
          },
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

// ---------------------------------------------------------------------------
// HTTP harness
// ---------------------------------------------------------------------------

beforeEach(async () => {
  tenant = await createTenant();
  capturedUserPrompts = [];
  // Deactivate any real production templates for image so our test governs.
  await deactivateExistingImageCaseTypes();

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { tenantId: number }).tenantId = tenant.tenantId;
    (req as unknown as { clerkUserId: string }).clerkUserId = clerkUserId;
    (req as unknown as { log: unknown }).log = {
      info() {},
      error() {},
      warn() {},
      debug() {},
    };
    next();
  });
  app.use(aiRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      port = (server.address() as AddressInfo).port;
      resolve();
    });
  });
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db
    .delete(compiledPromptLogsTable)
    .where(eq(compiledPromptLogsTable.tenantId, tenant.tenantId));
  await restoreImageCaseTypes();
  await db.delete(usageEventsTable).where(eq(usageEventsTable.tenantId, tenant.tenantId));
  await db.delete(creditLedgerTable).where(eq(creditLedgerTable.tenantId, tenant.tenantId));
  await db
    .delete(creditBalancesTable)
    .where(eq(creditBalancesTable.tenantId, tenant.tenantId));
  await deleteTenant(tenant.tenantId);
});

afterAll(async () => {
  await pool.end();
});

const FAKE_IMAGE_PATH = "images/test/governed.png";
const FAKE_B64 = Buffer.from("fake-image-bytes").toString("base64");

function successImageScript() {
  return async () => ({
    imagePath: FAKE_IMAGE_PATH,
    b64Json: FAKE_B64,
    meta: {
      provider: "openai",
      model: "dall-e-3",
      requestBytes: 100,
      responseBytes: 200,
      durationMs: 800,
    },
  });
}

function postImage(): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/ai/generate-image",
        headers: { "Content-Type": "application/json" },
      },
      (res) => {
        let buf = "";
        res.on("data", (c: Buffer) => (buf += c.toString()));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: JSON.parse(buf || "{}") as Record<string, unknown>,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify({ prompt: USER_PROMPT }));
  });
}

async function compiledLogRows() {
  return db
    .select()
    .from(compiledPromptLogsTable)
    .where(eq(compiledPromptLogsTable.tenantId, tenant.tenantId));
}

describe("image Prompt Kit governance", () => {
  it("passes the governed text to performImageGeneration and logs success", async () => {
    const seeded = await seedProductionImageTemplate();
    imageGenScript = successImageScript();

    const res = await postImage();
    expect(res.status).toBe(200);
    expect(res.body.imagePath).toBe(FAKE_IMAGE_PATH);

    // The governed text (not the raw user prompt) reached image generation.
    expect(capturedUserPrompts).toHaveLength(1);
    expect(capturedUserPrompts[0]).toContain(GOVERNED_MARKER);
    // The original user prompt is still included (appended as userInput).
    expect(capturedUserPrompts[0]).toContain(USER_PROMPT);

    // Compiled-prompt trace row: success, correct flow + lineage.
    const logs = await compiledLogRows();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      flowKey: "image",
      success: true,
      caseTypeId: seeded.caseId,
      templateId: seeded.templateId,
      templateVersionId: seeded.versionId,
      clerkUserId,
    });
    expect(logs[0].compiledPrompt).toContain(GOVERNED_MARKER);
    expect(logs[0].latencyMs).not.toBeNull();
  });

  it("logs a failed compiled-prompt row when image generation throws", async () => {
    const seeded = await seedProductionImageTemplate();
    imageGenScript = async () => {
      throw new Error("provider rejected the request");
    };

    const res = await postImage();
    expect(res.status).toBe(500);

    // The governed prompt was still passed before the failure.
    expect(capturedUserPrompts).toHaveLength(1);
    expect(capturedUserPrompts[0]).toContain(GOVERNED_MARKER);

    const logs = await compiledLogRows();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      flowKey: "image",
      success: false,
      templateVersionId: seeded.versionId,
    });
  });

  it("fails open to the original user prompt when no production version exists", async () => {
    // All real production templates are already deactivated in beforeEach.
    // Insert a case type with no production pointer: still ungoverned.
    await db.insert(promptCaseTypesTable).values({
      name: "Image (test, no prod)",
      slug: `${IMAGE_SLUG_PREFIX}${randomUUID()}`,
      status: "active",
      flowKey: "image",
    });

    imageGenScript = successImageScript();

    const res = await postImage();
    expect(res.status).toBe(200);

    // Ungoverned: performImageGeneration received the raw user prompt.
    expect(capturedUserPrompts).toHaveLength(1);
    expect(capturedUserPrompts[0]).not.toContain(GOVERNED_MARKER);
    expect(capturedUserPrompts[0]).toContain(USER_PROMPT);

    // Ungoverned: no compiled-prompt trace row.
    expect(await compiledLogRows()).toHaveLength(0);
  });
});
