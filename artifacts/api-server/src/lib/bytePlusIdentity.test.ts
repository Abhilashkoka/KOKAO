import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  status: "pending",
  tokenHash: "",
  resolveCalls: 0,
}));

vi.mock("./oauthState", () => ({
  signOAuthState: () => "signed-state",
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
}));
vi.mock("@workspace/db", async (original) => {
  const actual = await original<typeof import("@workspace/db")>();
  const row = () => ({
    id: 11, tenantId: 7, label: "Person", assetGroupId: state.status === "verified" ? "group-1" : null,
    status: state.status, verificationTokenHash: state.tokenHash, resultCode: null, error: null,
    verifiedAt: null, createdAt: new Date(), updatedAt: new Date(),
  });
  const update = () => ({
    set(values: Record<string, unknown>) {
      return {
        where() {
          const canClaim = values.status !== "completing" || state.status === "pending";
          if (canClaim) {
            if (typeof values.verificationTokenHash === "string") state.tokenHash = values.verificationTokenHash;
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
    state.resolveCalls = 0;
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
});