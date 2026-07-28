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

import {
  isQuotaError,
  quotaErrorMessage,
  QUOTA_FALLBACK_MESSAGE,
  QUOTA_MEMBER_ASK_OWNER_MESSAGE,
  QUOTA_MEMBER_PLAIN_MESSAGE,
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
});
