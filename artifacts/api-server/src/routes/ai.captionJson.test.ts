/**
 * Billing tests for the NON-streaming caption endpoint POST /ai/generate-caption
 * (still used by mobile and non-SSE clients). Mirrors the harness in
 * ai.captionStream.test.ts: mocked ../lib/plans and ../lib/textGen, real dev DB.
 *
 * Covers the funding path:
 *  - success: exactly one usage_events row with the right funding source
 *  - model error: the reserved credit is refunded, no usage row
 *  - 402 when both quota and credits are exhausted (nothing spent)
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

// Controllable fake NON-streaming completion. Each test sets `completionScript`
// to either return a completion object or throw like a failed model call.
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

function postCaption(): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/ai/generate-caption",
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
    req.end(JSON.stringify({ prompt: "Write a post about coffee" }));
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

describe("JSON caption endpoint billing", () => {
  it("records exactly one quota-funded usage event on success", async () => {
    planState.captions = 100; // quota funding

    completionScript = async () => ({
      choices: [
        {
          message: {
            content:
              '{"title":"Morning brew","caption":"Morning brew magic","hashtags":["coffee"]}',
          },
        },
      ],
      usage: { prompt_tokens: 40, completion_tokens: 9 },
    });

    const res = await postCaption();
    expect(res.status).toBe(200);
    expect(res.body.caption).toBe("Morning brew magic");

    const rows = await usageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("caption");
    expect(rows[0].funding).toBe("quota");
    // Quota funded: the credit ledger must be untouched.
    expect(await ledgerRows()).toHaveLength(0);
  });

  it("settles a credit-funded success exactly once (credit stays spent)", async () => {
    await grantCredits({
      tenantId: tenant.tenantId,
      captionCredits: 1,
      imageCredits: 0,
      kind: "admin_grant",
    });

    completionScript = async () => ({
      choices: [{ message: { content: '{"caption":"Fresh roast","hashtags":["coffee"]}' } }],
    });

    const res = await postCaption();
    expect(res.status).toBe(200);

    const rows = await usageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].funding).toBe("credit");
    expect((await getCreditBalances(tenant.tenantId)).captionCredits).toBe(0);
    const kinds = (await ledgerRows()).map((r) => r.kind).sort();
    expect(kinds).toEqual(["admin_grant", "spend"]); // no refund entry
  });

  it("refunds the reserved credit when the model call throws", async () => {
    await grantCredits({
      tenantId: tenant.tenantId,
      captionCredits: 1,
      imageCredits: 0,
      kind: "admin_grant",
    });

    completionScript = async () => {
      throw new Error("model exploded");
    };

    const res = await postCaption();
    expect(res.status).toBe(500);

    // The reservation must be given back: balance restored, refund in the
    // ledger, and no usage event charged.
    expect((await getCreditBalances(tenant.tenantId)).captionCredits).toBe(1);
    const kinds = (await ledgerRows()).map((r) => r.kind).sort();
    expect(kinds).toEqual(["admin_grant", "refund", "spend"]);
    const refund = (await ledgerRows()).find((r) => r.kind === "refund")!;
    expect(refund.captionDelta).toBe(1);
    expect(await usageRows()).toHaveLength(0);
  });

  it("returns 402 and spends nothing when quota and credits are both exhausted", async () => {
    // planState.captions is 0 and no credits were granted.
    completionScript = async () => {
      throw new Error("must not be called");
    };

    const res = await postCaption();
    expect(res.status).toBe(402);
    expect(String(res.body.error)).toMatch(/quota/i);

    expect(await usageRows()).toHaveLength(0);
    expect(await ledgerRows()).toHaveLength(0);
    expect((await getCreditBalances(tenant.tenantId)).captionCredits).toBe(0);
  });
});
