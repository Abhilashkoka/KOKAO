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
let completionCalls = 0;

/** Queue up per-call replies; each create() consumes the next entry. */
function scriptSequence(...completions: Completion[]) {
  const queue = [...completions];
  completionScript = async () => {
    const next = queue.shift();
    if (!next) throw new Error("completion script exhausted");
    return next;
  };
}

// Controllable wallet rail: when walletState.enabled, reserveFunding takes
// the wallet path (reserveWallet → settleWallet/refundWallet). The wallet
// module is mocked so tests can count settles/refunds exactly, without
// depending on the platform kill switch or tenant billingMode.
const walletState = { enabled: false, settleFails: false };
const walletCalls = {
  reserve: [] as unknown[],
  settle: [] as unknown[],
  refund: [] as unknown[],
};
vi.mock("../lib/wallet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/wallet")>();
  return {
    ...actual,
    isWalletFunded: vi.fn(async () => walletState.enabled),
    reserveWallet: vi.fn(async (tenantId: number, kind: string) => {
      walletCalls.reserve.push({ tenantId, kind });
      return { id: 12345, amountPaise: 500, units: 1 };
    }),
    settleWallet: vi.fn(async (tenantId: number, reservation: unknown, meta: unknown) => {
      walletCalls.settle.push({ tenantId, reservation, meta });
      if (walletState.settleFails) throw new Error("settle exploded");
      return { chargedPaise: 500, estimated: true, balancePaise: 0 };
    }),
    refundWallet: vi.fn(async (tenantId: number, reservation: unknown, note?: string) => {
      walletCalls.refund.push({ tenantId, reservation, note });
    }),
  };
});

// Controllable usage metering: passes through to the real recordUsage
// unless usageState.recordFails is set, so the settle-then-meter failure
// ordering can be exercised without touching other tests.
const usageState = { recordFails: false };
vi.mock("../lib/usage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/usage")>();
  return {
    ...actual,
    recordUsage: vi.fn(async (...args: Parameters<typeof actual.recordUsage>) => {
      if (usageState.recordFails) throw new Error("usage write exploded");
      return actual.recordUsage(...args);
    }),
  };
});

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
            create: vi.fn(async () => {
              completionCalls++;
              return completionScript();
            }),
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
let logMock: { info: any; error: any; warn: any; debug: any };

