/**
 * Billing-critical tests for POST /ai/generate-campaign/stream.
 *
 * The SSE campaign route reserves credit funding up front (quota first),
 * then streams per-platform caption deltas parsed out of the model's
 * partial JSON. On completion it records one usage row per platform. If the
 * client disconnects mid-stream AFTER caption text was delivered, the
 * campaign must SETTLE (usage rows recorded, credits stay spent); if it
 * disconnects BEFORE anything usable was delivered, reserved credits are
 * refunded. Also covers the extractPartialCampaign parser and the
 * campaignStreaming kill switch.
 */
import { describe, it, expect, afterAll, beforeEach, afterEach, vi } from "vitest";
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

import {
  db,
  pool,
  usageEventsTable,
  creditLedgerTable,
  creditBalancesTable,
  featureFlagsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import aiRouter, { extractPartialCampaign } from "./ai";
import { invalidateFeatureFlagCache } from "../lib/featureFlags";
import { grantCredits, getCreditBalances } from "../lib/credits";
import { createTenant, deleteTenant, type TestTenant } from "../test/dbHelpers";

function delta(content: string): Chunk {
  return { choices: [{ delta: { content } }] };
}

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
    if (!signal) return;
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
  await db
    .delete(featureFlagsTable)
    .where(eq(featureFlagsTable.feature, "campaignStreaming"));
  invalidateFeatureFlagCache();

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
    .delete(featureFlagsTable)
    .where(eq(featureFlagsTable.feature, "campaignStreaming"));
  invalidateFeatureFlagCache();
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
  events: Array<Record<string, unknown>>;
  headers: Promise<number>;
  done: Promise<void>;
  destroy: () => void;
  onEvent: (cb: (e: Record<string, unknown>) => void) => void;
  body: Promise<string>;
}

