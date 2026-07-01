import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";

// Keep the DB-backed helpers (getTenantCredentials, decryptJson) real; only
// stub the functions that make live network calls to Meta so tests never hit
// the real Graph API and we can drive each re-verification branch.
vi.mock("./metaApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./metaApi")>();
  return {
    ...actual,
    testFacebookCredentials: vi.fn(async () => ({
      ok: true,
      accountName: "Test Page",
    })),
    testInstagramCredentials: vi.fn(async () => ({
      ok: true,
      accountName: "@testig",
    })),
  };
});

// A verified->failed transition now emails the tenant via Clerk + SendGrid.
// Keep this DB-focused test hermetic: no live Clerk lookups, no real sends.
vi.mock("./clerkUser", () => ({
  fetchVerifiedEmail: vi.fn(async () => null),
}));
vi.mock("./email", () => ({
  sendEmail: vi.fn(async () => true),
}));

import { pool } from "@workspace/db";
import {
  testFacebookCredentials,
  testInstagramCredentials,
} from "./metaApi";
import { reverifyFacebook, reverifyInstagram } from "./socialReverify";
import {
  createTenant,
  deleteTenant,
  insertConnectedAccount,
  getConnectedAccount,
  getNotifications,
  setAccountState,
} from "../test/dbHelpers";

const mockFb = vi.mocked(testFacebookCredentials);
const mockIg = vi.mocked(testInstagramCredentials);

/** More than REVERIFY_STALE_MS (15 min) in the past. */
function staleDate(): Date {
  return new Date(Date.now() - 20 * 60 * 1000);
}

beforeAll(() => {
  process.env.SESSION_SECRET =
    process.env.SESSION_SECRET || "test-session-secret";
});

afterAll(async () => {
  await pool.end();
});

beforeEach(() => {
  vi.clearAllMocks();
  mockFb.mockResolvedValue({ ok: true, accountName: "Test Page" });
  mockIg.mockResolvedValue({ ok: true, accountName: "@testig" });
});

