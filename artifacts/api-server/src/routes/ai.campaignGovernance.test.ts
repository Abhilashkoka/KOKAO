/**
 * Prompt-Kit governance tests for POST /ai/generate-campaign and
 * POST /ai/generate-campaign/stream.
 *
 * Proves that an admin-published production template for the "campaign" flow
 * actually reaches generation on both routes:
 *  - the governed text replaces the built-in RICE prompt as the system message
 *  - a compiled-prompt log row (flowKey "campaign") is written on success AND
 *    on failure (no usable posts / model throws)
 *  - fail-open: with no production version the built-in RICE prompt is used
 *    and no compiled-prompt log row is written.
 *  - streamed route: error path writes a failure log row.
 *
 * Harness mirrors ai.carouselGovernance.test.ts: mocked ../lib/plans and
 * ../lib/textGen, real dev DB.
 */
import { describe, it, expect, afterAll, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

// High caption quota so funding never interferes.
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
type Chunk = { choices: Array<{ delta: { content?: string } }>; usage?: unknown };

// Shared per-test scripts; the mock detects stream:true and dispatches.
let completionScript: () => Promise<Completion>;
let streamScript: (signal: AbortSignal | undefined) => AsyncGenerator<Chunk>;
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
                if (args.stream) {
                  return streamScript(opts?.signal);
                }
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
  featureFlagsTable,
} from "@workspace/db";
import { and, eq, inArray, like } from "drizzle-orm";
import { randomUUID } from "crypto";
import aiRouter from "./ai";
import { invalidateFeatureFlagCache } from "../lib/featureFlags";
import { createTenant, deleteTenant, type TestTenant } from "../test/dbHelpers";

let server: http.Server;
let port: number;
let tenant: TestTenant;
const clerkUserId = `user_test_${randomUUID().slice(0, 8)}`;

// ---------------------------------------------------------------------------
// Snapshot/restore: any real production case types for "campaign" that exist
// in the dev DB are temporarily deactivated so the test governs the flow.
// ---------------------------------------------------------------------------

let snapshotedActiveIds: number[] = [];
const CAMPAIGN_SLUG_PREFIX = "test-campaign-gov-";
const GOVERNED_MARKER = `GOVERNED CAMPAIGN RULES ${randomUUID()}`;

async function deactivateExistingCampaignCaseTypes(): Promise<void> {
  const rows = await db
    .select({ id: promptCaseTypesTable.id })
    .from(promptCaseTypesTable)
    .where(
      and(
        eq(promptCaseTypesTable.flowKey, "campaign"),
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

async function restoreCampaignCaseTypes(): Promise<void> {
  // Delete all test-only rows (including ones seeded this run).
  const testRows = await db
    .select({ id: promptCaseTypesTable.id })
    .from(promptCaseTypesTable)
    .where(like(promptCaseTypesTable.slug, `${CAMPAIGN_SLUG_PREFIX}%`));
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

async function seedProductionCampaignTemplate(): Promise<{
  caseId: number;
  templateId: number;
  versionId: number;
}> {
  const caseRow = (
    await db
      .insert(promptCaseTypesTable)
      .values({
        name: "Campaign (test)",
        slug: `${CAMPAIGN_SLUG_PREFIX}${randomUUID()}`,
        status: "active",
        flowKey: "campaign",
      })
      .returning()
  )[0]!;
  const template = (
    await db
      .insert(promptTemplatesTable)
      .values({ caseTypeId: caseRow.id, title: "Governed campaign", status: "active" })
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
            content: `${GOVERNED_MARKER} for {{platforms}} in {{tone}} tone`,
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
  // Deactivate any real production templates for campaign so our test governs.
  await deactivateExistingCampaignCaseTypes();

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
  await restoreCampaignCaseTypes();
  await db.delete(usageEventsTable).where(eq(usageEventsTable.tenantId, tenant.tenantId));
  await db.delete(creditLedgerTable).where(eq(creditLedgerTable.tenantId, tenant.tenantId));
  await db
    .delete(creditBalancesTable)
    .where(eq(creditBalancesTable.tenantId, tenant.tenantId));
  await deleteTenant(tenant.tenantId);
  invalidateFeatureFlagCache();
});

afterAll(async () => {
  await pool.end();
});

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function postCampaign(
  platforms = ["linkedin", "twitter"],
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/ai/generate-campaign",
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
    req.end(JSON.stringify({ prompt: "Launch our new coffee blend", platforms }));
  });
}

function postCampaignStream(
  platforms = ["linkedin"],
): Promise<{ events: Array<Record<string, unknown>> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/ai/generate-campaign/stream",
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
          resolve({ events });
        });
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify({ prompt: "Launch our new coffee blend", platforms }));
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

