import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  status: "pending",
  tokenHash: "",
  tokenEncrypted: null as string | null,
  resolveCalls: 0,
  deleteGroupCalls: [] as string[],
  cleanupCalls: [] as Array<{
    sourceIdentityId: number;
    sourceAttemptId: string;
    assetGroupId?: string;
    verificationTokenEncrypted?: string;
  }>,
  finalizeMissing: false,
  tokenPersistenceMissing: false,
  signedData: "",
}));

vi.mock("./oauthState", () => ({
  signOAuthState: (_tenantId: number, data: string) => {
    state.signedData = data;
    return "signed-state";
  },
  verifySignedOAuthState: () => ({ tenantId: 7, data: "11" }),
}));
vi.mock("./byteplus/assets", () => ({
  BYTEPLUS_TOKEN_TTL_MS: 1_800_000,
  BYTEPLUS_VERIFY_SUCCESS_CODE: "10000",
  resolveBytePlusAssetsCredentials: async () => ({ accessKeyId: "x", secretAccessKey: "y" }),
  createLivenessVerification: async () => ({ verificationUrl: "https://verify.example", bytedToken: "exact-token" }),
  resolveLivenessAssetGroup: async () => {
    state.resolveCalls++;
    return "group-1";
  },
  deleteAssetGroup: async (id: string) => {
    state.deleteGroupCalls.push(id);
  },
}));
vi.mock("./bytePlusIdentityCleanup", () => ({
  enqueueBytePlusIdentityCleanup: async (args: {
    sourceIdentityId: number;
    sourceAttemptId: string;
    assetGroupId?: string;
    verificationTokenEncrypted?: string;
  }) => {
    state.cleanupCalls.push(args);
    return 1;
  },
  sweepBytePlusIdentityCleanups: async () => 1,
}));
vi.mock("@workspace/db", async (original) => {
  const actual = await original<typeof import("@workspace/db")>();
  const row = () => ({
    id: 11, tenantId: 7, label: "Person", verificationAttemptId: "attempt-11",
    assetGroupId: state.status === "verified" ? "group-1" : null,
    status: state.status, verificationTokenHash: state.tokenHash, verificationTokenEncrypted: null,
    resultCode: null, error: null,
    verifiedAt: null, createdAt: new Date(), updatedAt: new Date(),
  });
  const update = () => ({
    set(values: Record<string, unknown>) {
      return {
        where() {
          const canClaim =
            (values.status !== "completing" || state.status === "pending") &&
            !(values.status === "verified" && state.finalizeMissing) &&
            !(typeof values.verificationTokenHash === "string" && state.tokenPersistenceMissing);
          if (canClaim) {
            if (typeof values.verificationTokenHash === "string") state.tokenHash = values.verificationTokenHash;
            if (typeof values.verificationTokenEncrypted === "string" || values.verificationTokenEncrypted === null) {
              state.tokenEncrypted = values.verificationTokenEncrypted as string | null;
            }
            if (typeof values.status === "string") state.status = values.status;
          }
          const result = canClaim ? [row()] : [];
          return Object.assign(Promise.resolve(result), {
            returning: async () => result,
            catch: (fn: (error: unknown) => unknown) => Promise.resolve(result).catch(fn),
          });
        },
      };
    },
  });
  return {
    ...actual,
    db: {
      transaction: async (callback: (tx: any) => Promise<unknown>) => callback({
        execute: async () => undefined,
        select: () => ({
          from: () => ({
            where: () => ({
              for: () => ({ limit: async () => [] }),
            }),
          }),
        }),
        insert: () => ({ values: () => ({ returning: async () => [row()] }) }),
        update,
      }),
      insert: () => ({ values: () => ({ returning: async () => [row()] }) }),
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [row()] }) }) }),
      update,
    },
  };
});

import {
  completeBytePlusIdentityVerification,
  startBytePlusIdentityVerification,
} from "./bytePlusIdentity";

