/**
 * Billing tests for POST /ai/generate-carousel clarifying-question replies.
 * Mirrors the harness in ai.captionJson.test.ts: mocked ../lib/plans and
 * ../lib/textGen, real dev DB.
 *
 * Covers the clarify-and-refund branch: when the model answers ONLY with
 * {"clarifyingQuestions":[...]} the reserved caption funding must be
 * released — credit balance restored (spend+refund in the ledger) for the
 * credit-funded case, ledger untouched for the quota-funded case, and zero
 * usage_events rows either way.
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
    req.end(JSON.stringify({ prompt: "Make a carousel about coffee", slideCount: 3 }));
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

describe("carousel endpoint clarifying-question billing", () => {
  it("releases the reserved credit when the model returns clarifying questions", async () => {
    await grantCredits({
      tenantId: tenant.tenantId,
      captionCredits: 1,
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

    const res = await postCarousel();
    expect(res.status).toBe(200);
    expect(res.body.slides).toEqual([]);
    expect(res.body.clarifyingQuestions).toEqual([
      "What product is this about?",
      "Who is the audience?",
    ]);

    // Nothing was generated: the credit must come back and no usage charged.
    expect((await getCreditBalances(tenant.tenantId)).captionCredits).toBe(1);
    const kinds = (await ledgerRows()).map((r) => r.kind).sort();
    expect(kinds).toEqual(["admin_grant", "refund", "spend"]);
    const refund = (await ledgerRows()).find((r) => r.kind === "refund")!;
    expect(refund.captionDelta).toBe(1);
    expect(await usageRows()).toHaveLength(0);
  });

  it("charges no quota usage when a quota-funded request gets clarifying questions", async () => {
    planState.captions = 100; // quota funding

    completionScript = async () => ({
      choices: [
        { message: { content: '{"clarifyingQuestions":["Which platform?"]}' } },
      ],
    });

    const res = await postCarousel();
    expect(res.status).toBe(200);
    expect(res.body.clarifyingQuestions).toEqual(["Which platform?"]);

    // Quota funded: no usage event recorded and the ledger stays untouched.
    expect(await usageRows()).toHaveLength(0);
    expect(await ledgerRows()).toHaveLength(0);
  });
});