describe("reverifyFacebook", () => {
  it("(a) flips a stale, rejected token to failed", async () => {
    const tenant = await createTenant();
    try {
      await insertConnectedAccount(
        tenant.tenantId,
        "facebook",
        { pageId: "PAGE_1", pageAccessToken: "tok_1" },
        "verified",
      );
      // Make the stored check stale so a live re-test is allowed.
      await setAccountState(tenant.tenantId, "facebook", {
        verifiedAt: staleDate(),
      });
      // Meta definitively rejects the token (NOT a transient error).
      mockFb.mockResolvedValueOnce({
        ok: false,
        error: "Error validating access token: the token expired.",
      });

      const row = await reverifyFacebook(tenant.tenantId);

      expect(mockFb).toHaveBeenCalledTimes(1);
      expect(row?.verifyStatus).toBe("failed");
      expect(row?.status).toBe("error");
      expect(row?.verifyError).toMatch(/token expired/i);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("(b) does not re-check a fresh token (rate limiting)", async () => {
    const tenant = await createTenant();
    try {
      // insertConnectedAccount stamps verifiedAt = now, i.e. fresh.
      await insertConnectedAccount(
        tenant.tenantId,
        "facebook",
        { pageId: "PAGE_2", pageAccessToken: "tok_2" },
        "verified",
      );

      const row = await reverifyFacebook(tenant.tenantId);

      // Rate limiter: no live call, status untouched.
      expect(mockFb).not.toHaveBeenCalled();
      expect(row?.verifyStatus).toBe("verified");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("force=true re-checks even a fresh token", async () => {
    const tenant = await createTenant();
    try {
      await insertConnectedAccount(
        tenant.tenantId,
        "facebook",
        { pageId: "PAGE_3", pageAccessToken: "tok_3" },
        "verified",
      );
      mockFb.mockResolvedValueOnce({ ok: false, error: "revoked" });

      const row = await reverifyFacebook(tenant.tenantId, { force: true });

      expect(mockFb).toHaveBeenCalledTimes(1);
      expect(row?.verifyStatus).toBe("failed");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("(c) keeps the prior status on a transient/network error", async () => {
    const tenant = await createTenant();
    try {
      await insertConnectedAccount(
        tenant.tenantId,
        "facebook",
        { pageId: "PAGE_4", pageAccessToken: "tok_4" },
        "verified",
      );
      const stale = staleDate();
      await setAccountState(tenant.tenantId, "facebook", { verifiedAt: stale });
      // Could not reach Meta — must NOT flip a still-valid token to failed.
      mockFb.mockResolvedValueOnce({
        ok: false,
        error: "Could not reach Meta.",
        transient: true,
      });

      const row = await reverifyFacebook(tenant.tenantId);

      expect(mockFb).toHaveBeenCalledTimes(1);
      // Prior status is preserved...
      expect(row?.verifyStatus).toBe("verified");
      expect(row?.status).toBe("connected");
      expect(row?.verifyError).toBeNull();
      // ...but the check clock advanced so we don't hammer Meta on every load.
      expect(row?.verifiedAt?.getTime()).toBeGreaterThan(stale.getTime());
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
});

describe("reverifyInstagram", () => {
  it("(c) keeps the prior status on a transient/network error", async () => {
    const tenant = await createTenant();
    try {
      // IG re-verification rides on a verified Facebook Page token.
      await insertConnectedAccount(
        tenant.tenantId,
        "facebook",
        { pageId: "PAGE_FB", pageAccessToken: "page_tok" },
        "verified",
      );
      await insertConnectedAccount(
        tenant.tenantId,
        "instagram",
        { igUserId: "IG_1" },
        "verified",
      );
      const stale = staleDate();
      await setAccountState(tenant.tenantId, "instagram", { verifiedAt: stale });
      mockIg.mockResolvedValueOnce({
        ok: false,
        error: "Could not reach Meta.",
        transient: true,
      });

      const row = await reverifyInstagram(tenant.tenantId);

      expect(mockIg).toHaveBeenCalledTimes(1);
      expect(row?.verifyStatus).toBe("verified");
      expect(row?.status).toBe("connected");
      expect(row?.verifyError).toBeNull();
      expect(row?.verifiedAt?.getTime()).toBeGreaterThan(stale.getTime());
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("(a) flips a stale, rejected token to failed", async () => {
    const tenant = await createTenant();
    try {
      await insertConnectedAccount(
        tenant.tenantId,
        "facebook",
        { pageId: "PAGE_FB2", pageAccessToken: "page_tok2" },
        "verified",
      );
      await insertConnectedAccount(
        tenant.tenantId,
        "instagram",
        { igUserId: "IG_2" },
        "verified",
      );
      await setAccountState(tenant.tenantId, "instagram", {
        verifiedAt: staleDate(),
      });
      mockIg.mockResolvedValueOnce({
        ok: false,
        error: "Instagram account is no longer accessible.",
      });

      const row = await reverifyInstagram(tenant.tenantId);

      expect(mockIg).toHaveBeenCalledTimes(1);
      expect(row?.verifyStatus).toBe("failed");
      expect(row?.status).toBe("error");
      expect(row?.verifyError).toMatch(/no longer accessible/i);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("(b) does not re-check a fresh token (rate limiting)", async () => {
    const tenant = await createTenant();
    try {
      await insertConnectedAccount(
        tenant.tenantId,
        "facebook",
        { pageId: "PAGE_FB3", pageAccessToken: "page_tok3" },
        "verified",
      );
      await insertConnectedAccount(
        tenant.tenantId,
        "instagram",
        { igUserId: "IG_3" },
        "verified",
      );

      const row = await reverifyInstagram(tenant.tenantId);

      expect(mockIg).not.toHaveBeenCalled();
      expect(row?.verifyStatus).toBe("verified");
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("notifies once when a verified connection flips to failed, and dedupes on re-check", async () => {
    const tenant = await createTenant();
    try {
      await insertConnectedAccount(
        tenant.tenantId,
        "facebook",
        { pageId: "PAGE_FB4", pageAccessToken: "page_tok4" },
        "verified",
      );
      await insertConnectedAccount(
        tenant.tenantId,
        "instagram",
        { igUserId: "IG_4" },
        "verified",
      );
      await setAccountState(tenant.tenantId, "instagram", {
        verifiedAt: staleDate(),
      });
      // Meta definitively rejects the Instagram account.
      mockIg.mockResolvedValueOnce({
        ok: false,
        error: "Instagram account is no longer accessible.",
      });

      await reverifyInstagram(tenant.tenantId);

      let notes = await getNotifications(tenant.tenantId);
      expect(notes).toHaveLength(1);
      expect(notes[0].type).toBe("social_connection_failed");
      expect(notes[0].platform).toBe("instagram");
      expect(notes[0].linkUrl).toBe("/accounts");

      // A second stale re-check still reports the token as dead. The prior
      // status is already "failed" so no duplicate notification is recorded.
      await setAccountState(tenant.tenantId, "instagram", {
        verifiedAt: staleDate(),
      });
      mockIg.mockResolvedValueOnce({
        ok: false,
        error: "Instagram account is no longer accessible.",
      });

      await reverifyInstagram(tenant.tenantId);

      notes = await getNotifications(tenant.tenantId);
      expect(notes).toHaveLength(1);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });

  it("does not notify on a transient/network error", async () => {
    const tenant = await createTenant();
    try {
      await insertConnectedAccount(
        tenant.tenantId,
        "facebook",
        { pageId: "PAGE_FB5", pageAccessToken: "page_tok5" },
        "verified",
      );
      await insertConnectedAccount(
        tenant.tenantId,
        "instagram",
        { igUserId: "IG_5" },
        "verified",
      );
      await setAccountState(tenant.tenantId, "instagram", {
        verifiedAt: staleDate(),
      });
      // Could not reach Meta — a momentary blip must not alert the tenant.
      mockIg.mockResolvedValueOnce({
        ok: false,
        error: "Could not reach Meta.",
        transient: true,
      });

      await reverifyInstagram(tenant.tenantId);

      const notes = await getNotifications(tenant.tenantId);
      expect(notes).toHaveLength(0);
    } finally {
      await deleteTenant(tenant.tenantId);
    }
  });
});