const validCampaign = completionOf({
  title: "Coffee Campaign",
  posts: [
    {
      platform: "linkedin",
      caption: "Specialty coffee for the discerning palate.",
      hashtags: ["coffee", "specialty"],
      imagePrompt: "a cup of specialty coffee",
    },
    {
      platform: "twitter",
      caption: "Great coffee. Full stop.",
      hashtags: ["coffee"],
      imagePrompt: "espresso shot",
    },
  ],
});

// Distinctive substring present in the built-in RICE prompt but absent from
// any governed template in these tests.
const BUILTIN_ROLE = "social media strategist and expert copywriter";

async function enableCampaignStreaming(): Promise<void> {
  await db
    .delete(featureFlagsTable)
    .where(eq(featureFlagsTable.feature, "campaignStreaming"));
  await db
    .insert(featureFlagsTable)
    .values({ feature: "campaignStreaming", enabled: true });
  invalidateFeatureFlagCache();
}

// ---------------------------------------------------------------------------
// JSON campaign route governance
// ---------------------------------------------------------------------------

describe("campaign JSON route Prompt Kit governance", () => {
  it("uses the governed production template as the system message and logs success", async () => {
    const seeded = await seedProductionCampaignTemplate();
    completionScript = async () => validCampaign;

    const res = await postCampaign();
    expect(res.status).toBe(200);
    expect((res.body.posts as unknown[]).length).toBeGreaterThan(0);

    // The system message is the governed text, not the built-in RICE prompt.
    expect(capturedMessages).toHaveLength(1);
    const systemMsg = capturedMessages[0].find((m) => m.role === "system")!;
    expect(systemMsg.content).toContain(GOVERNED_MARKER);
    // Placeholders substituted from runtime values.
    expect(systemMsg.content).toContain("for linkedin");
    expect(systemMsg.content).not.toContain(BUILTIN_ROLE);
    // Runtime output contract is appended so parsing never breaks.
    expect(systemMsg.content).toContain('"posts"');

    // Compiled-prompt trace row: success, correct flow + lineage.
    const logs = await compiledLogRows();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      flowKey: "campaign",
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

  it("logs a failed compiled-prompt row when the model returns no usable posts", async () => {
    const seeded = await seedProductionCampaignTemplate();
    completionScript = async () => completionOf({ title: "Bad", posts: [] });

    const res = await postCampaign();
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Failed to generate campaign");

    const logs = await compiledLogRows();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      flowKey: "campaign",
      success: false,
      templateVersionId: seeded.versionId,
    });
  });

  it("logs a failed compiled-prompt row when the model call throws", async () => {
    const seeded = await seedProductionCampaignTemplate();
    completionScript = async () => {
      throw new Error("model exploded");
    };

    const res = await postCampaign();
    expect(res.status).toBe(500);

    const logs = await compiledLogRows();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      flowKey: "campaign",
      success: false,
      templateVersionId: seeded.versionId,
    });
  });

  it("fails open to the built-in RICE prompt when no production version exists", async () => {
    // All real production templates are already deactivated in beforeEach.
    // Insert a case type with no production pointer: still ungoverned.
    await db.insert(promptCaseTypesTable).values({
      name: "Campaign (test, no prod)",
      slug: `${CAMPAIGN_SLUG_PREFIX}${randomUUID()}`,
      status: "active",
      flowKey: "campaign",
    });

    completionScript = async () => validCampaign;

    const res = await postCampaign();
    expect(res.status).toBe(200);

    const systemMsg = capturedMessages[0].find((m) => m.role === "system")!;
    expect(systemMsg.content).toContain(BUILTIN_ROLE);
    expect(systemMsg.content).not.toContain(GOVERNED_MARKER);

    // Ungoverned: no compiled-prompt trace row.
    expect(await compiledLogRows()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Streaming campaign route governance
// ---------------------------------------------------------------------------

describe("campaign streaming route Prompt Kit governance", () => {
  it("uses the governed production template as the system message and logs success", async () => {
    await enableCampaignStreaming();
    const seeded = await seedProductionCampaignTemplate();

    const fullJson =
      '{"title":"Coffee Campaign","posts":[{"platform":"linkedin","caption":"Specialty coffee for the discerning palate.","hashtags":["coffee"],"imagePrompt":"coffee"}]}';

    async function* makeStream(): AsyncGenerator<Chunk> {
      for (const ch of fullJson) yield { choices: [{ delta: { content: ch } }] };
      yield { choices: [{ delta: {} }], usage: { prompt_tokens: 5, completion_tokens: 10 } };
    }
    streamScript = () => makeStream();

    const { events } = await postCampaignStream(["linkedin"]);
    const resultEvent = events.find((e) => e.type === "result");
    expect(resultEvent).toBeDefined();
    expect((resultEvent!.posts as unknown[]).length).toBe(1);

    // The governed system message was used.
    expect(capturedMessages).toHaveLength(1);
    const systemMsg = capturedMessages[0].find((m) => m.role === "system")!;
    expect(systemMsg.content).toContain(GOVERNED_MARKER);
    expect(systemMsg.content).not.toContain(BUILTIN_ROLE);

    const logs = await compiledLogRows();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      flowKey: "campaign",
      success: true,
      caseTypeId: seeded.caseId,
      templateId: seeded.templateId,
      templateVersionId: seeded.versionId,
      clerkUserId,
    });
    expect(logs[0].compiledPrompt).toContain(GOVERNED_MARKER);
  });

  it("logs a failed compiled-prompt row on stream error (model throws)", async () => {
    await enableCampaignStreaming();
    const seeded = await seedProductionCampaignTemplate();

    async function* throwingStream(_signal: AbortSignal | undefined): AsyncGenerator<Chunk> {
      throw new Error("stream exploded");
      // eslint-disable-next-line no-unreachable
      yield { choices: [{ delta: {} }] };
    }
    streamScript = (signal) => throwingStream(signal);

    const { events } = await postCampaignStream(["linkedin"]);
    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent!.message).toBe("Failed to generate campaign");

    const logs = await compiledLogRows();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      flowKey: "campaign",
      success: false,
      templateVersionId: seeded.versionId,
    });
  });

  it("fails open to the built-in RICE prompt when no production version exists (stream)", async () => {
    await enableCampaignStreaming();
    // All real production templates already deactivated in beforeEach.
    await db.insert(promptCaseTypesTable).values({
      name: "Campaign (stream test, no prod)",
      slug: `${CAMPAIGN_SLUG_PREFIX}${randomUUID()}`,
      status: "active",
      flowKey: "campaign",
    });

    const fullJson =
      '{"title":"Coffee","posts":[{"platform":"linkedin","caption":"Good coffee.","hashtags":["coffee"],"imagePrompt":"coffee"}]}';
    async function* makeStream(): AsyncGenerator<Chunk> {
      for (const ch of fullJson) yield { choices: [{ delta: { content: ch } }] };
      yield { choices: [{ delta: {} }], usage: { prompt_tokens: 5, completion_tokens: 10 } };
    }
    streamScript = () => makeStream();

    const { events } = await postCampaignStream(["linkedin"]);
    expect(events.find((e) => e.type === "result")).toBeDefined();

    const systemMsg = capturedMessages[0].find((m) => m.role === "system")!;
    expect(systemMsg.content).toContain(BUILTIN_ROLE);
    expect(systemMsg.content).not.toContain(GOVERNED_MARKER);

    // Ungoverned: no compiled-prompt trace row.
    expect(await compiledLogRows()).toHaveLength(0);
  });
});
