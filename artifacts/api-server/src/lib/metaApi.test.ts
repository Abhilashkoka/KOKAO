import { describe, it, expect, beforeEach, vi } from "vitest";

// Fake DB: getMetaAppCredentials does db.select().from().where().limit(1).
const dbRows: unknown[] = [];
vi.mock("@workspace/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => dbRows,
        }),
      }),
    }),
  },
  appCredentialsTable: { provider: "provider" },
  connectedAccountsTable: {},
}));

vi.mock("./secretCrypto", () => ({
  decryptJson: () => ({ appId: "app-id", appSecret: "app-secret" }),
}));

const fetchMock = vi.fn();
vi.mock("./platformFetch", () => ({
  platformFetch: (...args: unknown[]) => fetchMock(...args),
}));

import { testFacebookCredentials } from "./metaApi";

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

const CREDS = { pageId: "page-1", pageAccessToken: "page-token" };

function mockPageRead() {
  fetchMock.mockResolvedValueOnce(
    jsonResponse(200, { id: "page-1", name: "My Page" }),
  );
}

describe("testFacebookCredentials scope check", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    dbRows.length = 0;
    dbRows.push({ encryptedCredentials: "enc" });
  });

  it("passes when the token has both publish permissions", async () => {
    mockPageRead();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        data: { scopes: ["pages_read_engagement", "pages_manage_posts"] },
      }),
    );
    const res = await testFacebookCredentials(CREDS);
    expect(res.ok).toBe(true);
    expect(res.accountName).toBe("My Page");
  });

  it("fails with an actionable error when pages_manage_posts is missing", async () => {
    mockPageRead();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { data: { scopes: ["pages_read_engagement"] } }),
    );
    const res = await testFacebookCredentials(CREDS);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("pages_manage_posts");
  });

  it("does not block when the debug_token call fails", async () => {
    mockPageRead();
    fetchMock.mockResolvedValueOnce(jsonResponse(500, {}));
    const res = await testFacebookCredentials(CREDS);
    expect(res.ok).toBe(true);
  });

  it("does not block when app credentials are not configured", async () => {
    dbRows.length = 0;
    mockPageRead();
    const res = await testFacebookCredentials(CREDS);
    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("exchanges a USER token for the Page token and returns correctedCredentials", async () => {
    mockPageRead();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        data: {
          type: "USER",
          scopes: ["pages_read_engagement", "pages_manage_posts"],
        },
      }),
    );
    // Long-lived exchange fails -> fall back to the original user token.
    fetchMock.mockResolvedValueOnce(jsonResponse(400, { error: { message: "nope" } }));
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { access_token: "real-page-token" }),
    );
    const res = await testFacebookCredentials(CREDS);
    expect(res.ok).toBe(true);
    expect(res.correctedCredentials).toEqual({
      pageId: "page-1",
      pageAccessToken: "real-page-token",
    });
  });

  it("fails with guidance when a USER token cannot be exchanged", async () => {
    mockPageRead();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        data: {
          type: "USER",
          scopes: ["pages_read_engagement", "pages_manage_posts"],
        },
      }),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse(400, { error: { message: "nope" } }));
    const res = await testFacebookCredentials(CREDS);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("Page access token");
  });

  it("keeps a PAGE token as-is when the long-lived exchange fails", async () => {
    mockPageRead();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        data: {
          type: "PAGE",
          scopes: ["pages_read_engagement", "pages_manage_posts"],
        },
      }),
    );
    // fb_exchange_token attempt fails -> keep the original token.
    fetchMock.mockResolvedValueOnce(jsonResponse(400, { error: { message: "nope" } }));
    const res = await testFacebookCredentials(CREDS);
    expect(res.ok).toBe(true);
    expect(res.correctedCredentials).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("upgrades a PAGE token to a long-lived token via fb_exchange_token", async () => {
    mockPageRead();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        data: {
          type: "PAGE",
          scopes: ["pages_read_engagement", "pages_manage_posts"],
        },
      }),
    );
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { access_token: "long-lived-page-token" }),
    );
    const res = await testFacebookCredentials(CREDS);
    expect(res.ok).toBe(true);
    expect(res.correctedCredentials).toEqual({
      pageId: "page-1",
      pageAccessToken: "long-lived-page-token",
    });
    // The exchange call carries the token in the POST body, never the URL.
    const exchangeCall = fetchMock.mock.calls[2];
    expect(String(exchangeCall[0])).not.toContain("page-token");
    const body = (exchangeCall[1] as { body: URLSearchParams }).body;
    expect(body.get("grant_type")).toBe("fb_exchange_token");
    expect(body.get("fb_exchange_token")).toBe("page-token");
  });

  it("does not rewrite credentials when the token type is unknown", async () => {
    mockPageRead();
    // debug_token fails -> type null. No exchange should be attempted.
    fetchMock.mockResolvedValueOnce(jsonResponse(500, {}));
    const res = await testFacebookCredentials(CREDS);
    expect(res.ok).toBe(true);
    expect(res.correctedCredentials).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("upgrades a USER token to long-lived before exchanging for the Page token", async () => {
    mockPageRead();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        data: {
          type: "USER",
          scopes: ["pages_read_engagement", "pages_manage_posts"],
        },
      }),
    );
    // fb_exchange_token succeeds with a long-lived user token.
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { access_token: "long-lived-user-token" }),
    );
    // Page token exchange uses the long-lived user token.
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { access_token: "real-page-token" }),
    );
    const res = await testFacebookCredentials(CREDS);
    expect(res.ok).toBe(true);
    expect(res.correctedCredentials).toEqual({
      pageId: "page-1",
      pageAccessToken: "real-page-token",
    });
    const pageExchangeCall = fetchMock.mock.calls[3];
    const headers = (pageExchangeCall[1] as { headers: Record<string, string> }).headers;
    expect(headers.Authorization).toBe("Bearer long-lived-user-token");
  });

  it("rejects a token issued by a different Meta app than the configured one", async () => {
    mockPageRead();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        data: {
          type: "PAGE",
          app_id: "some-other-app",
          scopes: ["pages_read_engagement", "pages_manage_posts"],
        },
      }),
    );
    const res = await testFacebookCredentials(CREDS);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("different Facebook app");
    // No exchange should even be attempted for a foreign-app token.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("accepts a token when the issuing app matches the configured app", async () => {
    mockPageRead();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        data: {
          type: "PAGE",
          app_id: "app-id",
          expires_at: 0,
          scopes: ["pages_read_engagement", "pages_manage_posts"],
        },
      }),
    );
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { access_token: "long-lived-page-token" }),
    );
    const res = await testFacebookCredentials(CREDS);
    expect(res.ok).toBe(true);
  });

  it("rejects a short-lived PAGE token when the long-lived upgrade fails", async () => {
    mockPageRead();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        data: {
          type: "PAGE",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          scopes: ["pages_read_engagement", "pages_manage_posts"],
        },
      }),
    );
    // fb_exchange_token attempt fails.
    fetchMock.mockResolvedValueOnce(jsonResponse(400, { error: { message: "nope" } }));
    const res = await testFacebookCredentials(CREDS);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("temporary");
  });

  it("keeps a never-expiring PAGE token even when the upgrade fails", async () => {
    mockPageRead();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        data: {
          type: "PAGE",
          expires_at: 0,
          scopes: ["pages_read_engagement", "pages_manage_posts"],
        },
      }),
    );
    fetchMock.mockResolvedValueOnce(jsonResponse(400, { error: { message: "nope" } }));
    const res = await testFacebookCredentials(CREDS);
    expect(res.ok).toBe(true);
  });

  it("rejects a USER-derived Page token that is still short-lived", async () => {
    mockPageRead();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        data: {
          type: "USER",
          scopes: ["pages_read_engagement", "pages_manage_posts"],
        },
      }),
    );
    // Long-lived exchange fails -> fall back to the short-lived user token.
    fetchMock.mockResolvedValueOnce(jsonResponse(400, { error: { message: "nope" } }));
    // Page token derived from the short-lived user token.
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { access_token: "derived-page-token" }),
    );
    // Final inspection shows the derived token also expires within hours.
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        data: {
          type: "PAGE",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          scopes: ["pages_read_engagement", "pages_manage_posts"],
        },
      }),
    );
    const res = await testFacebookCredentials(CREDS);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("temporary");
  });

  it("accepts a USER-derived Page token that never expires", async () => {
    mockPageRead();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        data: {
          type: "USER",
          scopes: ["pages_read_engagement", "pages_manage_posts"],
        },
      }),
    );
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { access_token: "long-lived-user-token" }),
    );
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { access_token: "real-page-token" }),
    );
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        data: {
          type: "PAGE",
          expires_at: 0,
          scopes: ["pages_read_engagement", "pages_manage_posts"],
        },
      }),
    );
    const res = await testFacebookCredentials(CREDS);
    expect(res.ok).toBe(true);
    expect(res.correctedCredentials).toEqual({
      pageId: "page-1",
      pageAccessToken: "real-page-token",
    });
  });

  it("never puts the page token in a URL", async () => {
    mockPageRead();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { data: { scopes: [] } }),
    );
    await testFacebookCredentials(CREDS);
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).not.toContain("page-token");
    }
  });
});
