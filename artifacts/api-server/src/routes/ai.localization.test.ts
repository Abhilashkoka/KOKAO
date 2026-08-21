/**
 * Billing and timing-spine tests for POST /ai/localize-script.
 *
 * Localization reserves one caption unit per target locale. These tests guard
 * the multi-locale edge cases that single-generation billing tests cannot see:
 * one remaining quota slot must not fund every locale, and a failed locale must
 * not strand a successful locale on prepaid credit while quota is still free.
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";

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

type Completion = {
  choices: Array<{ message: { content: string } }>;
};
let completionScript: () => Promise<Completion>;
const completionCreate = vi.fn(async () => completionScript());

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
            create: completionCreate,
          },
        },
      },
    })),
  };
});

import {
  creditBalancesTable,
  creditLedgerTable,
  db,
  pool,
  usageEventsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { getCreditBalances, grantCredits } from "../lib/credits";
import { getUsage } from "../lib/usage";
import { createTenant, deleteTenant, type TestTenant } from "../test/dbHelpers";
import aiRouter from "./ai";

let server: http.Server;
let port: number;
let tenant: TestTenant;

beforeEach(async () => {
  tenant = await createTenant();
  planState.captions = 0;
  completionCreate.mockClear();
  completionScript = async () => ({
    choices: [
      {
        message: {
          content:
            '{"lines":[{"index":1,"text":"kokao प्रकाशन आसान बनाता है","back":"kokao makes publishing simple"}]}',
        },
      },
    ],
  });

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
  await db
    .delete(usageEventsTable)
    .where(eq(usageEventsTable.tenantId, tenant.tenantId));
  await db
    .delete(creditLedgerTable)
    .where(eq(creditLedgerTable.tenantId, tenant.tenantId));
  await db
    .delete(creditBalancesTable)
    .where(eq(creditBalancesTable.tenantId, tenant.tenantId));
  await deleteTenant(tenant.tenantId);
});

afterAll(async () => {
  await pool.end();
});

function postLocalization(
  locales: string[],
  cues = [
    {
      index: 1,
      startMs: 0,
      endMs: 3000,
      text: "KOKAO makes publishing simple.",
    },
  ],
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/ai/localize-script",
        headers: { "Content-Type": "application/json" },
      },
      (res) => {
        let buf = "";
        res.on("data", (chunk: Buffer) => (buf += chunk.toString()));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: JSON.parse(buf || "{}") as Record<string, unknown>,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify({ locales, cues }));
  });
}

async function usageFunding(): Promise<Array<string | null>> {
  const rows = await db
    .select({ funding: usageEventsTable.funding })
    .from(usageEventsTable)
    .where(eq(usageEventsTable.tenantId, tenant.tenantId));
  return rows.map((row) => row.funding).sort();
}

describe("localize-script funding", () => {
  it("uses one remaining quota slot once, then prepaid credits for other locales", async () => {
    planState.captions = 1;
    await grantCredits({
      tenantId: tenant.tenantId,
      captionCredits: 2,
      imageCredits: 0,
      kind: "admin_grant",
    });

    const response = await postLocalization(["te", "ta", "hi"]);

    expect(response.status).toBe(200);
    expect(completionCreate).toHaveBeenCalledTimes(3);
    expect(await usageFunding()).toEqual(["credit", "credit", "quota"]);
    expect((await getCreditBalances(tenant.tenantId)).captionCredits).toBe(0);
  });

  it("reassigns a failed locale's quota slot before charging a successful locale credit", async () => {
    planState.captions = 1;
    await grantCredits({
      tenantId: tenant.tenantId,
      captionCredits: 1,
      imageCredits: 0,
      kind: "admin_grant",
    });
    let call = 0;
    completionScript = async () => {
      call += 1;
      if (call === 1) throw new Error("Telugu timed out");
      return {
        choices: [
          {
            message: {
              content:
                '{"lines":[{"index":1,"text":"kokao प्रकाशन आसान बनाता है","back":"kokao makes publishing simple"}]}',
            },
          },
        ],
      };
    };

    const response = await postLocalization(["te", "hi"]);

    expect(response.status).toBe(200);
    expect(await usageFunding()).toEqual(["quota"]);
    expect((await getCreditBalances(tenant.tenantId)).captionCredits).toBe(1);
    const ledger = await db
      .select()
      .from(creditLedgerTable)
      .where(eq(creditLedgerTable.tenantId, tenant.tenantId));
    expect(ledger.map((row) => row.kind).sort()).toEqual([
      "admin_grant",
      "refund",
      "spend",
    ]);
  });

  it("refunds earlier reservations and calls no model when all locales cannot be funded", async () => {
    planState.captions = 1;
    await grantCredits({
      tenantId: tenant.tenantId,
      captionCredits: 1,
      imageCredits: 0,
      kind: "admin_grant",
    });

    const response = await postLocalization(["te", "ta", "hi"]);

    expect(response.status).toBe(402);
    expect(completionCreate).not.toHaveBeenCalled();
    expect(await usageFunding()).toEqual([]);
    expect((await getCreditBalances(tenant.tenantId)).captionCredits).toBe(1);
  });

  it("atomically shares the last quota slot across concurrent localization requests", async () => {
    planState.captions = 1;
    await grantCredits({
      tenantId: tenant.tenantId,
      captionCredits: 1,
      imageCredits: 0,
      kind: "admin_grant",
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    completionScript = async () => {
      await gate;
      return {
        choices: [
          {
            message: {
              content:
                '{"lines":[{"index":1,"text":"kokao प्रकाशन आसान बनाता है","back":"kokao makes publishing simple"}]}',
            },
          },
        ],
      };
    };

    const first = postLocalization(["hi"]);
    const second = postLocalization(["hi"]);
    const startedAt = Date.now();
    while (completionCreate.mock.calls.length < 2) {
      if (Date.now() - startedAt > 5000)
        throw new Error("Concurrent model calls did not start");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    release();

    const responses = await Promise.all([first, second]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(await usageFunding()).toEqual(["credit", "quota"]);
    expect((await getCreditBalances(tenant.tenantId)).captionCredits).toBe(0);
  });

  it("never recreates quota when an aged hold is reclaimed before its request finishes", async () => {
    planState.captions = 1;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    completionScript = async () => {
      await gate;
      return {
        choices: [
          {
            message: {
              content:
                '{"lines":[{"index":1,"text":"kokao प्रकाशन आसान बनाता है","back":"kokao makes publishing simple"}]}',
            },
          },
        ],
      };
    };

    const first = postLocalization(["hi"]);
    const firstStartedAt = Date.now();
    while (completionCreate.mock.calls.length < 1) {
      if (Date.now() - firstStartedAt > 5000)
        throw new Error("First model call did not start");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const pending = (
      await db
        .select({ id: usageEventsTable.id })
        .from(usageEventsTable)
        .where(eq(usageEventsTable.model, "__quota_reservation__"))
    )[0];
    expect(pending).toBeDefined();
    await db
      .update(usageEventsTable)
      .set({ createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000) })
      .where(eq(usageEventsTable.id, pending!.id));

    const second = postLocalization(["hi"]);
    const secondStartedAt = Date.now();
    while (completionCreate.mock.calls.length < 2) {
      if (Date.now() - secondStartedAt > 5000)
        throw new Error("Second model call did not start");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    release();

    const responses = await Promise.all([first, second]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(await usageFunding()).toEqual(["quota", "unmetered"]);
    expect((await getUsage(tenant.tenantId)).captions).toBe(1);
  });
});

describe("localize-script timing spine", () => {
  it("rejects overlapping source cues before reserving funding or calling the model", async () => {
    planState.captions = 10;

    const response = await postLocalization(
      ["hi"],
      [
        { index: 1, startMs: 0, endMs: 2000, text: "First line." },
        { index: 2, startMs: 1500, endMs: 3000, text: "Second line." },
      ],
    );

    expect(response.status).toBe(400);
    expect(String(response.body.error)).toMatch(/overlapping timings/i);
    expect(completionCreate).not.toHaveBeenCalled();
    expect(await usageFunding()).toEqual([]);
  });

  it("rejects duplicate cue indexes before model output can be mapped ambiguously", async () => {
    planState.captions = 10;

    const response = await postLocalization(
      ["hi"],
      [
        { index: 1, startMs: 0, endMs: 1000, text: "First line." },
        { index: 1, startMs: 1000, endMs: 2000, text: "Second line." },
      ],
    );

    expect(response.status).toBe(400);
    expect(String(response.body.error)).toMatch(/appears more than once/i);
    expect(completionCreate).not.toHaveBeenCalled();
  });
});
