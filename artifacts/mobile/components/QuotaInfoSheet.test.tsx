/**
 * Guard: the shared quota explainer used by every screen that can hit a 402.
 * - isQuotaError only flags status 402.
 * - quotaErrorMessage prefers the server's text, with a sensible fallback.
 * - Tapping the QuotaErrorNotice opens the QuotaInfoSheet with the
 *   monthly-reset and Settings > Billing guidance.
 */
import React, { useState } from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("@expo/vector-icons", () => ({
  Feather: () => null,
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("@/components/ui", () => ({
  Button: ({ title, onPress }: { title: string; onPress?: () => void }) => (
    <button onClick={onPress}>{title}</button>
  ),
}));

// Wallet-billed workspaces get recharge guidance instead of credit-pack copy.
const mockState: { wallet: { walletBilling: boolean } | undefined } = {
  wallet: undefined,
};
vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  return createApiClientMock({
    useWalletGetOverview: () => ({ data: mockState.wallet, isLoading: false }),
  });
});

import { beforeEach } from "vitest";
import {
  isQuotaError,
  quotaErrorMessage,
  quotaErrorTitle,
  QUOTA_FALLBACK_MESSAGE,
  QUOTA_MEMBER_ASK_OWNER_MESSAGE,
  QUOTA_MEMBER_PLAIN_MESSAGE,
  QUOTA_MEMBER_WALLET_MESSAGE,
  QUOTA_OWNER_WALLET_MESSAGE,
  QuotaErrorNotice,
  QuotaInfoSheet,
} from "./QuotaInfoSheet";

describe("isQuotaError", () => {
  it("flags only status 402", () => {
    expect(isQuotaError({ status: 402 })).toBe(true);
    expect(isQuotaError({ status: 500 })).toBe(false);
    expect(isQuotaError(null)).toBe(false);
    expect(isQuotaError(undefined)).toBe(false);
    expect(isQuotaError(new Error("boom"))).toBe(false);
  });
});

describe("quotaErrorMessage", () => {
  it("prefers the server's error text", () => {
    expect(
      quotaErrorMessage({ status: 402, data: { error: "Monthly image quota reached." } }),
    ).toBe("Monthly image quota reached.");
  });

  it("falls back to the shared default", () => {
    expect(quotaErrorMessage({ status: 402 })).toBe(QUOTA_FALLBACK_MESSAGE);
    expect(quotaErrorMessage({ status: 402, data: { error: "" } })).toBe(
      QUOTA_FALLBACK_MESSAGE,
    );
  });

  it("gives members role-appropriate copy instead of the server's owner advice", () => {
    const err = {
      status: 402,
      data: { error: "Quota reached. Upgrade your plan or buy a credit pack." },
    };
    expect(
      quotaErrorMessage(err, { isOwner: false, upgradeRequestsEnabled: true }),
    ).toBe(QUOTA_MEMBER_ASK_OWNER_MESSAGE);
    expect(
      quotaErrorMessage(err, { isOwner: false, upgradeRequestsEnabled: false }),
    ).toBe(QUOTA_MEMBER_PLAIN_MESSAGE);
  });

  it("owners keep the server's message", () => {
    const err = {
      status: 402,
      data: { error: "Quota reached. Upgrade your plan or buy a credit pack." },
    };
    expect(quotaErrorMessage(err, { isOwner: true, upgradeRequestsEnabled: true })).toBe(
      "Quota reached. Upgrade your plan or buy a credit pack.",
    );
  });

  it("wallet-billed owners see wallet-flavored server messages verbatim", () => {
    const err = {
      status: 402,
      data: {
        error:
          "This video needs 4 generations and your wallet balance can't cover it. Recharge to continue.",
      },
    };
    expect(
      quotaErrorMessage(err, { isOwner: true, upgradeRequestsEnabled: true, walletBilling: true }),
    ).toBe(
      "This video needs 4 generations and your wallet balance can't cover it. Recharge to continue.",
    );
  });

  it("wallet-billed owners get recharge guidance when the server text is credit-pack oriented", () => {
    const err = {
      status: 402,
      data: { error: "Quota reached. Upgrade your plan or buy a credit pack." },
    };
    expect(quotaErrorMessage(err, { isOwner: true, walletBilling: true })).toBe(
      QUOTA_OWNER_WALLET_MESSAGE,
    );
    expect(quotaErrorMessage({ status: 402 }, { walletBilling: true })).toBe(
      QUOTA_OWNER_WALLET_MESSAGE,
    );
  });

  it("wallet-billed members are told to ask the owner to recharge", () => {
    const err = {
      status: 402,
      data: {
        error: "This video needs 4 generations and your wallet balance can't cover it.",
      },
    };
    expect(
      quotaErrorMessage(err, {
        isOwner: false,
        upgradeRequestsEnabled: true,
        walletBilling: true,
      }),
    ).toBe(QUOTA_MEMBER_WALLET_MESSAGE);
    // Wallet copy wins even with upgrade requests off — recharging is an
    // owner action outside that feature, and the funding reason must be real.
    expect(
      quotaErrorMessage(err, {
        isOwner: false,
        upgradeRequestsEnabled: false,
        walletBilling: true,
      }),
    ).toBe(QUOTA_MEMBER_WALLET_MESSAGE);
  });
});

describe("quotaErrorTitle", () => {
  it("wallet-billed workspaces get a wallet-aware title", () => {
    expect(quotaErrorTitle(true)).toBe("Wallet balance too low");
    expect(quotaErrorTitle(true, "Video quota reached")).toBe("Wallet balance too low");
    expect(quotaErrorTitle(false)).toBe("AI quota reached");
    expect(quotaErrorTitle(false, "Video quota reached")).toBe("Video quota reached");
  });
});

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <QuotaErrorNotice message="Quota reached." onPress={() => setOpen(true)} />
      <QuotaInfoSheet visible={open} onClose={() => setOpen(false)} />
    </>
  );
}

