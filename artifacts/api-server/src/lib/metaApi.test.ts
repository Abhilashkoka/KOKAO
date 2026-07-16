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

  it("keeps a PAGE token as-is with no correctedCredentials", async () => {
    mockPageRead();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        data: {
          type: "PAGE",
          scopes: ["pages_read_engagement", "pages_manage_posts"],
        },
      }),
    );
    const res = await testFacebookCredentials(CREDS);
    expect(res.ok).toBe(true);
    expect(res.correctedCredentials).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
