import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, cleanup } from "@testing-library/react";

/**
 * Quota copy must respect the workspace billing mode: wallet-billed (prepaid)
 * workspaces are pointed at recharging the wallet, quota-billed workspaces
 * keep the upgrade / credit-pack guidance (including the server's message).
 */

const mockState = vi.hoisted(() => ({ wallet: undefined as unknown }));

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  return createApiClientMock({
    useWalletGetOverview: () => ({ data: mockState.wallet, isLoading: false }),
  });
});

import {
  useWalletBilling,
  ownerQuotaMessage,
  memberQuotaMessage,
  imageQuotaHint,
  quotaLimitDescription,
  QUOTA_OWNER_WALLET_MESSAGE,
  QUOTA_OWNER_UPGRADE_MESSAGE,
} from "./quotaCopy";

afterEach(() => {
  mockState.wallet = undefined;
  cleanup();
});

describe("useWalletBilling", () => {
  it("is true only when the wallet overview reports walletBilling", () => {
    mockState.wallet = { walletBilling: true };
    expect(renderHook(() => useWalletBilling()).result.current).toBe(true);
  });

  it("is false for quota-billed workspaces and while the overview is unavailable", () => {
    mockState.wallet = { walletBilling: false };
    expect(renderHook(() => useWalletBilling()).result.current).toBe(false);
    mockState.wallet = undefined;
    expect(renderHook(() => useWalletBilling()).result.current).toBe(false);
  });
});

describe("ownerQuotaMessage", () => {
  it("always shows wallet-recharge guidance for wallet-billed workspaces, even over a server message", () => {
    const msg = ownerQuotaMessage({
      walletBilling: true,
      serverMessage: "Upgrade your plan or buy a credit pack.",
    });
    expect(msg).toBe(QUOTA_OWNER_WALLET_MESSAGE);
    expect(msg).toMatch(/recharge your prepaid wallet/i);
    expect(msg).not.toMatch(/credit pack/i);
  });

  it("prefers the server message for quota-billed workspaces", () => {
    expect(
      ownerQuotaMessage({ walletBilling: false, serverMessage: "Server says upgrade." }),
    ).toBe("Server says upgrade.");
  });

  it("falls back to the provided upgrade copy, then the default", () => {
    expect(
      ownerQuotaMessage({ walletBilling: false, upgradeFallback: "Buy a credit pack." }),
    ).toBe("Buy a credit pack.");
    expect(ownerQuotaMessage({ walletBilling: false })).toBe(QUOTA_OWNER_UPGRADE_MESSAGE);
  });
});

describe("memberQuotaMessage", () => {
  it("asks the owner to recharge the wallet for wallet-billed workspaces", () => {
    const msg = memberQuotaMessage({ walletBilling: true, canRequestUpgrade: true });
    expect(msg).toMatch(/recharge the prepaid wallet/i);
    expect(msg).not.toMatch(/upgrade/i);
  });

  it("asks the owner to upgrade for quota-billed workspaces and supports a custom noun", () => {
    expect(memberQuotaMessage({ walletBilling: false, canRequestUpgrade: true })).toMatch(
      /ask your workspace owner to upgrade/i,
    );
    expect(
      memberQuotaMessage({ walletBilling: true, canRequestUpgrade: true, quotaNoun: "video quota" }),
    ).toMatch(/run out of video quota/i);
  });

  it("shows a plain out-of-quota notice when upgrade requests are disabled", () => {
    for (const walletBilling of [true, false]) {
      expect(memberQuotaMessage({ walletBilling, canRequestUpgrade: false })).toBe(
        "The workspace is out of AI quota.",
      );
    }
  });
});

describe("static quota copy", () => {
  it("imageQuotaHint switches between wallet and credit copy", () => {
    expect(imageQuotaHint(true)).toMatch(/recharge your prepaid wallet/i);
    expect(imageQuotaHint(false)).toMatch(/upgrade your plan or buy credits/i);
    expect(imageQuotaHint(true)).not.toMatch(/buy credits/i);
  });

  it("quotaLimitDescription switches between wallet and upgrade copy", () => {
    expect(quotaLimitDescription(true)).toMatch(/recharge your prepaid wallet/i);
    expect(quotaLimitDescription(false)).toMatch(/upgrade your plan/i);
    expect(quotaLimitDescription(true)).not.toMatch(/upgrade/i);
  });
});