function openStream(platforms: string[] = ["linkedin", "twitter"]): StreamHandle {
  const events: Array<Record<string, unknown>> = [];
  const listeners: Array<(e: Record<string, unknown>) => void> = [];
  let resolveHeaders!: (s: number) => void;
  let resolveDone!: () => void;
  let resolveBody!: (b: string) => void;
  const headers = new Promise<number>((r) => (resolveHeaders = r));
  const done = new Promise<void>((r) => (resolveDone = r));
  const body = new Promise<string>((r) => (resolveBody = r));

  const req = http.request(
    {
      host: "127.0.0.1",
      port,
      method: "POST",
      path: "/ai/generate-campaign/stream",
      headers: { "Content-Type": "application/json" },
    },
    (res) => {
      resolveHeaders(res.statusCode ?? 0);
      let buf = "";
      let all = "";
      res.on("data", (c: Buffer) => {
        const s = c.toString();
        all += s;
        buf += s;
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
      res.on("end", () => {
        resolveBody(all);
        resolveDone();
      });
      res.on("error", () => {});
    },
  );
  req.on("error", () => {});
  req.end(JSON.stringify({ prompt: "Launch our new coffee blend", platforms }));

  return {
    events,
    headers,
    done,
    destroy: () => req.destroy(),
    onEvent: (cb) => listeners.push(cb),
    body,
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

const FULL_JSON =
  '{"title":"Bold Brew Launch","posts":[' +
  '{"platform":"linkedin","caption":"Big day: our new blend is here.","hashtags":["coffee","launch"],"imagePrompt":"a bag of coffee"},' +
  '{"platform":"twitter","caption":"New blend. Big flavor.","hashtags":["coffee"],"imagePrompt":"espresso shot"}]}';

describe("extractPartialCampaign", () => {
  it("attributes streamed caption text to the right platform", () => {
    const partial =
      '{"title":"T","posts":[{"platform":"linkedin","caption":"Hello wor';
    expect(extractPartialCampaign(partial)).toEqual([
      { platform: "linkedin", text: "Hello wor", done: false },
    ]);
  });

  it("handles multiple completed posts and escapes", () => {
    const partial =
      '{"posts":[{"platform":"linkedin","caption":"Line1\\nLine2","hashtags":["a"]},' +
      '{"platform":"twitter","caption":"Sho';
    expect(extractPartialCampaign(partial)).toEqual([
      { platform: "linkedin", text: "Line1\nLine2", done: true },
      { platform: "twitter", text: "Sho", done: false },
    ]);
  });

  it("reports a platform with no caption yet as empty", () => {
    const partial = '{"posts":[{"platform":"linkedin","capti';
    expect(extractPartialCampaign(partial)).toEqual([
      { platform: "linkedin", text: "", done: false },
    ]);
  });
});

describe("campaign stream", () => {
  it("streams per-platform deltas and settles per platform on completion (quota funded)", async () => {
    planState.captions = 100;

    streamScript = async function* () {
      yield delta('{"title":"Bold Brew Launch","posts":[{"platform":"linkedin","caption":"Big day: our ');
      yield delta('new blend is here.","hashtags":["coffee","launch"],"imagePrompt":"a bag of coffee"},');
      yield delta('{"platform":"twitter","caption":"New blend. Big flavor.","hashtags":["coffee"],"imagePrompt":"espresso shot"}]}');
    };

    const stream = openStream();
    expect(await stream.headers).toBe(200);
    await stream.done;

    const deltas = stream.events.filter((e) => e.type === "delta");
    expect(deltas.some((e) => e.platform === "linkedin")).toBe(true);
    expect(deltas.some((e) => e.platform === "twitter")).toBe(true);
    const linkedinText = deltas
      .filter((e) => e.platform === "linkedin")
      .map((e) => e.text)
      .join("");
    expect(linkedinText).toBe("Big day: our new blend is here.");

    const result = stream.events.find((e) => e.type === "result") as
      | { posts: Array<{ platform: string; caption: string; hashtags: string[] }>; campaignId?: string; title?: string }
      | undefined;
    expect(result).toBeDefined();
    expect(result!.title).toBe("Bold Brew Launch");
    expect(result!.campaignId).toBeTruthy();
    expect(result!.posts).toHaveLength(2);
    expect(result!.posts.find((p) => p.platform === "twitter")!.caption).toBe(
      "New blend. Big flavor.",
    );

    await waitFor(async () => (await usageRows()).length === 2);
    const rows = await usageRows();
    expect(rows.map((r) => r.funding).sort()).toEqual(["quota", "quota"]);
    expect(new Set(rows.map((r) => r.platform))).toEqual(new Set(["linkedin", "twitter"]));
    expect(rows[0]!.campaignId).toBe(rows[1]!.campaignId);
    expect(await ledgerRows()).toHaveLength(0);
  });

  it("refunds reserved credits when the client disconnects before any delta", async () => {
    await grantCredits({
      tenantId: tenant.tenantId,
      captionCredits: 2,
      imageCredits: 0,
      kind: "admin_grant",
    });

    streamScript = async function* (signal) {
      await abortable(signal);
    };

    const stream = openStream();
    expect(await stream.headers).toBe(200);
    await waitFor(async () => (await getCreditBalances(tenant.tenantId)).captionCredits === 0);

    stream.destroy();

    await waitFor(async () => (await getCreditBalances(tenant.tenantId)).captionCredits === 2);
    const ledger = await ledgerRows();
    const refund = ledger.find((r) => r.kind === "refund")!;
    expect(refund.captionDelta).toBe(2);
    expect(await usageRows()).toHaveLength(0);
  });

  it("settles all platforms exactly once when the client disconnects after deltas", async () => {
    await grantCredits({
      tenantId: tenant.tenantId,
      captionCredits: 2,
      imageCredits: 0,
      kind: "admin_grant",
    });

    streamScript = async function* (signal) {
      yield delta('{"title":"T","posts":[{"platform":"linkedin","caption":"Fresh roast, big flavor');
      await abortable(signal);
    };

    const stream = openStream();
    expect(await stream.headers).toBe(200);

    await new Promise<void>((resolve) => {
      if (stream.events.some((e) => e.type === "delta")) return resolve();
      stream.onEvent((e) => {
        if (e.type === "delta") resolve();
      });
    });
    stream.destroy();

    // Delivered output -> settle: one usage row per requested platform,
    // credits stay spent, no refund entry.
    await waitFor(async () => (await usageRows()).length === 2);
    await new Promise((r) => setTimeout(r, 300));
    const rows = await usageRows();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.kind === "caption")).toBe(true);
    expect(rows.map((r) => r.funding).sort()).toEqual(["credit", "credit"]);
    expect((await getCreditBalances(tenant.tenantId)).captionCredits).toBe(0);
    const kinds = (await ledgerRows()).map((r) => r.kind).sort();
    expect(kinds).toEqual(["admin_grant", "spend"]);
  });

  it("refunds reserved credits when the model errors mid-stream", async () => {
    await grantCredits({
      tenantId: tenant.tenantId,
      captionCredits: 2,
      imageCredits: 0,
      kind: "admin_grant",
    });

    streamScript = async function* () {
      yield delta('{"title":"T","posts":[{"platform":"linkedin","caption":"doomed');
      throw new Error("model exploded");
    };

    const stream = openStream();
    expect(await stream.headers).toBe(200);
    await stream.done;

    expect(stream.events.some((e) => e.type === "error")).toBe(true);
    await waitFor(async () => (await getCreditBalances(tenant.tenantId)).captionCredits === 2);
    expect(await usageRows()).toHaveLength(0);
  });

  it("refunds reserved credits and returns questions on a clarify response", async () => {
    await grantCredits({
      tenantId: tenant.tenantId,
      captionCredits: 2,
      imageCredits: 0,
      kind: "admin_grant",
    });

    streamScript = async function* () {
      yield delta('{"clarifyingQuestions":["What product?","Who is the audience?"]}');
    };

    const stream = openStream();
    expect(await stream.headers).toBe(200);
    await stream.done;

    const result = stream.events.find((e) => e.type === "result") as
      | { posts: unknown[]; clarifyingQuestions?: string[] }
      | undefined;
    expect(result).toBeDefined();
    expect(result!.posts).toEqual([]);
    expect(result!.clarifyingQuestions).toHaveLength(2);

    await waitFor(async () => (await getCreditBalances(tenant.tenantId)).captionCredits === 2);
    expect(await usageRows()).toHaveLength(0);
  });

  it("answers 403 feature_disabled when the campaignStreaming switch is off", async () => {
    await db
      .insert(featureFlagsTable)
      .values({ feature: "campaignStreaming", enabled: false });
    invalidateFeatureFlagCache();
    planState.captions = 100;

    streamScript = async function* () {
      yield delta(FULL_JSON);
    };

    const stream = openStream();
    expect(await stream.headers).toBe(403);
    const body = await stream.body;
    expect(body).toContain("feature_disabled");
    expect(await usageRows()).toHaveLength(0);
  });

  it("402s without reserving anything when funding cannot cover all platforms", async () => {
    await grantCredits({
      tenantId: tenant.tenantId,
      captionCredits: 1, // needs 2
      imageCredits: 0,
      kind: "admin_grant",
    });

    streamScript = async function* () {
      yield delta(FULL_JSON);
    };

    const stream = openStream();
    expect(await stream.headers).toBe(402);
    expect((await getCreditBalances(tenant.tenantId)).captionCredits).toBe(1);
    expect(await usageRows()).toHaveLength(0);
  });
});
