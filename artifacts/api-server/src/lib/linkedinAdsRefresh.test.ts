import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from "vitest";

// Mock only the network + app-credential lookups; DB logic stays real.
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
// markFailed now notifies the tenant; no live Clerk lookups or real emails.
vi.mock("./clerkUser", () => ({
  fetchVerifiedEmail: vi.fn(async () => null),
}));
vi.mock("./email", () => ({
  sendEmail: vi.fn(async () => true),
}));

import { db, pool, adAccountConnectionsTable, type AdAccountConnection } from "@workspace/db";
import { eq } from "drizzle-orm";
import { platformFetch } from "./platformFetch";
import { getLinkedinAppCredentials } from "./linkedinApp";
import { encryptJson, decryptJson } from "./secretCrypto";
import type { LinkedinAdsCredentials } from "./linkedinAdsApi";
import {
  LINKEDIN_ADS_REFRESH_WINDOW_MS,
  linkedinAdsRefreshDue,
  maybeRefreshLinkedinAdsToken,
  refreshDueLinkedinAdsTokens,
  handleLinkedinAdsAuthFailure,
} from "./linkedinAdsRefresh";
import { createTenant, deleteTenant, getNotifications } from "../test/dbHelpers";

const mockFetch = vi.mocked(platformFetch);
const mockAppCreds = vi.mocked(getLinkedinAppCredentials);

const DAY = 24 * 60 * 60 * 1000;

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
    .delete(adAccountConnectionsTable)
    .where(eq(adAccountConnectionsTable.tenantId, tenantId));
});

afterAll(async () => {
  for (const id of createdTenants) await deleteTenant(id);
  await pool.end();
});

async function insertConnection(
  creds: LinkedinAdsCredentials,
  overrides: Partial<typeof adAccountConnectionsTable.$inferInsert> = {},
  ownerTenantId = tenantId,
): Promise<AdAccountConnection> {
  const [row] = await db
    .insert(adAccountConnectionsTable)
    .values({
      tenantId: ownerTenantId,
      platform: "linkedin",
      status: "connected",
      adAccountId: "512345678",
      adAccountName: "Test LinkedIn Account",
      currency: "USD",
      verifyStatus: "verified",
      encryptedCredentials: encryptJson(creds),
      ...overrides,
    })
    .returning();
  return row!;
}

async function readConnection(id: number): Promise<AdAccountConnection> {
  return (
    await db
      .select()
      .from(adAccountConnectionsTable)
      .where(eq(adAccountConnectionsTable.id, id))
      .limit(1)
  )[0]!;
}

