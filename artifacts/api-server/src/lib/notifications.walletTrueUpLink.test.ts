/**
 * Confirms that `notifyWalletTrueUpFailing` constructs the correct deep-link
 * URL for every usageKind so that the admin banner always lands on the right
 * pricing-catalog row — even after an admin renames the model.
 *
 * Deep-link shape: /admin?tab=ai&model=<model>&kind=<pricingKind>[&provider=<p>]
 *   caption  → kind=text
 *   image    → kind=image
 *   video    → kind=video
 *   unknown  → /admin?tab=ai  (no model param, safe fallback)
 *
 * The DB is mocked so the tests run in milliseconds. The sole thing under test
 * is the linkUrl value that reaches the notifications insert — the DB writes
 * themselves are covered by the real-DB suites for notifyTextGenFailover and
 * notifyVideoGenFailover which share the same notifyProviderFailover path.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── side-channel stubs ────────────────────────────────────────────────────

vi.mock("./clerkUser", () => ({
  fetchVerifiedEmail: vi.fn(async () => "admin@example.com"),
}));
vi.mock("./email", () => ({
  sendEmail: vi.fn(async () => true),
}));
vi.mock("./push", () => ({
  sendTenantPush: vi.fn(async () => undefined),
}));

// ── DB mock: one superadmin, no existing unread row, captures inserts ─────

const insertedValues: Array<Record<string, unknown>> = [];

/** Call index tracks which select() invocation we're on. */
let selectCallIndex = 0;

vi.mock("@workspace/db", () => {
  const table = {};

  /**
   * Build a fluent Drizzle-like chain. Every method returns `this` (noop) so
   * the caller can keep chaining. The chain is also directly awaitable (drizzle
   * query-builders implement `.then()` so callers can `await db.select()…`
   * without an explicit terminal like `.limit()`). Explicit terminals like
   * `.limit()` and `.groupBy()` also call through to `terminal`.
   */
  function makeChain(terminal: () => Promise<unknown>) {
    const chain: Record<string, unknown> = {};
    const noop = () => chain;
    chain.from = noop;
    chain.where = noop;
    chain.orderBy = noop;
    chain.for = noop;
    chain.limit = terminal;
    chain.groupBy = terminal;
    chain.returning = terminal;
    // Make the chain directly awaitable (mirrors drizzle's thenable query builder).
    chain.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
      terminal().then(resolve, reject);
    return chain;
  }

  return {
    db: {
      select: (_fields?: unknown) => {
        const idx = selectCallIndex++;
        if (idx === 0) {
          // notifyProviderFailover → list superadmin candidates
          return makeChain(async () => [
            { id: 1, clerkUserId: "user_admin", email: "admin@example.com", isSuperadmin: true },
          ]);
        }
        // Subsequent selects: check for existing unread row → none
        return makeChain(async () => []);
      },
      insert: () => ({
        values: (vals: Record<string, unknown>) => {
          insertedValues.push(vals);
          return Promise.resolve();
        },
      }),
      update: () => ({
        set: () => ({ where: () => Promise.resolve() }),
      }),
    },
    and: (...args: unknown[]) => args,
    or: (...args: unknown[]) => args,
    eq: () => true,
    isNull: () => true,
    isNotNull: () => true,
    desc: (x: unknown) => x,
    notificationsTable: table,
    notificationPoliciesTable: table,
    seatRequestsTable: table,
    tenantMembersTable: table,
    tenantsTable: table,
    pool: { end: async () => {} },
  };
});

// notificationSettings is used inside notifyProviderFailover to gate the write.
vi.mock("./notificationSettings", () => ({
  getEffectiveSetting: async () => ({ enabled: true, inApp: true, email: false }),
  defaultPolicy: {},
  defaultPreference: {},
  getMemberEmailSetting: async () => true,
  getPolicyState: async () => ({ emailPolicy: "default" }),
  resolveEffective: async () => ({ enabled: true, inApp: true, email: false }),
}));

vi.mock("./superadmins", () => ({
  isSuperadminEmail: (email: string) => email === "admin@example.com",
}));

// ── import under test (after mocks so hoisting resolves first) ────────────

import { notifyWalletTrueUpFailing } from "./notifications";

// ── helpers ───────────────────────────────────────────────────────────────

/** Reset captured state between tests. */
beforeEach(() => {
  insertedValues.length = 0;
  selectCallIndex = 0;
});

function capturedLinkUrl(): string | null {
  const row = insertedValues.find((v) => "linkUrl" in v);
  return row ? (row.linkUrl as string) : null;
}

// ── tests ─────────────────────────────────────────────────────────────────

describe("notifyWalletTrueUpFailing — linkUrl construction", () => {
  it("caption usageKind maps to kind=text", async () => {
    await notifyWalletTrueUpFailing({
      usageKind: "caption",
      model: "gpt-4o",
      provider: "openrouter",
      failCount: 3,
      lastError: null,
    });

    expect(capturedLinkUrl()).toBe(
      "/admin?tab=ai&model=gpt-4o&kind=text&provider=openrouter",
    );
  });

  it("image usageKind maps to kind=image", async () => {
    await notifyWalletTrueUpFailing({
      usageKind: "image",
      model: "dall-e-3",
      provider: "openai",
      failCount: 5,
      lastError: "price not found",
    });

    expect(capturedLinkUrl()).toBe(
      "/admin?tab=ai&model=dall-e-3&kind=image&provider=openai",
    );
  });

  it("video usageKind maps to kind=video", async () => {
    await notifyWalletTrueUpFailing({
      usageKind: "video",
      model: "wan-2.1-t2v-turbo",
      provider: "replicate",
      failCount: 2,
      lastError: null,
    });

    expect(capturedLinkUrl()).toBe(
      "/admin?tab=ai&model=wan-2.1-t2v-turbo&kind=video&provider=replicate",
    );
  });

  it("omits the provider segment when provider is null", async () => {
    await notifyWalletTrueUpFailing({
      usageKind: "image",
      model: "gpt-image-1",
      provider: null,
      failCount: 1,
      lastError: null,
    });

    const url = capturedLinkUrl();
    expect(url).toBe("/admin?tab=ai&model=gpt-image-1&kind=image");
    expect(url).not.toContain("provider");
  });

  it("unknown usageKind falls back to /admin?tab=ai with no model param", async () => {
    await notifyWalletTrueUpFailing({
      usageKind: "custom_unknown",
      model: "some-model",
      provider: null,
      failCount: 1,
      lastError: null,
    });

    expect(capturedLinkUrl()).toBe("/admin?tab=ai");
  });

  it("URL-encodes special characters in model and provider names", async () => {
    const model = "dall-e 3 (preview)";
    const provider = "open ai/v2";

    await notifyWalletTrueUpFailing({
      usageKind: "image",
      model,
      provider,
      failCount: 1,
      lastError: null,
    });

    expect(capturedLinkUrl()).toBe(
      `/admin?tab=ai&model=${encodeURIComponent(model)}&kind=image&provider=${encodeURIComponent(provider)}`,
    );
  });
});