beforeEach(async () => {
  tenant = await createTenant();
  planState.captions = 0;
  completionCalls = 0;
  walletState.enabled = false;
  walletState.settleFails = false;
  usageState.recordFails = false;
  walletCalls.reserve.length = 0;
  walletCalls.settle.length = 0;
  walletCalls.refund.length = 0;
  logMock = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { tenantId: number }).tenantId = tenant.tenantId;
    (req as unknown as { log: unknown }).log = logMock;
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

/** Build a completion whose content is the given object, JSON-encoded. */
function completionOf(obj: unknown): Completion {
  return { choices: [{ message: { content: JSON.stringify(obj) } }] };
}

// Two usable slides — fewer than the requested slideCount (3).
const incompleteCarousel = completionOf({
  title: "Coffee",
  caption: "A caption",
  hashtags: ["coffee"],
  slides: [
    { heading: "Slide 1", body: "Body 1", imagePrompt: "p1" },
    { heading: "Slide 2", body: "Body 2", imagePrompt: "p2" },
  ],
});

// A fully valid 3-slide carousel.
const validCarousel = completionOf({
  title: "Coffee Done Right",
  caption: "Three truths about coffee.",
  hashtags: ["coffee", "brew"],
  slides: [
    { heading: "Slide 1", body: "Body 1", imagePrompt: "p1" },
    { heading: "Slide 2", body: "Body 2", imagePrompt: "p2" },
    { heading: "Slide 3", body: "Body 3", imagePrompt: "p3" },
  ],
});

// A completion with fewer slide objects than the requested slideCount (3).
const incompleteCarouselCompletion = async (): Promise<Completion> => incompleteCarousel;

describe("carousel endpoint incomplete-slides billing", () => {
  it("releases the reserved credit when the model returns fewer slides than requested", async () => {
    await grantCredits({
      tenantId: tenant.tenantId,
      captionCredits: 1,
      imageCredits: 0,
      kind: "admin_grant",
    });

    completionScript = incompleteCarouselCompletion;

    const res = await postCarousel();
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Failed to generate carousel");

    // Incomplete carousel: credit restored (spend+refund) and no usage charged.
    expect((await getCreditBalances(tenant.tenantId)).captionCredits).toBe(1);
    const kinds = (await ledgerRows()).map((r) => r.kind).sort();
    expect(kinds).toEqual(["admin_grant", "refund", "spend"]);
    const refund = (await ledgerRows()).find((r) => r.kind === "refund")!;
    expect(refund.captionDelta).toBe(1);
    expect(await usageRows()).toHaveLength(0);
  });

  it("charges no quota usage when a quota-funded request yields an incomplete carousel", async () => {
    planState.captions = 100; // quota funding

    completionScript = incompleteCarouselCompletion;

    const res = await postCarousel();
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Failed to generate carousel");

    // Quota funded: no usage event recorded and the ledger stays untouched.
    expect(await usageRows()).toHaveLength(0);
    expect(await ledgerRows()).toHaveLength(0);
  });
});

const isIncompleteWarn = (call: unknown[]) =>
  call[1] === "Carousel generation returned an incomplete carousel";
const isFinalError = (call: unknown[]) =>
  call[1] === "Carousel generation failed: incomplete carousel after retry";

describe("carousel retry across sequential completions", () => {
  it("recovers from an incomplete first attempt and settles funding exactly once", async () => {
    await grantCredits({
      tenantId: tenant.tenantId,
      captionCredits: 1,
      imageCredits: 0,
      kind: "admin_grant",
    });
    scriptSequence(incompleteCarousel, validCarousel);

    const res = await postCarousel();
    expect(res.status).toBe(200);
    expect(completionCalls).toBe(2);
    expect((res.body.slides as unknown[]).length).toBe(3);
    expect(res.body.title).toBe("Coffee Done Right");

    // Settled exactly once: the spent credit stays spent (no refund), and
    // exactly one usage event was recorded.
    expect((await getCreditBalances(tenant.tenantId)).captionCredits).toBe(0);
    const kinds = (await ledgerRows()).map((r) => r.kind).sort();
    expect(kinds).toEqual(["admin_grant", "spend"]);
    expect(await usageRows()).toHaveLength(1);

    // The flake on attempt 1 was diagnosed, and nothing was logged as an error.
    expect(logMock.warn.mock.calls.filter(isIncompleteWarn)).toHaveLength(1);
    expect(logMock.warn.mock.calls.filter(isIncompleteWarn)[0][0]).toMatchObject({
      attempt: 1,
      slideCount: 3,
      parsedSlides: 2,
    });
    expect(logMock.error.mock.calls.filter(isFinalError)).toHaveLength(0);
  });

  it("fails with 500 after two incomplete attempts, refunding exactly once", async () => {
    await grantCredits({
      tenantId: tenant.tenantId,
      captionCredits: 1,
      imageCredits: 0,
      kind: "admin_grant",
    });
    scriptSequence(incompleteCarousel, incompleteCarousel);

    const res = await postCarousel();
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Failed to generate carousel");
    expect(completionCalls).toBe(2);

    // Refunded exactly once: balance restored, one spend + one refund row.
    expect((await getCreditBalances(tenant.tenantId)).captionCredits).toBe(1);
    const rows = await ledgerRows();
    expect(rows.map((r) => r.kind).sort()).toEqual(["admin_grant", "refund", "spend"]);
    expect(rows.find((r) => r.kind === "refund")!.captionDelta).toBe(1);
    expect(await usageRows()).toHaveLength(0);

    // Two per-attempt warnings plus one final error.
    const warns = logMock.warn.mock.calls.filter(isIncompleteWarn);
    expect(warns).toHaveLength(2);
    expect(warns[0][0]).toMatchObject({ attempt: 1 });
    expect(warns[1][0]).toMatchObject({ attempt: 2 });
    const errors = logMock.error.mock.calls.filter(isFinalError);
    expect(errors).toHaveLength(1);
    expect(errors[0][0]).toMatchObject({ slideCount: 3, deliveredSlides: 2 });
  });

  it("treats slides missing both heading and body as unusable and retries", async () => {
    planState.captions = 100; // quota funding

    // Three slide objects, but one has neither heading nor body — only two
    // are usable, so attempt 1 must be treated as incomplete.
    const junkSlideCarousel = completionOf({
      title: "Coffee",
      caption: "A caption",
      hashtags: ["coffee"],
      slides: [
        { heading: "Slide 1", body: "Body 1", imagePrompt: "p1" },
        { imagePrompt: "p2" },
        { heading: "Slide 3", body: "Body 3", imagePrompt: "p3" },
      ],
    });
    scriptSequence(junkSlideCarousel, validCarousel);

    const res = await postCarousel();
    expect(res.status).toBe(200);
    expect(completionCalls).toBe(2);
    expect((res.body.slides as unknown[]).length).toBe(3);

    const warns = logMock.warn.mock.calls.filter(isIncompleteWarn);
    expect(warns).toHaveLength(1);
    expect(warns[0][0]).toMatchObject({ attempt: 1, parsedSlides: 2 });
  });

  it("wallet-funded: incomplete first attempt + valid second settles exactly once, no refund", async () => {
    walletState.enabled = true;
    scriptSequence(incompleteCarousel, validCarousel);

    const res = await postCarousel();
    expect(res.status).toBe(200);
    expect(completionCalls).toBe(2);
    expect((res.body.slides as unknown[]).length).toBe(3);

    // Exactly one wallet reservation, settled exactly once, never refunded.
    expect(walletCalls.reserve).toHaveLength(1);
    expect(walletCalls.settle).toHaveLength(1);
    expect(walletCalls.refund).toHaveLength(0);
    expect(walletCalls.settle[0]).toMatchObject({
      tenantId: tenant.tenantId,
      reservation: { id: 12345, amountPaise: 500, units: 1 },
      meta: { kind: "caption" },
    });

    // Wallet rail: one usage row (funding=wallet), credit ledger untouched.
    const usage = await usageRows();
    expect(usage).toHaveLength(1);
    expect(usage[0].funding).toBe("wallet");
    expect(await ledgerRows()).toHaveLength(0);

    // The flake was diagnosed but nothing was logged as a final error.
    expect(logMock.warn.mock.calls.filter(isIncompleteWarn)).toHaveLength(1);
    expect(logMock.error.mock.calls.filter(isFinalError)).toHaveLength(0);
  });

  it("wallet-funded: two incomplete attempts refund exactly once, no settle", async () => {
    walletState.enabled = true;
    scriptSequence(incompleteCarousel, incompleteCarousel);

    const res = await postCarousel();
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Failed to generate carousel");
    expect(completionCalls).toBe(2);

    // Exactly one wallet reservation, refunded exactly once, never settled.
    expect(walletCalls.reserve).toHaveLength(1);
    expect(walletCalls.settle).toHaveLength(0);
    expect(walletCalls.refund).toHaveLength(1);
    expect(walletCalls.refund[0]).toMatchObject({
      tenantId: tenant.tenantId,
      reservation: { id: 12345, amountPaise: 500, units: 1 },
    });

    // Nothing charged anywhere: no usage rows, credit ledger untouched.
    expect(await usageRows()).toHaveLength(0);
    expect(await ledgerRows()).toHaveLength(0);

    expect(logMock.warn.mock.calls.filter(isIncompleteWarn)).toHaveLength(2);
    expect(logMock.error.mock.calls.filter(isFinalError)).toHaveLength(1);
  });

  it("does not retry when attempt 1 returns clarifying questions", async () => {
    await grantCredits({
      tenantId: tenant.tenantId,
      captionCredits: 1,
      imageCredits: 0,
      kind: "admin_grant",
    });
    scriptSequence(
      completionOf({ clarifyingQuestions: ["What product is this about?"] }),
      validCarousel, // must never be consumed
    );

    const res = await postCarousel();
    expect(res.status).toBe(200);
    expect(completionCalls).toBe(1);
    expect(res.body.slides).toEqual([]);
    expect(res.body.clarifyingQuestions).toEqual(["What product is this about?"]);

    // Refunded, nothing charged, no incomplete-carousel diagnostics.
    expect((await getCreditBalances(tenant.tenantId)).captionCredits).toBe(1);
    expect((await ledgerRows()).map((r) => r.kind).sort()).toEqual([
      "admin_grant",
      "refund",
      "spend",
    ]);
    expect(await usageRows()).toHaveLength(0);
    expect(logMock.warn.mock.calls.filter(isIncompleteWarn)).toHaveLength(0);
    expect(logMock.error.mock.calls.filter(isFinalError)).toHaveLength(0);
  });
});

const isSettleFailure = (call: unknown[]) =>
  call[1] === "Failed to settle wallet charge";
const isUsageFailure = (call: unknown[]) =>
  call[1] === "Failed to record usage after settling";

describe("wallet settle/metering failure after a successful generation", () => {
  it("settleWallet rejection: request still 200, no refund, failure logged", async () => {
    walletState.enabled = true;
    walletState.settleFails = true;
    scriptSequence(validCarousel);

    const res = await postCarousel();
    expect(res.status).toBe(200);
    expect((res.body.slides as unknown[]).length).toBe(3);

    // The estimate stays charged: settle was attempted once, and the failure
    // must NEVER be followed by a refund of the (still-debited) reservation.
    expect(walletCalls.reserve).toHaveLength(1);
    expect(walletCalls.settle).toHaveLength(1);
    expect(walletCalls.refund).toHaveLength(0);

    // The failure is logged loudly, not swallowed silently.
    const settleErrors = logMock.error.mock.calls.filter(isSettleFailure);
    expect(settleErrors).toHaveLength(1);
    expect((settleErrors[0][0] as { err: Error }).err.message).toBe("settle exploded");

    // Metering still ran: exactly one wallet usage row, ledger untouched.
    const usage = await usageRows();
    expect(usage).toHaveLength(1);
    expect(usage[0].funding).toBe("wallet");
    expect(await ledgerRows()).toHaveLength(0);
  });

  it("recordUsage rejection after a settled wallet charge does not refund", async () => {
    walletState.enabled = true;
    usageState.recordFails = true;
    scriptSequence(validCarousel);

    const res = await postCarousel();
    expect(res.status).toBe(200);
    expect((res.body.slides as unknown[]).length).toBe(3);

    // Settled exactly once; the metering failure afterwards must not look
    // like a failed generation and hand the settled charge back.
    expect(walletCalls.reserve).toHaveLength(1);
    expect(walletCalls.settle).toHaveLength(1);
    expect(walletCalls.refund).toHaveLength(0);

    const usageErrors = logMock.error.mock.calls.filter(isUsageFailure);
    expect(usageErrors).toHaveLength(1);
    expect((usageErrors[0][0] as { err: Error }).err.message).toBe(
      "usage write exploded",
    );

    // Metering failed, so no usage rows; ledger untouched either way.
    expect(await usageRows()).toHaveLength(0);
    expect(await ledgerRows()).toHaveLength(0);
  });
});
