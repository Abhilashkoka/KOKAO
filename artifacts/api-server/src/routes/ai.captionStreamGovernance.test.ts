/**
 * Prompt-Kit governance tests for POST /ai/generate-caption/stream.
 *
 * Proves that an admin-published production template for the "caption" flow
 * actually reaches the SSE streaming route:
 *  - the governed text replaces the built-in RICE prompt as the system message
 *  - a compiled-prompt log row (flowKey "caption") is written on success AND
 *    on model failure
 *  - fail-open: with no production version the built-in RICE prompt is used
 *    and no compiled-prompt log row is written.
 *
 * Harness mirrors ai.campaignGovernance.test.ts (streaming section): mocked
 * ../lib/plans and ../lib/textGen, real dev DB.
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

type Chunk = { choices: Array<{ delta: { content?: string } }>; usage?: unknown };

// Per-test stream script; called when stream:true is detected.
let streamScript: (signal: AbortSignal | undefined) => AsyncGenerator<Chunk>;
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
              async (
                args: { messages: Array<{ role: string; content: string }>; stream?: boolean },
                opts?: { signal?: AbortSignal },
              ) => {
                capturedMessages.push(args.messages);
                // The streaming route always passes stream: true.
                return streamScript(opts?.signal);
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
// Snapshot/restore: any real production case types for "caption" that exist
// in the dev DB are temporarily deactivated so the test governs the flow.
// ---------------------------------------------------------------------------

let snapshotedActiveIds: number[] = [];
const CAPTION_SLUG_PREFIX = "test-caption-stream-gov-";
const GOVERNED_MARKER = `GOVERNED CAPTION STREAM RULES ${randomUUID()}`;

/** Deactivate all currently-active caption case types and record their IDs. */
async function deactivateExistingCaptionCaseTypes(): Promise<void> {
  const rows = await db
    .select({ id: promptCaseTypesTable.id })
    .from(promptCaseTypesTable)
    .where(
      and(
        eq(promptCaseTypesTable.flowKey, "caption"),
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
async function restoreCaptionCaseTypes(): Promise<void> {
  // Remove all test-only rows (including ones seeded in this run).
  const testRows = await db
    .select({ id: promptCaseTypesTable.id })
    .from(promptCaseTypesTable)
    .where(like(promptCaseTypesTable.slug, `${CAPTION_SLUG_PREFIX}%`));
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

async function seedProductionCaptionTemplate(): Promise<{
  caseId: number;
  templateId: number;
  versionId: number;
}> {
  const caseRow = (
    await db
      .insert(promptCaseTypesTable)
      .values({
        name: "Caption Stream (test)",
        slug: `${CAPTION_SLUG_PREFIX}${randomUUID()}`,
        status: "active",
        flowKey: "caption",
      })
      .returning()
  )[0]!;
  const template = (
    await db
      .insert(promptTemplatesTable)
      .values({ caseTypeId: caseRow.id, title: "Governed caption stream", status: "active" })
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
            content: `${GOVERNED_MARKER} for {{platform}} in {{tone}} tone`,
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
  // Deactivate any real production templates for caption so our test governs.
  await deactivateExistingCaptionCaseTypes();

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
  await restoreCaptionCaseTypes();
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

// ---------------------------------------------------------------------------
// HTTP helper — consumes the SSE stream and returns the parsed events.
// ---------------------------------------------------------------------------

function postCaptionStream(
  platform = "linkedin",
): Promise<{ status: number; events: Array<Record<string, unknown>> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/ai/generate-caption/stream",
        headers: { "Content-Type": "application/json" },
      },
      (res) => {
        let buf = "";
        res.on("data", (c: Buffer) => (buf += c.toString()));
        res.on("end", () => {
          const lines = buf.split("\n").filter((l) => l.startsWith("data:"));
          const events = lines.map(
            (l) => JSON.parse(l.slice(5).trim()) as Record<string, unknown>,
          );
          resolve({ status: res.statusCode ?? 0, events });
        });
      },
    );
    req.on("error", reject);
    req.end(
      JSON.stringify({ prompt: "Write a post about specialty coffee", platform }),
    );
  });
}

async function compiledLogRows() {
  return db
    .select()
    .from(compiledPromptLogsTable)
    .where(eq(compiledPromptLogsTable.tenantId, tenant.tenantId));
}

// Distinctive substring present in the built-in RICE prompt but absent from
// any governed template in these tests.
const BUILTIN_ROLE = "hands-on experience writing high-performing";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("caption streaming route Prompt Kit governance", () => {
  it("uses the governed production template as the system message and logs success", async () => {
    const seeded = await seedProductionCaptionTemplate();

    const fullJson =
      '{"caption":"Specialty coffee is worth every sip.","title":"Coffee","hashtags":["coffee","specialty"]}';

    async function* makeStream(): AsyncGenerator<Chunk> {
      for (const ch of fullJson) yield { choices: [{ delta: { content: ch } }] };
      // Final chunk carries usage and no content delta.
      yield {
        choices: [{ delta: {} }],
        usage: { prompt_tokens: 11, completion_tokens: 22 },
      };
    }
    streamScript = () => makeStream();

    const { status, events } = await postCaptionStream("linkedin");
    expect(status).toBe(200);

    const resultEvent = events.find((e) => e.type === "result");
    expect(resultEvent).toBeDefined();
    expect(resultEvent!.caption).toBeTruthy();

    // The system message must be the governed text, not the built-in RICE prompt.
    expect(capturedMessages).toHaveLength(1);
    const systemMsg = capturedMessages[0].find((m) => m.role === "system")!;
    expect(systemMsg.content).toContain(GOVERNED_MARKER);
    // Placeholders substituted from runtime values.
    expect(systemMsg.content).toContain("for linkedin");
    expect(systemMsg.content).not.toContain(BUILTIN_ROLE);
    // Runtime output contract appended so JSON parsing never breaks.
    expect(systemMsg.content).toContain('"caption"');

    // Compiled-prompt trace row: success, correct flow + lineage.
    const logs = await compiledLogRows();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      flowKey: "caption",
      success: true,
      caseTypeId: seeded.caseId,
      templateId: seeded.templateId,
      templateVersionId: seeded.versionId,
      clerkUserId,
      // Streamed usage: prompt_tokens + completion_tokens derived into totalTokens.
      tokenUsage: { promptTokens: 11, completionTokens: 22, totalTokens: 33 },
    });
    expect(logs[0].compiledPrompt).toContain(GOVERNED_MARKER);
    expect(logs[0].latencyMs).not.toBeNull();
  });

  it("logs a failed compiled-prompt row when the model call throws", async () => {
    const seeded = await seedProductionCaptionTemplate();

    async function* throwingStream(_signal: AbortSignal | undefined): AsyncGenerator<Chunk> {
      throw new Error("stream exploded");
      // eslint-disable-next-line no-unreachable
      yield { choices: [{ delta: {} }] };
    }
    streamScript = (signal) => throwingStream(signal);

    const { events } = await postCaptionStream("linkedin");
    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent!.message).toBe("Failed to generate caption");

    // The governed system message was used before the throw.
    expect(capturedMessages).toHaveLength(1);
    expect(capturedMessages[0].find((m) => m.role === "system")!.content).toContain(
      GOVERNED_MARKER,
    );

    const logs = await compiledLogRows();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      flowKey: "caption",
      success: false,
      templateVersionId: seeded.versionId,
    });
  });

  it("fails open to the built-in RICE prompt when no production version exists", async () => {
    // All real production templates are already deactivated in beforeEach.
    // Insert a case type with no production pointer: still ungoverned.
    await db.insert(promptCaseTypesTable).values({
      name: "Caption stream (test, no prod)",
      slug: `${CAPTION_SLUG_PREFIX}${randomUUID()}`,
      status: "active",
      flowKey: "caption",
    });

    const fullJson =
      '{"caption":"Good coffee is simple.","title":"Coffee","hashtags":["coffee"]}';

    async function* makeStream(): AsyncGenerator<Chunk> {
      for (const ch of fullJson) yield { choices: [{ delta: { content: ch } }] };
      yield {
        choices: [{ delta: {} }],
        usage: { prompt_tokens: 5, completion_tokens: 10 },
      };
    }
    streamScript = () => makeStream();

    const { events } = await postCaptionStream("linkedin");
    expect(events.find((e) => e.type === "result")).toBeDefined();

    // The built-in prompt must have been used, not any governed template.
    const systemMsg = capturedMessages[0].find((m) => m.role === "system")!;
    expect(systemMsg.content).toContain(BUILTIN_ROLE);
    expect(systemMsg.content).not.toContain(GOVERNED_MARKER);

    // Ungoverned: no compiled-prompt trace row.
    expect(await compiledLogRows()).toHaveLength(0);
  });
});
