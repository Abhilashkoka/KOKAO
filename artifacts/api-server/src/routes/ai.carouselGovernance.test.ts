/**
 * Prompt-Kit governance tests for POST /ai/generate-carousel.
 *
 * Proves that an admin-published production template for the "carousel" flow
 * actually reaches generation:
 *  - the governed text replaces the built-in RICE prompt as the system message
 *  - a compiled-prompt log row (flowKey "carousel") is written on success AND
 *    on model failure
 *  - fail-open: with no production version the built-in RICE prompt is used
 *    and no compiled-prompt log row is written.
 *
 * Harness mirrors ai.carouselJson.test.ts: mocked ../lib/plans and
 * ../lib/textGen, real dev DB.
 */
import { describe, it, expect, afterAll, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

// High caption quota so funding never interferes with these tests.
vi.mock("../lib/plans", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/plans")>();
  return {
    ...actual,
    getPlanLimits: vi.fn(async () => ({
      captions: 100,
      images: 0,
      videos: 0,
      teamSeats: 0,
    })),
  };
});

type Completion = {
  choices: Array<{ message: { content: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
};
let completionScript: () => Promise<Completion>;
// Every create() call's messages array, so tests can assert the system prompt.
let capturedMessages: Array<Array<{ role: string; content: string }>> = [];

vi.mock("../lib/textGen", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/textGen")>();
  return {
    ...actual,
    getTextGenClient: vi.fn(async () => ({
      provider: "builtin",
      model: "test-model",
      client: {
        chat: {
          completions: {
            create: vi.fn(
              async (args: { messages: Array<{ role: string; content: string }> }) => {
                capturedMessages.push(args.messages);
                return completionScript();
              },
            ),
          },
        },
      },
    })),
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
// Snapshot/restore: any real production case types for "carousel" that exist
// in the dev DB are temporarily deactivated so the test governs the flow.
// ---------------------------------------------------------------------------

let snapshotedActiveIds: number[] = [];
const CAROUSEL_SLUG_PREFIX = "test-carousel-gov-";
const GOVERNED_MARKER = `GOVERNED CAROUSEL RULES ${randomUUID()}`;

/** Deactivate all currently-active carousel case types and record their IDs. */
async function deactivateExistingCarouselCaseTypes(): Promise<void> {
  const rows = await db
    .select({ id: promptCaseTypesTable.id })
    .from(promptCaseTypesTable)
    .where(
      and(
        eq(promptCaseTypesTable.flowKey, "carousel"),
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

/** Restore previously-active case types and delete all test-only rows. */
async function restoreCarouselCaseTypes(): Promise<void> {
  // Remove all test-only rows (including ones seeded in this run).
  const testRows = await db
    .select({ id: promptCaseTypesTable.id })
    .from(promptCaseTypesTable)
    .where(like(promptCaseTypesTable.slug, `${CAROUSEL_SLUG_PREFIX}%`));
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

// ---------------------------------------------------------------------------
// Prompt Kit seeding: a live production template for the carousel flow.
// ---------------------------------------------------------------------------

async function seedProductionCarouselTemplate(): Promise<{
  caseId: number;
  templateId: number;
  versionId: number;
}> {
  const caseRow = (
    await db
      .insert(promptCaseTypesTable)
      .values({
        name: "Carousel (test)",
        slug: `${CAROUSEL_SLUG_PREFIX}${randomUUID()}`,
        status: "active",
        flowKey: "carousel",
      })
      .returning()
  )[0]!;
  const template = (
    await db
      .insert(promptTemplatesTable)
      .values({ caseTypeId: caseRow.id, title: "Governed carousel", status: "active" })
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
            title: "Rules",
            content: `${GOVERNED_MARKER} for {{platform}} with {{slideCount}} slides`,
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
  capturedMessages = [];
  // Deactivate any real production templates for carousel so our test governs.
  await deactivateExistingCarouselCaseTypes();

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
  await restoreCarouselCaseTypes();
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

function postCarousel(): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/ai/generate-carousel",
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
    req.end(
      JSON.stringify({ prompt: "Make a carousel about coffee", slideCount: 3, platform: "linkedin" }),
    );
  });
}

async function compiledLogRows() {
  return db
    .select()
    .from(compiledPromptLogsTable)
    .where(eq(compiledPromptLogsTable.tenantId, tenant.tenantId));
}

function completionOf(obj: unknown): Completion {
  return {
    choices: [{ message: { content: JSON.stringify(obj) } }],
    usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 },
  };
}

const validCarousel = completionOf({
  title: "Coffee Done Right",
  caption: "Three truths about coffee.",
  hashtags: ["coffee"],
  slides: [
    { heading: "Slide 1", body: "Body 1", imagePrompt: "p1" },
    { heading: "Slide 2", body: "Body 2", imagePrompt: "p2" },
    { heading: "Slide 3", body: "Body 3", imagePrompt: "p3" },
  ],
});

const incompleteCarousel = completionOf({
  title: "Coffee",
  caption: "A caption",
  hashtags: ["coffee"],
  slides: [{ heading: "Slide 1", body: "Body 1", imagePrompt: "p1" }],
});

// The built-in RICE role line — presence/absence distinguishes the built-in
// prompt from the governed one.
const BUILTIN_ROLE =
  "senior social media strategist and carousel designer with deep experience";

describe("carousel Prompt Kit governance", () => {
  it("uses the governed production template as the system message and logs success", async () => {
    const seeded = await seedProductionCarouselTemplate();
    completionScript = async () => validCarousel;

    const res = await postCarousel();
    expect(res.status).toBe(200);
    expect((res.body.slides as unknown[]).length).toBe(3);

    // The system message is the governed text, not the built-in RICE prompt.
    expect(capturedMessages).toHaveLength(1);
    const systemMsg = capturedMessages[0].find((m) => m.role === "system")!;
    expect(systemMsg.content).toContain(GOVERNED_MARKER);
    // Placeholders substituted from runtime values.
    expect(systemMsg.content).toContain("for linkedin with 3 slides");
    expect(systemMsg.content).not.toContain(BUILTIN_ROLE);
    // Runtime output contract is appended so parsing never breaks.
    expect(systemMsg.content).toContain('"slides"');

    // Compiled-prompt trace row: success, correct flow + lineage.
    const logs = await compiledLogRows();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      flowKey: "carousel",
      success: true,
      caseTypeId: seeded.caseId,
      templateId: seeded.templateId,
      templateVersionId: seeded.versionId,
      clerkUserId,
      tokenUsage: { promptTokens: 11, completionTokens: 22, totalTokens: 33 },
    });
    expect(logs[0].compiledPrompt).toContain(GOVERNED_MARKER);
    expect(logs[0].latencyMs).not.toBeNull();
  });

  it("logs a failed compiled-prompt row when the governed generation fails", async () => {
    const seeded = await seedProductionCarouselTemplate();
    // Incomplete on both attempts -> 500 after the retry.
    completionScript = async () => incompleteCarousel;

    const res = await postCarousel();
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Failed to generate carousel");

    // Both attempts used the governed system prompt.
    expect(capturedMessages).toHaveLength(2);
    for (const messages of capturedMessages) {
      expect(messages.find((m) => m.role === "system")!.content).toContain(GOVERNED_MARKER);
    }

    const logs = await compiledLogRows();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      flowKey: "carousel",
      success: false,
      templateVersionId: seeded.versionId,
    });
  });

  it("logs a failed compiled-prompt row when the model call throws", async () => {
    const seeded = await seedProductionCarouselTemplate();
    completionScript = async () => {
      throw new Error("model exploded");
    };

    const res = await postCarousel();
    expect(res.status).toBe(500);

    const logs = await compiledLogRows();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      flowKey: "carousel",
      success: false,
      templateVersionId: seeded.versionId,
    });
  });

  it("fails open to the built-in RICE prompt when no production version exists", async () => {
    // All real production templates are already deactivated in beforeEach.
    // Insert a case type with no production pointer: still ungoverned.
    await db.insert(promptCaseTypesTable).values({
      name: "Carousel (test, no prod)",
      slug: `${CAROUSEL_SLUG_PREFIX}${randomUUID()}`,
      status: "active",
      flowKey: "carousel",
    });

    completionScript = async () => validCarousel;

    const res = await postCarousel();
    expect(res.status).toBe(200);

    const systemMsg = capturedMessages[0].find((m) => m.role === "system")!;
    expect(systemMsg.content).toContain(BUILTIN_ROLE);
    expect(systemMsg.content).not.toContain(GOVERNED_MARKER);

    // Ungoverned: no compiled-prompt trace row.
    expect(await compiledLogRows()).toHaveLength(0);
  });
});
