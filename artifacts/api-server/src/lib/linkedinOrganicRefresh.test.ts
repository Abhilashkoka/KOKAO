import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from "vitest";

// Mock only the network + app-credential lookups + notification fan-out; DB
// logic stays real (mirrors linkedinAdsRefresh.test.ts).
vi.mock("./platformFetch", () => ({
  platformFetch: vi.fn(),
}));
vi.mock("./linkedinApp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./linkedinApp")>();
  return {
    ...actual,
    getLinkedinAppCredentials: vi.fn(async () => ({
      clientId: "app-id",
      clientSecret: "app-secret",
    })),
  };
});
vi.mock("./notifications", () => ({
  notifySocialConnectionFailed: vi.fn(async () => {}),
  resolveSocialConnectionNotifications: vi.fn(async () => {}),
}));

import { db, pool, connectedAccountsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { platformFetch } from "./platformFetch";
import { getLinkedinAppCredentials } from "./linkedinApp";
import {
  notifySocialConnectionFailed,
  resolveSocialConnectionNotifications,
} from "./notifications";
import { encryptJson, decryptJson } from "./secretCrypto";
import {
  LINKEDIN_ORGANIC_REFRESH_WINDOW_MS,
  linkedinOrganicRefreshDue,
  maybeRefreshLinkedinOrganicToken,
  handleLinkedinOrganicAuthFailure,
  type LinkedinOrganicStoredCredentials,
} from "./linkedinOrganicRefresh";
import { createTenant, deleteTenant } from "../test/dbHelpers";

const mockFetch = vi.mocked(platformFetch);
const mockAppCreds = vi.mocked(getLinkedinAppCredentials);
const mockNotifyFailed = vi.mocked(notifySocialConnectionFailed);
const mockResolve = vi.mocked(resolveSocialConnectionNotifications);

const DAY = 24 * 60 * 60 * 1000;

type AccountRow = typeof connectedAccountsTable.$inferSelect;

let tenantId: number;
const createdTenants: number[] = [];

beforeEach(async () => {
  vi.clearAllMocks();
  mockAppCreds.mockResolvedValue({ clientId: "app-id", clientSecret: "app-secret" });
  const t = await createTenant();
  tenantId = t.tenantId;
  createdTenants.push(tenantId);
});

afterEach(async () => {
  await db
    .delete(connectedAccountsTable)
    .where(eq(connectedAccountsTable.tenantId, tenantId));
});

afterAll(async () => {
  for (const id of createdTenants) await deleteTenant(id);
  await pool.end();
});

async function insertAccount(opts: {
  accessToken?: string | null;
  tokenExpiresAt?: Date | null;
  stored?: LinkedinOrganicStoredCredentials | null;
  overrides?: Partial<typeof connectedAccountsTable.$inferInsert>;
}): Promise<AccountRow> {
  const [row] = await db
    .insert(connectedAccountsTable)
    .values({
      tenantId,
      platform: "linkedin",
      accountName: "Test Member",
      status: "connected",
      accessToken: opts.accessToken === undefined ? "tok" : opts.accessToken,
      tokenExpiresAt:
        opts.tokenExpiresAt === undefined ? new Date(Date.now() + DAY) : opts.tokenExpiresAt,
      providerUserId: "member-1",
      verifyStatus: "verified",
      encryptedCredentials: opts.stored ? encryptJson(opts.stored) : null,
      ...opts.overrides,
    })
    .returning();
  return row!;
}

async function readAccount(id: number): Promise<AccountRow> {
  return (
    await db
      .select()
      .from(connectedAccountsTable)
      .where(eq(connectedAccountsTable.id, id))
      .limit(1)
  )[0]!;
}

function readStored(row: AccountRow): LinkedinOrganicStoredCredentials {
  return decryptJson<LinkedinOrganicStoredCredentials>(row.encryptedCredentials!);
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe("linkedinOrganicRefreshDue", () => {
  it("is false without a stored refresh token", async () => {
    const row = await insertAccount({});
    expect(linkedinOrganicRefreshDue(row)).toBe(false);
  });

  it("is false when the access token is far from expiry", async () => {
    const row = await insertAccount({
      tokenExpiresAt: new Date(Date.now() + LINKEDIN_ORGANIC_REFRESH_WINDOW_MS + DAY),
      stored: { refreshToken: "refresh" },
    });
    expect(linkedinOrganicRefreshDue(row)).toBe(false);
  });

  it("is true inside the refresh window", async () => {
    const row = await insertAccount({
      tokenExpiresAt: new Date(Date.now() + DAY),
      stored: { refreshToken: "refresh" },
    });
    expect(linkedinOrganicRefreshDue(row)).toBe(true);
  });

  it("is true when the access token already lapsed", async () => {
    const row = await insertAccount({
      tokenExpiresAt: new Date(Date.now() - DAY),
      stored: { refreshToken: "refresh" },
    });
    expect(linkedinOrganicRefreshDue(row)).toBe(true);
  });

  it("is false for a disconnected row", async () => {
    const row = await insertAccount({
      stored: { refreshToken: "refresh" },
      overrides: { status: "disconnected" },
    });
    expect(linkedinOrganicRefreshDue(row)).toBe(false);
  });

  it("with no expiry, only a failed row is due (silent revive attempt)", async () => {
    const healthy = await insertAccount({
      tokenExpiresAt: null,
      stored: { refreshToken: "refresh" },
    });
    expect(linkedinOrganicRefreshDue(healthy)).toBe(false);
    const failed = await readAccount(
      (
        await db
          .update(connectedAccountsTable)
          .set({ verifyStatus: "failed" })
          .where(eq(connectedAccountsTable.id, healthy.id))
          .returning()
      )[0]!.id,
    );
    expect(linkedinOrganicRefreshDue(failed)).toBe(true);
  });
});

describe("maybeRefreshLinkedinOrganicToken", () => {
  it("refreshes a due token, storing the new access + rotated refresh token", async () => {
    const row = await insertAccount({
      accessToken: "old-token",
      tokenExpiresAt: new Date(Date.now() + DAY),
      stored: {
        refreshToken: "old-refresh",
        refreshTokenExpiresAt: Date.now() + 300 * DAY,
      },
    });
    mockFetch.mockResolvedValue(
      jsonResponse(200, {
        access_token: "new-token",
        expires_in: 60 * 24 * 60 * 60,
        refresh_token: "new-refresh",
        refresh_token_expires_in: 365 * 24 * 60 * 60,
      }),
    );

    const outcome = await maybeRefreshLinkedinOrganicToken(row);
    expect(outcome).toBe("refreshed");
    const after = await readAccount(row.id);
    expect(after.accessToken).toBe("new-token");
    expect(after.tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 50 * DAY);
    const stored = readStored(after);
    expect(stored.refreshToken).toBe("new-refresh");
    expect(stored.refreshTokenExpiresAt).toBeGreaterThan(Date.now() + 300 * DAY);
    expect(mockResolve).toHaveBeenCalledWith(tenantId, "linkedin");

    // Request went to the token endpoint with the refresh grant in the body.
    const [, init] = mockFetch.mock.calls[0]!;
    const body = String((init as RequestInit).body);
    expect(body).toContain("grant_type=refresh_token");
    expect(body).toContain("refresh_token=old-refresh");
  });

  it("keeps the old refresh token when LinkedIn does not rotate it", async () => {
    const row = await insertAccount({
      accessToken: "old-token",
      tokenExpiresAt: new Date(Date.now() + DAY),
      stored: {
        refreshToken: "keep-me",
        refreshTokenExpiresAt: Date.now() + 200 * DAY,
      },
    });
    mockFetch.mockResolvedValue(
      jsonResponse(200, { access_token: "new-token", expires_in: 5184000 }),
    );

    await maybeRefreshLinkedinOrganicToken(row);
    const after = await readAccount(row.id);
    expect(after.accessToken).toBe("new-token");
    const stored = readStored(after);
    expect(stored.refreshToken).toBe("keep-me");
    expect(stored.refreshTokenExpiresAt).toBeDefined();
  });

  it("restores a failed row to verified on successful refresh", async () => {
    const row = await insertAccount({
      accessToken: "old-token",
      tokenExpiresAt: new Date(Date.now() - DAY),
      stored: { refreshToken: "refresh" },
      overrides: {
        status: "error",
        verifyStatus: "failed",
        verifyError: "token expired",
      },
    });
    mockFetch.mockResolvedValue(
      jsonResponse(200, { access_token: "revived", expires_in: 5184000 }),
    );

    const outcome = await maybeRefreshLinkedinOrganicToken(row);
    expect(outcome).toBe("refreshed");
    const after = await readAccount(row.id);
    expect(after.verifyStatus).toBe("verified");
    expect(after.verifyError).toBeNull();
    expect(after.status).toBe("connected");
    expect(after.accessToken).toBe("revived");
  });

  it("marks the connection failed when the refresh token is rejected (400)", async () => {
    const row = await insertAccount({
      accessToken: "old-token",
      tokenExpiresAt: new Date(Date.now() + DAY),
      stored: { refreshToken: "dead-refresh" },
    });
    mockFetch.mockResolvedValue(jsonResponse(400, { error: "invalid_grant" }));

    const outcome = await maybeRefreshLinkedinOrganicToken(row);
    expect(outcome).toBe("invalid");
    const after = await readAccount(row.id);
    expect(after.verifyStatus).toBe("failed");
    expect(after.status).toBe("error");
    expect(after.verifyError).toContain("Reconnect LinkedIn");
    // Fresh verified -> failed transition fires the deduped notification.
    expect(mockNotifyFailed).toHaveBeenCalledWith(
      tenantId,
      "linkedin",
      expect.any(String),
    );
  });

  it("leaves the row untouched on a transient failure (5xx)", async () => {
    const row = await insertAccount({
      accessToken: "still-good",
      tokenExpiresAt: new Date(Date.now() + DAY),
      stored: { refreshToken: "refresh" },
    });
    mockFetch.mockResolvedValue(jsonResponse(503, {}));

    const outcome = await maybeRefreshLinkedinOrganicToken(row);
    expect(outcome).toBe("transient");
    const after = await readAccount(row.id);
    expect(after.verifyStatus).toBe("verified");
    expect(after.accessToken).toBe("still-good");
  });

  it("leaves the row untouched on a network error", async () => {
    const row = await insertAccount({
      accessToken: "still-good",
      tokenExpiresAt: new Date(Date.now() + DAY),
      stored: { refreshToken: "refresh" },
    });
    mockFetch.mockRejectedValue(new Error("ECONNRESET"));

    const outcome = await maybeRefreshLinkedinOrganicToken(row);
    expect(outcome).toBe("transient");
    expect((await readAccount(row.id)).accessToken).toBe("still-good");
  });

  it("marks failed when the refresh token is expired AND the access token lapsed", async () => {
    const row = await insertAccount({
      accessToken: "lapsed",
      tokenExpiresAt: new Date(Date.now() - DAY),
      stored: {
        refreshToken: "expired-refresh",
        refreshTokenExpiresAt: Date.now() - DAY,
      },
    });

    const outcome = await maybeRefreshLinkedinOrganicToken(row);
    expect(outcome).toBe("invalid");
    expect((await readAccount(row.id)).verifyStatus).toBe("failed");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("does not mark failed while the access token still works, even with a dead refresh token", async () => {
    const row = await insertAccount({
      accessToken: "still-valid",
      tokenExpiresAt: new Date(Date.now() + DAY),
      stored: {
        refreshToken: "expired-refresh",
        refreshTokenExpiresAt: Date.now() - DAY,
      },
    });

    const outcome = await maybeRefreshLinkedinOrganicToken(row);
    expect(outcome).toBe("transient");
    expect((await readAccount(row.id)).verifyStatus).toBe("verified");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("is a no-op when the token is not yet due", async () => {
    const row = await insertAccount({
      accessToken: "fresh",
      tokenExpiresAt: new Date(Date.now() + LINKEDIN_ORGANIC_REFRESH_WINDOW_MS + 10 * DAY),
      stored: { refreshToken: "refresh" },
    });

    const outcome = await maybeRefreshLinkedinOrganicToken(row);
    expect(outcome).toBe("not_due");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("handleLinkedinOrganicAuthFailure", () => {
  it("does NOT mark failed when the refresh attempt fails transiently", async () => {
    const row = await insertAccount({
      accessToken: "lapsed",
      tokenExpiresAt: new Date(Date.now() - DAY),
      stored: {
        refreshToken: "still-valid-refresh",
        refreshTokenExpiresAt: Date.now() + 200 * DAY,
      },
    });
    mockFetch.mockResolvedValue(jsonResponse(503, {}));

    const outcome = await handleLinkedinOrganicAuthFailure(row, "401 from LinkedIn");
    expect(outcome).toBe("transient");
    const after = await readAccount(row.id);
    expect(after.verifyStatus).toBe("verified");
    expect(after.verifyError).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("does NOT mark failed on a network error during the forced refresh", async () => {
    const row = await insertAccount({
      accessToken: "lapsed",
      tokenExpiresAt: new Date(Date.now() - DAY),
      stored: { refreshToken: "still-valid-refresh" },
    });
    mockFetch.mockRejectedValue(new Error("ETIMEDOUT"));

    await handleLinkedinOrganicAuthFailure(row, "401 from LinkedIn");
    expect((await readAccount(row.id)).verifyStatus).toBe("verified");
  });

  it("renews the token instead of marking failed when the refresh succeeds", async () => {
    const row = await insertAccount({
      accessToken: "stale",
      tokenExpiresAt: new Date(Date.now() - DAY),
      stored: { refreshToken: "refresh" },
    });
    mockFetch.mockResolvedValue(
      jsonResponse(200, { access_token: "renewed", expires_in: 5184000 }),
    );

    const outcome = await handleLinkedinOrganicAuthFailure(row, "401 from LinkedIn");
    expect(outcome).toBe("refreshed");
    const after = await readAccount(row.id);
    expect(after.verifyStatus).toBe("verified");
    expect(after.accessToken).toBe("renewed");
  });

  it("marks failed when the refresh token is definitively rejected (400)", async () => {
    const row = await insertAccount({
      accessToken: "stale",
      tokenExpiresAt: new Date(Date.now() - DAY),
      stored: { refreshToken: "dead-refresh" },
    });
    mockFetch.mockResolvedValue(jsonResponse(400, { error: "invalid_grant" }));

    const outcome = await handleLinkedinOrganicAuthFailure(row, "401 from LinkedIn");
    expect(outcome).toBe("invalid");
    const after = await readAccount(row.id);
    expect(after.verifyStatus).toBe("failed");
    expect(after.verifyError).toBe("401 from LinkedIn");
  });

  it("marks failed when there is no refresh token stored (legacy connection)", async () => {
    const row = await insertAccount({ accessToken: "old-style" });

    const outcome = await handleLinkedinOrganicAuthFailure(row, "401 from LinkedIn");
    expect(outcome).toBe("invalid");
    expect((await readAccount(row.id)).verifyStatus).toBe("failed");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("marks failed when the refresh token itself is expired", async () => {
    const row = await insertAccount({
      accessToken: "stale",
      tokenExpiresAt: new Date(Date.now() - DAY),
      stored: {
        refreshToken: "expired",
        refreshTokenExpiresAt: Date.now() - DAY,
      },
    });

    await handleLinkedinOrganicAuthFailure(row, "401 from LinkedIn");
    expect((await readAccount(row.id)).verifyStatus).toBe("failed");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
