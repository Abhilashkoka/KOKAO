import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextFunction, Request, Response } from "express";

// Mock the live Clerk email lookup and the allowlist before importing the
// middleware so the module-load-time allowlist doesn't matter here.
vi.mock("../lib/clerkUser", () => ({
  fetchVerifiedEmail: vi.fn(),
}));
vi.mock("../lib/superadmins", () => ({
  isSuperadminEmail: vi.fn(),
}));

const updateWhere = vi.fn().mockResolvedValue(undefined);
const updateSet = vi.fn(() => ({ where: updateWhere }));
vi.mock("@workspace/db", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    db: {
      update: vi.fn(() => ({ set: updateSet })),
    },
  };
});

import { requireSuperadmin } from "./requireSuperadmin";
import { fetchVerifiedEmail } from "../lib/clerkUser";
import { isSuperadminEmail } from "../lib/superadmins";
import { db } from "@workspace/db";

function makeReq(overrides: Partial<Request>): Request {
  return {
    clerkUserId: "user_actor",
    tenantId: 42,
    tenantEmail: "owner@example.com",
    tenantIsSuperadmin: false,
    memberRole: "owner",
    log: { error: vi.fn() },
    ...overrides,
  } as unknown as Request;
}

function makeRes() {
  const res = {} as Response & { statusCode?: number; body?: unknown };
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  }) as unknown as Response["status"];
  res.json = vi.fn((body: unknown) => {
    res.body = body;
    return res;
  }) as unknown as Response["json"];
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("requireSuperadmin email self-heal", () => {
  it("backfills the cached tenant email for an allowlisted OWNER in their own workspace", async () => {
    vi.mocked(fetchVerifiedEmail).mockResolvedValue("root@example.com");
    vi.mocked(isSuperadminEmail).mockReturnValue(true);

    const req = makeReq({ memberRole: "owner", tenantEmail: "stale@old.com" });
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    await requireSuperadmin(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(db.update).toHaveBeenCalledTimes(1);
    expect(req.tenantEmail).toBe("root@example.com");
  });

  it("does NOT overwrite the workspace owner's cached email when the allowlisted actor is only a MEMBER of that workspace", async () => {
    vi.mocked(fetchVerifiedEmail).mockResolvedValue("root@example.com");
    vi.mocked(isSuperadminEmail).mockReturnValue(true);

    const req = makeReq({
      memberRole: "member",
      tenantEmail: "owner@example.com",
    });
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    await requireSuperadmin(req, res, next);

    // Access is still granted (allowlist passes), but the other workspace's
    // cached owner email must remain untouched.
    expect(next).toHaveBeenCalledTimes(1);
    expect(db.update).not.toHaveBeenCalled();
    expect(req.tenantEmail).toBe("owner@example.com");
  });

  it("denies non-allowlisted users without touching the database", async () => {
    vi.mocked(fetchVerifiedEmail).mockResolvedValue("random@example.com");
    vi.mocked(isSuperadminEmail).mockReturnValue(false);

    const req = makeReq({});
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    await requireSuperadmin(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(db.update).not.toHaveBeenCalled();
  });
});
