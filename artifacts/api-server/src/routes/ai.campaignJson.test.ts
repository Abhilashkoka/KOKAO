/**
 * Billing tests for the NON-streaming campaign endpoint POST /ai/generate-campaign.
 * Mirrors the harness in ai.captionJson.test.ts: mocked ../lib/plans and
 * ../lib/textGen, real dev DB.
 *
 * Focus: the clarify branch. When the model answers with clarifying
 * questions instead of posts, every reserved caption credit must be
 * released — being asked a question must never charge a credit.
 * Assertions are on usage_events and the credit ledger/balance, not just
 * response shape.
 */
import { describe, it, expect, afterAll, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

// Controllable plan limits: captions=0 forces credit funding, a high limit
// gives quota funding.
const planState = { captions: 0 };
vi.mock("../lib/plans", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/plans")>();
  return {
    ...actual,
    getPlanLimits: vi.fn(async () => ({
      captions: planState.captions,
      images: 0,
      videos: 0,
      teamSeats: 0,
    })),
  };
});

// Controllable fake NON-streaming completion.
type Completion = {
  choices: Array<{ message: { content: string } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
};
let completionScript: () => Promise<Completion>;

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
            create: vi.fn(async () => completionScript()),
          },
        },
      },
    })),
  };
});

import { db, pool, usageEventsTable, creditLedgerTable, creditBalancesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import aiRouter from "./ai";
import { grantCredits, getCreditBalances } from "../lib/credits";
import { createTenant, deleteTenant, type TestTenant } from "../test/dbHelpers";

let server: http.Server;
let port: number;
let tenant: TestTenant;

beforeEach(async () => {
  tenant = await createTenant();
  planState.captions = 0;

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { tenantId: number }).tenantId = tenant.tenantId;
    (req as unknown as { log: unknown }).log = {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
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

function postCampaign(
  platforms: string[] = ["linkedin", "twitter"],
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

async function usageRows() {
  return db
    .select()
    .from(usageEventsTable)
    .where(eq(usageEventsTable.tenantId, tenant.tenantId));
}

async function ledgerRows() {
  return db
    .select()
    .from(creditLedgerTable)
    .where(eq(creditLedgerTable.tenantId, tenant.tenantId));
}

describe("JSON campaign endpoint clarify billing", () => {
  it("releases all reserved credits when the model returns clarifying questions", async () => {
    await grantCredits({
      tenantId: tenant.tenantId,
      captionCredits: 2, // one per platform
      imageCredits: 0,
      kind: "admin_grant",
    });

    completionScript = async () => ({
      choices: [
        {
          message: {
            content:
              '{"clarifyingQuestions":["What product is this about?","Who is the audience?"]}',
          },
        },
      ],
    });

    const res = await postCampaign();
    expect(res.status).toBe(200);
    expect(res.body.posts).toEqual([]);
    expect(res.body.clarifyingQuestions).toEqual([
      "What product is this about?",
      "Who is the audience?",
    ]);

    // Being asked a question must never cost a credit: full balance back,
    // spend+refund pair in the ledger, and no usage event charged.
    expect((await getCreditBalances(tenant.tenantId)).captionCredits).toBe(2);
    const kinds = (await ledgerRows()).map((r) => r.kind).sort();
    expect(kinds).toEqual(["admin_grant", "refund", "spend"]);
    const refund = (await ledgerRows()).find((r) => r.kind === "refund")!;
    expect(refund.captionDelta).toBe(2);
    expect(await usageRows()).toHaveLength(0);
  });

  it("charges no quota usage when a quota-funded campaign gets clarifying questions", async () => {
    planState.captions = 100; // quota funding

    completionScript = async () => ({
      choices: [
        { message: { content: '{"clarifyingQuestions":["Which platforms matter most?"]}' } },
      ],
    });

    const res = await postCampaign();
    expect(res.status).toBe(200);
    expect(res.body.clarifyingQuestions).toEqual(["Which platforms matter most?"]);

    // Quota funded: no usage event recorded and the ledger stays untouched.
    expect(await usageRows()).toHaveLength(0);
    expect(await ledgerRows()).toHaveLength(0);
  });

  it("releases all reserved credits when the model returns malformed output", async () => {
    await grantCredits({
      tenantId: tenant.tenantId,
      captionCredits: 2, // one per platform
      imageCredits: 0,
      kind: "admin_grant",
    });

    completionScript = async () => ({
      choices: [{ message: { content: "sorry, I cannot produce JSON today" } }],
    });

    const res = await postCampaign();
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Failed to generate campaign");

    // Nothing usable was made: full balance back, spend+refund pair in the
    // ledger, and zero usage events.
    expect((await getCreditBalances(tenant.tenantId)).captionCredits).toBe(2);
    const kinds = (await ledgerRows()).map((r) => r.kind).sort();
    expect(kinds).toEqual(["admin_grant", "refund", "spend"]);
    const refund = (await ledgerRows()).find((r) => r.kind === "refund")!;
    expect(refund.captionDelta).toBe(2);
    expect(await usageRows()).toHaveLength(0);
  });

  it("releases all reserved credits when the model returns empty posts", async () => {
    await grantCredits({
      tenantId: tenant.tenantId,
      captionCredits: 2,
      imageCredits: 0,
      kind: "admin_grant",
    });

    completionScript = async () => ({
      choices: [{ message: { content: '{"title":"Empty","posts":[]}' } }],
    });

    const res = await postCampaign();
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Failed to generate campaign");

    expect((await getCreditBalances(tenant.tenantId)).captionCredits).toBe(2);
    const kinds = (await ledgerRows()).map((r) => r.kind).sort();
    expect(kinds).toEqual(["admin_grant", "refund", "spend"]);
    expect(await usageRows()).toHaveLength(0);
  });

  it("charges no quota usage when a quota-funded campaign gets malformed output", async () => {
    planState.captions = 100; // quota funding

    completionScript = async () => ({
      choices: [{ message: { content: '{"posts":[{"platform":"linkedin"},{"platform":"twitter"}]}' } }],
    });

    const res = await postCampaign();
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Failed to generate campaign");

    // Quota funded: no usage event recorded and the ledger stays untouched.
    expect(await usageRows()).toHaveLength(0);
    expect(await ledgerRows()).toHaveLength(0);
  });

  it("releases all reserved credits when the completion request throws", async () => {
    await grantCredits({
      tenantId: tenant.tenantId,
      captionCredits: 2,
      imageCredits: 0,
      kind: "admin_grant",
    });

    completionScript = async () => {
      throw new Error("model exploded");
    };

    const res = await postCampaign();
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Failed to generate campaign");

    expect((await getCreditBalances(tenant.tenantId)).captionCredits).toBe(2);
    const kinds = (await ledgerRows()).map((r) => r.kind).sort();
    expect(kinds).toEqual(["admin_grant", "refund", "spend"]);
    expect(await usageRows()).toHaveLength(0);
  });

  it("records per-platform usage on success (sanity check the harness charges)", async () => {
    planState.captions = 100;

    completionScript = async () => ({
      choices: [
        {
          message: {
            content:
              '{"title":"Bold Brew Launch","posts":[' +
              '{"platform":"linkedin","caption":"Big day: our new blend is here.","hashtags":["coffee"],"imagePrompt":"a bag of coffee"},' +
              '{"platform":"twitter","caption":"New blend. Big flavor.","hashtags":["coffee"],"imagePrompt":"espresso shot"}]}',
          },
        },
      ],
      usage: { prompt_tokens: 40, completion_tokens: 9 },
    });

    const res = await postCampaign();
    expect(res.status).toBe(200);
    const posts = res.body.posts as Array<{ platform: string }>;
    expect(posts).toHaveLength(2);

    const rows = await usageRows();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.funding).sort()).toEqual(["quota", "quota"]);
    expect(await ledgerRows()).toHaveLength(0);
  });
});
