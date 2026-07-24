/**
 * Billing-critical disconnect tests for POST /ai/generate-caption/stream.
 *
 * The SSE caption route reserves funding up front, then streams caption
 * deltas. If the client disconnects mid-stream AFTER caption text was
 * delivered, the charge must SETTLE (otherwise clients could read the
 * caption and drop the connection to dodge the charge). If the client
 * disconnects BEFORE anything usable was delivered, the reserved funding
 * must be refunded. Assertions are on usage_events rows and the credit
 * ledger/balance — not just the response shape.
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

// Controllable fake model stream. Each test sets `streamScript` to an async
// generator factory; the abort signal passed by the route is honored so a
// blocked stream terminates when the route aborts it on disconnect.
type Chunk = { choices: Array<{ delta: { content?: string } }> };
let streamScript: (signal: AbortSignal | undefined) => AsyncGenerator<Chunk>;

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
              async (_body: unknown, opts?: { signal?: AbortSignal }) =>
                streamScript(opts?.signal),
            ),
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

function delta(content: string): Chunk {
  return { choices: [{ delta: { content } }] };
}

/** A promise gate the test resolves to let the fake stream proceed/end. */
function makeGate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

/** Wait (poll) until an async condition holds; settlement runs after 'close'. */
async function waitFor(cond: () => Promise<boolean>, ms = 5000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - start > ms) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Block until the signal aborts, then throw like the OpenAI SDK does. */
function abortable(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    const err = Object.assign(new Error("Request was aborted."), {
      name: "APIUserAbortError",
    });
    if (!signal) return; // never settles; test always aborts via disconnect
    if (signal.aborted) reject(err);
    else signal.addEventListener("abort", () => reject(err), { once: true });
  });
}

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

interface StreamHandle {
  /** SSE events received so far (parsed `data:` payloads). */
  events: Array<Record<string, unknown>>;
  /** Resolves when the response headers arrive. */
  headers: Promise<number>;
  /** Resolves when the response ends normally. */
  done: Promise<void>;
  /** Hard-destroy the client socket (simulates closing the page). */
  destroy: () => void;
  /** Register a callback fired on every parsed event. */
  onEvent: (cb: (e: Record<string, unknown>) => void) => void;
}

function openStream(): StreamHandle {
  const events: Array<Record<string, unknown>> = [];
  const listeners: Array<(e: Record<string, unknown>) => void> = [];
  let resolveHeaders!: (s: number) => void;
  let resolveDone!: () => void;
  const headers = new Promise<number>((r) => (resolveHeaders = r));
  const done = new Promise<void>((r) => (resolveDone = r));

  const req = http.request(
    {
      host: "127.0.0.1",
      port,
      method: "POST",
      path: "/ai/generate-caption/stream",
      headers: { "Content-Type": "application/json" },
    },
    (res) => {
      resolveHeaders(res.statusCode ?? 0);
      let buf = "";
      res.on("data", (c: Buffer) => {
        buf += c.toString();
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = frame.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          const parsed = JSON.parse(line.slice(6)) as Record<string, unknown>;
          events.push(parsed);
          for (const cb of listeners) cb(parsed);
        }
      });
      res.on("end", resolveDone);
      res.on("error", () => {});
    },
  );
  req.on("error", () => {}); // socket destroy raises ECONNRESET locally
  req.end(JSON.stringify({ prompt: "Write a post about coffee" }));

  return {
    events,
    headers,
    done,
    destroy: () => req.destroy(),
    onEvent: (cb) => listeners.push(cb),
  };
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