describe("BytePlus liveness token binding", () => {
  beforeEach(() => {
    process.env.SESSION_SECRET = "test-session-secret";
    state.status = "pending";
    state.tokenHash = "";
    state.tokenEncrypted = null;
    state.resolveCalls = 0;
    state.deleteGroupCalls = [];
    state.cleanupCalls = [];
    state.finalizeMissing = false;
    state.tokenPersistenceMissing = false;
    state.signedData = "";
  });

  it("binds a mobile return destination into the signed state", async () => {
    await startBytePlusIdentityVerification({
      tenantId: 7,
      label: "Person",
      callbackBaseUrl: "https://app.example/cb",
      returnTarget: "mobile",
    });
    expect(state.signedData).toBe("11:mobile");
  });

  it("rejects token substitution without resolving or rebinding", async () => {
    await startBytePlusIdentityVerification({ tenantId: 7, label: "Person", callbackBaseUrl: "https://app.example/cb" });
    const bound = state.tokenHash;
    await expect(completeBytePlusIdentityVerification({
      state: "signed-state", bytedToken: "substitute", resultCode: "10000",
    })).resolves.toMatchObject({ ok: false, reason: "token_mismatch" });
    expect(state.tokenHash).toBe(bound);
    expect(state.resolveCalls).toBe(0);
  });

  it("is single-use under replay and idempotent after verified completion", async () => {
    await startBytePlusIdentityVerification({ tenantId: 7, label: "Person", callbackBaseUrl: "https://app.example/cb" });
    const first = await completeBytePlusIdentityVerification({
      state: "signed-state", bytedToken: "exact-token", resultCode: "10000",
    });
    expect(first.ok).toBe(true);
    expect(state.resolveCalls).toBe(1);
    expect(state.tokenEncrypted).toBeNull();
    const replay = await completeBytePlusIdentityVerification({
      state: "signed-state", bytedToken: "exact-token", resultCode: "10000",
    });
    expect(replay).toMatchObject({ ok: true, identityId: 11 });
    expect(state.resolveCalls).toBe(1);
  });

  it("allows only one racing callback to exchange the bound token", async () => {
    await startBytePlusIdentityVerification({ tenantId: 7, label: "Person", callbackBaseUrl: "https://app.example/cb" });
    const callback = () => completeBytePlusIdentityVerification({
      state: "signed-state", bytedToken: "exact-token", resultCode: "10000",
    });
    const results = await Promise.all([callback(), callback()]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(state.resolveCalls).toBe(1);
    expect(state.tokenHash).not.toBe("");
  });

  it("cleans up the resolved asset group when the attempt is deleted mid-callback", async () => {
    await startBytePlusIdentityVerification({
      tenantId: 7,
      label: "Person",
      callbackBaseUrl: "https://app.example/cb",
    });
    state.finalizeMissing = true;

    const result = await completeBytePlusIdentityVerification({
      state: "signed-state",
      bytedToken: "exact-token",
      resultCode: "10000",
    });

    expect(result).toMatchObject({ ok: false, reason: "identity_deleted" });
    expect(state.cleanupCalls).toEqual([{
      sourceIdentityId: 11,
      sourceAttemptId: "attempt-11",
      assetGroupId: "group-1",
      tenantId: 7,
    }]);
  });

  it("does not return a verification URL when token persistence loses a delete race", async () => {
    state.tokenPersistenceMissing = true;

    await expect(startBytePlusIdentityVerification({
      tenantId: 7,
      label: "Person",
      callbackBaseUrl: "https://app.example/cb",
    })).rejects.toThrow(/removed before it could start/i);

    expect(state.cleanupCalls).toHaveLength(1);
    expect(state.cleanupCalls[0]).toMatchObject({
      sourceIdentityId: 11,
      verificationTokenEncrypted: expect.any(String),
    });
    expect(state.cleanupCalls[0]!.verificationTokenEncrypted).not.toContain("exact-token");
  });
});