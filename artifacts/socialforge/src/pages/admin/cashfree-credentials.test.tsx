import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CredentialsTab } from "./credentials-tab";

const mockState: {
  cashfree: Record<string, unknown>;
  gateway: Record<string, unknown>;
} = {
  cashfree: {
    configured: false,
    appIdMasked: null,
    secretKeyMasked: null,
    mode: "sandbox",
    testStatus: null,
    testedAt: null,
    testError: null,
  },
  gateway: {
    activeGateway: "razorpay",
    razorpayConfigured: true,
    cashfreeConfigured: false,
  },
};

const saveCashfreeMutate = vi.fn();
const saveGatewayMutate = vi.fn();
const toastFn = vi.fn();

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../../test/apiClientMock");
  return createApiClientMock({
    useAdminGetCashfreeCredentials: () => ({
      data: mockState.cashfree,
      isLoading: false,
    }),
    useAdminSaveCashfreeCredentials: () => ({
      mutate: saveCashfreeMutate,
      isPending: false,
    }),
    useAdminGetPaymentGateway: () => ({
      data: mockState.gateway,
      isLoading: false,
    }),
    useAdminSavePaymentGateway: () => ({
      mutate: saveGatewayMutate,
      isPending: false,
    }),
  });
});

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: toastFn }) }));

function renderTab() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <CredentialsTab />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  saveCashfreeMutate.mockReset();
  saveGatewayMutate.mockReset();
  toastFn.mockReset();
  mockState.cashfree = {
    configured: false,
    appIdMasked: null,
    secretKeyMasked: null,
    mode: "sandbox",
    testStatus: null,
    testedAt: null,
    testError: null,
  };
  mockState.gateway = {
    activeGateway: "razorpay",
    razorpayConfigured: true,
    cashfreeConfigured: false,
  };
});

describe("CashfreeCredentialsCard", () => {
  it("renders the App ID, Secret Key and Mode fields", () => {
    renderTab();
    expect(screen.getByTestId("input-cashfree-app-id")).toBeTruthy();
    expect(screen.getByTestId("input-cashfree-secret-key")).toBeTruthy();
    expect(screen.getByTestId("select-cashfree-mode")).toBeTruthy();
  });

  it("saves the entered App ID, Secret Key and mode", () => {
    renderTab();
    fireEvent.change(screen.getByTestId("input-cashfree-app-id"), {
      target: { value: "app_123" },
    });
    fireEvent.change(screen.getByTestId("input-cashfree-secret-key"), {
      target: { value: "secret_xyz" },
    });
    fireEvent.click(screen.getByTestId("button-save-cashfree-credentials"));
    expect(saveCashfreeMutate).toHaveBeenCalledTimes(1);
    const [payload] = saveCashfreeMutate.mock.calls[0];
    expect(payload).toEqual({
      data: { appId: "app_123", secretKey: "secret_xyz", mode: "sandbox" },
    });
  });
});

describe("ActivePaymentGatewayCard", () => {
  it("disables the Cashfree option while it is unconfigured", () => {
    renderTab();
    const cashfreeOption = screen.getByTestId(
      "gateway-option-cashfree",
    ) as HTMLButtonElement;
    expect(cashfreeOption.disabled).toBe(true);
    expect(cashfreeOption.textContent).toContain("Not configured");
    fireEvent.click(cashfreeOption);
    expect(saveGatewayMutate).not.toHaveBeenCalled();
  });

  it("lets you switch to a configured gateway", () => {
    mockState.gateway = {
      activeGateway: "razorpay",
      razorpayConfigured: true,
      cashfreeConfigured: true,
    };
    renderTab();
    const cashfreeOption = screen.getByTestId(
      "gateway-option-cashfree",
    ) as HTMLButtonElement;
    expect(cashfreeOption.disabled).toBe(false);
    fireEvent.click(cashfreeOption);
    expect(saveGatewayMutate).toHaveBeenCalledTimes(1);
    const [payload] = saveGatewayMutate.mock.calls[0];
    expect(payload).toEqual({ data: { activeGateway: "cashfree" } });
  });
});
