/**
 * Regression guard: the mobile Settings "Have an invite or promo code?" box
 * (owner-only) must clear the input and show a success notice on redeem,
 * surface the server's specific message on a 400 rejection, and stay hidden
 * for non-owner team members.
 */
import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const redeemMutate = vi.fn();

const mockState: {
  team: { role: string; workspaceName: string } | null;
} = {
  team: null,
};

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock, idleMutation } = await import("./apiClientMock");
  return createApiClientMock({
    useGetMe: () => ({
      data: {
        tenant: { id: 1, name: "Test Workspace", plan: "free" },
        usage: { captions: 1, images: 1 },
        limits: { captions: 10, images: 10 },
        credits: { captionCredits: 0, imageCredits: 0 },
        team: mockState.team,
      },
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
      isRefetching: false,
    }),
    useBillingGetOverview: () => ({
      data: {
        configured: true,
        keyId: "rzp_test_key",
        plan: "free",
        subscription: null,
        credits: { captionCredits: 0, imageCredits: 0 },
        creditPacks: [],
        history: [],
      },
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
      isRefetching: false,
    }),
    useListPlans: () => ({
      data: [],
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
      isRefetching: false,
    }),
    useBillingRedeemPromo: () => ({
      ...idleMutation(),
      mutate: redeemMutate,
    }),
  });
});

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("@expo/vector-icons", () => ({
  Feather: Object.assign(() => null, { glyphMap: {} }),
}));
vi.mock("@/components/RazorpayCheckoutModal", () => ({
  RazorpayCheckoutModal: () => null,
}));

import SettingsScreen from "../app/settings";

function renderScreen() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <SettingsScreen />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  cleanup();
  redeemMutate.mockReset();
  mockState.team = null;
});

describe("Mobile Settings invite/promo code redeem box", () => {
  it("successful redeem shows the success notice and clears the input", async () => {
    redeemMutate.mockImplementation((_vars, opts) =>
      opts?.onSuccess?.({ message: "Code redeemed! 50 caption credits added." }),
    );
    renderScreen();

    const input = screen.getByTestId("input-promo-code") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "WELCOME50" } });
    fireEvent.click(screen.getByTestId("button-redeem-promo"));

    await waitFor(() =>
      expect(redeemMutate).toHaveBeenCalledWith(
        { data: { code: "WELCOME50" } },
        expect.anything(),
      ),
    );
    await waitFor(() =>
      expect(
        screen.getByText("Code redeemed! 50 caption credits added."),
      ).toBeTruthy(),
    );
    expect((screen.getByTestId("input-promo-code") as HTMLInputElement).value).toBe("");
  });

  it("falls back to a generic success message when the server sends none", async () => {
    redeemMutate.mockImplementation((_vars, opts) => opts?.onSuccess?.({}));
    renderScreen();

    fireEvent.change(screen.getByTestId("input-promo-code"), {
      target: { value: "abc" },
    });
    fireEvent.click(screen.getByTestId("button-redeem-promo"));

    await waitFor(() =>
      expect(
        screen.getByText("Code redeemed. Credits added to your workspace."),
      ).toBeTruthy(),
    );
  });

  it("a 400 rejection surfaces the server's specific message", async () => {
    redeemMutate.mockImplementation((_vars, opts) =>
      opts?.onError?.(
        Object.assign(new Error("HTTP 400"), {
          status: 400,
          data: { error: "This code has expired." },
        }),
      ),
    );
    renderScreen();

    fireEvent.change(screen.getByTestId("input-promo-code"), {
      target: { value: "OLDCODE" },
    });
    fireEvent.click(screen.getByTestId("button-redeem-promo"));

    await waitFor(() =>
      expect(screen.getByText("This code has expired.")).toBeTruthy(),
    );
    // Failed redeem keeps the typed code so the user can correct it.
    expect((screen.getByTestId("input-promo-code") as HTMLInputElement).value).toBe(
      "OLDCODE",
    );
  });

  it("shows a generic error when the failure carries no server message", async () => {
    redeemMutate.mockImplementation((_vars, opts) =>
      opts?.onError?.(new Error("network down")),
    );
    renderScreen();

    fireEvent.change(screen.getByTestId("input-promo-code"), {
      target: { value: "abc" },
    });
    fireEvent.click(screen.getByTestId("button-redeem-promo"));

    await waitFor(() =>
      expect(
        screen.getByText("Could not redeem the code. Please try again."),
      ).toBeTruthy(),
    );
  });

  it("does not send anything for a blank or whitespace-only code", () => {
    renderScreen();

    fireEvent.click(screen.getByTestId("button-redeem-promo"));
    fireEvent.change(screen.getByTestId("input-promo-code"), {
      target: { value: "   " },
    });
    fireEvent.click(screen.getByTestId("button-redeem-promo"));

    expect(redeemMutate).not.toHaveBeenCalled();
  });

  it("trims surrounding whitespace before sending the code", async () => {
    redeemMutate.mockImplementation((_vars, opts) => opts?.onSuccess?.({}));
    renderScreen();

    fireEvent.change(screen.getByTestId("input-promo-code"), {
      target: { value: "  SPACED  " },
    });
    fireEvent.click(screen.getByTestId("button-redeem-promo"));

    await waitFor(() =>
      expect(redeemMutate).toHaveBeenCalledWith(
        { data: { code: "SPACED" } },
        expect.anything(),
      ),
    );
  });

  it("does not render the redeem box for non-owner team members", () => {
    mockState.team = { role: "member", workspaceName: "Owner WS" };
    renderScreen();

    expect(screen.queryByText("Have an invite or promo code?")).toBeNull();
    expect(screen.queryByTestId("input-promo-code")).toBeNull();
    expect(screen.queryByTestId("button-redeem-promo")).toBeNull();
  });
});