describe("caption stream disconnect billing", () => {
  it("refunds the reserved credit when the client disconnects before any delta", async () => {
    await grantCredits({
      tenantId: tenant.tenantId,
      captionCredits: 1,
      imageCredits: 0,
      kind: "admin_grant",
    });

    // Model produces nothing before the route aborts it on disconnect.
    streamScript = async function* (signal) {
      await abortable(signal);
    };

    const stream = openStream();
    expect(await stream.headers).toBe(200);
    // The credit was reserved (debited) before streaming started.
    await waitFor(async () => (await getCreditBalances(tenant.tenantId)).captionCredits === 0);

    stream.destroy();

    // Nothing was delivered -> the reservation must be refunded.
    await waitFor(async () => (await getCreditBalances(tenant.tenantId)).captionCredits === 1);

    const ledger = await ledgerRows();
    const kinds = ledger.map((r) => r.kind).sort();
    expect(kinds).toEqual(["admin_grant", "refund", "spend"]);
    const refund = ledger.find((r) => r.kind === "refund")!;
    expect(refund.captionDelta).toBe(1);

    // No usage event: the generation was never charged.
    expect(await usageRows()).toHaveLength(0);
  });

  it("settles the charge exactly once when the client disconnects after deltas", async () => {
    await grantCredits({
      tenantId: tenant.tenantId,
      captionCredits: 1,
      imageCredits: 0,
      kind: "admin_grant",
    });

    // First chunk carries caption text (a delta is emitted), then the model
    // blocks until aborted by the disconnect handler.
    streamScript = async function* (signal) {
      yield delta('{"caption":"Fresh roast, big flavor');
      await abortable(signal);
    };

    const stream = openStream();
    expect(await stream.headers).toBe(200);

    // Destroy the socket only after a delta was actually received (the
    // event may already have arrived before this listener registers).
    await new Promise<void>((resolve) => {
      if (stream.events.some((e) => e.type === "delta")) return resolve();
      stream.onEvent((e) => {
        if (e.type === "delta") resolve();
      });
    });
    expect(stream.events.some((e) => e.type === "delta")).toBe(true);
    stream.destroy();

    // Delivered output -> settle: exactly one usage row, credit stays spent.
    await waitFor(async () => (await usageRows()).length > 0);
    const rows = await usageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("caption");
    expect(rows[0].funding).toBe("credit");

    // Give any (incorrect) second settlement/refund a moment to land.
    await new Promise((r) => setTimeout(r, 300));
    expect(await usageRows()).toHaveLength(1);
    expect((await getCreditBalances(tenant.tenantId)).captionCredits).toBe(0);
    const kinds = (await ledgerRows()).map((r) => r.kind).sort();
    expect(kinds).toEqual(["admin_grant", "spend"]); // no refund entry
  });

  it("settles exactly once on normal completion (quota funded)", async () => {
    planState.captions = 100; // quota funding

    streamScript = async function* () {
      yield delta('{"caption":"Morning brew ');
      yield delta('magic","hashtags":["coffee"]}');
    };

    const stream = openStream();
    expect(await stream.headers).toBe(200);
    await stream.done;

    const result = stream.events.find((e) => e.type === "result");
    expect(result).toBeDefined();
    expect(result!.caption).toBe("Morning brew magic");

    await waitFor(async () => (await usageRows()).length > 0);
    const rows = await usageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("caption");
    expect(rows[0].funding).toBe("quota");
    // Quota funded: the credit ledger must be untouched.
    expect(await ledgerRows()).toHaveLength(0);
  });

  it("refunds the reserved credit when the model errors mid-stream", async () => {
    await grantCredits({
      tenantId: tenant.tenantId,
      captionCredits: 1,
      imageCredits: 0,
      kind: "admin_grant",
    });

    streamScript = async function* () {
      yield delta('{"caption":"doomed');
      throw new Error("model exploded");
    };

    const stream = openStream();
    expect(await stream.headers).toBe(200);
    await stream.done;

    expect(stream.events.some((e) => e.type === "error")).toBe(true);

    await waitFor(async () => (await getCreditBalances(tenant.tenantId)).captionCredits === 1);
    const kinds = (await ledgerRows()).map((r) => r.kind).sort();
    expect(kinds).toEqual(["admin_grant", "refund", "spend"]);
    expect(await usageRows()).toHaveLength(0);
  });
});