describe("QuotaErrorNotice + QuotaInfoSheet", () => {
  beforeEach(() => {
    mockState.wallet = undefined;
  });

  it("tapping the notice opens the explainer with reset and billing guidance", () => {
    render(<Harness />);
    expect(screen.queryByText(/About your AI quota/)).toBeNull();

    fireEvent.click(
      screen.getByLabelText("Learn how AI quotas work and how to get more"),
    );

    expect(screen.getByText(/About your AI quota/)).toBeTruthy();
    expect(screen.getByText(/resets\s+automatically/i)).toBeTruthy();
    expect(screen.getByText(/Settings, then\s+Billing/i)).toBeTruthy();

    fireEvent.click(screen.getByText("Got it"));
    expect(screen.queryByText(/About your AI quota/)).toBeNull();
  });

  it("owner sheet keeps the upgrade/credit-pack advice and the web-app Billing row", () => {
    render(<QuotaInfoSheet visible onClose={() => {}} isOwner upgradeRequestsEnabled />);
    expect(
      screen.getByText(/Upgrade your plan or buy a credit pack\. Credits are used automatically/i),
    ).toBeTruthy();
    expect(screen.getByText(/Settings, then\s+Billing/i)).toBeTruthy();
  });

  it("member sheet with upgrade requests on points at the studio upgrade request", () => {
    render(
      <QuotaInfoSheet visible onClose={() => {}} isOwner={false} upgradeRequestsEnabled />,
    );
    expect(
      screen.getByText(/send them an upgrade request from the studio/i),
    ).toBeTruthy();
    expect(screen.queryByText(/Settings, then\s+Billing/i)).toBeNull();
  });

  it("member sheet with upgrade requests off shows plain ask-your-owner copy", () => {
    render(
      <QuotaInfoSheet
        visible
        onClose={() => {}}
        isOwner={false}
        upgradeRequestsEnabled={false}
      />,
    );
    expect(
      screen.getByText(
        /Ask your workspace owner to upgrade the plan or buy a credit pack\.$/i,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/upgrade request from the studio/i)).toBeNull();
    expect(screen.queryByText(/Settings, then\s+Billing/i)).toBeNull();
  });

  it("wallet-billed owner sheet points at wallet recharge, not credit packs", () => {
    mockState.wallet = { walletBilling: true };
    render(<QuotaInfoSheet visible onClose={() => {}} isOwner upgradeRequestsEnabled />);
    expect(
      screen.getByText(/Recharge your prepaid wallet — generations are paid from your wallet balance/i),
    ).toBeTruthy();
    expect(
      screen.getByText(/Wallet recharges are managed on the KOKAO web app/i),
    ).toBeTruthy();
    expect(screen.queryByText(/credit pack/i)).toBeNull();
  });

  it("wallet-billed member sheet with upgrade requests on asks the owner to recharge", () => {
    mockState.wallet = { walletBilling: true };
    render(
      <QuotaInfoSheet visible onClose={() => {}} isOwner={false} upgradeRequestsEnabled />,
    );
    expect(
      screen.getByText(
        /Ask your workspace owner to recharge the prepaid wallet — you can send them an upgrade request from the studio/i,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/credit pack/i)).toBeNull();
    expect(screen.queryByText(/Settings, then\s+Billing/i)).toBeNull();
  });

  it("wallet-billed member sheet with upgrade requests off shows plain recharge copy", () => {
    mockState.wallet = { walletBilling: true };
    render(
      <QuotaInfoSheet
        visible
        onClose={() => {}}
        isOwner={false}
        upgradeRequestsEnabled={false}
      />,
    );
    expect(
      screen.getByText(/Ask your workspace owner to recharge the prepaid wallet\.$/i),
    ).toBeTruthy();
    expect(screen.queryByText(/upgrade request from the studio/i)).toBeNull();
    expect(screen.queryByText(/credit pack/i)).toBeNull();
  });

  it("quota-billed workspaces (walletBilling false) keep the credit-pack copy", () => {
    mockState.wallet = { walletBilling: false };
    render(<QuotaInfoSheet visible onClose={() => {}} isOwner upgradeRequestsEnabled />);
    expect(
      screen.getByText(/Upgrade your plan or buy a credit pack\. Credits are used automatically/i),
    ).toBeTruthy();
    expect(screen.queryByText(/prepaid wallet/i)).toBeNull();
  });
});