function readCreds(conn: AdAccountConnection): LinkedinAdsCredentials {
  return decryptJson<LinkedinAdsCredentials>(conn.encryptedCredentials!);
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe("linkedinAdsRefreshDue", () => {
  it("is false without a refresh token", async () => {
    const conn = await insertConnection({
      accessToken: "tok",
      expiresAt: Date.now() + DAY,
    });
    expect(linkedinAdsRefreshDue(conn)).toBe(false);
  });

  it("is false when the access token is far from expiry", async () => {
    const conn = await insertConnection({
      accessToken: "tok",
      expiresAt: Date.now() + LINKEDIN_ADS_REFRESH_WINDOW_MS + DAY,
      refreshToken: "refresh",
    });
    expect(linkedinAdsRefreshDue(conn)).toBe(false);
  });

  it("is true inside the refresh window", async () => {
    const conn = await insertConnection({
      accessToken: "tok",
      expiresAt: Date.now() + DAY,
      refreshToken: "refresh",
    });
    expect(linkedinAdsRefreshDue(conn)).toBe(true);
  });

  it("is false for non-linkedin platforms", async () => {
    const conn = await insertConnection(
      { accessToken: "tok", expiresAt: Date.now() + DAY, refreshToken: "r" },
      { platform: "meta" },
    );
    expect(linkedinAdsRefreshDue(conn)).toBe(false);
  });
});

describe("maybeRefreshLinkedinAdsToken", () => {
  it("refreshes a due token, storing the new access + rotated refresh token", async () => {
    const conn = await insertConnection({
      accessToken: "old-token",
      expiresAt: Date.now() + DAY,
      refreshToken: "old-refresh",
      refreshTokenExpiresAt: Date.now() + 300 * DAY,
    });
    mockFetch.mockResolvedValue(
      jsonResponse(200, {
        access_token: "new-token",
        expires_in: 60 * 24 * 60 * 60,
        refresh_token: "new-refresh",
        refresh_token_expires_in: 365 * 24 * 60 * 60,
      }),
    );

    const updated = await maybeRefreshLinkedinAdsToken(conn);
    const creds = readCreds(updated);
    expect(creds.accessToken).toBe("new-token");
    expect(creds.refreshToken).toBe("new-refresh");
    expect(creds.expiresAt).toBeGreaterThan(Date.now() + 50 * DAY);
    expect(creds.refreshTokenExpiresAt).toBeGreaterThan(Date.now() + 300 * DAY);

    // Request went to the token endpoint with the refresh grant in the body.
    const [, init] = mockFetch.mock.calls[0]!;
    const body = String((init as RequestInit).body);
    expect(body).toContain("grant_type=refresh_token");
    expect(body).toContain("refresh_token=old-refresh");
  });

  it("keeps the old refresh token when LinkedIn does not rotate it", async () => {
    const conn = await insertConnection({
      accessToken: "old-token",
      expiresAt: Date.now() + DAY,
      refreshToken: "keep-me",
      refreshTokenExpiresAt: Date.now() + 200 * DAY,
    });
    mockFetch.mockResolvedValue(
      jsonResponse(200, { access_token: "new-token", expires_in: 5184000 }),
    );

    const updated = await maybeRefreshLinkedinAdsToken(conn);
    const creds = readCreds(updated);
    expect(creds.accessToken).toBe("new-token");
    expect(creds.refreshToken).toBe("keep-me");
    expect(creds.refreshTokenExpiresAt).toBeDefined();
  });

  it("restores a failed row to verified on successful refresh", async () => {
    const conn = await insertConnection(
      {
        accessToken: "old-token",
        expiresAt: Date.now() - DAY,
        refreshToken: "refresh",
      },
      { verifyStatus: "failed", verifyError: "token expired" },
    );
    mockFetch.mockResolvedValue(
      jsonResponse(200, { access_token: "revived", expires_in: 5184000 }),
    );

    const updated = await maybeRefreshLinkedinAdsToken(conn);
    expect(updated.verifyStatus).toBe("verified");
    expect(updated.verifyError).toBeNull();
    expect(readCreds(updated).accessToken).toBe("revived");
  });

  it("auto-resolves the reconnect notification when a failed row is revived by a refresh", async () => {
    const conn = await insertConnection({
      accessToken: "old-token",
      expiresAt: Date.now() - DAY,
      refreshToken: "refresh",
    });
    // Fail the row for real first, recording the tenant alert.
    mockFetch.mockResolvedValueOnce(jsonResponse(400, { error: "invalid_grant" }));
    await handleLinkedinAdsAuthFailure(conn, "401 from LinkedIn");
    let alerts = (await getNotifications(tenantId)).filter(
      (n) => n.type === "ads_connection_failed" && n.readAt == null,
    );
    expect(alerts).toHaveLength(1);

    mockFetch.mockResolvedValue(
      jsonResponse(200, { access_token: "revived", expires_in: 5184000 }),
    );
    const updated = await maybeRefreshLinkedinAdsToken(
      await readConnection(conn.id),
    );
    expect(updated.verifyStatus).toBe("verified");

    alerts = (await getNotifications(tenantId)).filter(
      (n) => n.type === "ads_connection_failed" && n.readAt == null,
    );
    expect(alerts).toHaveLength(0);
  });

  it("marks the connection failed when the refresh token is rejected (400)", async () => {
    const conn = await insertConnection({
      accessToken: "old-token",
      expiresAt: Date.now() + DAY,
      refreshToken: "dead-refresh",
    });
    mockFetch.mockResolvedValue(
      jsonResponse(400, { error: "invalid_grant" }),
    );

    const updated = await maybeRefreshLinkedinAdsToken(conn);
    expect(updated.verifyStatus).toBe("failed");
    expect(updated.verifyError).toContain("Reconnect LinkedIn Ads");

    // A fresh verified -> failed transition notifies the tenant (deduped).
    const alerts = (await getNotifications(tenantId)).filter(
      (n) => n.type === "ads_connection_failed",
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0].platform).toBe("linkedin");

    const again = await maybeRefreshLinkedinAdsToken(updated);
    expect(again.verifyStatus).toBe("failed");
    const after = (await getNotifications(tenantId)).filter(
      (n) => n.type === "ads_connection_failed",
    );
    expect(after).toHaveLength(1);
  });

  it("leaves the row untouched on a transient failure (5xx)", async () => {
    const conn = await insertConnection({
      accessToken: "still-good",
      expiresAt: Date.now() + DAY,
      refreshToken: "refresh",
    });
    mockFetch.mockResolvedValue(jsonResponse(503, {}));

    const updated = await maybeRefreshLinkedinAdsToken(conn);
    expect(updated.verifyStatus).toBe("verified");
    expect(readCreds(updated).accessToken).toBe("still-good");
  });

  it("leaves the row untouched on a network error", async () => {
    const conn = await insertConnection({
      accessToken: "still-good",
      expiresAt: Date.now() + DAY,
      refreshToken: "refresh",
    });
    mockFetch.mockRejectedValue(new Error("ECONNRESET"));

    const updated = await maybeRefreshLinkedinAdsToken(conn);
    expect(updated.verifyStatus).toBe("verified");
    expect(readCreds(updated).accessToken).toBe("still-good");
  });

  it("marks failed when the refresh token is expired AND the access token lapsed", async () => {
    const conn = await insertConnection({
      accessToken: "lapsed",
      expiresAt: Date.now() - DAY,
      refreshToken: "expired-refresh",
      refreshTokenExpiresAt: Date.now() - DAY,
    });

    const updated = await maybeRefreshLinkedinAdsToken(conn);
    expect(updated.verifyStatus).toBe("failed");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("does not mark failed while the access token still works, even with a dead refresh token", async () => {
    const conn = await insertConnection({
      accessToken: "still-valid",
      expiresAt: Date.now() + DAY,
      refreshToken: "expired-refresh",
      refreshTokenExpiresAt: Date.now() - DAY,
    });

    const updated = await maybeRefreshLinkedinAdsToken(conn);
    expect(updated.verifyStatus).toBe("verified");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("coalesces two parallel refresh calls into a single token exchange", async () => {
    const conn = await insertConnection({
      accessToken: "old-token",
      expiresAt: Date.now() + DAY,
      refreshToken: "old-refresh",
      refreshTokenExpiresAt: Date.now() + 300 * DAY,
    });
    // Hold the token exchange open until both callers are in flight, so the
    // race window is guaranteed.
    let releaseExchange!: () => void;
    const gate = new Promise<void>((resolve) => (releaseExchange = resolve));
    mockFetch.mockImplementation(async () => {
      await gate;
      return jsonResponse(200, {
        access_token: "new-token",
        expires_in: 5184000,
        refresh_token: "rotated-refresh",
        refresh_token_expires_in: 365 * 24 * 60 * 60,
      });
    });

    const p1 = maybeRefreshLinkedinAdsToken(conn);
    const p2 = maybeRefreshLinkedinAdsToken(conn);
    // Give both calls a chance to reach the exchange before releasing it.
    await new Promise((r) => setTimeout(r, 20));
    releaseExchange();
    const [r1, r2] = await Promise.all([p1, p2]);

    // Exactly one exchange ran; both callers got the refreshed row.
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(readCreds(r1).accessToken).toBe("new-token");
    expect(readCreds(r2).accessToken).toBe("new-token");
    expect(readCreds(await readConnection(conn.id)).refreshToken).toBe(
      "rotated-refresh",
    );
  });

  it("skips the exchange when a caller holds a stale snapshot after another refresh landed", async () => {
    const conn = await insertConnection({
      accessToken: "old-token",
      expiresAt: Date.now() + DAY,
      refreshToken: "old-refresh",
      refreshTokenExpiresAt: Date.now() + 300 * DAY,
    });
    mockFetch.mockResolvedValue(
      jsonResponse(200, {
        access_token: "new-token",
        expires_in: 5184000,
        refresh_token: "rotated-refresh",
        refresh_token_expires_in: 365 * 24 * 60 * 60,
      }),
    );

    // First refresh lands and rotates the refresh token.
    await maybeRefreshLinkedinAdsToken(conn);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // A second caller still holding the PRE-refresh snapshot must not run a
    // second exchange (which would use the dead pre-rotation refresh token).
    const result = await maybeRefreshLinkedinAdsToken(conn);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(readCreds(result).accessToken).toBe("new-token");
    expect(readCreds(result).refreshToken).toBe("rotated-refresh");
  });

  it("is a no-op when the token is not yet due", async () => {
    const conn = await insertConnection({
      accessToken: "fresh",
      expiresAt: Date.now() + LINKEDIN_ADS_REFRESH_WINDOW_MS + 10 * DAY,
      refreshToken: "refresh",
    });

    const updated = await maybeRefreshLinkedinAdsToken(conn);
    expect(updated).toEqual(conn);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("handleLinkedinAdsAuthFailure", () => {
  it("does NOT mark failed when the access token lapsed but the refresh attempt fails transiently (API 401 case)", async () => {
    // The LinkedIn Ads API just returned 401 because the access token lapsed,
    // but the refresh token is still valid — a transient refresh failure must
    // not surface a reconnect prompt.
    const conn = await insertConnection({
      accessToken: "lapsed",
      expiresAt: Date.now() - DAY,
      refreshToken: "still-valid-refresh",
      refreshTokenExpiresAt: Date.now() + 200 * DAY,
    });
    mockFetch.mockResolvedValue(jsonResponse(503, {}));

    await handleLinkedinAdsAuthFailure(conn, "401 from LinkedIn");
    const after = await readConnection(conn.id);
    expect(after.verifyStatus).toBe("verified");
    expect(after.verifyError).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("does NOT mark failed on a network error during the forced refresh", async () => {
    const conn = await insertConnection({
      accessToken: "lapsed",
      expiresAt: Date.now() - DAY,
      refreshToken: "still-valid-refresh",
    });
    mockFetch.mockRejectedValue(new Error("ETIMEDOUT"));

    await handleLinkedinAdsAuthFailure(conn, "401 from LinkedIn");
    expect((await readConnection(conn.id)).verifyStatus).toBe("verified");
  });

  it("renews the token instead of marking failed when the refresh succeeds", async () => {
    const conn = await insertConnection({
      accessToken: "stale",
      expiresAt: Date.now() - DAY,
      refreshToken: "refresh",
    });
    mockFetch.mockResolvedValue(
      jsonResponse(200, { access_token: "renewed", expires_in: 5184000 }),
    );

    await handleLinkedinAdsAuthFailure(conn, "401 from LinkedIn");
    const after = await readConnection(conn.id);
    expect(after.verifyStatus).toBe("verified");
    expect(readCreds(after).accessToken).toBe("renewed");
  });

  it("marks failed when the refresh token is definitively rejected (400)", async () => {
    const conn = await insertConnection({
      accessToken: "stale",
      expiresAt: Date.now() - DAY,
      refreshToken: "dead-refresh",
    });
    mockFetch.mockResolvedValue(jsonResponse(400, { error: "invalid_grant" }));

    await handleLinkedinAdsAuthFailure(conn, "401 from LinkedIn");
    const after = await readConnection(conn.id);
    expect(after.verifyStatus).toBe("failed");
    expect(after.verifyError).toBe("401 from LinkedIn");
  });

  it("marks failed when there is no refresh token stored (legacy connection)", async () => {
    const conn = await insertConnection({
      accessToken: "old-style",
      expiresAt: Date.now() + DAY,
    });

    await handleLinkedinAdsAuthFailure(conn, "401 from LinkedIn");
    expect((await readConnection(conn.id)).verifyStatus).toBe("failed");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("marks failed when the refresh token itself is expired", async () => {
    const conn = await insertConnection({
      accessToken: "stale",
      expiresAt: Date.now() - DAY,
      refreshToken: "expired",
      refreshTokenExpiresAt: Date.now() - DAY,
    });

    await handleLinkedinAdsAuthFailure(conn, "401 from LinkedIn");
    expect((await readConnection(conn.id)).verifyStatus).toBe("failed");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("refreshDueLinkedinAdsTokens", () => {
  it("refreshes only due LinkedIn rows and reports counts", async () => {
    const due = await insertConnection({
      accessToken: "old",
      expiresAt: Date.now() + DAY,
      refreshToken: "refresh",
    });
    const other = await createTenant();
    createdTenants.push(other.tenantId);
    const fresh = await insertConnection(
      {
        accessToken: "fresh",
        expiresAt: Date.now() + LINKEDIN_ADS_REFRESH_WINDOW_MS + 10 * DAY,
        refreshToken: "refresh",
      },
      {},
      other.tenantId,
    );
    mockFetch.mockResolvedValue(
      jsonResponse(200, { access_token: "renewed", expires_in: 5184000 }),
    );

    const outcome = await refreshDueLinkedinAdsTokens();
    expect(outcome.checked).toBe(1);
    expect(outcome.errors).toBe(0);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(readCreds(await readConnection(due.id)).accessToken).toBe("renewed");
    expect(readCreds(await readConnection(fresh.id)).accessToken).toBe("fresh");
  });
});
