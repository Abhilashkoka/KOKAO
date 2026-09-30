import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  rows: [] as Array<{ tenantId: number; type: string; platform: string }>,
  enabled: true,
  email: false,
  inApp: true,
  admin: false,
  verifiedEmail: "owner@example.test" as string | null,
  emailCalls: vi.fn(),
  pushCalls: vi.fn(),
}));

vi.mock("@workspace/db", () => {
  const notificationsTable = { id: "id", tenantId: "tenantId", type: "type", platform: "platform" };
  const tenantsTable = { id: "id", clerkUserId: "clerkUserId", isSuperadmin: "isSuperadmin" };
  const db = {
    select: () => ({ from: (table: unknown) => ({
      where: () => ({
        limit: async () => table === tenantsTable
          ? [{ clerkUserId: "clerk-1", isSuperadmin: state.admin }]
          : state.rows.map((row, i) => ({ id: i + 1, ...row })),
      }),
      // Admin fanout deliberately sees only an ordinary tenant in this test.
      then: (resolve: (rows: unknown[]) => void) => resolve([
        { id: 1, clerkUserId: "clerk-1", isSuperadmin: state.admin },
      ]),
    }) }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
    execute: async () => undefined,
    insert: () => ({ values: async (row: { tenantId: number; type: string; platform: string }) => {
      state.rows.push(row);
    } }),
  };
  return { db, notificationsTable, tenantsTable };
});
vi.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => a, eq: (_: unknown, value: unknown) => value,
  isNotNull: vi.fn(), isNull: vi.fn(), or: vi.fn(), desc: vi.fn(), inArray: vi.fn(),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => [strings, values],
}));
vi.mock("./notificationSettings", () => ({
  getEffectiveSetting: async () => ({
    enabled: state.enabled, email: state.email, inApp: state.inApp,
  }),
  defaultPolicy: vi.fn(), defaultPreference: vi.fn(), getMemberEmailSetting: vi.fn(),
  getPolicyState: vi.fn(), resolveEffective: vi.fn(),
}));
vi.mock("./clerkUser", () => ({ fetchVerifiedEmail: async () => state.verifiedEmail }));
vi.mock("./superadmins", () => ({ isSuperadminEmail: () => false }));
vi.mock("./push", () => ({ sendTenantPush: state.pushCalls }));
// Never sends actual email. email.ts independently tests the global pause gate.
vi.mock("./email", () => ({ sendEmail: state.emailCalls }));
vi.mock("./logger", () => ({ logger: { error: vi.fn() } }));

import { notifyCreatorAdmins, notifyCreatorEvent } from "./notifications";

const event = {
  tenantId: 1, type: "referral_purchase_reward", eventKey: "purchase:1",
  title: "Credits", message: "You earned credits.", linkUrl: "/studio",
};

describe("creator notifications", () => {
  beforeEach(() => {
    state.rows.length = 0;
    state.enabled = true;
    state.email = false;
    state.admin = false;
    state.inApp = true;
    state.verifiedEmail = "owner@example.test";
    state.emailCalls.mockReset();
    state.pushCalls.mockReset();
  });
  it("respects disabled preferences", async () => {
    state.enabled = false;
    await notifyCreatorEvent(event);
    expect(state.rows).toHaveLength(0);
    expect(state.emailCalls).not.toHaveBeenCalled();
  });
  it("records once, suppresses replay email, defaults email off", async () => {
    await notifyCreatorEvent(event);
    await notifyCreatorEvent(event);
    expect(state.rows).toHaveLength(1);
    expect(state.pushCalls).toHaveBeenCalledTimes(1);
    expect(state.emailCalls).not.toHaveBeenCalled();
  });
  it("only attempts opted-in email (global pause remains in sendEmail)", async () => {
    state.email = true;
    await notifyCreatorEvent(event);
    expect(state.emailCalls).toHaveBeenCalledTimes(1);
  });
  it("does not send admin alerts to ordinary workspaces", async () => {
    await notifyCreatorAdmins({
      type: "promoter_commission_held", eventKey: "commission:7",
      title: "Review", message: "Review it.", linkUrl: "/admin",
    });
    expect(state.rows).toHaveLength(0);
    state.admin = true;
    await notifyCreatorAdmins({
      type: "promoter_commission_held", eventKey: "commission:7",
      title: "Review", message: "Review it.", linkUrl: "/admin",
    });
    expect(state.rows).toHaveLength(1);
  });
});